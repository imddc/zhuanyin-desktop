import { DEFAULT_LANGUAGE } from '../lib/settings'

interface ITranscribeOptionsProps {
  language: string
  prompt: string
  onLanguageChange: (value: string) => void
  onPromptChange: (value: string) => void
}

/**
 * 可选语言：auto 交给模型自己判断，其余是常见语言。
 *
 * 只列常用项而不是把 whisper 支持的九十多种全铺出来——选择器一旦超过一屏，
 * 「找中文」本身就成了负担。需要别的语言可以直接改存储值。
 */
const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'auto', label: '自动检测' },
  { code: 'zh', label: '中文' },
  { code: 'yue', label: '粤语' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
]

/**
 * 转写选项：语言与初始提示词。
 *
 * 语言以前是写死的 `zh`，中英混说的素材没法切自动检测；提示词则在 Rust 侧
 * 有入口但前端从不传，等于白留了一个能力。这里把两者都接到界面上。
 */
const TranscribeOptions = (props: ITranscribeOptionsProps) => {
  const isAuto = props.language === DEFAULT_LANGUAGE

  return (
    <section className="panel">
      <header className="panel__head">
        <h2 className="panel__title">转写选项</h2>
      </header>

      <div className="options">
        <label className="field">
          <span className="field__label">语言</span>
          <select
            className="field__control"
            value={props.language}
            onChange={(event) => props.onLanguageChange(event.target.value)}
          >
            {LANGUAGES.map((item) => (
              <option key={item.code} value={item.code}>
                {item.label}
              </option>
            ))}
          </select>
          <span className="field__hint">
            {isAuto ? '前 30 秒用于判断语种，中英混说建议保持自动检测' : '明确指定语种可以省掉检测这一步'}
          </span>
        </label>

        <label className="field">
          <span className="field__label">初始提示词</span>
          <textarea
            className="field__control field__control--area"
            rows={3}
            placeholder="留空即可。需要偏向专有名词时，只写一句自然语言短句"
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
          />
          <span className="field__hint">实测把一长串术语表当提示词会让模型复读提示词并在结尾打转，所以建议留空</span>
        </label>
      </div>
    </section>
  )
}

export { TranscribeOptions }
