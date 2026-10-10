import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach } from 'vitest'

// jsdom 没有实现 scrollIntoView，逐字稿面板的自动滚动在测试里会直接抛错
const noopScrollIntoView = (): void => {}
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = noopScrollIntoView
}

// vitest 未开 globals 时 testing-library 不会自动注册清理钩子，
// 多个用例的 DOM 会累积在同一份 document 上（表现为「找到多个元素」）
afterEach(() => {
  cleanup()
  // sonner 的 toast 列表是模块级状态，不随组件卸载消失；
  // 不清掉的话上一个用例的提示会留到下一个，断言同一个文案时就会「找到多个元素」
  toast.dismiss()
})
