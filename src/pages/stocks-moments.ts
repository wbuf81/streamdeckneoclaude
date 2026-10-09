/**
 * The stocks page's rare moments: the opening and closing bell, and the
 * first time a symbol crosses +2 % or −2 % in a trading day.
 *
 * The rule both share: a moment fires only on a change this page SAW
 * happen. A daemon started at 11 AM must not ring the opening bell, and a
 * stock already up 3 % at the first quote of the day must not burst — at
 * 9:30 that would be a burst storm, and it would celebrate yesterday's
 * news. So every detector needs a previous observation, and a previous
 * observation older than `OBSERVATION_GAP_MS` (the page was hidden, the Mac
 * slept) does not count as one.
 *
 * Pure apart from its own fields: the clock is the `nowMs` the page passes
 * in, and memory is bounded by the watchlist (one record per symbol) plus a
 * handful of recent events, pruned on every observation.
 */
import type { MarketBoundary, MarketState, Quote } from '../sources/stocks.js'
import { easternDayKey, isFiniteNumber } from './stocks-format.js'

/** How long the strip banner of a bell shows. */
export const BELL_BANNER_MS = 4000
/** How long both round buttons pulse green after the opening bell. */
export const BELL_PULSE_MS = 2000
/** How long line 1 shows the day's best and worst after the close. */
export const CLOSE_SUMMARY_MS = 10 * 60_000
/** How long line 1 announces a big move. */
export const BIG_MOVE_STRIP_MS = 4000
/** The move, in percent, that earns a celebration. */
export const BIG_MOVE_PCT = 2
/** Two observations further apart than this are not one continuous watch. */
export const OBSERVATION_GAP_MS = 5000
/** A boundary seen BEFORE it passed may still ring its bell this long after,
 * which covers a page shown again a moment after the open. */
export const BOUNDARY_GRACE_MS = 10_000

export type BellKind = 'open' | 'close'

export interface Bell {
  kind: BellKind
  /** When the page noticed it: the clock the effects run on. */
  atMs: number
  /** The time the banner prints: the boundary itself when known. */
  labelMs: number
}

export interface BigMove {
  symbol: string
  kind: 'up' | 'down'
  atMs: number
}

interface MoveTrack {
  day: string
  /** The last change percent seen in a continuous watch, or null before the
   * first one of this day (or after a gap). */
  prev: number | null
  fired: Set<'up' | 'down'>
}

export interface Observation {
  nowMs: number
  state: MarketState
  boundary: MarketBoundary | null
  quotes: ReadonlyMap<string, Quote>
  symbols: readonly string[]
  isStale: (symbol: string) => boolean
}

/** The longest any event stays interesting, for pruning. */
const EVENT_TTL_MS = Math.max(BELL_BANNER_MS, BIG_MOVE_STRIP_MS, 1500)

export class StockMoments {
  private lastMs: number | null = null
  private lastState: MarketState | null = null
  private lastBoundary: MarketBoundary | null = null
  /** The Eastern day each bell last rang, so it rings once a day at most. */
  private bellDays: Record<BellKind, string> = { open: '', close: '' }
  private moves = new Map<string, MoveTrack>()
  private bellEvent: Bell | null = null
  private closeAtMs: number | null = null
  private bigMoves: BigMove[] = []

  /** The latest bell, while its banner or its after-effects still matter. */
  get bell(): Bell | null {
    return this.bellEvent
  }

  /** When the closing bell last rang, for the 10-minute summary. */
  get closedAtMs(): number | null {
    return this.closeAtMs
  }

  /** Recent big moves, oldest first. At most one per symbol per direction
   * per day can ever be added, and old ones are pruned. */
  get recentMoves(): readonly BigMove[] {
    return this.bigMoves
  }

