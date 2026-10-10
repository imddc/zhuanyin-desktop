import { open } from '@tauri-apps/plugin-dialog'

import { AUDIO_EXTENSIONS } from '../lib/format'

interface IDropZoneProps {
  disabled: boolean
  /** 是否正有文件悬停在窗口上：拖拽事件由 App 订阅 Tauri 的原生事件后传进来 */
  active: boolean
  onPaths: (paths: string[]) => void
  /** 还没装模型时点「去下载模型」的去处（切到模型页） */
  onFix: () => void
}

/**
 * 拖拽区与原生文件选择入口。
 *
 * 注意：窗口开了 Tauri 的 `dragDropEnabled`，webview 里的 HTML5 拖拽事件不会触发，
 * 所以这里不挂 onDrop —— 悬停高亮与投放路径都来自 App 订阅的 Tauri 拖拽事件。
 */
const DropZone = (props: IDropZoneProps) => {
  const pickFiles = async (): Promise<void> => {
    const picked = await open({
      multiple: true,
      title: '选择音频文件',
      filters: [{ name: '音频', extensions: [...AUDIO_EXTENSIONS] }],
    })
    if (picked === null) {
      return
    }
    props.onPaths(Array.isArray(picked) ? picked : [picked])
  }

  return (
    <section
      className={props.active ? 'dropzone dropzone--active' : 'dropzone'}
      aria-label="拖拽音频到这里"
      data-active={props.active ? 'true' : 'false'}
    >
      <div className="dropzone__inner">
        <svg className="dropzone__icon" viewBox="0 0 48 48" aria-hidden="true">
          <path
            d="M24 32V10m0 0l-7 7m7-7l7 7M10 30v6a2 2 0 002 2h24a2 2 0 002-2v-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <h2 className="dropzone__title">把录音拖进来</h2>
        <p className="dropzone__hint">支持 {AUDIO_EXTENSIONS.slice(0, 8).join(' / ')} 等格式，可一次拖入多个文件排队</p>
        <button
          type="button"
          className="button button--primary"
          onClick={() => void pickFiles()}
          disabled={props.disabled}
        >
          选择音频文件
        </button>
        {props.disabled ? (
          <div className="dropzone__blocked">
            {/* 这里以前写的是「先按上方提示修复」，但顶部状态条早就删了 ——
                没有模型时必须给一条真的走得通的路，而不是指一个不存在的地方 */}
            <p className="dropzone__warn" role="status">
              还没有可用的识别模型，转写暂时用不了
            </p>
            <button type="button" className="button" onClick={props.onFix}>
              去「模型」页下载
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

export { DropZone }
