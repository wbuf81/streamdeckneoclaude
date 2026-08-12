const ELLIPSIS = '…'

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
