import { describe, it, expect } from 'vitest'
import { truncate, formatDuration, formatClock, formatEasternTime } from '../../src/render/text.js'

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

  it('renders a nonsense timestamp as the unknown sentinel, not a blank string (M10)', () => {
    // `Intl.DateTimeFormat.format(new Date(NaN))` throws `RangeError`. Per
    // AGENTS.md's "treat absent platform signals as unknown," the catch
    // must say so visibly rather than leave the strip's right-hand field
    // looking simply empty.
    expect(formatEasternTime(Number.NaN)).toBe('--')
  })
})
