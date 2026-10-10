import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IModelStatus } from './types'

/**
 * 引导窗口的测试。
 *
 * 它是**独立窗口**：没有可用模型时应用只开这一个窗口，主窗口并不存在。
 * 所以这里守住两件事 —— 三步能走得通，以及最后一步确实把「开主窗口」
 * 这件事交给了 Rust（前端不自己切界面）。
 */
const fixtures = vi.hoisted(() => ({
  models: [] as IModelStatus[],
}))

const invokeSpy = vi.fn<(command: string, args?: unknown) => void>()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => {
    invokeSpy(command, args)
    if (command === 'list_models') {
      return Promise.resolve(fixtures.models)
    }
    if (command === 'models_dir') {
      return Promise.resolve('/models')
    }
    return Promise.resolve(null)
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: () => Promise.resolve(null),
}))

const closeWindow = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: closeWindow }),
}))

const { OnboardingWindow } = await import('./OnboardingWindow')

const MODEL: IModelStatus = {
  id: 'large-v3-turbo-q5_0',
  name: 'Large v3 Turbo · Q5_0',
  description: '推荐。速度与准确率最平衡',
  filename: 'ggml-large-v3-turbo-q5_0.bin',
  sizeBytes: 574_041_195,
  sha256: 'a'.repeat(64),
  multilingual: true,
  recommended: true,
  speedScore: 5,
  accuracyScore: 4,
  downloaded: true,
  downloading: false,
  downloadedBytes: 574_041_195,
  path: '/models/ggml-large-v3-turbo-q5_0.bin',
}

const NOT_DOWNLOADED: IModelStatus = {
  ...MODEL,
  downloaded: false,
  downloadedBytes: 0,
  path: null,
}

const boot = async (models: IModelStatus[]): Promise<void> => {
  fixtures.models = models
  render(<OnboardingWindow />)
  // 第 1 步不渲染模型列表，所以等的是欢迎标题；模型名要走到第 2 步才出现
  await screen.findByText('欢迎使用转音')
}

beforeEach(() => {
  localStorage.clear()
  invokeSpy.mockClear()
  closeWindow.mockClear()
})

describe('引导窗口', () => {
  it('打开时停在第 1 步，并说明不需要装别的东西', async () => {
    await boot([NOT_DOWNLOADED])

    expect(screen.getByText('欢迎使用转音')).toBeInTheDocument()
    expect(screen.getByText('第 1 / 3 步')).toBeInTheDocument()
    expect(screen.getByText(/不需要安装 Python、ffmpeg 或任何命令行工具/)).toBeInTheDocument()
  })

  it('走到第 2 步才会出现下载入口；没下完不能继续', async () => {
    await boot([NOT_DOWNLOADED])
    fireEvent.click(screen.getByText('开始设置'))

    expect(screen.getByText('第 2 / 3 步')).toBeInTheDocument()
    expect(screen.getByText('下载')).toBeInTheDocument()
    expect(screen.getByText('下载完成后继续')).toBeDisabled()
  })

  it('下载按钮把模型 id 交给后端', async () => {
    await boot([NOT_DOWNLOADED])
    fireEvent.click(screen.getByText('开始设置'))
    fireEvent.click(screen.getByText('下载'))

    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith('download_model', { id: 'large-v3-turbo-q5_0' })
    })
  })

  it('已下载时可以直接进入下一步，并在最后把「开主窗口」交给 Rust', async () => {
    await boot([MODEL])
    fireEvent.click(screen.getByText('开始设置'))
    fireEvent.click(screen.getByText('下一步'))

    expect(screen.getByText('第 3 / 3 步')).toBeInTheDocument()
    expect(screen.getByText('准备就绪')).toBeInTheDocument()

    fireEvent.click(screen.getByText('开始使用'))

    // 关键：前端不自己切界面，而是让 Rust 建主窗口、关掉本窗口
    await waitFor(() => {
      expect(invokeSpy.mock.calls.some(([command]) => command === 'finish_onboarding')).toBe(true)
    })
  })

  it('无边框窗口自带一个关闭按钮（系统红绿灯没有了）', async () => {
    await boot([NOT_DOWNLOADED])

    fireEvent.click(screen.getByLabelText('关闭'))

    await waitFor(() => {
      expect(closeWindow).toHaveBeenCalledTimes(1)
    })
  })

  it('标题带可整条拖动，但关闭按钮不会顺带把窗口拖走', async () => {
    await boot([NOT_DOWNLOADED])

    const bar = document.querySelector('.onboarding__bar')
    expect(bar?.getAttribute('data-tauri-drag-region')).toBe('deep')

    // 关闭按钮是 BUTTON，Tauri 的判定里可点击元素默认阻断拖动，
    // 所以它不会既关窗又拖窗
    const close = screen.getByLabelText('关闭')
    expect(close.tagName).toBe('BUTTON')
    fireEvent.click(close)
    await waitFor(() => {
      expect(closeWindow).toHaveBeenCalledTimes(1)
    })
  })

  it('模型目录来自后端，不是前端写死的', async () => {
    await boot([NOT_DOWNLOADED])
    fireEvent.click(screen.getByText('开始设置'))

    await waitFor(() => {
      expect(invokeSpy.mock.calls.some(([command]) => command === 'models_dir')).toBe(true)
    })
  })
})
