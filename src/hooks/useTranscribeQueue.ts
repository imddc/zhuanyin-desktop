import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  applyDone,
  applyError,
  applyMeta,
  applyPhase,
  applyProgress,
  applySegment,
  enqueueJobs,
  markCanceled,
  markRunning,
  pickNextQueued,
  summarize,
  updateJob,
} from '../lib/queue'
import type {
  IEngineStatus,
  IJobDonePayload,
  IJobErrorPayload,
  IJobMetaPayload,
  IJobPhasePayload,
  IJobProgressPayload,
  IJobSegmentPayload,
  ITranscribeJob,
} from '../types'

interface IQueueOptions {
  outputRoot: string | null
  /** 用哪个模型；null 交给后端按「已下载的推荐模型」挑 */
  modelId: string | null
  /** 'auto' 或语言代码 */
  language: string
  /** 初始提示词，空串表示不传 */
  prompt: string
  /** 任务结束（成功或失败）时回调，用来刷新历史列表 */
  onSettled?: () => void
}

interface IUseTranscribeQueueResult {
  engine: IEngineStatus | null
  engineError: string | null
  jobs: ITranscribeJob[]
  summary: ReturnType<typeof summarize>
  enqueue: (paths: string[]) => number
  cancel: (jobId: string) => Promise<void>
  refreshEngine: () => Promise<void>
  clearFinished: () => void
  /** 把历史条目挂进队列（标记为已完成），便于用同一套界面看旧结果 */
  adoptJob: (job: ITranscribeJob) => void
}

/**
 * 转写队列的唯一入口。
 *
 * 串行执行：一次只跑一个任务（模型占内存与显存，并行只会互相拖慢）。
 * 任务号由前端生成并传给 Rust —— 事件可能早于 invoke 返回，
 * 只有前端自带 id 才能保证事件一定对得上任务。
 */
