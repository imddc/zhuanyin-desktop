import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 样式表层面的回归锁。
 *
 * 这份样式表是手写的，规则之间靠优先级和书写顺序生效 —— 一条写在后面的
 * `padding: 0` 就能把前面组合规则里的留白整个吃掉，而类型检查、Lint、
 * 组件测试都不会有任何反应（引导页的三步进度条紧贴窗口左边缘就是这么来的）。
 *
 * 这里解析的是 `src/styles.css` 落盘的内容，不是我对它的印象。
 */

// 不用 import.meta.url：vitest 里它拿到的不是 file: 协议
const SOURCE = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

interface IDeclaration {
  property: string
  value: string
}

interface IBlock {
  selectors: string[]
  declarations: IDeclaration[]
}

/** 极简分块：这份样式表没有 @media，也没有嵌套，平铺解析就够 */
const parseBlocks = (source: string): IBlock[] => {
  const blocks: IBlock[] = []
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorGroup = match[1]
    const body = match[2]
    if (selectorGroup === undefined || body === undefined) {
      continue
    }
    blocks.push({
      selectors: selectorGroup
        .split(',')
        .map((selector) => selector.trim())
        .filter((selector) => selector !== ''),
      declarations: body
        .split(';')
        .map((declaration) => declaration.trim())
        .filter((declaration) => declaration !== '')
        .map((declaration) => {
          const at = declaration.indexOf(':')
          return {
            property: declaration.slice(0, at).trim(),
            value: declaration.slice(at + 1).trim(),
          }
        }),
    })
  }
  return blocks
}

const BLOCKS = parseBlocks(SOURCE)

/** 某个选择器最终生效的某条属性：后写的覆盖先写的 */
const resolved = (selector: string, property: string): string | null => {
  let found: string | null = null
  for (const block of BLOCKS) {
    if (!block.selectors.includes(selector)) {
      continue
    }
    for (const declaration of block.declarations) {
      if (declaration.property === property) {
        found = declaration.value
      }
    }
  }
  return found
}

/** 取左侧内边距，简写形式也认（1 值=四边 · 2/3 值=左右在第二位 · 4 值=左在第四位） */
const leftPadding = (selector: string): string | null => {
  const shorthand = resolved(selector, 'padding')
  if (shorthand !== null) {
    const parts = shorthand.split(/\s+/)
    const left = parts.length === 1 ? parts[0] : parts.length === 4 ? parts[3] : parts[1]
    if (left !== undefined) {
      return left
    }
  }
  return resolved(selector, 'padding-left')
}

describe('样式表的隐式覆盖', () => {
  it('窄窗口的播放控制可以换行，播放按钮不被压缩', () => {
    expect(resolved('.player', 'flex-wrap')).toBe('wrap')
    expect(resolved('.player__toggle', 'flex-shrink')).toBe('0')
  })
  it('原生控件采用深色主题，滚动条不会使用亮色系统默认值', () => {
    expect(resolved(':root', 'color-scheme')).toBe('dark')
    expect(resolved('*', 'scrollbar-color')).toBe('var(--scrollbar-thumb) transparent')
  })

  it('旧版 WebKit 的滚动条也使用主题色，悬停时提高可见度', () => {
    expect(resolved('::-webkit-scrollbar-thumb', 'background-color')).toBe('var(--scrollbar-thumb)')
    expect(resolved('::-webkit-scrollbar-thumb:hover', 'background-color')).toBe('var(--scrollbar-thumb-hover)')
  })

  it('引导页三步进度条保留左侧留白（别再被后面的 padding: 0 吃掉）', () => {
    // 曾经的样子：组合规则给了 32px 留白，后面一条 `.stepper { padding: 0 }`
    // 因为同优先级且书写靠后而覆盖掉它，进度条于是紧贴窗口左边缘。
    const padding = leftPadding('.stepper')
    expect(padding).toBeTruthy()
    expect(padding).not.toBe('0')
  })

  it('进度条的留白与同一屏的正文一致', () => {
    // 两者对不齐正是用户看到的问题，所以直接锁成同一个值
    expect(leftPadding('.stepper')).toBe(leftPadding('.onboarding__body'))
  })

  it('引导窗口的关闭按钮是圆形（无边框窗口唯一的窗口控件，要一眼看得见）', () => {
    expect(resolved('.onboarding__close', 'border-radius')).toBe('50%')
  })

  it('滚动页里的 panel 不会被压扁', () => {
    // flex 子项默认 flex-shrink: 1，加上 .panel 的 min-height: 0，
    // 内容放不下时每个 panel 都会被等比压扁，而文字不会跟着缩 ——
    // 实测 900×420 下「转写选项」容器 76px、内容 312px，内容整个溢出卡片。
    // 这类页面该滚动，所以必须显式禁止收缩。
    expect(resolved('.page:not(.page--split) > *', 'flex-shrink')).toBe('0')
  })

  it('进度条是块级元素（inline 元素上 height 不生效）', () => {
    // .progress 渲染出来是个 span，默认 inline，height: 4px 会被直接忽略
    expect(resolved('.progress', 'display')).toBe('block')
  })

  it('引导卡片自带圆角，窗口的圆角由它裁出来', () => {
    // 窗口是 transparent + decorations(false)，形状全靠这张卡片
    expect(resolved('.onboarding__card', 'border-radius')).toBe('var(--radius-lg)')
    expect(resolved('.onboarding__card', 'overflow')).toBe('hidden')
  })
})
