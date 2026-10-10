import { ModelList } from './ModelList'
import type { IModelStatus } from '../types'

interface IModelPanelProps {
  models: IModelStatus[]
  loading: boolean
  error: string | null
  /** 正在校验 sha256 的模型 id */
  verifying: string[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDownload: (id: string) => void
  onCancelDownload: (id: string) => void
  onDelete: (id: string) => void
  onImport: () => void
  onRefresh: () => void
  onReveal: (path: string) => void
  modelsDir: string
}

/**
 * 模型页：清单、下载、切换与删除。
 *
 * 应用自带引擎与解码，所以用户唯一的准备工作就是在这里选一个模型下载。
 * 清单编译在应用里，离线也能看到有哪些可选。
 */
const ModelPanel = (props: IModelPanelProps) => {
  const downloaded = props.models.filter((model) => model.downloaded).length

  return (
    <section className="panel panel--page">
      <header className="panel__head">
        <h2 className="panel__title">模型</h2>
        <div className="panel__actions">
          <span className="panel__meta">
            已下载 {downloaded} / {props.models.length}
          </span>
          <button type="button" className="button button--ghost" onClick={props.onImport}>
            导入已有模型
          </button>
          <button type="button" className="button button--ghost" onClick={() => props.onReveal(props.modelsDir)}>
            模型目录
          </button>
          <button type="button" className="button button--ghost" onClick={props.onRefresh}>
            刷新
          </button>
        </div>
      </header>

      <p className="panel__hint">
        模型来自 whisper.cpp 官方权重，下载后逐字节校验 sha256；支持断点续传，默认走国内镜像。
      </p>

      {props.error !== null ? (
        <p className="panel__error" role="alert">
          读取模型清单失败：{props.error}
        </p>
      ) : null}

      {props.loading && props.models.length === 0 ? (
        <p className="panel__empty">正在读取模型清单…</p>
      ) : (
        <ModelList
          models={props.models}
          selectedId={props.selectedId}
          verifying={props.verifying}
          onSelect={props.onSelect}
          onDownload={props.onDownload}
          onCancelDownload={props.onCancelDownload}
          onDelete={props.onDelete}
        />
      )}
    </section>
  )
}

export { ModelPanel }
