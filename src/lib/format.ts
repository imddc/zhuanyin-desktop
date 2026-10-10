/**
 * 纯格式化与路径工具。全部是纯函数，便于单测，也便于在组件里复用。
 */

/** 两位补零（不依赖外层变量，放模块作用域即可，不必每次调用重建） */
const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * 秒 → `mm:ss` 或 `h:mm:ss`（时间轴与片段标签用）
 * @param seconds 秒数，负数与 NaN 一律按 0 处理
 * @returns 形如 `07:30` 或 `1:02:03` 的字符串
 */
const formatClock = (seconds: number): string => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const total = Math.floor(safe)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
}

/**
 * 秒 → 中文可读时长（任务摘要用）
 * @param seconds 秒数
 * @returns 形如 `1 小时 2 分` / `3 分 5 秒` / `42 秒`
 */
const formatDuration = (seconds: number): string => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0
  if (safe < 60) {
    return `${safe} 秒`
  }
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const rest = safe % 60
  if (hours > 0) {
    return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  }
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
}

/**
 * 取路径最后一段（macOS / Linux / Windows 分隔符都兼容）
 * @param path 绝对路径
 * @returns 文件名，取不到时返回原串
 */
const baseName = (path: string): string => {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

/**
 * 去掉扩展名
 * @param fileName 文件名
 * @returns 不含扩展名的文件名
 */
const stripExtension = (fileName: string): string => {
  const index = fileName.lastIndexOf('.')
  return index > 0 ? fileName.slice(0, index) : fileName
}

/**
 * 从音频路径推导默认输出名
 * @param path 音频绝对路径
 * @returns 去掉扩展名的文件名
 */
const transcriptNameOf = (path: string): string => stripExtension(baseName(path))

/**
 * 扩展名 → 是否是我们认识的音频
 * @param path 文件路径
 * @returns 命中已知音频扩展名时返回 true
 */
const AUDIO_EXTENSIONS = ['m4a', 'mp3', 'wav', 'aac', 'aiff', 'aif', 'flac', 'ogg', 'opus', 'wma', 'mp4', 'mov', 'mkv']

const isAudioFile = (path: string): boolean => {
  const name = baseName(path).toLowerCase()
  const index = name.lastIndexOf('.')
  if (index < 0) {
    return false
  }
  return AUDIO_EXTENSIONS.includes(name.slice(index + 1))
}

/**
 * 生成任务号：本地生成再交给 Rust，避免事件先于 invoke 返回
 * @param seed 递增序号
 * @returns 形如 `job-1712345678901-3` 的标识
 */
const createJobId = (seed: number): string => `job-${Date.now()}-${seed}`

/**
 * 字节数 → 可读体积（模型大小与下载进度都用它）
 * @param bytes 字节数
 * @returns 形如 `574 MB` / `1.58 GB`
 */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 MB'
  }
  const megabytes = bytes / (1024 * 1024)
  if (megabytes < 1024) {
    // 小于 10 MB 时保留一位小数，否则「0 MB」会让人以为没下动
    return megabytes < 10 ? `${megabytes.toFixed(1)} MB` : `${Math.round(megabytes)} MB`
  }
  return `${(megabytes / 1024).toFixed(2)} GB`
}

/**
 * Unix 毫秒 → 本地日期时间
 * @param millis Unix 毫秒
 * @returns 形如 `2026-10-10 05:12`
 */
const formatDateTime = (millis: number): string => {
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) {
    return '未知时间'
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export {
  AUDIO_EXTENSIONS,
  baseName,
  createJobId,
  formatBytes,
  formatClock,
  formatDateTime,
  formatDuration,
  isAudioFile,
  stripExtension,
  transcriptNameOf,
}
