import { LogicalPosition } from '@tauri-apps/api/dpi'
import { Menu, type PredefinedMenuItemOptions } from '@tauri-apps/api/menu'
import { toast } from 'sonner'

type EditMenu = 'editable' | 'readonly' | 'selection'

const MENU_ITEMS: Record<EditMenu, PredefinedMenuItemOptions[]> = {
  editable: [{ item: 'Cut' }, { item: 'Copy' }, { item: 'Paste' }, { item: 'SelectAll' }],
  readonly: [{ item: 'Copy' }, { item: 'SelectAll' }],
  selection: [{ item: 'Copy' }],
}

/** 只拦截浏览器刷新与调试入口，不能影响复制、粘贴和撤销等编辑快捷键。 */
const isBrowserShortcut = (event: KeyboardEvent): boolean => {
  const key = event.key.toLowerCase()
  const command = event.metaKey || event.ctrlKey
  return (
    key === 'f5' ||
    key === 'f12' ||
    (command && key === 'r' && !event.altKey) ||
    (command && (event.altKey || event.shiftKey) && ['i', 'j', 'c', 'k'].includes(key)) ||
    (command && key === 'u')
  )
}

/** 按右键目标选择最小编辑菜单，不把 WebView 的默认菜单放行到任何区域。 */
const editMenuFor = (target: EventTarget | null): EditMenu | null => {
  if (!(target instanceof Element)) return null
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (target.disabled || target.closest('[inert]')) return null
    if (
      target instanceof HTMLInputElement &&
      !['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(target.type)
    )
      return null
    return target.readOnly ? 'readonly' : 'editable'
  }
  const editable = target.closest('[contenteditable]')
  if (editable && editable.getAttribute('contenteditable') !== 'false' && !editable.closest('[inert]')) {
    return 'editable'
  }
  return window.getSelection()?.toString() ? 'selection' : null
}

/** 菜单 IPC 出错时显式提示；不能回落到含 Reload 的浏览器菜单。 */
const reportMenuError = (error: unknown): void => {
  console.error('原生编辑菜单失败', error)
  toast.error('无法打开编辑菜单，请使用复制、粘贴快捷键')
}

/** 捕获阶段禁止浏览器动作，避免刷新重建正在转写的前端状态。 */
const onKeyDown = (event: KeyboardEvent): void => {
  if (!isBrowserShortcut(event)) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

/**
 * 两个窗口共用的生产策略：在 React 渲染前安装，不依赖页面或组件生命周期。
 * 这是防止误操作的产品策略，不是阻止本机所有者检查应用的安全边界。
 */
const installProductionGuards = (production: boolean): (() => void) => {
  if (!production) return () => {}
  const menus = new Map<EditMenu, Promise<Menu>>()
  let disposed = false

  /** 每个窗口按需复用三种原生菜单，创建失败时允许下次重试。 */
  const getMenu = (kind: EditMenu): Promise<Menu> => {
    const existing = menus.get(kind)
    if (existing) return existing
    const pending = Menu.new({ items: MENU_ITEMS[kind] }).catch((error: unknown) => {
      menus.delete(kind)
      throw error
    })
    menus.set(kind, pending)
    return pending
  }

  /** 先同步禁止默认菜单，再异步显示系统编辑菜单；不改变焦点与选区。 */
  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    const kind = editMenuFor(event.target)
    if (kind === null) return
    // IPC 是异步的，鼠标可能已移动；使用触发事件的位置而非弹出时的全局指针位置。
    const position = new LogicalPosition(event.clientX, event.clientY)
    void getMenu(kind)
      .then(async (menu) => {
        if (!disposed) await menu.popup(position)
      })
      .catch(reportMenuError)
  }

  window.addEventListener('contextmenu', onContextMenu, true)
  window.addEventListener('keydown', onKeyDown, true)

  /** 卸载时移除监听器并释放原生资源，包括尚未完成的菜单创建。 */
  return () => {
    if (disposed) return
    disposed = true
    window.removeEventListener('contextmenu', onContextMenu, true)
    window.removeEventListener('keydown', onKeyDown, true)
    for (const pending of menus.values()) {
      void pending.then((menu) => menu.close()).catch(reportMenuError)
    }
    menus.clear()
  }
}

export { installProductionGuards }
