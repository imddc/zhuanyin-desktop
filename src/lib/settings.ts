/**
 * 本机设置的读写。
 *
 * 存在 localStorage 里：这是个纯本地应用，为几项设置引入状态管理或后端存储都不值当。
 * 读写都做容错 —— 隐私模式或存储被策略拦下时 localStorage 会直接抛异常，
 * 那种情况应当退回默认值，而不是让整个界面崩掉。
 */

/** 输出位置；值是不带结尾分隔符的绝对路径 */
const OUTPUT_ROOT_KEY = 'zhuanyin.outputRoot'
/** 选中的模型 id */
const MODEL_KEY = 'zhuanyin.modelId'
/** 语言代码，默认自动检测 */
const LANGUAGE_KEY = 'zhuanyin.language'
/** 初始提示词 */
const PROMPT_KEY = 'zhuanyin.prompt'

/** 默认自动检测语言 */
const DEFAULT_LANGUAGE = 'auto'

/** 取 localStorage；拿不到（环境没有或访问被拒）返回 null */
const safeStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** 读一个字符串设置；空串视为没设置 */
const readString = (key: string, storage: Storage | null): string | null => {
  if (storage === null) {
    return null
  }
  try {
    const value = (storage.getItem(key) ?? '').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

/** 写一个字符串设置；传空表示恢复默认（清掉这一项） */
const writeString = (key: string, value: string | null, storage: Storage | null): void => {
  if (storage === null) {
    return
  }
  try {
    const trimmed = (value ?? '').trim()
    if (trimmed === '') {
      storage.removeItem(key)
    } else {
      storage.setItem(key, trimmed)
    }
  } catch {
    // 存不下就只在本次会话生效，不打断用户
  }
}

/** 读输出位置；没设置过、内容为空或存储不可用时一律返回 null（= 与音频同目录） */
const loadOutputRoot = (storage: Storage | null = safeStorage()): string | null => readString(OUTPUT_ROOT_KEY, storage)

/** 写输出位置；传 null 表示恢复默认（清掉这一项） */
const saveOutputRoot = (root: string | null, storage: Storage | null = safeStorage()): void =>
  writeString(OUTPUT_ROOT_KEY, root, storage)

/** 读取上次选中的模型 id；没选过返回 null，由调用方回退到推荐模型 */
const loadSelectedModelId = (storage: Storage | null = safeStorage()): string | null => readString(MODEL_KEY, storage)

const saveSelectedModelId = (id: string | null, storage: Storage | null = safeStorage()): void =>
  writeString(MODEL_KEY, id, storage)

/** 读取语言设置；没设置过返回 auto（自动检测） */
const loadLanguage = (storage: Storage | null = safeStorage()): string =>
  readString(LANGUAGE_KEY, storage) ?? DEFAULT_LANGUAGE

const saveLanguage = (language: string, storage: Storage | null = safeStorage()): void =>
  writeString(LANGUAGE_KEY, language, storage)

/** 读取初始提示词；没设置过返回空串 */
const loadPrompt = (storage: Storage | null = safeStorage()): string => readString(PROMPT_KEY, storage) ?? ''

const savePrompt = (prompt: string, storage: Storage | null = safeStorage()): void =>
  writeString(PROMPT_KEY, prompt, storage)

export {
  DEFAULT_LANGUAGE,
  LANGUAGE_KEY,
  loadLanguage,
  loadOutputRoot,
  loadPrompt,
  loadSelectedModelId,
  MODEL_KEY,
  OUTPUT_ROOT_KEY,
  PROMPT_KEY,
  safeStorage,
  saveLanguage,
  saveOutputRoot,
  savePrompt,
  saveSelectedModelId,
}
