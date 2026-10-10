import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TranscriptPanel } from './TranscriptPanel'

const SEGMENTS = [
  { start: 0, end: 5, text: '第一段内容' },
  { start: 5, end: 12, text: '第二段内容' },
]

describe('TranscriptPanel', () => {
  it('点击某一段时回传该段起点秒数', () => {
    const onSeek = vi.fn<(seconds: number) => void>()
    render(
      <TranscriptPanel
        title="逐字稿"
        segments={SEGMENTS}
        activeIndex={-1}
        onSeek={onSeek}
        onCopyAll={vi.fn<() => void>()}
        onReveal={null}
      />,
    )

    fireEvent.click(screen.getByText('第二段内容'))
    expect(onSeek).toHaveBeenCalledWith(5)
  })

  it('当前段用 aria-current 标记，便于无障碍与测试断言', () => {
    render(
      <TranscriptPanel
        title="逐字稿"
        segments={SEGMENTS}
        activeIndex={1}
        onSeek={vi.fn<(seconds: number) => void>()}
        onCopyAll={vi.fn<() => void>()}
        onReveal={null}
      />,
    )

    expect(screen.getByText('第二段内容').closest('button')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('第一段内容').closest('button')).not.toHaveAttribute('aria-current')
  })

  it('没有段落时给出空状态，且禁用复制', () => {
    render(
      <TranscriptPanel
        title="逐字稿"
        segments={[]}
        activeIndex={-1}
        onSeek={vi.fn<(seconds: number) => void>()}
        onCopyAll={vi.fn<() => void>()}
        onReveal={null}
      />,
    )

    expect(screen.getByText('选中一个任务后，识别出的段落会实时出现在这里。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制全文' })).toBeDisabled()
  })

  it('传了 onReveal 才渲染「打开产物目录」', () => {
    const { rerender } = render(
      <TranscriptPanel
        title="逐字稿"
        segments={SEGMENTS}
        activeIndex={-1}
        onSeek={vi.fn<(seconds: number) => void>()}
        onCopyAll={vi.fn<() => void>()}
        onReveal={null}
      />,
    )
    expect(screen.queryByRole('button', { name: '打开产物目录' })).toBeNull()

    rerender(
      <TranscriptPanel
        title="逐字稿"
        segments={SEGMENTS}
        activeIndex={-1}
        onSeek={vi.fn<(seconds: number) => void>()}
        onCopyAll={vi.fn<() => void>()}
        onReveal={vi.fn<() => void>()}
      />,
    )
    expect(screen.getByRole('button', { name: '打开产物目录' })).toBeInTheDocument()
  })
})
