import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 原生目录选择器在测试环境里不存在，按用到的面最小 mock
const dialog = vi.hoisted(() => ({ open: vi.fn<(options?: unknown) => Promise<string | null>>() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: dialog.open }))

const { OutputSettings } = await import('./OutputSettings')

const noopRoot = vi.fn<(root: string | null) => void>()
const noopNotice = vi.fn<(text: string) => void>()

describe('OutputSettings', () => {
  beforeEach(() => {
    dialog.open.mockReset()
    noopRoot.mockReset()
    noopNotice.mockReset()
  })

  it('默认状态显示「与音频同目录」，并且没有恢复默认按钮', () => {
    render(<OutputSettings root={null} onChange={noopRoot} onNotice={noopNotice} />)

    expect(screen.getByText('与音频同目录（默认）')).toBeInTheDocument()
    expect(screen.queryByText('恢复默认')).not.toBeInTheDocument()
    // 命名约定要写出来，否则用户不知道产物是什么形状
    expect(screen.getByText(/每个任务输出一个同名文件夹/)).toBeInTheDocument()
  })

  it('选中目录后回传路径并给出提示', async () => {
    dialog.open.mockResolvedValue('/Users/x/转音产物')
    render(<OutputSettings root={null} onChange={noopRoot} onNotice={noopNotice} />)

    fireEvent.click(screen.getByText('选择…'))

    await waitFor(() => expect(noopRoot).toHaveBeenCalledWith('/Users/x/转音产物'))
    expect(noopNotice).toHaveBeenCalledWith('输出位置已更新')
    expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }))
  })

  it('取消选择时什么都不改', async () => {
    dialog.open.mockResolvedValue(null)
    render(<OutputSettings root={null} onChange={noopRoot} onNotice={noopNotice} />)

    fireEvent.click(screen.getByText('选择…'))

    await waitFor(() => expect(dialog.open).toHaveBeenCalled())
    expect(noopRoot).not.toHaveBeenCalled()
  })

  it('已设置时显示当前路径，点恢复默认回传 null', () => {
    render(<OutputSettings root="/Users/x/转音产物" onChange={noopRoot} onNotice={noopNotice} />)

    expect(screen.getByText('/Users/x/转音产物')).toBeInTheDocument()
    fireEvent.click(screen.getByText('恢复默认'))

    expect(noopRoot).toHaveBeenCalledWith(null)
    expect(noopNotice).toHaveBeenCalledWith('输出位置已恢复默认（与音频同目录）')
  })
})
