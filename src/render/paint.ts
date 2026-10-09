/**
 * The small drawing vocabulary every render module shares: the device
 * geometry, the two fonts, the dim fraction, and the colour and number
 * helpers.
 *
 * It lives in its own module so `canvas.ts` and the newer primitive modules
 * (`spark.ts`, `overlays.ts`, `mascots.ts`) use ONE copy. Two copies of
 * `css` or `pseudoRandom` would drift, and family drift is this project's
 * dominant defect pattern (docs/LESSONS.md, lesson 21). `canvas.ts`
 * re-exports the public names, so no existing import changes.
 */
import type { Rgb } from './specs.js'

export const KEY_SIZE = 96
export const STRIP_WIDTH = 248
export const STRIP_HEIGHT = 58

/** Exported so `text.ts` can measure with the exact same font the renderer
 * uses. Two different font names would make a measurement meaningless. */
export const FONT = 'Menlo'
/** The one colour-emoji font. See `canvas.ts`'s `EMOJI_SIZE` comment. */
export const EMOJI_FONT = 'Apple Color Emoji'
export const PAD = 6
export const BORDER = 3

/** Dims a colour, or a colour emoji's `globalAlpha`, to this fraction. One
 * constant so text, border and emoji all dim by the same amount. */
export const DIM_FACTOR = 0.45

export function css(c: Rgb, dim = false): string {
  const f = dim ? DIM_FACTOR : 1
  return `rgb(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)})`
}

/** Same colour rule as `css`, but with an explicit alpha channel. */
export function cssAlpha(c: Rgb, alpha: number, dim = false): string {
  const f = dim ? DIM_FACTOR : 1
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0
  return `rgba(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)},${a})`
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Returns `n` when it is a finite number, otherwise `fallback`. `NaN` and
 * `+/-Infinity` are both valid `number`s at the type level, so this is a
 * runtime check, not something the type system can rule out for us. */
export function finiteOr(n: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

/**
 * Deterministic pseudo-random value in [0, 1) from an integer seed. No
 * internal state and never `Math.random()` — the same seed always returns
 * the same value, which is what lets two renders at the same `nowMs`
 * produce byte-identical frames (lesson 11 in docs/LESSONS.md).
 */
export function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/** A colour with every channel coerced to a finite 0..255 integer. A hostile
 * colour must not reach a CSS string as `NaN`. */
export function safeRgb(c: Rgb | undefined, fallback: Rgb): Rgb {
  if (!Array.isArray(c) || c.length < 3) return fallback
  const ch = (n: number, f: number): number =>
    Math.round(Math.min(255, Math.max(0, finiteOr(n, f))))
  return [ch(c[0], fallback[0]), ch(c[1], fallback[1]), ch(c[2], fallback[2])]
}
