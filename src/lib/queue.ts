/**
 * 队列的纯状态迁移。
 *
 * 这一层刻意不碰 React 与 Tauri：所有迁移都是「旧任务对象 + 事件 → 新任务对象」，
 * 所以可以用单测把状态机钉死（尤其是失败与取消这两条容易写错的分支）。
 */

import type {
  IHistoryEntry,
  IJobDonePayload,
  IJobErrorPayload,
  IJobMetaPayload,
  IJobPhasePayload,
  IJobProgressPayload,
  IJobSegmentPayload,
  ITranscriptSegment,
  ITranscribeJob,
} from '../types'
import { createJobId, isAudioFile, transcriptNameOf } from './format'

/** 新建一个排队中的任务 */
const createJob = (sourcePath: string, seed: number): ITranscribeJob => ({
  id: createJobId(seed),
  name: transcriptNameOf(sourcePath),
  sourcePath,
  status: 'queued',
  ratio: 0,
  phase: null,
  durationSeconds: 0,
  segments: [],
  text: '',
  files: {},
  errorMessage: null,
  startedAt: null,
  finishedAt: null,
  modelId: null,
  modelName: null,
  language: null,
  sourceRate: 0,
  sourceChannels: 0,
  historyId: null,
})

/**
 * 把一条历史记录还原成任务对象。
 *
 * 这是「关掉应用后逐字稿还在」的落点：历史里存了分段，所以恢复出来的任务
 * 同样能点段落跳播放、能跟着播放高亮。
 * @param entry 完整历史条目
 * @returns 一个已处于完成态的任务
 */
const jobFromHistory = (entry: IHistoryEntry): ITranscribeJob => ({
  id: `history-${entry.id}`,
  name: entry.name,
  sourcePath: entry.sourcePath,
  status: 'done',
  ratio: 1,
  phase: null,
  durationSeconds: entry.durationSeconds,
  segments: entry.segments,
  text: entry.text,
  files: entry.files,
  errorMessage: null,
  startedAt: null,
  finishedAt: entry.createdAt,
  modelId: entry.modelId,
  modelName: null,
  language: entry.language,
  sourceRate: 0,
  sourceChannels: 0,
  historyId: entry.id,
})

/**
 * 把一批路径加入队列
 * @param jobs 现有任务列表
 * @param paths 待加入的路径（拖拽或选择得到的）
 * @param seedStart 任务号起始序号
 * @returns 新列表与本次真正加入的数量（非音频与重复路径会被过滤）
 */
const enqueueJobs = (
  jobs: ITranscribeJob[],
  paths: string[],
  seedStart: number,
): { jobs: ITranscribeJob[]; added: number } => {
  const known = new Set(jobs.map((job) => job.sourcePath))
  const appended: ITranscribeJob[] = []
  let seed = seedStart

  for (const path of paths) {
    if (!isAudioFile(path) || known.has(path)) {
      continue
    }
    known.add(path)
    appended.push(createJob(path, seed))
    seed += 1
  }

  return { jobs: [...jobs, ...appended], added: appended.length }
}

/** 标记为转写中；已完成或失败的任务不回头 */
const markRunning = (job: ITranscribeJob, startedAt: number): ITranscribeJob => {
  // 先摆上「加载模型」，真正的阶段事件到达后会被覆盖：
  // 从点下到第一个事件之间也有几十毫秒，不留空档
  if (job.status !== 'queued') {
    return job
  }
  return { ...job, status: 'running', startedAt, errorMessage: null }
}

/** 应用 asr://meta：拿到真实时长与源音频信息，进度条才能算比例 */
const applyMeta = (job: ITranscribeJob, payload: IJobMetaPayload): ITranscribeJob => ({
  ...job,
  ratio: 0,
  durationSeconds: payload.duration,
  modelId: payload.modelId,
  modelName: payload.modelName,
  language: payload.language,
  sourceRate: payload.sourceRate,
  sourceChannels: payload.sourceChannels,
})

/**
 * 应用 asr://progress
 *
 * 分段之间的细粒度进度。长录音里两个段落可能隔十几秒，
 * 没有这条事件进度条看起来就像卡住了。
 */
const applyProgress = (job: ITranscribeJob, payload: IJobProgressPayload): ITranscribeJob => ({
  ...job,
  // 推理一开始，准备阶段就结束了 —— 进度条从不确定变回确定
  phase: null,
  ratio: clampRatio(payload.ratio, job.ratio),
})

/**
 * 应用 asr://phase
 *
 * 只记录阶段，不动进度：这段时间是真的没有进度可报，
 * 骗用户一个假百分比还不如老实说「正在解码音频」。
 */
