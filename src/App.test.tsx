import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OUTPUT_ROOT_KEY } from './lib/settings'
import type { IEngineStatus, IModelStatus } from './types'

/**
 * 这一组测试守的是几个真实缺陷与关键契约：
 * 1. `onDragDropEvent` 的投放分支必须看引擎状态，否则拖拽能把任务塞进队列然后必然失败；
 * 2. 引擎「能不能跑」等价于「有没有模型」，这条闸门必须有效；
 * 3. 首次使用必须被引导到「下载一个模型」，而不是丢一个空界面；
 * 4. 页面切换要真的换内容，不能只是高亮变了。
 *
 * Tauri 的 API 在测试环境里不存在，所以按最小面 mock：只给 App 真正用到的那几个。
 */
// vi.mock 的工厂会被提升到文件顶部，不能直接引用模块级变量；
// 用 vi.hoisted 把两边共享的可变量提前声明出来。
const fixtures = vi.hoisted(() => ({
  engine: null as IEngineStatus | null,
  models: [] as IModelStatus[],
  drops: [] as Array<(event: { payload: { type: string; paths?: string[] } }) => void>,
}))

const invokeSpy = vi.fn<(command: string, args?: unknown) => void>()

interface IRecordedRequest {
  input?: string
  outDir?: string
  modelId?: string
  language?: string
  prompt?: string
}

const startTranscribe = vi.fn<(request: IRecordedRequest) => Promise<string>>().mockResolvedValue('job-1')
const downloadModel = vi.fn<(args: { id: string }) => Promise<null>>().mockResolvedValue(null)

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: (command: string, args?: { request?: IRecordedRequest; id?: string }) => {
    invokeSpy(command, args)
    if (command === 'engine_status') {
      return Promise.resolve(fixtures.engine)
    }
    if (command === 'list_models') {
      return Promise.resolve(fixtures.models)
    }
    if (command === 'list_history') {
      return Promise.resolve([])
    }
    if (command === 'download_model') {
      return downloadModel(args as { id: string })
    }
    if (command === 'start_transcribe') {
      return startTranscribe(args?.request ?? {})
    }
    return Promise.resolve(null)
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: { payload: { type: string; paths?: string[] } }) => void) => {
      fixtures.drops.push(handler)
      return Promise.resolve(() => {})
    },
  }),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: () => Promise.resolve(null),
}))

const { App } = await import('./App')

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

const ENGINE_READY: IEngineStatus = {
  ready: true,
  modelsDir: '/models',
  availableModels: 1,
  loadedModelId: null,
  issues: [],
}

const ENGINE_MISSING_MODEL: IEngineStatus = {
  ready: false,
  modelsDir: '/models',
  availableModels: 0,
  loadedModelId: null,
  issues: [{ code: 'model', message: '还没有可用的模型。' }],
}

const boot = async (engine: IEngineStatus, models: IModelStatus[]): Promise<void> => {
  fixtures.engine = engine
  fixtures.models = models
  fixtures.drops.length = 0
  render(<App />)
  // 等拖拽监听注册完成（App 在 effect 里异步注册）
  await waitFor(() => expect(fixtures.drops).toHaveLength(1))
  // 再等引擎状态落到界面：侧边栏底部那行是唯一的状态出口。
  // 拦截读的是 ref，而 ref 在 effect 里才同步，不等这一步测出来的会是时序。
  await screen.findByText(engine.ready ? MODEL.name : '还没有可用模型')
}

const drop = (paths: string[]): void => {
  const handler = fixtures.drops[0]
  if (handler === undefined) {
    throw new Error('拖拽监听还没注册')
  }
  handler({ payload: { type: 'drop', paths } })
}

beforeEach(() => {
  // 设置存在 localStorage 里，用例之间必须互不影响
  localStorage.clear()
  startTranscribe.mockClear()
  downloadModel.mockClear()
  invokeSpy.mockClear()
})

