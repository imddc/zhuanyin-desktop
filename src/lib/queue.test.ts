import { describe, expect, it } from 'vitest'

import type { ITranscribeJob } from '../types'
import {
  activeSegmentIndex,
  applyDone,
  applyError,
  applyMeta,
  applyPhase,
  applyProgress,
  applySegment,
  createJob,
  enqueueJobs,
  jobFromHistory,
  markCanceled,
  markRunning,
  pickNextQueued,
  summarize,
  updateJob,
} from './queue'

const buildJob = (overrides: Partial<ITranscribeJob> = {}): ITranscribeJob => ({
  ...createJob('/tmp/meeting.m4a', 1),
  ...overrides,
})

describe('enqueueJobs', () => {
  it('过滤非音频与重复路径，并返回真正加入的数量', () => {
    const first = enqueueJobs([], ['/tmp/a.m4a', '/tmp/b.txt', '/tmp/c.mp3'], 1)
    expect(first.added).toBe(2)
    expect(first.jobs.map((job) => job.sourcePath)).toEqual(['/tmp/a.m4a', '/tmp/c.mp3'])

    const second = enqueueJobs(first.jobs, ['/tmp/a.m4a', '/tmp/d.wav'], 3)
    expect(second.added).toBe(1)
    expect(second.jobs).toHaveLength(3)
  })

  it('任务号互不相同', () => {
    const { jobs } = enqueueJobs([], ['/tmp/a.m4a', '/tmp/b.m4a'], 1)
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2)
  })
})

describe('状态迁移', () => {
  it('markRunning 只对排队中的任务生效', () => {
    const queued = buildJob()
    expect(markRunning(queued, 100).status).toBe('running')

    const done = buildJob({ status: 'done' })
    expect(markRunning(done, 100)).toBe(done)
  })

  it('applyMeta 记录真实时长与源音频信息，并重置比例', () => {
    const running = buildJob({ status: 'running', ratio: 0.5 })
    const next = applyMeta(running, {
      jobId: running.id,
      name: 'meeting',
      source: '/tmp/meeting.m4a',
      duration: 1800,
      modelId: 'large-v3-turbo-q5_0',
      modelName: 'Large v3 Turbo · Q5_0',
      language: 'zh',
      sourceRate: 44100,
      sourceChannels: 2,
    })
    expect(next.durationSeconds).toBe(1800)
    expect(next.ratio).toBe(0)
    expect(next.modelId).toBe('large-v3-turbo-q5_0')
    expect(next.sourceRate).toBe(44100)
    expect(next.sourceChannels).toBe(2)
  })

  it('applyPhase 记下准备阶段，但不编造进度', () => {
    // 加载模型 / 解码音频这两段是真的没有百分比可报，
    // 与其显示停在 0% 的假进度，不如让界面说清在干什么
    const queued = buildJob({ status: 'running', startedAt: 1 })
    const loading = applyPhase(queued, { jobId: queued.id, phase: 'loadingModel' })
    expect(loading.phase).toBe('loadingModel')
    expect(loading.ratio).toBe(queued.ratio)

    const decoding = applyPhase(loading, { jobId: queued.id, phase: 'decodingAudio' })
    expect(decoding.phase).toBe('decodingAudio')
  })

  it('一旦有了真实进度，准备阶段就结束', () => {
    // 否则进度条会一直停在「不确定」的扫描态，明明已经有百分比了
    const preparing = applyPhase(buildJob({ status: 'running' }), {
      jobId: 'x',
      phase: 'decodingAudio',
    })
    expect(applyProgress(preparing, { jobId: 'x', ratio: 0.2 }).phase).toBeNull()
    expect(applySegment(preparing, { jobId: 'x', start: 0, end: 3, text: '你好', ratio: 0.1 }).phase).toBeNull()
  })

  it('applyProgress 只推进进度，且同样单调不减', () => {
    const running = buildJob({ status: 'running' })
    const halfway = applyProgress(running, { jobId: running.id, ratio: 0.5 })
    expect(halfway.ratio).toBeCloseTo(0.5)
    expect(halfway.segments).toHaveLength(0)

    const backwards = applyProgress(halfway, { jobId: running.id, ratio: 0.2 })
    expect(backwards.ratio).toBeCloseTo(0.5)
  })

  it('applySegment 追加非空段落，空文本只推进进度', () => {
    const running = buildJob({ status: 'running' })
    const withText = applySegment(running, { jobId: running.id, start: 0, end: 5, text: ' 你好 ', ratio: 0.2 })
    expect(withText.segments).toEqual([{ start: 0, end: 5, text: '你好' }])
    expect(withText.ratio).toBeCloseTo(0.2)

    const blank = applySegment(withText, { jobId: running.id, start: 5, end: 9, text: '   ', ratio: 0.4 })
    expect(blank.segments).toHaveLength(1)
    expect(blank.ratio).toBeCloseTo(0.4)
  })

  it('进度比例单调不减，且不超过 1', () => {
    const running = buildJob({ status: 'running' })
    const high = applySegment(running, { jobId: running.id, start: 0, end: 5, text: 'a', ratio: 0.8 })
    const lower = applySegment(high, { jobId: running.id, start: 5, end: 6, text: 'b', ratio: 0.3 })
    expect(lower.ratio).toBeCloseTo(0.8)

    const overflow = applySegment(high, { jobId: running.id, start: 6, end: 7, text: 'c', ratio: 1.4 })
    expect(overflow.ratio).toBe(1)
  })

  it('applyDone 归位到完成态并记录产物与全文', () => {
    const running = buildJob({ status: 'running', ratio: 0.9 })
    const done = applyDone(
      running,
      {
        jobId: running.id,
        name: 'meeting',
        duration: 30,
        language: 'zh',
        segments: 2,
        files: { txt: '/tmp/meeting.txt', srt: '/tmp/meeting.srt' },
        text: '完整逐字稿',
        historyId: 7,
      },
      500,
    )
    expect(done.status).toBe('done')
    expect(done.ratio).toBe(1)
    expect(done.files.txt).toBe('/tmp/meeting.txt')
    expect(done.text).toBe('完整逐字稿')
    expect(done.historyId).toBe(7)
    expect(done.finishedAt).toBe(500)
  })

  it('applyError 带上失败原因', () => {
    const failed = applyError(buildJob({ status: 'running' }), { jobId: 'x', message: '模型缺失' }, 700)
    expect(failed.status).toBe('error')
    expect(failed.errorMessage).toBe('模型缺失')
  })

  it('已完成或失败的任务不会被取消覆盖', () => {
    const done = buildJob({ status: 'done' })
    expect(markCanceled(done, 1)).toBe(done)

    const canceled = markCanceled(buildJob({ status: 'running' }), 1)
    expect(canceled.status).toBe('canceled')
  })
})

