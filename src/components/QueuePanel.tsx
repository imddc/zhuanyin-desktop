import { invoke } from '@tauri-apps/api/core'

import { formatClock, formatDuration, baseName } from '../lib/format'
import type { ITranscribeJob, TJobPhase, TJobStatus } from '../types'

interface IQueuePanelProps {
  jobs: ITranscribeJob[]
  selectedId: string | null
  onSelect: (jobId: string) => void
  onCancel: (jobId: string) => void
  onClearFinished: () => void
}

const STATUS_LABEL: Record<TJobStatus, string> = {
  queued: '排队中',
  running: '转写中',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
}

/** 准备阶段的人话说法；与 Rust 侧 TranscribePhase 一一对应 */
const PHASE_LABEL: Record<TJobPhase, string> = {
  loadingModel: '加载模型',
  decodingAudio: '解码音频',
}
const statusClassOf = (status: TJobStatus): string => `badge badge--${status}`

/** 队列面板：一个任务一行，串行推进，行内可直接取消或打开产物目录 */
const QueuePanel = (props: IQueuePanelProps) => {
  const { jobs } = props

  return (
    <section className="panel">
      <header className="panel__head">
        <h2 className="panel__title">队列</h2>
        <div className="panel__actions">
          <span className="panel__meta">{jobs.length} 个任务</span>
          <button type="button" className="button button--ghost" onClick={props.onClearFinished}>
            清掉已结束
          </button>
        </div>
      </header>

      {jobs.length === 0 ? (
        <p className="panel__empty">还没有任务。把录音拖到左侧区域，或点「选择音频文件」。</p>
      ) : (
        <ul className="queue">
          {jobs.map((job) => {
            const isSelected = job.id === props.selectedId
            // 准备阶段（加载模型 / 解码音频）没有真实进度可报。
            // 以前这里显示「0 段 · 0%」、进度条停在原地，看起来就像卡住了；
            // 现在明确说出在干什么，并且进度条改成「不确定」的来回扫描。
            const preparing = job.status === 'running' && job.phase !== null
            return (
              <li key={job.id}>
                <div className={isSelected ? 'queue__row queue__row--selected' : 'queue__row'}>
                  <button
                    type="button"
                    className="queue__main"
                    onClick={() => props.onSelect(job.id)}
                    aria-current={isSelected ? 'true' : undefined}
                  >
                    <span className="queue__name" title={job.sourcePath}>
                      {job.name || baseName(job.sourcePath)}
                    </span>
                    <span className="queue__sub">
                      <span className={statusClassOf(job.status)}>{STATUS_LABEL[job.status]}</span>
                      <span>{formatDuration(job.durationSeconds)}</span>
                      <span>
                        {preparing
                          ? `${PHASE_LABEL[job.phase as TJobPhase]}…`
                          : `${job.segments.length} 段${job.status === 'running' ? ` · ${Math.round(job.ratio * 100)}%` : ''}`}
                      </span>
                    </span>
                    <span className={preparing ? 'progress progress--indeterminate' : 'progress'} aria-hidden="true">
                      <span
                        className={job.status === 'error' ? 'progress__fill progress__fill--error' : 'progress__fill'}
                        // 不确定进度时不写 width，交给 CSS 的扫描动画
                        style={
                          preparing
                            ? undefined
                            : { width: `${Math.round((job.status === 'done' ? 1 : job.ratio) * 100)}%` }
                        }
                      />
                    </span>
                  </button>

                  <div className="queue__side">
                    {job.status === 'running' || job.status === 'queued' ? (
                      <button type="button" className="button button--ghost" onClick={() => props.onCancel(job.id)}>
                        取消
                      </button>
                    ) : null}
                    {job.files.txt !== undefined ? (
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => void invoke('reveal_in_file_manager', { path: job.files.txt })}
                      >
                        打开目录
                      </button>
                    ) : null}
                  </div>
                </div>

                {job.errorMessage !== null ? <p className="queue__error">{job.errorMessage}</p> : null}
                {job.status === 'running' && job.segments.length > 0 ? (
                  <p className="queue__live">
                    <span className="queue__live-time">
                      {formatClock(job.segments[job.segments.length - 1]?.start ?? 0)}
                    </span>
                    {job.segments[job.segments.length - 1]?.text}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export { QueuePanel, STATUS_LABEL }
