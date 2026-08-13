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

/** The one US Eastern zone every page's wall-clock display uses. Never a
 * fixed offset, so the switch between standard and daylight time is
 * automatic. */
const EASTERN_TZ = 'America/New_York'

/**
 * Formats `epochMs` as a wall-clock timestamp in US Eastern time: a 12-hour
 * clock with `AM` or `PM`, plus the REAL zone abbreviation for that date —
 * `EDT` in summer, `EST` in winter. This is the ONE timestamp formatter for
 * the whole project (see `AGENTS.md`'s "Product conventions"). Every page's
 * wall-clock display must go through it instead of hand-rolling a second
 * one — four different ones had already grown before this rule existed.
 *
 * A **duration** — elapsed or remaining time, like `formatClock` or
 * `formatDuration` — is not a timestamp and must never be passed through
 * here or gain AM/PM.
 *
 * Pass `zone: false` to drop the trailing abbreviation on a key where every
 * character counts. AM/PM stays either way, per the user's decision.
 *
 * Never throws: a formatting failure costs a blank string, not a lost
 * render.
 */
export function formatEasternTime(epochMs: number, { zone = true }: { zone?: boolean } = {}): string {
  try {
    const d = new Date(epochMs)
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: EASTERN_TZ,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d)
    return zone ? `${time} ${easternZoneAbbr(d)}` : time
  } catch {
    return ''
  }
}

/** The real Eastern zone abbreviation for `d` — `EDT` or `EST`, whichever
 * the date actually falls under. Never hard-coded: the user asked for
 * "EST", meaning Eastern, and printing `EST` in July would be wrong. Falls
 * back to `ET` if the platform's data omits the short name, so the string
 * stays informative rather than going blank. */
function easternZoneAbbr(d: Date): string {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TZ,
    timeZoneName: 'short',
  })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')
  return part?.value ?? 'ET'
}
