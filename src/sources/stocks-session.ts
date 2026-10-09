import type { MarketState } from './stocks.js'

/**
 * Pure market-session logic for the stocks source. Nothing here reads the
 * wall clock, the network, or any state: every function takes the time it
 * judges as an argument, in epoch SECONDS (the unit Yahoo's windows use).
 *
 * Why this exists: the source used to compute the market state ONCE, at
 * fetch time, and store the answer. Between fetches the stored answer aged.
 * With a 15-minute closed-market poll, `PRE` stayed on the deck until about
 * 9:45 AM. The state is now derived at READ time from the windows the
 * upstream sent, so it flips on the boundary second whether or not a fetch
 * happened then.
 */

/** One `[start, end)` session window, in epoch seconds. */
export interface SessionWindow {
  start: number
  end: number
}

/**
 * `meta.currentTradingPeriod`, validated. A missing or malformed window is
 * `null`; it never becomes a guessed one. Live probe, MSFT, 2026-10-09
 * (a normal Friday, EDT): pre 04:00-09:30, regular 09:30-16:00, post
 * 16:00-20:00, each end equal to the next start.
 */
export interface TradingPeriod {
  pre: SessionWindow | null
  regular: SessionWindow | null
  post: SessionWindow | null
}

export type MarketBoundaryKind =
  | 'pre-start'
  | 'pre-end'
  | 'open'
  | 'close'
  | 'post-start'
  | 'post-end'

/**
 * The next edge of a window the upstream actually reported. `atMs` is epoch
 * milliseconds. `next` is the state the market enters at that instant.
 */
export interface MarketBoundary {
  kind: MarketBoundaryKind
  atMs: number
  next: MarketState
}

const EASTERN_TZ = 'America/New_York'

/**
 * The earliest local times at which a US equity session can start: Yahoo's
 * pre-market at 04:00, and the regular open at 09:30 for an instrument that
 * reports no pre window. These are NEVER used to claim a state. They mark
 * the instants at which a "closed" reading taken earlier stops being proof,
 * and at which the source fetches to learn the new day's windows. Every
 * day counts, weekends and holidays included: skipping a day would be
 * inferring "closed" from a calendar instead of from the upstream.
 */
const CANDIDATE_STARTS: ReadonlyArray<{ hour: number; minute: number }> = [
  { hour: 4, minute: 0 },
  { hour: 9, minute: 30 },
]

function parseWindow(v: unknown): SessionWindow | null {
  if (!v || typeof v !== 'object') return null
  const start = (v as Record<string, unknown>).start
  const end = (v as Record<string, unknown>).end
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return { start, end }
}

/** Validates a raw `currentTradingPeriod`. Null when no window is usable. */
export function parsePeriod(raw: unknown): TradingPeriod | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const period: TradingPeriod = {
    pre: parseWindow(p.pre),
    regular: parseWindow(p.regular),
    post: parseWindow(p.post),
  }
  if (!period.pre && !period.regular && !period.post) return null
  return period
}

function within(w: SessionWindow | null, t: number): boolean {
  return w !== null && t >= w.start && t < w.end
}

/** The window that covers `t`, or null when `t` is outside every one. */
function windowStateAt(p: TradingPeriod, t: number): 'open' | 'pre' | 'post' | null {
  if (within(p.regular, t)) return 'open'
  if (within(p.pre, t)) return 'pre'
  if (within(p.post, t)) return 'post'
  return null
}

function windows(p: TradingPeriod): SessionWindow[] {
  return [p.pre, p.regular, p.post].filter((w): w is SessionWindow => w !== null)
}

function edgesOf(p: TradingPeriod): number[] {
  return windows(p).flatMap((w) => [w.start, w.end])
}

function lastEnd(p: TradingPeriod): number {
  return Math.max(...windows(p).map((w) => w.end))
}

let partsFormatter: Intl.DateTimeFormat | null = null

/** Eastern wall-clock fields of epoch second `t`. */
function easternParts(t: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  partsFormatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  const out: Record<string, number> = {}
  for (const part of partsFormatter.formatToParts(new Date(t * 1000))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  return {
    y: out.year ?? 0, mo: out.month ?? 1, d: out.day ?? 1,
    h: out.hour ?? 0, mi: out.minute ?? 0, s: out.second ?? 0,
  }
}

/** Eastern UTC offset at epoch second `t`, in seconds (-14400 in EDT). */
function easternOffset(t: number): number {
  const p = easternParts(t)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000 - Math.floor(t)
}

/**
 * The epoch second of an Eastern wall-clock time. Uses the zone, never a
 * fixed offset, so 04:00 is 08:00Z in summer and 09:00Z in winter. The
 * candidate times (04:00, 09:30) never fall in the 02:00-03:00 DST gap.
 */
export function easternEpoch(y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi) / 1000
  let t = naive - easternOffset(naive)
  t = naive - easternOffset(t)
  return t
}

