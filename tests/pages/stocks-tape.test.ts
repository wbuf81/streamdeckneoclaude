import { describe, it, expect } from 'vitest'
import { snapTape, segmentWidthPx, LIVE_PACE, CRAWL_PACE, TAPE_CHAR_PX } from '../../src/pages/stocks-tape.js'
import { tapeLoopWidthPx, renderStrip, STRIP_WIDTH } from '../../src/render/canvas.js'
import type { TapeSegment } from '../../src/render/specs.js'

/** The widest realistic segments: 5-letter symbols, 4- to 6-digit prices,
 * both signs, the flat case, and the `--` unknown change. */
const SEGMENTS: TapeSegment[] = [
  { text: 'SPY 641.18 −2.14%' },
  { text: 'GOOGL 1234.56 +12.34%' },
  { text: 'BRK-B 471.10 0.00%' },
  { text: 'NVDA 188.92 +3.41%' },
  { text: 'XYZ 9.05 --' },
]

describe('stocks tape: the page-side width matches the renderer', () => {
  it('estimates every segment within half a pixel of the renderer measurement', () => {
    // The hold stops on a segment boundary only if this holds. A font or
    // separator change in the renderer fails here instead of drifting.
    for (const seg of SEGMENTS) {
      expect(Math.abs(segmentWidthPx(seg.text) - tapeLoopWidthPx([seg]))).toBeLessThan(0.5)
    }
  })

  it('pins the measured advance', () => {
    expect(TAPE_CHAR_PX).toBeCloseTo(7.83, 2)
  })
})

describe('stocks tape: scroll one quote, then hold', () => {
  const T0 = 1_786_549_560_000 - (1_786_549_560_000 % (LIVE_PACE.holdMs + LIVE_PACE.scrollMs))

  it('holds at offset 0 for the whole hold, with the current quote first', () => {
    for (const dt of [0, 500, LIVE_PACE.holdMs - 1]) {
      const t = snapTape(SEGMENTS, T0 + dt, LIVE_PACE)
      expect(t.offsetPx).toBe(0)
    }
  })

  it('rotates one segment per cycle, so each quote gets its turn at the left edge', () => {
    const cycle = LIVE_PACE.holdMs + LIVE_PACE.scrollMs
    const leads = Array.from({ length: SEGMENTS.length }, (_, k) => snapTape(SEGMENTS, T0 + k * cycle, LIVE_PACE).segments[0]!.text)
    expect(new Set(leads).size).toBe(SEGMENTS.length)
    // Next in order: the segment after the lead is the next cycle's lead.
    const a = snapTape(SEGMENTS, T0, LIVE_PACE)
    const b = snapTape(SEGMENTS, T0 + cycle, LIVE_PACE)
    expect(b.segments[0]).toEqual(a.segments[1])
  })

  it('ends each scroll exactly where the next hold begins', () => {
    const cycle = LIVE_PACE.holdMs + LIVE_PACE.scrollMs
    const end = snapTape(SEGMENTS, T0 + cycle - 1, LIVE_PACE)
    expect(end.offsetPx).toBe(Math.round(segmentWidthPx(end.segments[0]!.text)))
  })

  it('draws the same pixels on both sides of the snap (region probe of the tape band)', () => {
    const cycle = LIVE_PACE.holdMs + LIVE_PACE.scrollMs
    const before = renderStrip({ lines: ['x'], tape: snapTape(SEGMENTS, T0 + cycle - 1, LIVE_PACE) })
    const after = renderStrip({ lines: ['x'], tape: snapTape(SEGMENTS, T0 + cycle, LIVE_PACE) })
    // The ink profile of line 2's band, column by column, and the shift
    // that best lines the two frames up. Rounding may move the tape by under
    // a pixel; a wrong boundary (a wrong advance) moves it by whole glyphs.
    const profile = (buf: Buffer): number[] => Array.from({ length: STRIP_WIDTH }, (_, x) => {
      let sum = 0
      for (let y = 18; y < 38; y++) sum += buf[(y * STRIP_WIDTH + x) * 4]!
      return sum
    })
    const pa = profile(before)
    const pb = profile(after)
    let best = 0
    let bestCost = Infinity
    for (let shift = -12; shift <= 12; shift++) {
      let cost = 0
      for (let x = 20; x < STRIP_WIDTH - 20; x++) cost += Math.abs(pa[x]! - pb[x + shift]!)
      if (cost < bestCost) { bestCost = cost; best = shift }
    }
    expect(Math.abs(best)).toBeLessThanOrEqual(1)
  })

  it('writes far fewer distinct frames when closed, at the page\'s closed tick', () => {
    // The old continuous tape changed on every 40 ms frame: 225 strip writes
    // per 9 s. The crawl, sampled at the 100 ms closed tick, changes only
    // during its 4 s scroll.
    const distinct = (pace: typeof LIVE_PACE, tick: number): number => {
      const seen = new Set<string>()
      for (let t = 0; t < 9000; t += tick) seen.add(JSON.stringify(snapTape(SEGMENTS, T0 + t, pace)))
      return seen.size
    }
    expect(distinct(CRAWL_PACE, 100)).toBeLessThanOrEqual(45)
    expect(distinct(LIVE_PACE, 40)).toBeLessThanOrEqual(110)
  })

  it('returns an empty tape unchanged and survives a non-finite clock', () => {
    expect(snapTape([], 5, LIVE_PACE)).toEqual({ segments: [], offsetPx: 0 })
    expect(snapTape(SEGMENTS, Number.NaN, LIVE_PACE).offsetPx).toBe(0)
  })
})
