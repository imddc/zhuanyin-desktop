import type { MenuOptions } from '@tauri-apps/api/menu'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installProductionGuards } from './productionGuards'

const { popup, close, createMenu, reportError } = vi.hoisted(() => ({
  popup: vi.fn<(position?: LogicalPosition) => Promise<void>>().mockResolvedValue(undefined),
  close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  createMenu: vi.fn<(options: MenuOptions) => Promise<{ popup: () => Promise<void>; close: () => Promise<void> }>>(),
  reportError: vi.fn<(message: string) => void>(),
}))

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: createMenu } }))
vi.mock('sonner', () => ({ toast: { error: reportError } }))

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  window.getSelection()?.removeAllRanges()
  vi.clearAllMocks()
})

/** 安装与正式入口相同的策略，仅替换系统菜单 IPC。 */
const install = (production = true): void => {
  createMenu.mockResolvedValue({ popup, close })
  dispose = installProductionGuards(production)
}

/** 派发可取消的键盘事件，验证默认浏览器动作是否被阻止。 */
const press = (key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
  document.body.dispatchEvent(event)
  return event
}

/** 右键目标元素，验证原生菜单不会再由 WebView 生成。 */
const rightClick = (target: Element): MouseEvent => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 37, clientY: 55 })
  target.dispatchEvent(event)
  return event
}

describe('生产版 WebView 交互策略', () => {
  it('空白区域不出现浏览器右键菜单，也不创建无意义的编辑菜单', () => {
    install()
    expect(rightClick(document.body).defaultPrevented).toBe(true)
    expect(createMenu).not.toHaveBeenCalled()
  })

  it.each([
    ['r', { metaKey: true }],
    ['R', { metaKey: true, shiftKey: true }],
    ['r', { ctrlKey: true }],
    ['F5', {}],
    ['F5', { ctrlKey: true }],
    ['F12', {}],
    ['i', { metaKey: true, altKey: true }],
    ['j', { metaKey: true, altKey: true }],
    ['c', { ctrlKey: true, shiftKey: true }],
    ['I', { ctrlKey: true, shiftKey: true }],
  ])('阻止刷新或调试快捷键 %s %j', (key, modifiers) => {
    install()
    expect(press(key, modifiers).defaultPrevented).toBe(true)
  })

  it.each(['c', 'v', 'x', 'a', 'z'])('保留标准编辑快捷键 %s', (key) => {
    install()
    expect(press(key, { metaKey: true }).defaultPrevented).toBe(false)
    expect(press(key, { ctrlKey: true }).defaultPrevented).toBe(false)
  })

  it('输入框使用没有 Reload/Inspect 的原生编辑菜单，复用菜单不泄漏资源', async () => {
    install()
    const input = document.createElement('input')
    document.body.append(input)
    expect(rightClick(input).defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(1))
    expect(popup).toHaveBeenCalledWith(expect.objectContaining({ x: 37, y: 55 }))
    expect(createMenu).toHaveBeenCalledWith({
      items: [{ item: 'Cut' }, { item: 'Copy' }, { item: 'Paste' }, { item: 'SelectAll' }],
    })
    rightClick(input)
    await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(2))
    expect(createMenu).toHaveBeenCalledTimes(1)
    dispose?.()
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  })

  it('只读输入框只提供复制与全选，禁用输入框不弹菜单', async () => {
    install()
    const input = document.createElement('textarea')
    input.readOnly = true
    document.body.append(input)
    rightClick(input)
    await vi.waitFor(() => expect(popup).toHaveBeenCalled())
    expect(createMenu).toHaveBeenCalledWith({ items: [{ item: 'Copy' }, { item: 'SelectAll' }] })
    input.disabled = true
    rightClick(input)
    expect(popup).toHaveBeenCalledTimes(1)
  })

  it('选择逐字稿文字时保留原生复制菜单', async () => {
    install()
    const text = document.createElement('p')
    text.textContent = '可复制的逐字稿'
    document.body.append(text)
    const range = document.createRange()
    range.selectNodeContents(text)
    window.getSelection()?.addRange(range)
    expect(rightClick(text).defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(popup).toHaveBeenCalled())
    expect(createMenu).toHaveBeenCalledWith({ items: [{ item: 'Copy' }] })
  })

  it('原生菜单失败时报告错误，不恢复危险默认菜单', async () => {
    install()
    createMenu.mockRejectedValueOnce(new Error('IPC denied'))
    const input = document.createElement('input')
    document.body.append(input)
    expect(rightClick(input).defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(reportError).toHaveBeenCalled())
  })

  it('开发模式保留默认右键与调试快捷键', () => {
    install(false)
    expect(rightClick(document.body).defaultPrevented).toBe(false)
    expect(press('F12').defaultPrevented).toBe(false)
    expect(press('r', { metaKey: true }).defaultPrevented).toBe(false)
  })

  it('清理后移除监听器，允许重复清理', () => {
    install()
    dispose?.()
    dispose?.()
    expect(rightClick(document.body).defaultPrevented).toBe(false)
    expect(press('F5').defaultPrevented).toBe(false)
  })

  it('销毁窗口时，尚未完成的菜单创建也会释放且不再弹出', async () => {
    install()
    let resolveMenu: ((menu: { popup: typeof popup; close: typeof close }) => void) | undefined
    createMenu.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMenu = resolve
        }),
    )
    const input = document.createElement('input')
    document.body.append(input)
    rightClick(input)
    dispose?.()
    resolveMenu?.({ popup, close })
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(popup).not.toHaveBeenCalled()
  })

  it('可编辑容器使用编辑菜单，内部明确不可编辑的区域不误判', async () => {
    install()
    const container = document.createElement('div')
    container.setAttribute('contenteditable', 'true')
    const child = document.createElement('span')
    container.append(child)
    document.body.append(container)
    rightClick(child)
    await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(1))
    child.setAttribute('contenteditable', 'false')
    rightClick(child)
    expect(popup).toHaveBeenCalledTimes(1)
  })
})

// 源码接线检查防止策略仅在测试中安装；原生行为仍需 release .app 人工验收。
describe('主窗口与引导窗口生产策略接线', () => {
  it('两个窗口共用入口，按生产构建安装策略且支持热更新清理', () => {
    const entry = readFileSync('src/main.tsx', 'utf8')
    expect(entry).toContain('installProductionGuards(import.meta.env.PROD)')
    expect(entry.indexOf('installProductionGuards(import.meta.env.PROD)')).toBeLessThan(
      entry.indexOf('createRoot(container).render'),
    )
    expect(entry).toContain('import.meta.hot?.dispose(disposeProductionGuards)')
  })

  it('每个原生 WebView 都仅在 debug 构建启用 DevTools，依赖不包含 devtools feature', () => {
    const windows = readFileSync('src-tauri/src/windows.rs', 'utf8')
    const webviews = windows.match(/WebviewWindowBuilder::new\([\s\S]*?(?:builder\.build\(\)|\.build\(\))/g) ?? []
    expect(webviews).toHaveLength(2)
    for (const builder of webviews) expect(builder).toContain('.devtools(cfg!(debug_assertions))')
    const manifest = readFileSync('src-tauri/Cargo.toml', 'utf8')
    expect(manifest).not.toMatch(/"(?:tauri\/)?devtools"/)
  })
})
import type { LogicalPosition } from '@tauri-apps/api/dpi'