const applyPhase = (job: ITranscribeJob, payload: IJobPhasePayload): ITranscribeJob => ({
  ...job,
  phase: payload.phase,
})

/**
 * 应用 asr://segment
 *
 * 模型偶尔会吐空文本段，这类段不写入 segments（否则 UI 会出现空行），
 * 但进度仍要推进，所以比例照常更新。
 */
const applySegment = (job: ITranscribeJob, payload: IJobSegmentPayload): ITranscribeJob => {
  const text = payload.text.trim()
  const segment: ITranscriptSegment = { start: payload.start, end: payload.end, text }
  const segments = text.length > 0 ? [...job.segments, segment] : job.segments
  return {
    ...job,
    segments,
    phase: null,
    ratio: clampRatio(payload.ratio, job.ratio),
  }
}

/** 应用 asr://done：进度归位到 1，记录产物路径与全文 */
const applyDone = (job: ITranscribeJob, payload: IJobDonePayload, finishedAt: number): ITranscribeJob => ({
  ...job,
  status: 'done',
  ratio: 1,
  durationSeconds: payload.duration > 0 ? payload.duration : job.durationSeconds,
  language: payload.language,
  text: payload.text,
  files: payload.files,
  historyId: payload.historyId,
  finishedAt,
})

/** 应用 asr://error */
const applyError = (job: ITranscribeJob, payload: IJobErrorPayload, finishedAt: number): ITranscribeJob => ({
  ...job,
  status: 'error',
  errorMessage: payload.message,
  finishedAt,
})

/** 用户主动取消 */
const markCanceled = (job: ITranscribeJob, finishedAt: number): ITranscribeJob => {
  if (job.status === 'done' || job.status === 'error') {
    return job
  }
  return { ...job, status: 'canceled', finishedAt, errorMessage: null }
}

/**
 * 按任务号替换列表中的一项；找不到时原样返回（事件与任务表不同步时不炸）
 * @param jobs 任务列表
 * @param jobId 目标任务号
 * @param update 迁移函数
 * @returns 新列表
 */
const updateJob = (
  jobs: ITranscribeJob[],
  jobId: string,
  update: (job: ITranscribeJob) => ITranscribeJob,
): ITranscribeJob[] => {
  let hit = false
  const next = jobs.map((job) => {
    if (job.id !== jobId) {
      return job
    }
    hit = true
    return update(job)
  })
  return hit ? next : jobs
}

/** 取出下一个该跑的任务：串行执行，一次只跑一个（内存与显存都有限） */
const pickNextQueued = (jobs: ITranscribeJob[]): ITranscribeJob | null => {
  const running = jobs.some((job) => job.status === 'running')
  if (running) {
    return null
  }
  return jobs.find((job) => job.status === 'queued') ?? null
}

/** 队列汇总，用于顶部统计 */
const summarize = (
  jobs: ITranscribeJob[],
): { total: number; queued: number; running: number; done: number; failed: number } => {
  let queued = 0
  let running = 0
  let done = 0
  let failed = 0
  for (const job of jobs) {
    if (job.status === 'queued') {
      queued += 1
    } else if (job.status === 'running') {
      running += 1
    } else if (job.status === 'done') {
      done += 1
    } else if (job.status === 'error' || job.status === 'canceled') {
      failed += 1
    }
  }
  return { total: jobs.length, queued, running, done, failed }
}

/**
 * 当前播放位置落在第几段（时间轴高亮用）
 * @param segments 段落列表
 * @param timeSeconds 播放位置（秒）
 * @returns 命中的索引，未命中返回 -1
 */
const activeSegmentIndex = (segments: ITranscriptSegment[], timeSeconds: number): number => {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === undefined) {
      continue
    }
    if (timeSeconds >= segment.start && timeSeconds < segment.end) {
      return index
    }
  }
  return -1
}

/**
 * 比例只允许单调不减、且不超过 1：模型偶尔回吐较小的比例会让进度条倒退
 */
const clampRatio = (next: number, previous: number): number => {
  if (!Number.isFinite(next)) {
    return previous
  }
  const bounded = Math.min(1, Math.max(0, next))
  return Math.max(previous, bounded)
}

export {
  activeSegmentIndex,
  applyDone,
  applyError,
  applyMeta,
  applyPhase,
  applyProgress,
  applySegment,
  clampRatio,
  createJob,
  enqueueJobs,
  jobFromHistory,
  markCanceled,
  markRunning,
  pickNextQueued,
  summarize,
  updateJob,
}
