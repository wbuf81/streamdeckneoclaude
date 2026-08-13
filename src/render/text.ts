import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import { FONT } from './canvas.js'

const ELLIPSIS = '…'

/** A throwaway 1x1 canvas, kept alive for repeated measurement calls. It is
 * never drawn on, only measured against, so its size does not matter. */
let measureCtx: SKRSContext2D | null = null

function ctx(): SKRSContext2D {
  measureCtx ??= createCanvas(1, 1).getContext('2d')
  return measureCtx
}

/**
 * Picks the largest size in `candidates` whose rendered width for `text`
 * measures at or under `maxWidth`, using the SAME font `renderKey` draws
 * with — a size chosen with a different font could still clip. Candidates
 * are tried largest first. When none fits, this returns the smallest
 * candidate rather than throwing: an oversized line is a smaller defect than
 * a page that crashes.
 */
export function fitSize(text: string, candidates: number[], maxWidth: number): number {
  const c = ctx()
  const sorted = [...candidates].sort((a, b) => b - a)
  for (const size of sorted) {
    c.font = `${size}px ${FONT}`
    if (c.measureText(text).width <= maxWidth) return size
  }
  return sorted[sorted.length - 1] ?? 0
}

/**
 * Cuts a string to `max` characters. The result never exceeds `max`, because
 * the ellipsis replaces the last kept character.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1) + ELLIPSIS
}

/** Formats a duration in seconds as `14m`, `2h11m`, or `4d1h`. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

/** Formats a playback position in seconds as `2:14`. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
