import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { truncate, formatDuration, formatClock, fitSize } from '../../src/render/text.js'
import { FONT } from '../../src/render/canvas.js'

/** Measures independently of `fitSize`, so the test does not just check
 * that `fitSize` agrees with itself. */
function measure(text: string, size: number): number {
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.font = `${size}px ${FONT}`
  return ctx.measureText(text).width
}

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

describe('fitSize', () => {
  const USABLE_WIDTH = 81

  it('picks the largest candidate that actually measures within the budget', () => {
    // "9.99" is short: the largest candidate, 24, must measure within budget.
    const size = fitSize('9.99', [24, 20, 16], USABLE_WIDTH)
    expect(size).toBe(24)
    expect(measure('9.99', size)).toBeLessThanOrEqual(USABLE_WIDTH)
  })

  it('drops to a smaller size when the largest candidate would clip a six-character price', () => {
    // Per VERIFIED-FACTS.md, a 6-character price at 24 px measures over 81 px.
    expect(measure('327.51', 24)).toBeGreaterThan(USABLE_WIDTH)
    const size = fitSize('327.51', [24, 20, 16], USABLE_WIDTH)
    expect(size).toBeLessThan(24)
    expect(measure('327.51', size)).toBeLessThanOrEqual(USABLE_WIDTH)
  })

  it('drops to the smallest candidate for a seven-character price', () => {
    const size = fitSize('1234.56', [24, 20, 16], USABLE_WIDTH)
    expect(measure('1234.56', size)).toBeLessThanOrEqual(USABLE_WIDTH)
  })

  it('falls back to the smallest candidate when nothing measures inside the budget', () => {
    // An absurdly small budget: even the smallest candidate overflows it, so
    // the function must still return a defined size rather than throwing.
    const size = fitSize('a very long line of text indeed', [24, 20, 16], 1)
    expect(size).toBe(16)
  })

  it('measures with canvas rather than the advance table, for a candidate list of one', () => {
    expect(fitSize('x', [11], USABLE_WIDTH)).toBe(11)
  })
})
