import { Toaster } from 'sonner'

/**
 * sonner 的挂载点。提示固定在右下角，不占布局、自动消失。
 *
 * 两个窗口各自渲染一份：引导窗口也要能弹出「模型下载完成」这类提示。
 */
const AppToaster = () => (
  <Toaster
    position="bottom-right"
    theme="dark"
    duration={2600}
    offset={16}
    toastOptions={{
      style: {
        background: 'var(--surface-3)',
        border: '1px solid var(--border-strong)',
        color: 'var(--text-1)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-2)',
        fontSize: 'var(--font-sm)',
      },
    }}
  />
)

export { AppToaster }