describe('updateJob', () => {
  it('按任务号替换，找不到时原样返回同一个引用', () => {
    const jobs = [buildJob({ id: 'a' }), buildJob({ id: 'b' })]
    const updated = updateJob(jobs, 'b', (job) => ({ ...job, ratio: 0.5 }))
    expect(updated[1]?.ratio).toBe(0.5)
    expect(updated[0]).toBe(jobs[0])

    expect(updateJob(jobs, 'missing', (job) => job)).toBe(jobs)
  })
})

describe('pickNextQueued', () => {
  it('串行执行：有任务在跑就不取下一个', () => {
    const jobs = [buildJob({ id: 'a', status: 'running' }), buildJob({ id: 'b', status: 'queued' })]
    expect(pickNextQueued(jobs)).toBeNull()
  })

  it('按顺序取第一个排队任务', () => {
    const jobs = [buildJob({ id: 'a', status: 'done' }), buildJob({ id: 'b', status: 'queued' })]
    expect(pickNextQueued(jobs)?.id).toBe('b')
  })

  it('全部结束时返回 null', () => {
    expect(pickNextQueued([buildJob({ status: 'done' })])).toBeNull()
  })
})

describe('summarize', () => {
  it('把取消也算进失败位，便于顶部提示', () => {
    const jobs = [
      buildJob({ id: 'a', status: 'queued' }),
      buildJob({ id: 'b', status: 'running' }),
      buildJob({ id: 'c', status: 'done' }),
      buildJob({ id: 'd', status: 'error' }),
      buildJob({ id: 'e', status: 'canceled' }),
    ]
    expect(summarize(jobs)).toEqual({ total: 5, queued: 1, running: 1, done: 1, failed: 2 })
  })
})

describe('jobFromHistory', () => {
  it('把历史记录还原成完成态任务，并带回分段与产物', () => {
    const job = jobFromHistory({
      id: 12,
      name: 'interview',
      sourcePath: '/audio/interview.m4a',
      outputDir: '/audio/interview',
      modelId: 'large-v3-turbo-q5_0',
      language: 'zh',
      durationSeconds: 66.8,
      segmentCount: 2,
      createdAt: 1_700_000_000_000,
      text: '全文',
      segments: [
        { start: 0, end: 6.24, text: '第一段' },
        { start: 6.24, end: 15.74, text: '第二段' },
      ],
      files: { txt: '/audio/interview/interview.txt' },
    })

    expect(job.status).toBe('done')
    expect(job.ratio).toBe(1)
    expect(job.id).toBe('history-12')
    expect(job.historyId).toBe(12)
    expect(job.segments).toHaveLength(2)
    expect(job.durationSeconds).toBeCloseTo(66.8)
    expect(job.finishedAt).toBe(1_700_000_000_000)
  })
})

describe('activeSegmentIndex', () => {
  const segments = [
    { start: 0, end: 5, text: 'a' },
    { start: 5, end: 12, text: 'b' },
  ]

  it('左闭右开：段落边界归下一段', () => {
    expect(activeSegmentIndex(segments, 0)).toBe(0)
    expect(activeSegmentIndex(segments, 4.99)).toBe(0)
    expect(activeSegmentIndex(segments, 5)).toBe(1)
    expect(activeSegmentIndex(segments, 11.99)).toBe(1)
  })

  it('超出范围或空列表返回 -1', () => {
    expect(activeSegmentIndex(segments, 30)).toBe(-1)
    expect(activeSegmentIndex([], 1)).toBe(-1)
  })
})
