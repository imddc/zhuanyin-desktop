import { formatDateTime, formatDuration } from '../lib/format'
import type { IHistorySummary } from '../types'

interface IHistoryPanelProps {
  entries: IHistorySummary[]
  loading: boolean
  error: string | null
  activeId: number | null
  onOpen: (id: number) => void
  onDelete: (id: number) => void
  onClear: () => void
  onRefresh: () => void
  onReveal: (path: string) => void
}

/**
 * 历史面板。
 *
 * 存在的理由：转写一小时录音要几分钟，如果关掉应用就什么都不剩，
 * 「点段落跳播放 + 高亮跟随」就只能在当次会话里用。点一条历史会把它
 * 还原成完成态任务挂进队列，逐字稿与时间轴联动照常可用。
 */
const HistoryPanel = (props: IHistoryPanelProps) => {
  const { entries } = props

  return (
    <section className="panel">
      <header className="panel__head">
        <h2 className="panel__title">历史</h2>
        <div className="panel__actions">
          <span className="panel__meta">{entries.length} 条</span>
          <button type="button" className="button button--ghost" onClick={props.onRefresh}>
            刷新
          </button>
          {entries.length > 0 ? (
            <button type="button" className="button button--ghost" onClick={props.onClear}>
              清空
            </button>
          ) : null}
        </div>
      </header>

      {props.error !== null ? (
        <p className="panel__error" role="alert">
          读取历史失败：{props.error}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="panel__empty">
          {props.loading ? '正在读取历史…' : '还没有历史。转写完成后会自动记在这里，关掉应用也还在。'}
        </p>
      ) : (
        <ul className="history">
          {entries.map((entry) => {
            const isActive = entry.id === props.activeId
            return (
              <li key={entry.id}>
                <div className={isActive ? 'history__row history__row--active' : 'history__row'}>
                  <button
                    type="button"
                    className="history__main"
                    onClick={() => props.onOpen(entry.id)}
                    aria-current={isActive ? 'true' : undefined}
                  >
                    <span className="history__name" title={entry.sourcePath}>
                      {entry.name}
                    </span>
                    <span className="history__sub">
                      <span>{formatDateTime(entry.createdAt)}</span>
                      <span>{formatDuration(entry.durationSeconds)}</span>
                      <span>{entry.segmentCount} 段</span>
                      <span>{entry.language}</span>
                    </span>
                  </button>
                  <div className="history__side">
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => props.onReveal(entry.outputDir)}
                    >
                      产物目录
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => props.onDelete(entry.id)}
                      aria-label={`删除历史 ${entry.name}`}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export { HistoryPanel }