describe('输出位置', () => {
  it('未设置时请求不带 outDir，交给引擎按音频所在目录处理', async () => {
    await boot(ENGINE_READY, [MODEL])
    drop(['/Users/x/interview.m4a'])

    await waitFor(() => expect(startTranscribe).toHaveBeenCalled())
    expect(startTranscribe.mock.calls[0]?.[0].outDir).toBeUndefined()
  })

  it('设置过输出位置时，请求带上它', async () => {
    localStorage.setItem(OUTPUT_ROOT_KEY, '/Users/x/转音产物')
    await boot(ENGINE_READY, [MODEL])
    drop(['/Users/x/interview.m4a'])

    await waitFor(() => expect(startTranscribe).toHaveBeenCalled())
    expect(startTranscribe.mock.calls[0]?.[0].outDir).toBe('/Users/x/转音产物')
  })
})

describe('转写参数', () => {
  it('带上自动选出的模型与默认的自动检测语言', async () => {
    await boot(ENGINE_READY, [MODEL])
    drop(['/Users/x/interview.m4a'])

    await waitFor(() => expect(startTranscribe).toHaveBeenCalled())
    const request = startTranscribe.mock.calls[0]?.[0]
    // 只有一个已下载模型时自动用它，用户不需要先去选
    expect(request?.modelId).toBe('large-v3-turbo-q5_0')
    expect(request?.language).toBe('auto')
    // 提示词留空时不传，避免把空串当成提示词送进模型
    expect(request?.prompt).toBeUndefined()
  })
})

describe('引擎未就绪时的拖拽投放', () => {
  it('拒绝入队并提示先下载模型', async () => {
    await boot(ENGINE_MISSING_MODEL, [NOT_DOWNLOADED])
    drop(['/Users/x/interview.m4a'])

    await waitFor(() => {
      expect(screen.getByText(/还没有可用的模型 —— 先在「模型」里下载一个/)).toBeInTheDocument()
    })
    expect(startTranscribe).not.toHaveBeenCalled()
  })

  it('引擎就绪时照常入队', async () => {
    await boot(ENGINE_READY, [MODEL])
    drop(['/Users/x/interview.m4a'])

    await waitFor(() => {
      // 提示必须与事实一致：任务确实进了队列，就该说「已加入」。见 issue #15
      expect(screen.getByText('已加入 1 个任务')).toBeInTheDocument()
    })
    expect(screen.getAllByText('interview').length).toBeGreaterThan(0)
  })

  it('重复拖同一个文件不再重复入队，且提示如实说没有可加入的', async () => {
    await boot(ENGINE_READY, [MODEL])
    drop(['/Users/x/interview.m4a'])
    await waitFor(() => {
      expect(screen.getByText('已加入 1 个任务')).toBeInTheDocument()
    })

    // 第二次投放：去重要基于「包含上一次结果」的当前队列，
    // 这一条同时守住 ref 与 state 不会失去同步
    drop(['/Users/x/interview.m4a'])
    await waitFor(() => {
      expect(screen.getByText('没有可加入的音频文件（或已在队列里）')).toBeInTheDocument()
    })
    expect(screen.getAllByText('interview')).toHaveLength(1)
  })

  it('混入非音频文件时，只把音频计入数量', async () => {
    await boot(ENGINE_READY, [MODEL])
    drop(['/Users/x/interview.m4a', '/Users/x/notes.txt'])

    await waitFor(() => {
      expect(screen.getByText('已加入 1 个任务')).toBeInTheDocument()
    })
    expect(screen.queryAllByText(/notes/)).toHaveLength(0)
  })
})

describe('主窗口与引导的分工', () => {
  it('主窗口里不再有引导覆盖层：引导是独立窗口的事', async () => {
    await boot(ENGINE_MISSING_MODEL, [NOT_DOWNLOADED])

    // 一个模型都没有时，主窗口只管把「还没有可用模型」说清楚，
    // 不再自己弹引导 —— 该不该开引导窗口由 Rust 在启动时决定。
    expect(screen.queryByText('欢迎使用转音')).not.toBeInTheDocument()
    expect(screen.getByText('还没有可用模型')).toBeInTheDocument()
  })

  it('设置页的「重新打开引导」交给 Rust 去开窗口', async () => {
    await boot(ENGINE_READY, [MODEL])
    fireEvent.click(screen.getByText('设置'))
    fireEvent.click(screen.getByText('重新打开引导'))

    await waitFor(() => {
      // spy 记录的是 (command, args)，这里只关心命令名
      expect(invokeSpy.mock.calls.some(([command]) => command === 'open_onboarding')).toBe(true)
    })
  })
})

