import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AppToaster } from './components/AppToaster'
import { Sidebar } from './components/Sidebar'
import { HistoryPage } from './pages/HistoryPage'
import { ModelsPage } from './pages/ModelsPage'
import { SettingsPage } from './pages/SettingsPage'
import { TranscribePage } from './pages/TranscribePage'
import { useHistory } from './hooks/useHistory'
import { useModels } from './hooks/useModels'
import { useTranscribeQueue } from './hooks/useTranscribeQueue'
import { pickModelId } from './lib/models'
import { notify } from './lib/notice'
import { activeSegmentIndex, jobFromHistory } from './lib/queue'
import {
  loadLanguage,
  loadOutputRoot,
  loadPrompt,
  loadSelectedModelId,
  saveLanguage,
  saveOutputRoot,
  savePrompt,
  saveSelectedModelId,
} from './lib/settings'
import type { TPage } from './components/Sidebar'
import type { ITranscriptSegment } from './types'

/**
 * 应用外壳：持有跨页面共享的状态（队列、模型、历史、播放），
 * 并按当前页面渲染对应内容。
 *
 * 播放状态放在这里而不是转写页里，是因为时间轴高亮与音频播放必须共享同一个时钟，
 * 而且切到别的页面时播放不该被打断。
 */
/** 空段落数组的稳定引用：`?? []` 每次渲染都会新建数组，会让下游的 useMemo/useCallback 全部失效 */
const EMPTY_SEGMENTS: ITranscriptSegment[] = []

