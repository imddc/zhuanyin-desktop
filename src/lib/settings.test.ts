import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_LANGUAGE,
  loadLanguage,
  loadOutputRoot,
  loadPrompt,
  loadSelectedModelId,
  MODEL_KEY,
  OUTPUT_ROOT_KEY,
  safeStorage,
  saveLanguage,
  saveOutputRoot,
  savePrompt,
  saveSelectedModelId,
} from './settings'

/** 造一个读写都会抛异常的 storage，模拟隐私模式 / 策略拦截 */
const brokenStorage = (): Storage =>
  ({
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
    removeItem: () => {
      throw new Error('denied')
    },
  }) as unknown as Storage

describe('输出位置设置', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('存进去能原样读出来', () => {
    saveOutputRoot('/Users/x/转音产物')
    expect(loadOutputRoot()).toBe('/Users/x/转音产物')
    expect(localStorage.getItem(OUTPUT_ROOT_KEY)).toBe('/Users/x/转音产物')
  })

  it('传 null 或空白即恢复默认，并清掉存储项', () => {
    saveOutputRoot('/Users/x/转音产物')
    saveOutputRoot(null)
    expect(loadOutputRoot()).toBeNull()
    expect(localStorage.getItem(OUTPUT_ROOT_KEY)).toBeNull()

    saveOutputRoot('   ')
    expect(loadOutputRoot()).toBeNull()
  })

  it('读取时去掉首尾空白', () => {
    localStorage.setItem(OUTPUT_ROOT_KEY, '  /Users/x/out  ')
    expect(loadOutputRoot()).toBe('/Users/x/out')
  })

  it('没设置过时返回 null（= 与音频同目录）', () => {
    expect(loadOutputRoot()).toBeNull()
  })

  it('存储不可用时读写都不抛异常，一律回落默认', () => {
    expect(loadOutputRoot(null)).toBeNull()
    expect(() => saveOutputRoot('/Users/x/out', null)).not.toThrow()
  })

  it('存储抛异常时不崩，读回落默认、写静默失败', () => {
    const broken = brokenStorage()
    expect(loadOutputRoot(broken)).toBeNull()
    expect(() => saveOutputRoot('/Users/x/out', broken)).not.toThrow()
  })

  it('jsdom 环境下能拿到 localStorage', () => {
    expect(safeStorage()).not.toBeNull()
  })
})

describe('模型 / 语言 / 提示词设置', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('选中的模型能存回来；没选过返回 null', () => {
    expect(loadSelectedModelId()).toBeNull()
    saveSelectedModelId('large-v3-turbo-q5_0')
    expect(loadSelectedModelId()).toBe('large-v3-turbo-q5_0')
    expect(localStorage.getItem(MODEL_KEY)).toBe('large-v3-turbo-q5_0')

    saveSelectedModelId(null)
    expect(loadSelectedModelId()).toBeNull()
  })

  it('语言没设置过时默认自动检测', () => {
    expect(loadLanguage()).toBe(DEFAULT_LANGUAGE)
    saveLanguage('zh')
    expect(loadLanguage()).toBe('zh')
  })

  it('提示词能带空格与换行地存取', () => {
    expect(loadPrompt()).toBe('')
    savePrompt('这是一段会议记录，包含 Kubernetes 与 PostgreSQL')
    expect(loadPrompt()).toBe('这是一段会议记录，包含 Kubernetes 与 PostgreSQL')
  })

  it('提示词清空后回到默认', () => {
    savePrompt('先设一个')
    savePrompt('')
    expect(loadPrompt()).toBe('')
  })

  it('存储不可用时三项设置都回落默认且不抛异常', () => {
    expect(loadSelectedModelId(null)).toBeNull()
    expect(loadLanguage(null)).toBe(DEFAULT_LANGUAGE)
    expect(loadPrompt(null)).toBe('')
    expect(() => saveSelectedModelId('x', null)).not.toThrow()
    expect(() => saveLanguage('zh', null)).not.toThrow()
    expect(() => savePrompt('x', null)).not.toThrow()
  })
})
