import { formatBytes } from '../lib/format'
import type { IModelStatus } from '../types'

interface IModelListProps {
  models: IModelStatus[]
  selectedId: string | null
  /** 正在校验 sha256 的模型 id */
  verifying: string[]
  onSelect: (id: string) => void
  onDownload: (id: string) => void
  onCancelDownload: (id: string) => void
  /** 不传则不显示删除按钮（引导流程里删模型没有意义） */
  onDelete?: (id: string) => void
}

/** 分数（1 到 5）画成实心方块，比数字更容易一眼比较。 */
const scoreBar = (score: number): string => '■'.repeat(score) + '□'.repeat(Math.max(0, 5 - score))

/**
 * 模型列表。
 *
 * 抽出来是因为它有两个使用场景：模型页（可删除、可切换）与首次使用的引导页
 * （只能下载，且列表就是这一步的进度）。两处共享同一套渲染逻辑，
 * 分类标签、评分条、下载进度的表现才不会有分歧。
 */
const ModelList = (props: IModelListProps) => (
  <ul className="models">
    {props.models.map((model) => {
      const isSelected = model.id === props.selectedId
      const ratio = model.sizeBytes > 0 ? Math.min(1, model.downloadedBytes / model.sizeBytes) : 0
      const isVerifying = props.verifying.includes(model.id)

      return (
        <li key={model.id}>
          <div className={isSelected ? 'model model--selected' : 'model'}>
            <button
              type="button"
              className="model__main"
              onClick={() => props.onSelect(model.id)}
              // 没下载完的模型选了也用不了，直接禁掉比让用户白点一次好
              disabled={!model.downloaded}
              aria-current={isSelected ? 'true' : undefined}
            >
              <span className="model__name">
                {model.name}
                {model.recommended ? <em className="model__tag">推荐</em> : null}
                {isSelected ? <em className="model__tag model__tag--current">使用中</em> : null}
              </span>
              <span className="model__desc">{model.description}</span>
              <span className="model__meta">
                <span>{formatBytes(model.sizeBytes)}</span>
                <span className="model__score">速度 {scoreBar(model.speedScore)}</span>
                <span className="model__score">精度 {scoreBar(model.accuracyScore)}</span>
              </span>
              {/*
                进度条要放在卡片里、跟着正文的留白走。
                原先它是 .model 的兄弟节点，渲染到卡片外的行间空隙里，看着像渲染坏了；
                而 .progress 是个 span（inline），height 根本不生效。
                队列面板里的进度条本来就在卡片内，这里统一成同样的位置。
              */}
              {model.downloading ? (
                <span className="progress" aria-hidden="true">
                  <span className="progress__fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
                </span>
              ) : null}
            </button>

            <div className="model__side">
              {model.downloading ? (
                <>
                  <span className="model__progress-text">{isVerifying ? '校验中' : `${Math.round(ratio * 100)}%`}</span>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => props.onCancelDownload(model.id)}
                  >
                    取消
                  </button>
                </>
              ) : model.downloaded ? (
                props.onDelete !== undefined ? (
                  <button type="button" className="button button--ghost" onClick={() => props.onDelete?.(model.id)}>
                    删除
                  </button>
                ) : (
                  <span className="model__tag model__tag--current">已下载</span>
                )
              ) : (
                <button
                  type="button"
                  className="button button--primary button--small"
                  onClick={() => props.onDownload(model.id)}
                >
                  下载
                </button>
              )}
            </div>
          </div>
        </li>
      )
    })}
  </ul>
)

export { ModelList }
