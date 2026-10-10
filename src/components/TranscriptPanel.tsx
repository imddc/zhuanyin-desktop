import { useEffect, useRef } from 'react'

import { formatClock } from '../lib/format'
import type { ITranscriptSegment } from '../types'

interface ITranscriptPanelProps {
  segments: ITranscriptSegment[]
  activeIndex: number
  /** 点击某一段时把播放位置跳到该段起点（秒） */
  onSeek: (seconds: number) => void
  onCopyAll: () => void
  onReveal: (() => void) | null
  title: string
}

/**
 * 逐字稿面板：段落与时间轴一一对应，点一段就跳播放位置。
 * 当前播放到的段会自动滚进视野 —— 复盘长录音时不用手找。
 */
const TranscriptPanel = (props: ITranscriptPanelProps) => {
  const activeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- activeIndex 只作为「变化时滚动」的触发条件，不在体内读取
  }, [props.activeIndex])

  return (
    <section className="panel panel--grow">
      <header className="panel__head">
        <h2 className="panel__title">{props.title}</h2>
        <div className="panel__actions">
          <span className="panel__meta">{props.segments.length} 段</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={props.onCopyAll}
            disabled={props.segments.length === 0}
          >
            复制全文
          </button>
          {props.onReveal !== null ? (
            <button type="button" className="button button--ghost" onClick={props.onReveal}>
              打开产物目录
            </button>
          ) : null}
        </div>
      </header>

      {props.segments.length === 0 ? (
        <p className="panel__empty">选中一个任务后，识别出的段落会实时出现在这里。</p>
      ) : (
        <ol className="transcript">
          {props.segments.map((segment, index) => {
            const isActive = index === props.activeIndex
            return (
              <li key={`${segment.start}-${index}`}>
                <button
                  type="button"
                  ref={isActive ? activeRef : null}
                  className={isActive ? 'transcript__row transcript__row--active' : 'transcript__row'}
                  onClick={() => props.onSeek(segment.start)}
                  aria-current={isActive ? 'true' : undefined}
                >
                  <span className="transcript__time">{formatClock(segment.start)}</span>
                  <span className="transcript__text">{segment.text}</span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

export { TranscriptPanel }
