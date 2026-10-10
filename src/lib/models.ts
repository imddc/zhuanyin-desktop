import type { IModelStatus } from '../types'

/**
 * 挑出实际生效的模型 id。
 *
 * 用户选的那个若已被删除，就回退到「已下载的推荐模型」，再退到第一个已下载的；
 * 一个都没有则返回 null（调用方据此判断「还没有可用的模型」）。
 *
 * 主窗口与引导窗口都要做同样的判断，抽出来避免两边逻辑漂移。
 * @param models 模型清单（含本机状态）
 * @param preferred 用户上次选中的 id
 * @returns 实际生效的 id，或 null
 */
const pickModelId = (models: IModelStatus[], preferred: string | null): string | null => {
  const downloaded = models.filter((model) => model.downloaded)
  if (preferred !== null && downloaded.some((model) => model.id === preferred)) {
    return preferred
  }
  return downloaded.find((model) => model.recommended)?.id ?? downloaded[0]?.id ?? null
}

export { pickModelId }
