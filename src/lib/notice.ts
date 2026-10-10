import { toast } from 'sonner'

/**
 * 提示的统一出口（右下角）。
 *
 * 放在模块作用域而不是组件里：它不依赖任何组件状态，引用天然稳定，
 * 也就不会出现在各处 useCallback / useEffect 的依赖数组里。
 * 两个窗口（主窗口与引导窗口）共用这一份。
 */
const notify = (text: string): void => {
  toast(text)
}

export { notify }
