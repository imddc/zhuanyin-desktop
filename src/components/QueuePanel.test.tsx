import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { QueuePanel } from './QueuePanel'
import { createJob } from '../lib/queue'
import type { ITranscribeJob } from '../types'

/**
 * 队列行的准备阶段。
 *
 * 回归的是这个体验问题：长音频解码要几秒（dev 构建下曾经是六十多秒），
 * 而这期间界面显示「0 段 · 0%」、进度条一动不动，看起来就是卡住了。
 */
/** 这几个回调在用例里都不需要断言，共享一个空的即可 */
const noop = (): void => {}

const job = (overrides: Partial<ITranscribeJob> = {}): ITranscribeJob => ({
  ...createJob('/Users/x/interview.m4a', 1),
  status: 'running',
  startedAt: 1,
  ...overrides,
})

const renderPanel = (jobs: ITranscribeJob[]): void => {
  render(<QueuePanel jobs={jobs} selectedId={null} onSelect={noop} onCancel={noop} onClearFinished={noop} />)
}

describe('队列里的准备阶段', () => {
  it('加载模型时说出在做这件事，而不是显示 0%', () => {
    renderPanel([job({ phase: 'loadingModel' })])

    expect(screen.getByText('加载模型…')).toBeInTheDocument()
    expect(screen.queryByText(/· 0%/)).not.toBeInTheDocument()
  })

  it('解码音频时同理', () => {
    renderPanel([job({ phase: 'decodingAudio' })])

    expect(screen.getByText('解码音频…')).toBeInTheDocument()
  })

  it('准备阶段用不确定进度条，不假装有百分比', () => {
    const { container } = render(
      <QueuePanel
        jobs={[job({ phase: 'decodingAudio' })]}
        selectedId={null}
        onSelect={noop}
        onCancel={noop}
        onClearFinished={noop}
      />,
    )

    const bar = container.querySelector('.progress')
    expect(bar?.classList.contains('progress--indeterminate')).toBe(true)
    // 不确定态不写 width，交给 CSS 的扫描动画
    expect(container.querySelector('.progress__fill')?.getAttribute('style')).toBeNull()
  })

  it('有了真实进度就切回确定进度条与百分比', () => {
    const { container } = render(
      <QueuePanel
        jobs={[job({ phase: null, ratio: 0.42, segments: [{ start: 0, end: 4, text: '你好' }] })]}
        selectedId={null}
        onSelect={noop}
        onCancel={noop}
        onClearFinished={noop}
      />,
    )

    expect(screen.getByText('1 段 · 42%')).toBeInTheDocument()
    expect(container.querySelector('.progress')?.classList.contains('progress--indeterminate')).toBe(false)
    expect(container.querySelector('.progress__fill')?.getAttribute('style')).toContain('width: 42%')
  })
})
