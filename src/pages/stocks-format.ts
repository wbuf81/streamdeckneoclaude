/**
 * Small pure helpers for the stocks page: direction, colour and the text
 * formats. Nothing here reads a clock, a canvas or the network.
 *
 * They live apart from `stocks-page.ts` so that the tile, the tape, the strip
 * and the detail view all read ONE definition of "up", one sign convention
 * and one price format (lesson 21: one decision, one function).
 */
import type { Rgb } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { formatDuration } from '../render/text.js'

export type Trend = 'up' | 'down' | 'flat' | 'unknown'

export function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

export function trendOf(changePercent: number | null | undefined): Trend {
  if (!isFiniteNumber(changePercent)) return 'unknown'
  if (changePercent > 0) return 'up'
  if (changePercent < 0) return 'down'
  return 'flat'
}

export function trendColor(trend: Trend): Rgb {
  if (trend === 'up') return theme.green
  if (trend === 'down') return theme.red
  return theme.gray
}

/** The real minus sign, U+2212. Measured: Menlo draws it at the same 7.83 px
 * advance as every ASCII character at 13 px, so the tape's width arithmetic
 * stays exact (see `stocks-tape.ts`). */
export const MINUS = '−'

/** `123.5` becomes `123.50`. Never NaN, because it checks finiteness first. */
export function formatPrice(price: number | null | undefined): string {
  return isFiniteNumber(price) ? price.toFixed(2) : '--'
}

/**
 * A price for a narrow slot that shares its row with a symbol: two decimals
 * below 1000, one below 10 000, none above. At most 6 characters for any
 * price under a million, so `GOOGL` plus the price fit one 81 px row at
 * 11 px (11 characters at 6.62 px is 73 px).
 */
export function formatShortPrice(price: number | null | undefined): string {
  if (!isFiniteNumber(price)) return '--'
  const abs = Math.abs(price)
  if (abs < 1000) return price.toFixed(2)
  if (abs < 10_000) return price.toFixed(1)
  return price.toFixed(0)
}

/** `-2.144` becomes `−2.14%`, `3.41` becomes `+3.41%`, a move that rounds to
 * zero becomes `0.00%` (no sign: a "loss" of nothing is self-contradictory).
 * Unknown becomes `--`. */
export function formatSignedPct(changePercent: number | null | undefined): string {
  if (!isFiniteNumber(changePercent)) return '--'
  const magnitude = Math.abs(changePercent).toFixed(2)
  if (magnitude === '0.00') return '0.00%'
  return `${changePercent < 0 ? MINUS : '+'}${magnitude}%`
}

/** `price - previousClose` as a signed amount: `−5.30`, `+5.30`, `0.00`.
 * `--` when either side is unknown. The sign comes from the ROUNDED
 * magnitude, so a tiny negative diff never prints `−0.00` (M8). */
export function formatChangeValue(
  price: number | null | undefined, previousClose: number | null | undefined,
): string {
  if (!isFiniteNumber(price) || !isFiniteNumber(previousClose)) return '--'
  const diff = price - previousClose
  const magnitude = Math.abs(diff).toFixed(2)
  if (magnitude === '0.00') return '0.00'
  return `${diff < 0 ? MINUS : '+'}${magnitude}`
}

/** `38_200_000` becomes `38.2M`. `--` for unknown or negative, never `0`
 * standing in for a missing reading. */
export function formatVolume(volume: number | null | undefined): string {
  if (!isFiniteNumber(volume) || volume < 0) return '--'
  const units: readonly [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [size, suffix] of units) {
    if (volume >= size) {
      const v = volume / size
      return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${suffix}`
    }
  }
  return volume.toFixed(0)
}

/**
 * Where `value` sits inside `lo..hi`, as a whole percent clamped to 0..100,
 * or null when the range is unknown or empty. ONE function for the gauge's
 * caption, so the caption and the marker cannot disagree about NaN.
 */
export function rangePercent(
  lo: number | null | undefined, hi: number | null | undefined, value: number | null | undefined,
): number | null {
  if (!isFiniteNumber(lo) || !isFiniteNumber(hi) || !isFiniteNumber(value)) return null
  if (hi <= lo) return null
  return Math.round(Math.min(1, Math.max(0, (value - lo) / (hi - lo))) * 100)
}

/** A countdown, a DURATION and never a timestamp: `2h14m`, `9m`, `<1m`.
 * Goes through the shared `formatDuration`, so it changes at most once a
 * minute and the strip is not rewritten every second for it. */
export function formatCountdown(ms: number): string {
  if (!isFiniteNumber(ms) || ms <= 0) return '0m'
  if (ms < 60_000) return '<1m'
  return formatDuration(Math.floor(ms / 1000))
}

let dayFormatter: Intl.DateTimeFormat | null = null

/**
 * The US Eastern calendar date of `epochMs`, as `2026-10-09`. An identity
 * for "one trading day", never displayed. Eastern because the exchange
 * trades Eastern hours: a celebration fired at 3 PM Pacific is still that
 * Eastern day. `''` for a non-finite input, which never equals a real day.
 */
export function easternDayKey(epochMs: number): string {
  if (!isFiniteNumber(epochMs)) return ''
  dayFormatter ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  try {
    return dayFormatter.format(new Date(epochMs))
  } catch {
    return ''
  }
}

/** Scales a colour's channels by `level`, clamped to 0..1. */
export function scaleRgb(c: Rgb, level: number): Rgb {
  const k = Math.min(1, Math.max(0, isFiniteNumber(level) ? level : 0))
  return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)]
}
