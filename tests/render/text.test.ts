import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { truncate, formatDuration, formatClock, fitSize, formatEasternTime } from '../../src/render/text.js'
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

describe('formatEasternTime', () => {
  // Every case below is a FIXED epoch, never `Date.now()`, so the assertion
  // stays true on any machine and does not flip in November when the zone
  // switches — per docs/LESSONS.md #17 and the project's "Product
  // conventions" (AGENTS.md).

  it('renders a summer instant with EDT, not a hard-coded EST', () => {
    // 2026-07-15 20:05 UTC is 4:05 PM Eastern Daylight Time.
    expect(formatEasternTime(1784145900000)).toBe('4:05 PM EDT')
  })

  it('renders a winter instant with EST', () => {
    // 2026-01-15 21:05 UTC is 4:05 PM Eastern Standard Time.
    expect(formatEasternTime(1768511100000)).toBe('4:05 PM EST')
  })

  it('renders midnight as 12:00 AM, not 0:00 AM', () => {
    // 2026-01-15 05:00 UTC is midnight Eastern Standard Time.
    expect(formatEasternTime(1768453200000)).toBe('12:00 AM EST')
  })

  it('renders noon as 12:00 PM', () => {
    // 2026-01-15 17:00 UTC is noon Eastern Standard Time.
    expect(formatEasternTime(1768496400000)).toBe('12:00 PM EST')
  })

  it('drops the zone abbreviation when asked, but keeps AM/PM', () => {
    expect(formatEasternTime(1784145900000, { zone: false })).toBe('4:05 PM')
  })

  it('never throws, even for a nonsense timestamp', () => {
    expect(() => formatEasternTime(Number.NaN)).not.toThrow()
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

  it('measures each candidate rather than assuming the largest always fits', () => {
    // T1 from the review: a single-candidate list is vacuous — it returns
    // that candidate under ANY implementation, including one that never
    // measures anything at all. A string that fits at 16 px but not at
    // 24 px (both verified below, independently of fitSize) forces the
    // function to actually measure and REJECT the larger candidate before
    // it can return the smaller one.
    expect(measure('1234.56', 24)).toBeGreaterThan(USABLE_WIDTH)
    expect(measure('1234.56', 16)).toBeLessThanOrEqual(USABLE_WIDTH)
    expect(fitSize('1234.56', [24, 16], USABLE_WIDTH)).toBe(16)
  })
})
