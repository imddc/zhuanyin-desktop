import { describe, expect, it } from 'vitest'

import { pickModelId } from './models'
import type { IModelStatus } from '../types'

const model = (id: string, overrides: Partial<IModelStatus> = {}): IModelStatus => ({
  id,
  name: id,
  description: '',
  filename: `${id}.bin`,
  sizeBytes: 1000,
  sha256: 'a'.repeat(64),
  multilingual: true,
  recommended: false,
  speedScore: 3,
  accuracyScore: 3,
  downloaded: true,
  downloading: false,
  downloadedBytes: 1000,
  path: `/models/${id}.bin`,
  ...overrides,
})

describe('pickModelId', () => {
  it('一个都没下载时返回 null', () => {
    expect(pickModelId([model('a', { downloaded: false, path: null })], null)).toBeNull()
    expect(pickModelId([], null)).toBeNull()
  })

  it('用户选过的且仍可用时就用它', () => {
    expect(pickModelId([model('a'), model('b')], 'b')).toBe('b')
  })

  it('用户选过的已被删除时，回退到推荐档', () => {
    // 这正是「删掉正在用的模型」之后界面不该停在不存在选择上的原因
    expect(pickModelId([model('a'), model('b', { recommended: true })], 'missing')).toBe('b')
  })

  it('用户选过的还在但未下载完时，同样回退', () => {
    const models = [model('a', { downloaded: false, path: null }), model('b')]
    expect(pickModelId(models, 'a')).toBe('b')
  })

  it('没有推荐档时用第一个已下载的', () => {
    expect(pickModelId([model('a'), model('b')], null)).toBe('a')
  })

  it('推荐档未下载时不会被选中', () => {
    const models = [model('a', { recommended: true, downloaded: false, path: null }), model('b')]
    expect(pickModelId(models, null)).toBe('b')
  })
})
