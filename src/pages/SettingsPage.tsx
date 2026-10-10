import { OutputSettings } from '../components/OutputSettings'
import { TranscribeOptions } from '../components/TranscribeOptions'

interface ISettingsPageProps {
  outputRoot: string | null
  onOutputRootChange: (root: string | null) => void
  onNotice: (text: string) => void
  language: string
  prompt: string
  onLanguageChange: (value: string) => void
  onPromptChange: (value: string) => void
  modelsDir: string
  onReveal: (path: string) => void
  /** 切到模型页去挑 / 下载模型 */
  onOpenModels: () => void
  /** 重新走一遍首次使用的引导 */
  onReopenOnboarding: () => void
  activeModelName: string | null
  availableModels: number
}

/**
 * 设置页：输出位置、转写选项，以及关于。
 *
 * 「关于」里刻意放了一个「重新打开引导」：引导页本身是首次使用的入口，
 * 但用户忘了某一步怎么做时，应该能再走一遍，而不是只能去翻文档。
 */
const SettingsPage = (props: ISettingsPageProps) => (
  <div className="page">
    <OutputSettings root={props.outputRoot} onChange={props.onOutputRootChange} onNotice={props.onNotice} />

    <TranscribeOptions
      language={props.language}
      prompt={props.prompt}
      onLanguageChange={props.onLanguageChange}
      onPromptChange={props.onPromptChange}
    />

    {/* 模型单独成一块：引导窗口可以被直接关掉，这里必须是那条走得通的路 */}
    <section className="panel">
      <header className="panel__head">
        <h2 className="panel__title">模型</h2>
        <div className="panel__actions">
          <span className="panel__meta">
            {props.availableModels > 0 ? `${props.availableModels} 个已下载` : '还没有下载'}
          </span>
        </div>
      </header>
      <div className="about">
        {props.availableModels === 0 ? (
          <p className="about__warn" role="alert">
            还没有可用的识别模型，转写暂时用不了。下载一个之后即可开始使用。
          </p>
        ) : null}

        <dl className="kv">
          <dt>当前使用</dt>
          <dd>{props.activeModelName ?? '还没有选择'}</dd>
          <dt>存放位置</dt>
          <dd>
            <code>{props.modelsDir}</code>
          </dd>
        </dl>

        <div className="about__actions">
          <button type="button" className="button button--primary" onClick={props.onOpenModels}>
            去「模型」页选择
          </button>
          <button type="button" className="button" onClick={props.onReopenOnboarding}>
            重新打开引导
          </button>
          <button type="button" className="button" onClick={() => props.onReveal(props.modelsDir)}>
            打开模型目录
          </button>
        </div>
      </div>
    </section>

    <section className="panel">
      <header className="panel__head">
        <h2 className="panel__title">关于</h2>
      </header>
      <div className="about">
        <dl className="kv">
          <dt>识别引擎</dt>
          <dd>whisper.cpp（Rust 原生，Metal 加速）· 随应用内置</dd>
          <dt>音频解码</dt>
          <dd>纯 Rust（symphonia）· 不需要 ffmpeg</dd>
        </dl>
        <p className="about__note">转写全程在本机完成，音频与识别结果都不会离开这台电脑（下载模型时会访问模型源）。</p>
      </div>
    </section>
  </div>
)

export { SettingsPage }