describe('窗口拖动区', () => {
  it('主窗口有一条可整条拖动的标题区（无边框窗口没有系统标题栏）', async () => {
    await boot(ENGINE_READY, [MODEL])

    const strip = document.querySelector('.shell__titlebar')
    expect(strip).not.toBeNull()
    // 必须是 "deep"：裸写属性时 Tauri 只认「点到这个元素本身」，
    // 子元素盖住的地方就拖不动了（这正是之前的 bug）
    expect(strip?.getAttribute('data-tauri-drag-region')).toBe('deep')
  })
})

describe('提示', () => {
  it('挂在右下角（无提示时 sonner 不渲染容器，所以要先触发一条）', async () => {
    await boot(ENGINE_READY, [MODEL])
    // 故意拖非音频：同样会弹提示，但不会真的把任务泵起来 ——
    // 否则这条用例会留下未结算的队列更新，污染后面的用例
    drop(['/Users/x/notes.txt'])
    expect(await screen.findByText('没有可加入的音频文件（或已在队列里）')).toBeInTheDocument()

    const toaster = document.querySelector('[data-sonner-toaster]')
    expect(toaster).not.toBeNull()
    expect(toaster?.getAttribute('data-y-position')).toBe('bottom')
    expect(toaster?.getAttribute('data-x-position')).toBe('right')
  })
})

describe('没有模型时的逃生口', () => {
  it('拖拽区给出真实可行的去处，而不是指向一个不存在的地方', async () => {
    await boot(ENGINE_MISSING_MODEL, [NOT_DOWNLOADED])

    expect(screen.getByText(/还没有可用的识别模型/)).toBeInTheDocument()
    // 顶部状态条早就删了，说明里不能再叫用户去看「上方提示」
    expect(screen.queryByText(/上方提示/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('去「模型」页下载'))
    expect(screen.getByText('导入已有模型')).toBeInTheDocument()
  })

  it('设置页有独立的选模型入口，点了能到模型页', async () => {
    await boot(ENGINE_MISSING_MODEL, [NOT_DOWNLOADED])
    fireEvent.click(screen.getByText('设置'))

    // 设置里必须能看出「现在没有模型，并且能去哪里拿」
    expect(screen.getByText(/还没有可用的识别模型/)).toBeInTheDocument()
    expect(screen.getByText('去「模型」页选择')).toBeInTheDocument()

    fireEvent.click(screen.getByText('去「模型」页选择'))
    expect(screen.getByText('导入已有模型')).toBeInTheDocument()
  })
})

describe('页面导航', () => {
  it('默认停在转写页', async () => {
    await boot(ENGINE_READY, [MODEL])
    expect(screen.getByLabelText('拖拽音频到这里')).toBeInTheDocument()
    expect(screen.queryByText('关于')).not.toBeInTheDocument()
  })

  it('切到设置页会显示关于与输出位置', async () => {
    await boot(ENGINE_READY, [MODEL])

    fireEvent.click(screen.getByText('设置'))

    expect(screen.getByText('关于')).toBeInTheDocument()
    expect(screen.getByText('输出位置')).toBeInTheDocument()
    // 转写页的内容应当已经让位
    expect(screen.queryByLabelText('拖拽音频到这里')).not.toBeInTheDocument()
  })

  it('切到模型页会显示完整清单与操作', async () => {
    await boot(ENGINE_READY, [MODEL])

    fireEvent.click(screen.getByText('模型'))

    expect(screen.getByText('导入已有模型')).toBeInTheDocument()
    expect(screen.getByText('模型目录')).toBeInTheDocument()
    // 已下载的模型在模型页里可以删除
    expect(screen.getByText('删除')).toBeInTheDocument()
  })

  it('切到历史页会说明历史会被保留', async () => {
    await boot(ENGINE_READY, [MODEL])

    fireEvent.click(screen.getByText('历史'))

    expect(screen.getByText(/关掉应用也还在/)).toBeInTheDocument()
  })
})
