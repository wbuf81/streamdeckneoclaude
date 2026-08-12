import { describe, it, expect } from 'vitest'
import { truncate, formatDuration, formatClock } from '../../src/render/text.js'

describe('truncate', () => {
  it('leaves a short string alone', () => {
    expect(truncate('daisy', 10)).toBe('daisy')
  })

  it('leaves an exact-length string alone', () => {
    expect(truncate('abcde', 5)).toBe('abcde')
  })

  it('cuts a long string and adds an ellipsis', () => {
    expect(truncate('streamdeckneoclaude', 10)).toBe('streamdec…')
  })

  it('never returns more characters than the limit', () => {
    expect(truncate('streamdeckneoclaude', 10)).toHaveLength(10)
  })

  it('handles a limit of 1', () => {
    expect(truncate('abc', 1)).toBe('…')
  })

  it('handles an empty string', () => {
    expect(truncate('', 5)).toBe('')
  })
})

describe('formatDuration', () => {
  it('shows minutes below an hour', () => {
    expect(formatDuration(14 * 60)).toBe('14m')
  })

  it('shows hours and minutes above an hour', () => {
    expect(formatDuration(2 * 3600 + 11 * 60)).toBe('2h11m')
  })

  it('shows days above a day', () => {
    expect(formatDuration(4 * 86400 + 3600)).toBe('4d1h')
  })

  it('shows 0m for zero', () => {
    expect(formatDuration(0)).toBe('0m')
  })

  it('shows 0m for a negative value', () => {
    expect(formatDuration(-30)).toBe('0m')
  })
})

describe('formatClock', () => {
  it('formats seconds as m:ss', () => {
    expect(formatClock(134)).toBe('2:14')
  })

  it('pads the seconds', () => {
    expect(formatClock(65)).toBe('1:05')
  })

  it('handles over an hour', () => {
    expect(formatClock(3725)).toBe('62:05')
  })
})
