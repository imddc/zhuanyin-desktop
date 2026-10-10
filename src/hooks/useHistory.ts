import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useState } from 'react'

import type { IHistoryEntry, IHistorySummary } from '../types'

interface IUseHistoryResult {
  entries: IHistorySummary[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** 取完整条目（含分段），用于恢复逐字稿与时间轴 */
  load: (id: number) => Promise<IHistoryEntry | null>
  remove: (id: number) => Promise<void>
  clear: () => Promise<void>
}

/**
 * 转写历史。
 *
 * 列表只取摘要（不含分段与全文），点开某条时才拉完整内容 ——
 * 这样即便积累了几百条历史，启动时也只做一次轻量查询。
 */
const useHistory = (): IUseHistoryResult => {
  const [entries, setEntries] = useState<IHistorySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<IHistorySummary[]>('list_history', { limit: 200 })
      setEntries(list)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- 历史来自 SQLite，渲染期拿不到
    void refresh()
  }, [refresh])

  const load = useCallback(async (id: number): Promise<IHistoryEntry | null> => {
    try {
      return await invoke<IHistoryEntry | null>('get_history_entry', { id })
    } catch {
      // 读不出来就当这条历史已失效，不打断界面
      return null
    }
  }, [])

  const remove = useCallback(
    async (id: number) => {
      await invoke('delete_history_entry', { id })
      await refresh()
    },
    [refresh],
  )

  const clear = useCallback(async () => {
    await invoke('clear_history')
    await refresh()
  }, [refresh])

  return { entries, loading, error, refresh, load, remove, clear }
}

export { useHistory }
