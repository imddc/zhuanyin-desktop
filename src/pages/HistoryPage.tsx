import { HistoryPanel } from '../components/HistoryPanel'
import type { IHistorySummary } from '../types'

interface IHistoryPageProps {
  entries: IHistorySummary[]
  loading: boolean
  error: string | null
  /** 当前正在查看的那条历史（用于高亮） */
  activeId: number | null
  onOpen: (id: number) => void
  onDelete: (id: number) => void
  onClear: () => void
  onRefresh: () => void
  onReveal: (path: string) => void
}

/** 历史页：转写过的任务都留在这里，关掉应用也不会丢。 */
const HistoryPage = (props: IHistoryPageProps) => (
  <div className="page">
    <HistoryPanel {...props} />
  </div>
)

export { HistoryPage }
