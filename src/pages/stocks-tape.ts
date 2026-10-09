/**
 * The stocks ticker tape's motion: scroll one segment, then HOLD with a
 * whole quote at the left edge, so a glance always lands on a readable
 * quote instead of two half ones.
 *
 * Pure and clock-driven: the position is a function of `nowMs` alone, so a
 * test passes a fixed clock and gets a fixed frame.
 *
 * WHY THE PAGE KNOWS A FONT ADVANCE. To stop exactly on a segment boundary
 * the page needs each segment's width, and a page must not touch a canvas.
 * The tape font is 13 px Menlo, which is monospaced, and every character a
 * segment can contain (ASCII, `·`, and the U+2212 minus) measures the same
 * 7.83 px advance — measured with `@napi-rs/canvas`, not reasoned (lesson
 * 17). A test in `tests/pages/stocks-tape.test.ts` checks this constant
 * against `tapeLoopWidthPx`, the renderer's own measurement, so a font
 * change fails a test instead of drifting the hold position.
 *
 * The estimate cannot accumulate error: every hold restarts at offset 0
 * with the segment list ROTATED so the held quote comes first. A wrong
 * advance would cost one small jump at the end of one scroll, never a slow
 * creep across the loop.
 */
import type { TapeSegment, TapeSpec } from '../render/specs.js'

/** Measured: one 13 px Menlo character, in px. */
export const TAPE_CHAR_PX = 7.83
/** The renderer's `TAPE_SEPARATOR` (`'  ·  '`) is 5 characters. */
export const TAPE_SEPARATOR_CHARS = 5

export interface TapePace {
  /** How long a quote rests at the left edge. */
  holdMs: number
  /** How long one segment takes to scroll past. */
  scrollMs: number
  /** Ease-out (true) for the live tape, linear crawl (false) when closed. */
  ease: boolean
  /** The tape's clock is floored to this many ms, so it changes at most
   * once per quantum however fast the page ticks. 0 for none. */
  quantumMs: number
}

/**
 * While the market trades: 1.5 s hold, then a 1.1 s eased scroll — the
 * mockup's 2.6 s cycle. At the 40 ms tick that is about 28 strip writes per
 * 2.6 s, roughly 11 a second, against the 25 a second the old continuous
 * tape cost.
 */
export const LIVE_PACE: TapePace = { holdMs: 1500, scrollMs: 1100, ease: true, quantumMs: 0 }

/**
 * Closed or unknown: a 5 s hold, then a 4 s linear crawl that steps every
 * 200 ms. That is at most 20 strip writes per 9 s, about 2.2 a second,
 * against 25 a second all night before — and the quantum holds even while
 * the page ticks fast for a one-shot. Nothing is trading, so the tape only
 * has to stay reachable, not lively.
 */
export const CRAWL_PACE: TapePace = { holdMs: 5000, scrollMs: 4000, ease: false, quantumMs: 200 }

/** The width one segment occupies on the tape, separator included. Counts
 * code points, so a surrogate pair would count once — none is ever used. */
export function segmentWidthPx(text: string): number {
  return ([...text].length + TAPE_SEPARATOR_CHARS) * TAPE_CHAR_PX
}

function easeOutCubic(p: number): number {
  const x = Math.min(1, Math.max(0, p))
  return 1 - Math.pow(1 - x, 3)
}

/**
 * The tape at `nowMs`: the segments rotated so the current quote leads, and
 * an offset that is 0 during the hold and grows to that quote's width
 * during the scroll. The offset is a whole pixel, so every frame of a hold
 * hashes identically and the daemon writes the strip once per hold.
 */
export function snapTape(segments: readonly TapeSegment[], nowMs: number, pace: TapePace): TapeSpec {
  const n = segments.length
  if (n === 0 || !Number.isFinite(nowMs)) return { segments: [...segments], offsetPx: 0 }
  const cycle = pace.holdMs + pace.scrollMs
  const t = pace.quantumMs > 0 ? Math.floor(nowMs / pace.quantumMs) * pace.quantumMs : nowMs
  const k = Math.floor(t / cycle)
  const phase = t - k * cycle
  const i = ((k % n) + n) % n
  const rotated = [...segments.slice(i), ...segments.slice(0, i)]
  if (phase < pace.holdMs) return { segments: rotated, offsetPx: 0 }
  const p = (phase - pace.holdMs) / pace.scrollMs
  const travel = pace.ease ? easeOutCubic(p) : Math.min(1, Math.max(0, p))
  return { segments: rotated, offsetPx: Math.round(segmentWidthPx(segments[i]!.text) * travel) }
}