const useTranscribeQueue = (options: IQueueOptions): IUseTranscribeQueueResult => {
  const [engine, setEngine] = useState<IEngineStatus | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<ITranscribeJob[]>([])

  // 启动参数在排队期间可能被用户改（改完期望对后面的任务生效），
  // 但调度用的 effect 不该因为这几项重新注册，所以统一用 ref 读最新值。
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const seedRef = useRef(1)
  const startingRef = useRef(false)

  // 队列的「当前值」同时存在 ref 与 state 两份，且只从下面这个口子写入。
  // 为什么非要 ref：enqueue 得在同一个 tick 里知道当前队列才能算出实际加入了几个
  // （去重就依赖它），而 React 18 的状态更新是批处理的 —— 更新函数不会在 setState
  // 调用时立即执行，靠它回传计数的返回值从诞生起就是过期的（见 issue #15）。
  const jobsRef = useRef<ITranscribeJob[]>([])

  /** 唯一的状态提交口：ref 与 state 一起更新，保证调用方随后读到的是同一份数据 */
  const commitJobs = useCallback((next: ITranscribeJob[]): void => {
    jobsRef.current = next
    setJobs(next)
  }, [])

  const refreshEngine = useCallback(async () => {
    try {
      const status = await invoke<IEngineStatus>('engine_status')
      setEngine(status)
      setEngineError(null)
    } catch (error) {
      setEngine(null)
      setEngineError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  // 首次挂载探测引擎状态：这是「与外部系统（Rust 端）同步」的典型场景，
  // 状态只能等异步探测回来后才知道，渲染期无法推导。
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- 外部系统探测结果回写，渲染期拿不到
    void refreshEngine()
  }, [refreshEngine])

  useEffect(() => {
    const disposers: Array<() => void> = []
    let disposed = false

    const register = async (): Promise<void> => {
      const unlistenMeta = await listen<IJobMetaPayload>('asr://meta', (event) => {
        const payload = event.payload
        commitJobs(updateJob(jobsRef.current, payload.jobId, (job) => applyMeta(job, payload)))
      })
      const unlistenSegment = await listen<IJobSegmentPayload>('asr://segment', (event) => {
        const payload = event.payload
        commitJobs(updateJob(jobsRef.current, payload.jobId, (job) => applySegment(job, payload)))
      })
      const unlistenPhase = await listen<IJobPhasePayload>('asr://phase', (event) => {
        const payload = event.payload
        commitJobs(updateJob(jobsRef.current, payload.jobId, (job) => applyPhase(job, payload)))
      })
      const unlistenProgress = await listen<IJobProgressPayload>('asr://progress', (event) => {
        const payload = event.payload
        commitJobs(updateJob(jobsRef.current, payload.jobId, (job) => applyProgress(job, payload)))
      })
      const unlistenDone = await listen<IJobDonePayload>('asr://done', (event) => {
        const payload = event.payload
        commitJobs(updateJob(jobsRef.current, payload.jobId, (job) => applyDone(job, payload, Date.now())))
      })
      const unlistenError = await listen<IJobErrorPayload>('asr://error', (event) => {
        const payload = event.payload
        // 任务已被用户取消时，引擎退出产生的错误不再覆盖取消状态
        commitJobs(
          updateJob(jobsRef.current, payload.jobId, (job) =>
            job.status === 'canceled' ? job : applyError(job, payload, Date.now()),
          ),
        )
      })
      // 后端在每个任务收尾时都会发这一条（成功、失败、取消都一样），
      // 用它刷新引擎状态与历史，比在每个分支里各接一次可靠。
      const unlistenFinished = await listen<string>('asr://finished', () => {
        optionsRef.current.onSettled?.()
        void refreshEngine()
      })

      if (disposed) {
        unlistenMeta()
        unlistenPhase()
        unlistenSegment()
        unlistenProgress()
        unlistenDone()
        unlistenError()
        unlistenFinished()
        return
      }
      disposers.push(
        unlistenMeta,
        unlistenPhase,
        unlistenSegment,
        unlistenProgress,
        unlistenDone,
        unlistenError,
        unlistenFinished,
      )
    }

    void register()

    return () => {
      disposed = true
      for (const dispose of disposers) {
        dispose()
      }
    }
  }, [commitJobs, refreshEngine])

  useEffect(() => {
    if (startingRef.current) {
      return
    }
    const next = pickNextQueued(jobs)
    if (next === null) {
      return
    }

    startingRef.current = true
    const jobId = next.id
    // 队列泵：本 hook 的核心职责就是「由队列状态推进下一个任务」，
    // 这个写入不是从 props 或父组件派生的值，渲染期没有等价写法。
    // oxlint-disable-next-line react/set-state-in-effect -- 队列泵，由队列状态驱动启动下一个任务
    commitJobs(updateJob(jobsRef.current, jobId, (job) => markRunning(job, Date.now())))

    const { outputRoot, modelId, language, prompt } = optionsRef.current
    invoke<string>('start_transcribe', {
      request: {
        input: next.sourcePath,
        jobId,
        name: next.name,
        // 没选模型就不传，交给后端按「已下载的推荐模型」挑
        modelId: modelId ?? undefined,
        language,
        prompt: prompt.trim() === '' ? undefined : prompt,
        // 没选输出位置就不传，交给引擎按「音频所在目录」处理
        outDir: outputRoot ?? undefined,
      },
    })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        commitJobs(
          updateJob(jobsRef.current, jobId, (job) =>
            job.status === 'canceled' ? job : applyError(job, { jobId, message }, Date.now()),
          ),
        )
        startingRef.current = false
      })
      .finally(() => {
        startingRef.current = false
      })
  }, [jobs, commitJobs])

  const enqueue = useCallback(
    (paths: string[]): number => {
      const result = enqueueJobs(jobsRef.current, paths, seedRef.current)
      if (result.added > 0) {
        seedRef.current += result.added
        commitJobs(result.jobs)
      }
      return result.added
    },
    [commitJobs],
  )

  const adoptJob = useCallback(
    (job: ITranscribeJob) => {
      // 同一条历史重复点开时替换而不是追加，避免队列里堆出一串同样的条目
      const existing = jobsRef.current.filter((item) => item.id !== job.id)
      commitJobs([...existing, job])
    },
    [commitJobs],
  )

  const cancel = useCallback(
    async (jobId: string) => {
      commitJobs(updateJob(jobsRef.current, jobId, (job) => markCanceled(job, Date.now())))
      try {
        await invoke('cancel_job', { jobId })
      } catch {
        // 取消失败通常意味着任务已自行结束，此时本地状态已经是对的
      }
    },
    [commitJobs],
  )

  const clearFinished = useCallback(() => {
    commitJobs(jobsRef.current.filter((job) => job.status === 'queued' || job.status === 'running'))
  }, [commitJobs])

  return {
    engine,
    engineError,
    jobs,
    summary: summarize(jobs),
    enqueue,
    cancel,
    refreshEngine,
    clearFinished,
    adoptJob,
  }
}

export { useTranscribeQueue }
