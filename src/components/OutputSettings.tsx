import { open } from '@tauri-apps/plugin-dialog'

interface IOutputSettingsProps {
  /** 当前输出位置；null 表示默认（与音频同目录） */
  root: string | null
  onChange: (root: string | null) => void
  onNotice: (text: string) => void
}

/**
 * 输出位置设置。
 *
 * 产物是「一个任务一个文件夹」，所以这里选的是这些文件夹放在哪个根目录下。
 * 顺带把命名约定写出来 —— 否则用户既不知道产物长什么样，也不知道该去哪里找。
 */
const OutputSettings = (props: IOutputSettingsProps) => {
  const pickDirectory = async (): Promise<void> => {
    const picked = await open({
      directory: true,
      title: '选择产物的输出位置',
      defaultPath: props.root ?? undefined,
    })
    // 目录选择器取消时返回 null；类型上也可能是数组，这里只接受单个路径
    if (typeof picked !== 'string') {
      return
    }
    props.onChange(picked)
    props.onNotice('输出位置已更新')
  }

  const reset = (): void => {
    props.onChange(null)
    props.onNotice('输出位置已恢复默认（与音频同目录）')
  }

  return (
    <section className="panel output-settings">
      <div className="panel__head">
        <h2 className="panel__title">输出位置</h2>
        <div className="panel__actions">
          <button type="button" className="button button--ghost button--small" onClick={() => void pickDirectory()}>
            选择…
          </button>
          {props.root !== null ? (
            <button type="button" className="button button--ghost button--small" onClick={reset}>
              恢复默认
            </button>
          ) : null}
        </div>
      </div>
      <div className="output-settings__body">
        <p className="output-settings__value" title={props.root ?? '与音频同目录'}>
          {props.root ?? '与音频同目录（默认）'}
        </p>
        <p className="output-settings__hint">
          每个任务输出一个同名文件夹，里面放 <code>txt</code> / <code>srt</code> / <code>vtt</code> / <code>json</code>
          。
        </p>
      </div>
    </section>
  )
}

export { OutputSettings }