const App = () => {
  const [outputRoot, setOutputRoot] = useState<string | null>(() => loadOutputRoot())
  const [preferredModelId, setPreferredModelId] = useState<string | null>(() => loadSelectedModelId())
  const [language, setLanguage] = useState<string>(() => loadLanguage())
  const [prompt, setPrompt] = useState<string>(() => loadPrompt())

  const [page, setPage] = useState<TPage>('transcribe')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const history = useHistory()

  const models = useModels(notify)

  // 历史刷新交给队列的收尾回调：成功后新任务立刻出现在历史里
  const refreshHistoryRef = useRef(history.refresh)
  useEffect(() => {
    refreshHistoryRef.current = history.refresh
  }, [history.refresh])

  const onSettled = useCallback(() => {
    void refreshHistoryRef.current()
  }, [])

  /**
   * 实际生效的模型：用户选的那个若已被删除，就回退到「已下载的推荐模型」。
   * 这样删掉正在用的模型之后界面不会停在一个不存在的选择上。
   */
  const effectiveModelId = useMemo(
    () => pickModelId(models.models, preferredModelId),
    [preferredModelId, models.models],
  )

  const queue = useTranscribeQueue({
    outputRoot,
    // 传「实际生效」的模型而不是用户偏好：偏好那个可能已被删除
    modelId: effectiveModelId,
    language,
    prompt,
    onSettled,
  })

  const engineReady = queue.engine?.ready === true
  const availableModels = queue.engine?.availableModels ?? 0
  const activeModel = models.models.find((model) => model.id === effectiveModelId) ?? null

  const applyOutputRoot = useCallback((root: string | null) => {
    setOutputRoot(root)
    saveOutputRoot(root)
  }, [])

  const applyModelId = useCallback((id: string) => {
    setPreferredModelId(id)
    saveSelectedModelId(id)
  }, [])

  const applyLanguage = useCallback((value: string) => {
    setLanguage(value)
    saveLanguage(value)
  }, [])

  const applyPrompt = useCallback((value: string) => {
    setPrompt(value)
    savePrompt(value)
  }, [])

  // 选中项优先用用户点过的；它失效（任务被清掉）时回落到「正在跑的任务，否则最后一个」。
  // 这里在渲染期直接推导，而不是用 effect 去 setState —— 后者每次都要多走一轮渲染。
  const selectedJob =
    queue.jobs.find((job) => job.id === selectedId) ??
    queue.jobs.find((job) => job.status === 'running') ??
    queue.jobs[queue.jobs.length - 1] ??
    null
  const activeJobId = selectedJob?.id ?? null

  // enqueue 是稳定引用，但 hook 返回的对象每次渲染都会变；
  // 用它做拖拽事件的依赖会让监听反复注册/注销，所以单独存进 ref。
  const enqueueRef = useRef(queue.enqueue)
  useEffect(() => {
    enqueueRef.current = queue.enqueue
  }, [queue.enqueue])

  // 拖拽监听只注册一次，引擎状态必须用 ref 读最新值。
  const engineReadyRef = useRef(engineReady)
  useEffect(() => {
    engineReadyRef.current = engineReady
  }, [engineReady])

  // 切任务时把播放状态归零，避免拿着上一条录音的进度去看新逐字稿
  useEffect(() => {
    const audio = audioRef.current
    if (audio !== null) {
      audio.pause()
      audio.currentTime = 0
    }
    // 这两个 setState 是必要的：audio 是命令式外部对象，必须在 effect 里等它挂载后才能操作，
    // 而「播放状态」与它是一体的，改播放位置就必须同步清零。
    // oxlint-disable-next-line react/set-state-in-effect -- 同步命令式 audio 元素，渲染期无法完成
    setPlaying(false)
    setCurrentTime(0)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- activeJobId 只作为「换任务」的触发条件，不在体内读取
  }, [activeJobId])

  useEffect(() => {
    const disposers: Array<() => void> = []
    let disposed = false

    const register = async (): Promise<void> => {
      const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload
        if (payload.type === 'enter' || payload.type === 'over') {
          setDragActive(true)
          return
        }
        if (payload.type === 'leave') {
          setDragActive(false)
          return
        }
        setDragActive(false)
        if (!engineReadyRef.current) {
          notify('还没有可用的模型 —— 先在「模型」里下载一个，再拖文件')
          return
        }
        const added = enqueueRef.current(payload.paths)
        notify(added > 0 ? `已加入 ${added} 个任务` : '没有可加入的音频文件（或已在队列里）')
      })
      if (disposed) {
        unlisten()
        return
      }
      disposers.push(unlisten)
    }

    void register()

    return () => {
      disposed = true
      for (const dispose of disposers) {
        dispose()
      }
    }
  }, [])

  const segments = selectedJob?.segments ?? EMPTY_SEGMENTS
  const activeIndex = useMemo(() => activeSegmentIndex(segments, currentTime), [segments, currentTime])
  const sourceUrl = selectedJob !== null ? convertFileSrc(selectedJob.sourcePath) : null
  const duration = selectedJob?.durationSeconds ?? 0

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current
    setCurrentTime(seconds)
    if (audio !== null) {
      audio.currentTime = seconds
    }
  }, [])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (audio === null) {
      return
    }
    if (audio.paused) {
      void audio.play()
    } else {
      audio.pause()
    }
  }, [])

  const changeRate = useCallback((rate: number) => {
    setPlaybackRate(rate)
    const audio = audioRef.current
    if (audio !== null) {
      audio.playbackRate = rate
    }
  }, [])

  const copyAll = useCallback(() => {
    const text = segments.map((segment) => segment.text).join('\n')
    if (text.length === 0) {
      return
    }
    void navigator.clipboard.writeText(text).then(() => notify('逐字稿全文已复制'))
  }, [segments])

  const reveal = useCallback((path: string) => {
    if (path === '') {
      return
    }
    void invoke('reveal_in_file_manager', { path }).catch(() => notify('这个路径已经不存在了'))
  }, [])

  /** 点开一条历史：还原成完成态任务挂进队列，逐字稿与时间轴立刻可用 */
  const openHistory = useCallback(
    async (id: number) => {
      const entry = await history.load(id)
      if (entry === null) {
        notify('这条历史已经读不出来了')
        return
      }
      const job = jobFromHistory(entry)
      queue.adoptJob(job)
      setSelectedId(job.id)
      setPage('transcribe')
    },
    [history, queue],
  )

  return (
    <div className="shell">
      {/* 无边框窗口（titleBarStyle: Overlay）没有系统标题栏，这一条就是拖动区。
          写成布局里的真实一层而不是浮层：浮层会挡住下面内容的点击。
          红绿灯悬浮在这条上（位置在 Rust 侧的 traffic_light_position 里定）。 */}
      <div className="shell__titlebar" data-tauri-drag-region="deep" />
      <div className="app">
        <Sidebar
          page={page}
          onChange={setPage}
          counts={{
            transcribe: queue.jobs.length,
            models: models.models.filter((model) => model.downloaded).length,
            history: history.entries.length,
            settings: null,
          }}
          engineReady={engineReady}
          activeModelName={activeModel?.name ?? null}
        />

        <main className="content">
          {page === 'transcribe' ? (
            <TranscribePage
              engineReady={engineReady}
              dragActive={dragActive}
              onPaths={(paths) => {
                const added = queue.enqueue(paths)
                notify(added > 0 ? `已加入 ${added} 个任务` : '没有可加入的音频文件（或已在队列里）')
              }}
              onOpenModels={() => setPage('models')}
              jobs={queue.jobs}
              selectedId={activeJobId}
              onSelect={setSelectedId}
              onCancel={(jobId) => void queue.cancel(jobId)}
              onClearFinished={queue.clearFinished}
              selectedJob={selectedJob}
              segments={segments}
              activeIndex={activeIndex}
              onSeek={seek}
              onCopyAll={copyAll}
              onReveal={reveal}
              sourceUrl={sourceUrl}
              playing={playing}
              currentTime={currentTime}
              duration={duration}
              playbackRate={playbackRate}
              onToggle={toggle}
              onRateChange={changeRate}
            />
          ) : null}

          {page === 'models' ? (
            <ModelsPage
              models={models.models}
              loading={models.loading}
              error={models.error}
              verifying={models.verifying}
              selectedId={effectiveModelId}
              modelsDir={queue.engine?.modelsDir ?? ''}
              onSelect={applyModelId}
              onDownload={(id) => void models.download(id)}
              onCancelDownload={(id) => void models.cancelDownload(id)}
              onDelete={(id) => void models.remove(id)}
              onImport={() => void models.importExisting()}
              onRefresh={() => void models.refresh()}
              onReveal={reveal}
            />
          ) : null}

          {page === 'history' ? (
            <HistoryPage
              entries={history.entries}
              loading={history.loading}
              error={history.error}
              activeId={selectedJob?.historyId ?? null}
              onOpen={(id) => void openHistory(id)}
              onDelete={(id) => void history.remove(id)}
              onClear={() => void history.clear()}
              onRefresh={() => void history.refresh()}
              onReveal={reveal}
            />
          ) : null}

          {page === 'settings' ? (
            <SettingsPage
              outputRoot={outputRoot}
              onOutputRootChange={applyOutputRoot}
              onNotice={notify}
              language={language}
              prompt={prompt}
              onLanguageChange={applyLanguage}
              onPromptChange={applyPrompt}
              modelsDir={queue.engine?.modelsDir ?? ''}
              onReveal={reveal}
              onOpenModels={() => setPage('models')}
              onReopenOnboarding={() => {
                void invoke('open_onboarding').catch(() => notify('无法打开引导窗口'))
              }}
              activeModelName={activeModel?.name ?? null}
              availableModels={availableModels}
            />
          ) : null}
        </main>

        <audio
          ref={audioRef}
          src={sourceUrl ?? undefined}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={(event) => {
            event.currentTarget.playbackRate = playbackRate
          }}
        />

        <AppToaster />
      </div>
    </div>
  )
}

export { App }
