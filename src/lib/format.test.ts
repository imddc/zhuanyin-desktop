import { describe, expect, it } from 'vitest'

import {
  baseName,
  formatBytes,
  formatClock,
  formatDateTime,
  formatDuration,
  isAudioFile,
  stripExtension,
  transcriptNameOf,
} from './format'

describe('formatBytes', () => {
  it('小于 10 MB 时保留一位小数', () => {
    expect(formatBytes(0.5 * 1024 * 1024)).toBe('0.5 MB')
    expect(formatBytes(59_707_625)).toBe('57 MB')
  })

  it('MB 与 GB 的切换按 1024 进制', () => {
    expect(formatBytes(574_041_195)).toBe('547 MB')
    expect(formatBytes(1_624_555_275)).toBe('1.51 GB')
  })

  it('零与非法值都退回 0 MB，不出现 NaN', () => {
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatBytes(-1)).toBe('0 MB')
    expect(formatBytes(Number.NaN)).toBe('0 MB')
  })
})

describe('formatDateTime', () => {
  it('输出本地时间，且月日时分补零', () => {
    // 用固定时间戳构造，避免依赖运行环境时区以外的东西
    const stamp = new Date(2026, 0, 5, 9, 7).getTime()
    expect(formatDateTime(stamp)).toBe('2026-01-05 09:07')
  })

  it('非法时间戳给出可读兜底', () => {
    expect(formatDateTime(Number.NaN)).toBe('未知时间')
  })
})

describe('formatClock', () => {
  it('一小时以内输出 mm:ss', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(9)).toBe('00:09')
    expect(formatClock(90)).toBe('01:30')
    expect(formatClock(599)).toBe('09:59')
  })

  it('超过一小时输出 h:mm:ss', () => {
    expect(formatClock(3600)).toBe('1:00:00')
    expect(formatClock(3661)).toBe('1:01:01')
    expect(formatClock(36000)).toBe('10:00:00')
  })

  it('负数、NaN、Infinity 一律按 0 处理', () => {
    expect(formatClock(-5)).toBe('00:00')
    expect(formatClock(Number.NaN)).toBe('00:00')
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('00:00')
  })
})

describe('formatDuration', () => {
  it('一分钟以内只给秒', () => {
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(45)).toBe('45 秒')
  })

  it('分钟与秒同时出现，整分不写秒', () => {
    expect(formatDuration(90)).toBe('1 分 30 秒')
    expect(formatDuration(120)).toBe('2 分')
  })

  it('小时档优先给小时与分，整小时不写分', () => {
    expect(formatDuration(3600)).toBe('1 小时')
    expect(formatDuration(3900)).toBe('1 小时 5 分')
  })
})

describe('路径工具', () => {
  it('baseName 兼容 unix 与 windows 分隔符以及结尾斜杠', () => {
    expect(baseName('/Users/demo/audio/面试.m4a')).toBe('面试.m4a')
    expect(baseName('C:\\Users\\demo\\audio\\talk.mp3')).toBe('talk.mp3')
    expect(baseName('/Users/demo/audio/')).toBe('audio')
  })

  it('stripExtension 只吃最后一段扩展名，隐藏文件原样返回', () => {
    expect(stripExtension('a.b.m4a')).toBe('a.b')
    expect(stripExtension('.hidden')).toBe('.hidden')
    expect(stripExtension('noext')).toBe('noext')
  })

  it('transcriptNameOf 由音频路径推导输出名', () => {
    expect(transcriptNameOf('/tmp/面试录音.m4a')).toBe('面试录音')
  })

  it('isAudioFile 大小写不敏感，且拒绝非音频与无扩展名', () => {
    expect(isAudioFile('/tmp/a.M4A')).toBe(true)
    expect(isAudioFile('/tmp/a.wav')).toBe(true)
    expect(isAudioFile('/tmp/a.txt')).toBe(false)
    expect(isAudioFile('/tmp/noext')).toBe(false)
  })
})