  observe(o: Observation): void {
    const { nowMs, state } = o
    if (!isFiniteNumber(nowMs)) return
    const continuous =
      this.lastMs !== null && nowMs >= this.lastMs && nowMs - this.lastMs <= OBSERVATION_GAP_MS

    this.observeBell(o, continuous)
    this.observeMoves(o, continuous)

    this.lastMs = nowMs
    this.lastState = state
    // A null boundary (unknown state) keeps the last real one: the grace
    // window and the once-a-day key already bound what it can do.
    if (o.boundary) this.lastBoundary = o.boundary

    this.bigMoves = this.bigMoves.filter((m) => nowMs - m.atMs < EVENT_TTL_MS && m.atMs <= nowMs)
    if (this.closeAtMs !== null && nowMs - this.closeAtMs >= CLOSE_SUMMARY_MS) this.closeAtMs = null
  }

  private observeBell(o: Observation, continuous: boolean): void {
    const { nowMs, state } = o
    let kind: BellKind | null = null
    const prev = this.lastState
    if (continuous && prev !== null && prev !== state) {
      if (state === 'open' && (prev === 'pre' || prev === 'closed')) kind = 'open'
      else if (prev === 'open' && (state === 'post' || state === 'closed')) kind = 'close'
    }

    // The second route: a boundary seen before it passed, now just behind
    // us, with the state on its far side. Covers a page hidden across the
    // edge for a few seconds, where no transition was watched.
    const b = this.lastBoundary
    const justPassed =
      b !== null && nowMs >= b.atMs && nowMs - b.atMs <= BOUNDARY_GRACE_MS
      && this.lastMs !== null && this.lastMs < b.atMs
    if (kind === null && justPassed && b) {
      if (b.kind === 'open' && state === 'open') kind = 'open'
      else if (b.kind === 'close' && (state === 'post' || state === 'closed')) kind = 'close'
    }
    if (kind === null) return

    // Print the boundary's own time when the page knew it, so the banner
    // says 9:30, not 9:30 and a few hundred milliseconds rounded.
    const near = b !== null && Math.abs(nowMs - b.atMs) <= BOUNDARY_GRACE_MS
      && (b.kind === kind)
    const labelMs = near && b ? b.atMs : nowMs
    const day = easternDayKey(labelMs)
    if (day === '' || this.bellDays[kind] === day) return
    this.bellDays[kind] = day
    this.bellEvent = { kind, atMs: nowMs, labelMs }
    if (kind === 'close') this.closeAtMs = nowMs
    else this.closeAtMs = null
  }

  private observeMoves(o: Observation, continuous: boolean): void {
    const { nowMs, state, quotes, symbols, isStale } = o
    const today = easternDayKey(nowMs)
    const wanted = new Set(symbols)
    for (const symbol of this.moves.keys()) {
      if (!wanted.has(symbol)) this.moves.delete(symbol)
    }

    for (const symbol of symbols) {
      let track = this.moves.get(symbol)
      if (!track || track.day !== today) {
        track = { day: today, prev: null, fired: new Set() }
        this.moves.set(symbol, track)
      }
      if (!continuous) track.prev = null

      const q = quotes.get(symbol)
      const cp = q?.changePercent
      // Only a fresh quote from TODAY's session, while the market trades,
      // can cross a line. Yesterday's quote, a stale one, or a pre-market
      // reading carries no crossing worth celebrating.
      const usable =
        state === 'open' && q !== undefined && isFiniteNumber(cp) && !isStale(symbol)
        && q.asOf > 0 && easternDayKey(q.asOf * 1000) === today
      if (!usable || !isFiniteNumber(cp)) continue

      const prev = track.prev
      track.prev = cp
      if (prev === null) continue
      if (prev < BIG_MOVE_PCT && cp >= BIG_MOVE_PCT && !track.fired.has('up')) {
        track.fired.add('up')
        this.bigMoves.push({ symbol, kind: 'up', atMs: nowMs })
      }
      if (prev > -BIG_MOVE_PCT && cp <= -BIG_MOVE_PCT && !track.fired.has('down')) {
        track.fired.add('down')
        this.bigMoves.push({ symbol, kind: 'down', atMs: nowMs })
      }
    }
  }
}
