/**
 * 全部共享类型定义。
 * 与 Rust 侧一一对应（Rust 用 camelCase 序列化）。
 */

/** 引擎缺失项：code 供判断与去重，message 给用户看 */
interface IEngineIssue {
  code: string
  message: string
}

/** 引擎状态：这一版「能不能跑」等价于「有没有可用的模型」 */
interface IEngineStatus {
  ready: boolean
  /** 模型目录，界面上可以一键打开 */
  modelsDir: string
  /** 已下载的模型数量 */
  availableModels: number
  /** 当前常驻内存的模型 */
  loadedModelId: string | null
  issues: IEngineIssue[]
}

/** 模型清单条目（来自编译进应用的 catalog） */
interface IModelSpec {
  id: string
  name: string
  description: string
  filename: string
  sizeBytes: number
  sha256: string
  multilingual: boolean
  recommended: boolean
  /** 1 到 5，仅用于界面展示 */
  speedScore: number
  accuracyScore: number
}

/** 模型 + 本机状态 */
interface IModelStatus extends IModelSpec {
  downloaded: boolean
  downloading: boolean
  downloadedBytes: number
  path: string | null
}

/** 事件：model://download */
interface IModelDownloadProgress {
  id: string
  downloadedBytes: number
  totalBytes: number
  ratio: number
  source: string
}

/** 任务状态机：排队中 → 转写中 → 完成 / 失败 / 已取消 */
type TJobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

/** 一段识别结果，start / end 单位为秒 */
interface ITranscriptSegment {
  start: number
  end: number
  text: string
}

/** 一个转写任务的完整状态 */
/** 推理开始前的阶段，与 Rust 侧 TranscribePhase 一一对应 */
type TJobPhase = 'loadingModel' | 'decodingAudio'

interface ITranscribeJob {
  id: string
  name: string
  sourcePath: string
  status: TJobStatus
  /** 0 到 1；时长为 0 时保持 0，表示不确定进度 */
  ratio: number
  /**
   * 推理开始前的准备阶段（加载模型 / 解码音频）。
   *
   * 这两个阶段不产生进度，但可能持续几秒；界面靠它说清「现在在干什么」，
   * 而不是让进度条停在 0% 一动不动。进入推理后置回 null。
   */
  phase: TJobPhase | null
  durationSeconds: number
  segments: ITranscriptSegment[]
  /** 全文；完成时由后端给出，历史恢复时也用得上 */
  text: string
  files: Record<string, string>
  errorMessage: string | null
  startedAt: number | null
  finishedAt: number | null
  modelId: string | null
  modelName: string | null
  language: string | null
  /** 源采样率与声道数，用于展示「源 44.1 kHz 立体声」 */
  sourceRate: number
  sourceChannels: number
  /** 落库后的历史 id，便于「在历史里找到它」 */
  historyId: number | null
}

/** 转写请求参数（传给 Rust 的 start_transcribe） */
interface ITranscribeRequest {
  input: string
  jobId: string
  outDir?: string
  name?: string
  modelId?: string
  /** 'auto' 或语言代码；不传等于自动检测 */
  language?: string
  /** 初始提示词；留空不传 */
  prompt?: string
}

/** 事件载荷：asr://meta */
interface IJobMetaPayload {
  jobId: string
  name: string
  source: string
  duration: number
  modelId: string
  modelName: string
  language: string
  sourceRate: number
  sourceChannels: number
}

/** 事件载荷：asr://segment */
interface IJobSegmentPayload {
  jobId: string
  start: number
  end: number
  text: string
  ratio: number
}

/** 事件载荷：asr://progress（比分段更细，长录音中途也在动） */
interface IJobProgressPayload {
  jobId: string
  ratio: number
}

/** asr://phase 的载荷：推理开始前的准备阶段 */
interface IJobPhasePayload {
  jobId: string
  phase: TJobPhase
}

/** 事件载荷：asr://done */
interface IJobDonePayload {
  jobId: string
  name: string
  duration: number
  language: string
  segments: number
  files: Record<string, string>
  text: string
  historyId: number | null
}

/** 事件载荷：asr://error */
interface IJobErrorPayload {
  jobId: string
  message: string
}

/** 历史列表项：不含分段与全文 */
interface IHistorySummary {
  id: number
  name: string
  sourcePath: string
  outputDir: string
  modelId: string
  language: string
  durationSeconds: number
  segmentCount: number
  createdAt: number
}

/** 完整历史条目：选中历史任务时用它的分段恢复逐字稿与时间轴 */
interface IHistoryEntry extends IHistorySummary {
  text: string
  segments: ITranscriptSegment[]
  files: Record<string, string>
}

export type {
  IEngineIssue,
  IEngineStatus,
  IHistoryEntry,
  IHistorySummary,
  IJobDonePayload,
  IJobErrorPayload,
  IJobMetaPayload,
  IJobPhasePayload,
  IJobProgressPayload,
  IJobSegmentPayload,
  IModelDownloadProgress,
  IModelSpec,
  IModelStatus,
  ITranscribeJob,
  TJobPhase,
  ITranscribeRequest,
  ITranscriptSegment,
  TJobStatus,
}
