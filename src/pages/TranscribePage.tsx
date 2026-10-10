import { DropZone } from '../components/DropZone'
import { PlayerBar } from '../components/PlayerBar'
import { QueuePanel } from '../components/QueuePanel'
import { TranscriptPanel } from '../components/TranscriptPanel'
import { baseName } from '../lib/format'
import type { ITranscribeJob, ITranscriptSegment } from '../types'

interface ITranscribePageProps {
  engineReady: boolean
  dragActive: boolean
  onPaths: (paths: string[]) => void
  /** 没有模型时从拖拽区跳到模型页 */
  onOpenModels: () => void
  jobs: ITranscribeJob[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCancel: (id: string) => void
  onClearFinished: () => void
  selectedJob: ITranscribeJob | null
  segments: ITranscriptSegment[]
  activeIndex: number
  onSeek: (seconds: number) => void
  onCopyAll: () => void
  onReveal: (path: string) => void
  sourceUrl: string | null
  playing: boolean
  currentTime: number
  duration: number
  playbackRate: number
  onToggle: () => void
  onRateChange: (rate: number) => void
}

/**
 * 转写页：左侧拖拽入口与队列，右侧逐字稿与播放条。
 *
 * 播放状态由 App 持有（时间轴高亮与音频播放必须共享同一个时钟），
 * 这里只负责摆放与转调。
 */
const TranscribePage = (props: ITranscribePageProps) => (
  <div className="page page--split">
    <div className="column column--left">
      <DropZone
        disabled={!props.engineReady}
        active={props.dragActive}
        onPaths={props.onPaths}
        onFix={props.onOpenModels}
      />
      <QueuePanel
        jobs={props.jobs}
        selectedId={props.selectedId}
        onSelect={props.onSelect}
        onCancel={props.onCancel}
        onClearFinished={props.onClearFinished}
      />
    </div>

    <div className="column column--right">
      <TranscriptPanel
        title={
          props.selectedJob !== null
            ? `逐字稿 · ${props.selectedJob.name || baseName(props.selectedJob.sourcePath)}`
            : '逐字稿'
        }
        segments={props.segments}
        activeIndex={props.activeIndex}
        onSeek={props.onSeek}
        onCopyAll={props.onCopyAll}
        onReveal={
          props.selectedJob?.files.txt !== undefined ? () => props.onReveal(props.selectedJob?.files.txt ?? '') : null
        }
      />
      <PlayerBar
        fileName={props.selectedJob !== null ? baseName(props.selectedJob.sourcePath) : '未选择任务'}
        sourceUrl={props.sourceUrl}
        playing={props.playing}
        currentTime={props.currentTime}
        duration={props.duration}
        playbackRate={props.playbackRate}
        onToggle={props.onToggle}
        onSeek={props.onSeek}
        onRateChange={props.onRateChange}
      />
    </div>
  </div>
)

export { TranscribePage }
