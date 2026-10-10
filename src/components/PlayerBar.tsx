import type { CSSProperties } from 'react'

import { formatClock } from '../lib/format'

interface IPlayerBarProps {
  fileName: string
  sourceUrl: string | null
  playing: boolean
  currentTime: number
  duration: number
  playbackRate: number
  onToggle: () => void
  onSeek: (seconds: number) => void
  onRateChange: (rate: number) => void
}

const PLAYBACK_RATES = [1, 1.25, 1.5, 2]

/**
 * 播放条：复盘录音时最常用的一条控制带。
 * 支持倍速 —— 一小时面试按 2 倍速听，时间成本直接减半。
 */
const PlayerBar = (props: IPlayerBarProps) => {
  const duration = props.duration > 0 ? props.duration : 0
  const ratio = duration > 0 ? Math.min(1, props.currentTime / duration) : 0
  const disabled = props.sourceUrl === null

  return (
    <section className="player" aria-label="音频播放">
      <button
        type="button"
        className="player__toggle"
        onClick={props.onToggle}
        disabled={disabled}
        aria-label={props.playing ? '暂停' : '播放'}
      >
        {props.playing ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
            <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5l11 7-11 7z" fill="currentColor" />
          </svg>
        )}
      </button>

      <span className="player__time">{formatClock(props.currentTime)}</span>

      <input
        className="player__seek"
        type="range"
        min={0}
        max={duration > 0 ? duration : 1}
        step={0.1}
        value={props.currentTime}
        onChange={(event) => props.onSeek(Number(event.target.value))}
        disabled={disabled || duration <= 0}
        aria-label="播放进度"
        style={{ '--seek-ratio': `${Math.round(ratio * 100)}%` } as CSSProperties}
      />

      <span className="player__time player__time--muted">{formatClock(duration)}</span>

      <div className="player__rates" role="group" aria-label="播放速度">
        {PLAYBACK_RATES.map((rate) => (
          <button
            key={rate}
            type="button"
            className={rate === props.playbackRate ? 'chip chip--active' : 'chip'}
            onClick={() => props.onRateChange(rate)}
            disabled={disabled}
          >
            {rate}×
          </button>
        ))}
      </div>

      <span className="player__name" title={props.fileName}>
        {props.fileName}
      </span>
    </section>
  )
}

export { PLAYBACK_RATES, PlayerBar }
