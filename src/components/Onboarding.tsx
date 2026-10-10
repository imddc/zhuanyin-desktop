import iconUrl from '../../assets/icon.svg'

import { ModelList } from './ModelList'
import { formatBytes } from '../lib/format'
import type { IModelStatus } from '../types'

/** 引导流程只有三步，顺序固定。 */
type TOnboardingStep = 'welcome' | 'model' | 'done'

const STEPS: Array<{ id: TOnboardingStep; label: string }> = [
  { id: 'welcome', label: '欢迎' },
  { id: 'model', label: '选择模型' },
  { id: 'done', label: '完成' },
]

interface IOnboardingProps {
  step: TOnboardingStep
  onStepChange: (step: TOnboardingStep) => void
  models: IModelStatus[]
  verifying: string[]
  selectedId: string | null
  loading: boolean
  error: string | null
  modelsDir: string
  onSelect: (id: string) => void
  onDownload: (id: string) => void
  onCancelDownload: (id: string) => void
  onImport: () => void
  onReveal: (path: string) => void
  /** 用户点「开始使用」，退出引导 */
  onFinish: () => void
  /** 关闭这个窗口（无边框，没有系统红绿灯可用） */
  onClose: () => void
}

/**
 * 首次使用的引导页。
 *
 * 为什么要有：应用自带引擎与解码，用户唯一要做的准备是「下载一个模型」——
 * 这件事必须在打开应用的第一眼就说清楚，而不是丢一个空界面加一句状态提示。
 *
 * 进度按两种粒度同时表达：顶部三段式步骤条说明「走到第几步」，
 * 当前步骤内部再给出该步自己的进度（第 2 步就是模型下载进度）。
 */
const Onboarding = (props: IOnboardingProps) => {
  const currentIndex = STEPS.findIndex((item) => item.id === props.step)
  const downloaded = props.models.filter((model) => model.downloaded)
  const recommended = props.models.find((model) => model.recommended) ?? props.models[0] ?? null
  const downloading = props.models.some((model) => model.downloading)

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        {/* 无边框窗口没有系统标题栏，拖动与关闭都在这里自绘。
            必须是 "deep"：裸写属性时 Tauri 只认「点到这个元素本身」，
            而标题文字是子元素，点到它就拖不动了（关闭按钮是 BUTTON，本来就排除在外）。 */}
        <div className="onboarding__bar" data-tauri-drag-region="deep">
          <span className="onboarding__bar-title">转音 · 初次设置</span>
          <button type="button" className="onboarding__close" aria-label="关闭" onClick={props.onClose}>
            <svg viewBox="0 0 12 12" width="13" height="13" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="onboarding__brand">
          <img className="onboarding__logo" src={iconUrl} alt="转音" width={72} height={72} />
          <div>
            <h1 className="onboarding__title">转音</h1>
            <p className="onboarding__tagline">把录音拖进来，就得到带时间轴的中文逐字稿</p>
          </div>
        </div>

        {/* 步骤条：一条进度 + 三个节点，当前步骤高亮 */}
        <ol className="stepper" aria-label="设置进度">
          {STEPS.map((item, index) => {
            const state =
              index < currentIndex ? 'stepper__step--done' : index === currentIndex ? 'stepper__step--active' : ''
            return (
              <li key={item.id} className={`stepper__step ${state}`.trim()}>
                <span className="stepper__dot" aria-hidden="true">
                  {index < currentIndex ? '✓' : index + 1}
                </span>
                <span className="stepper__label">{item.label}</span>
              </li>
            )
          })}
        </ol>

        <div className="onboarding__body">
          {props.step === 'welcome' ? (
            <div className="onboarding__panel">
              <h2 className="onboarding__heading">欢迎使用转音</h2>
              <p className="onboarding__text">
                识别引擎与音频解码都已经内置在应用里 ——
                <strong>不需要安装 Python、ffmpeg 或任何命令行工具</strong>，音频也全程不出本机。
              </p>
              <ul className="onboarding__list">
                <li>你只需要准备一件事：下载一个识别模型</li>
                <li>
                  推荐档{' '}
                  {recommended !== null ? `${recommended.name}（${formatBytes(recommended.sizeBytes)}）` : '需要下载'}，
                  下载支持断点续传与 sha256 校验
                </li>
                <li>模型下载完成后即可开始转写，之后随时可以在「模型」页更换</li>
              </ul>
            </div>
          ) : null}

          {props.step === 'model' ? (
            <div className="onboarding__panel">
              <h2 className="onboarding__heading">选择并下载模型</h2>
              <p className="onboarding__text">
                {downloading
                  ? '正在下载，请保持网络连接。可以先去泡杯茶。'
                  : '点下面的「下载」开始。下完会自动进入下一步。'}
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
                />
              )}

              <div className="onboarding__actions">
                <button type="button" className="button button--ghost" onClick={props.onImport}>
                  我有模型文件，直接导入
                </button>
                <button type="button" className="button button--ghost" onClick={() => props.onReveal(props.modelsDir)}>
                  打开模型目录
                </button>
              </div>
            </div>
          ) : null}

          {props.step === 'done' ? (
            <div className="onboarding__panel">
              <h2 className="onboarding__heading">准备就绪</h2>
              <p className="onboarding__text">
                已就绪 {downloaded.length} 个模型
                {props.selectedId !== null
                  ? `，当前使用：${props.models.find((model) => model.id === props.selectedId)?.name ?? props.selectedId}`
                  : ''}
                。
              </p>
              <ul className="onboarding__list">
                <li>把音频文件拖进窗口，或点「选择音频文件」</li>
                <li>转写完成后，点逐字稿任意一段就能跳到那个时间点</li>
                <li>产物会收进与音频同名的文件夹（txt / srt / vtt / json）</li>
              </ul>
            </div>
          ) : null}
        </div>

        <div className="onboarding__footer">
          <span className="onboarding__step-text">
            第 {currentIndex + 1} / {STEPS.length} 步
          </span>
          <div className="onboarding__buttons">
            {currentIndex > 0 && props.step !== 'done' ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => props.onStepChange(STEPS[currentIndex - 1]?.id ?? 'welcome')}
              >
                上一步
              </button>
            ) : null}

            {props.step === 'welcome' ? (
              <button type="button" className="button button--primary" onClick={() => props.onStepChange('model')}>
                开始设置
              </button>
            ) : null}

            {props.step === 'model' ? (
              <button
                type="button"
                className="button button--primary"
                disabled={downloaded.length === 0}
                onClick={() => props.onStepChange('done')}
              >
                {downloaded.length === 0 ? '下载完成后继续' : '下一步'}
              </button>
            ) : null}

            {props.step === 'done' ? (
              <button type="button" className="button button--primary" onClick={props.onFinish}>
                开始使用
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

export { Onboarding, STEPS }
export type { TOnboardingStep }