let candidateCache: number[] | null = null

/**
 * Every candidate session start on the Eastern dates around `t`, sorted.
 * The list spans five days, so it is reused while `t` sits at least two
 * candidates in from either end: then the next and the previous candidate
 * of `t` are both inside it. The state is read every render and every
 * heartbeat, and each fresh list costs about twenty `Intl` calls.
 */
function candidatesAround(t: number): number[] {
  const c = candidateCache
  if (c && t >= c[2]! && t <= c[c.length - 3]!) return c
  const p = easternParts(t)
  const out: number[] = []
  for (let offset = -2; offset <= 2; offset++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + offset))
    for (const c of CANDIDATE_STARTS) {
      out.push(easternEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), c.hour, c.minute))
    }
  }
  candidateCache = out.sort((a, b) => a - b)
  return candidateCache
}

/** The first candidate session start strictly after `t`. */
export function nextCandidateStart(t: number): number {
  return candidatesAround(t).find((c) => c > t) ?? Number.POSITIVE_INFINITY
}

/** The last candidate session start at or before `t`. */
export function prevCandidateStart(t: number): number {
  const before = candidatesAround(t).filter((c) => c <= t)
  return before[before.length - 1] ?? Number.NEGATIVE_INFINITY
}

/**
 * The market state at `now`, judged from the windows a fetch that STARTED
 * at `measuredAt` returned.
 *
 * - No usable window: `'unknown'` (lesson 18 — a signal that never arrived).
 * - Inside a window: that window's state. The windows are absolute epochs,
 *   so they stay true however old the fetch is; an early-close day is just
 *   a shorter regular window.
 * - Before a reported window starts: `'closed'` — the upstream said when
 *   the next session begins.
 * - Past every reported window: `'closed'` only until the next candidate
 *   session start after the later of `measuredAt` and the last window end.
 *   After that instant a new day may have begun, and these windows cannot
 *   say so. The answer is `'unknown'`, never a stale `'closed'`, until a
 *   fetch brings the new windows.
 */
export function deriveSessionState(
  period: TradingPeriod | null, measuredAt: number, now: number,
): MarketState {
  if (!period) return 'unknown'
  const inside = windowStateAt(period, now)
  if (inside) return inside
  if (windows(period).some((w) => w.start > now)) return 'closed'
  const ref = Math.max(measuredAt, lastEnd(period))
  return nextCandidateStart(ref) > now ? 'closed' : 'unknown'
}

/**
 * The next instant after `lastPollAt` at which the source must fetch: the
 * next reported window edge, or, once every reported window has ended, the
 * next candidate session start (the earliest moment new windows can exist).
 * Edges after `lastPollAt`, not after now: an edge that passed while the
 * Mac slept, or while a fetch was in flight, is still owed its fetch.
 */
export function nextPollEdge(period: TradingPeriod | null, lastPollAt: number): number | null {
  if (!period) return null
  const edges = edgesOf(period).filter((e) => e > lastPollAt)
  if (edges.length > 0) return Math.min(...edges)
  return nextCandidateStart(Math.max(lastPollAt, lastEnd(period)))
}

/**
 * True when every reported window has ended and a candidate session start
 * passed less than `graceSeconds` ago. The upstream may roll its windows to
 * the new day a little after the edge, so the source polls faster here
 * instead of waiting a full closed-market interval to notice.
 */
export function inStartGrace(period: TradingPeriod | null, now: number, graceSeconds: number): boolean {
  if (!period) return false
  if (windowStateAt(period, now)) return false
  if (windows(period).some((w) => w.start > now)) return false
  return now - prevCandidateStart(now) < graceSeconds
}

/**
 * The next reported window edge strictly after `now`, or null. Only real
 * upstream edges count — a candidate start is a guess and never shows as a
 * countdown. Null too while the state is `'unknown'`.
 */
export function nextBoundary(
  period: TradingPeriod | null, measuredAt: number, now: number,
): MarketBoundary | null {
  if (!period) return null
  if (deriveSessionState(period, measuredAt, now) === 'unknown') return null
  const edges = edgesOf(period).filter((e) => e > now)
  if (edges.length === 0) return null
  const at = Math.min(...edges)
  const { pre, regular, post } = period
  const kind: MarketBoundaryKind =
    regular?.start === at ? 'open'
      : regular?.end === at ? 'close'
        : pre?.start === at ? 'pre-start'
          : post?.end === at ? 'post-end'
            : pre?.end === at ? 'pre-end'
              : 'post-start'
  return { kind, atMs: at * 1000, next: windowStateAt(period, at) ?? 'closed' }
}
