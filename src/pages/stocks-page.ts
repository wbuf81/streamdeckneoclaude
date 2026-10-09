import type { DeckFrame, KeySpec, OneShotSpec, Rgb, StripBanner, StripSpec, TapeSegment } from '../render/specs.js'
import { theme, blend } from '../render/theme.js'
import { breathe } from '../render/motion.js'
import { truncate, formatEasternTime } from '../render/text.js'
import type { Page, PressOutcome } from './types.js'
import type { MarketBoundary, MarketState, Quote, StockStatus, YearlyState } from '../sources/stocks.js'
import { downsample, YEARLY_REFRESH_SECONDS } from '../sources/stocks.js'
import {
  type Trend, trendOf, trendColor, isFiniteNumber, formatPrice, formatShortPrice, formatSignedPct,
  formatChangeValue, formatVolume, rangePercent, formatCountdown, scaleRgb,
} from './stocks-format.js'
import { snapTape, LIVE_PACE, CRAWL_PACE } from './stocks-tape.js'
import {
  StockMoments, BELL_BANNER_MS, BELL_PULSE_MS, BIG_MOVE_STRIP_MS, CLOSE_SUMMARY_MS,
} from './stocks-moments.js'

export { trendOf } from './stocks-format.js'

/**
 * How many points the tile's line spark keeps. A line needs more points than
 * the old 12 bars to look like a day rather than a staircase; 48 is about two
 * pixels per point across the 81 px band.
 */
const TILE_SPARK_POINTS = 48
/** The detail chart spans three keys, about 250 px: two to three px a point. */
const DETAIL_SPARK_POINTS = 96
/** Measured limit for one strip line. See `render/canvas.ts`. */
const STRIP_CHARS = 30
/**
 * The tile spark's smallest half-range, as a fraction of the previous close.
 * A 0.1 percent day drawn against a ±1 percent scale looks nearly flat,
 * which is the truth; without it every wiggle stretches to fill the band
 * and a quiet stock looks as steep as a crash.
 */
const SPARK_MIN_HALF_RANGE = 0.01
/** The hero change's candidate sizes, largest first. `−12.34%` is 7
 * characters: 84 px at 20 px bold, past the 81 px usable width, so it
 * steps down rather than clipping. */
const HERO_SIZES = [20, 19, 17, 15, 13]
/** Candidates for the detail view's hero lines. */
const DETAIL_SYMBOL_SIZES = [20, 17, 15, 13]
const DETAIL_NUMBER_SIZES = [15, 13, 11]
/** How many of the detail view's tiles the intraday chart spans. */
const CHART_SPAN = 3
/** Below this many points a 3-key slice puts the chart on the wrong key
 * (I4, measured); the series draws whole on the first chart key instead. */
const MIN_SLICE_POINTS = 4

/** How long the first press on a tile shows its peek face. */
export const PEEK_MS = 3000
/** How long a breadth press shows the leaders on line 1. */
export const LEADERS_MS = 4000
/** How long one strip fact stays before the next one rotates in. */
export const FACT_ROTATE_MS = 8000
/** The mascot's heart pop. */
const HEARTS_MS = 1500
/** The opening-bell cascade: each key's sweep starts this much later. */
export const SWEEP_STAGGER_MS = 90
const SWEEP_MS = 500
/** The burst on a big up move runs this long. */
const BURST_MS = 1500

/** Render rates. 40 ms keeps a scroll or a one-shot smooth; 100 ms is the
 * mascot's own clock quantum; 200 ms is the closed-market crawl's step
 * (`CRAWL_PACE.quantumMs`), so a tick never renders a frame that cannot
 * have changed. */
const FAST_TICK_MS = 40
const MASCOT_TICK_MS = 100
const CRAWL_TICK_MS = CRAWL_PACE.quantumMs

/** The buttons breathe while the market trades: one slow cycle, gentle. */
const BUTTON_BREATHE_MS = 4000
const BUTTON_BREATHE_DEPTH = 0.35
/** A button for a side with no symbols on it still glows this faintly, so a
 * lit deck never looks unplugged. */
const BUTTON_FLOOR = 0.08

/** The peek face's background: a cool dark blue-grey, so a flipped tile
 * reads as "the other side of the card" at a glance. */
const PEEK_BG: Rgb = [16, 18, 25]

const STATE_LABELS: Record<MarketState, string> = {
  open: 'MARKET OPEN',
  pre: 'PRE-MARKET',
  post: 'AFTER HOURS',
  closed: 'MARKET CLOSED',
  // Per I1: never claim "closed" for a state that was never measured.
  unknown: 'MARKET UNKNOWN',
}

/** The states in which something is trading, so motion is honest. */
function isLive(state: MarketState): boolean {
  return state === 'open' || state === 'pre' || state === 'post'
}

/**
 * The move size at which a tile's heat wash reaches full strength, in
 * percent. ABSOLUTE, so a calm day is allowed to look calm. Measured live on
 * 2026-08-18: eight real symbols spanned −3.47 to +2.33 percent.
 */
const HEAT_SATURATION_PCT = 3
/** The smallest share of the wash a real, non-zero move gets. */
const HEAT_FLOOR = 0.06
/** The largest share of the trend colour a wash may blend in, so white text
 * stays crisp on top of it. */
const HEAT_MAX_BLEND = 0.3

/** How strongly the board presents, by market state. `unknown` is as quiet
 * as `closed` without claiming the market IS closed. */
const MOOD_BY_STATE: Record<MarketState, number> = {
  open: 1,
  pre: 0.55,
  post: 0.55,
  closed: 0.3,
  unknown: 0.3,
}

/**
 * How many symbols are up and down, and how many carry any known change at
 * all. ONE function for the breadth key, the strip text and the buttons, so
 * the lights can never contradict the words on one frame.
 */
export function breadth(quotes: Iterable<Quote | undefined>): { up: number; down: number; counted: number } {
  let up = 0
  let down = 0
  let counted = 0
  for (const q of quotes) {
    const trend = trendOf(q?.changePercent)
    if (trend === 'unknown') continue
    counted++
    if (trend === 'up') up++
    else if (trend === 'down') down++
  }
  return { up, down, counted }
}

/** The average change across the watchlist, or null when none is known. */
export function averageChange(quotes: Iterable<Quote | undefined>): number | null {
  let sum = 0
  let n = 0
  for (const q of quotes) {
    if (q && isFiniteNumber(q.changePercent)) {
      sum += q.changePercent
      n++
    }
  }
  return n > 0 ? sum / n : null
}

/** The best and worst mover, or null when nothing is known. */
export function leaders(
  symbols: readonly string[], quotes: ReadonlyMap<string, Quote>,
): { best: Quote; worst: Quote } | null {
  let best: Quote | null = null
  let worst: Quote | null = null
  for (const s of symbols) {
    const q = quotes.get(s)
    if (!q || !isFiniteNumber(q.changePercent)) continue
    if (!best || q.changePercent > best.changePercent!) best = q
    if (!worst || q.changePercent < worst.changePercent!) worst = q
  }
  return best && worst ? { best, worst } : null
}

export function blendToward(target: Rgb, fraction: number): Rgb {
  return blend(theme.bg, target, Math.min(HEAT_MAX_BLEND, fraction))
}

/** How big a move is, on a 0-to-1 absolute scale. */
export function moveMagnitude(changePercent: number | null): number {
  if (!isFiniteNumber(changePercent)) return 0
  return Math.min(1, Math.abs(changePercent) / HEAT_SATURATION_PCT)
}

/**
 * The background wash for one tile, or undefined for the plain background.
 * Unknown and a real flat 0.00 percent both get none: neither is a direction.
 */
export function heatWash(changePercent: number | null, marketState: MarketState): Rgb | undefined {
  const trend = trendOf(changePercent)
  if (trend === 'unknown' || trend === 'flat') return undefined
  const scaled = HEAT_FLOOR + (1 - HEAT_FLOOR) * moveMagnitude(changePercent)
  return blendToward(trendColor(trend), scaled * HEAT_MAX_BLEND * MOOD_BY_STATE[marketState])
}

/**
 * The two round buttons: left glows green by the SHARE of symbols up, right
 * glows red by the share down. Grey when offline or when nothing could be
 * counted — never a colour the data does not support. While the market is
 * open they breathe gently; otherwise they hold steady.
 */
export function breadthButtons(
  quotes: Iterable<Quote | undefined>, marketState: MarketState, status: StockStatus, nowMs: number,
): [Rgb, Rgb] {
  if (status === 'offline') return [theme.gray, theme.gray]
  const { up, down, counted } = breadth(quotes)
  if (counted === 0) return [theme.gray, theme.gray]
  const mood = MOOD_BY_STATE[marketState]
  const level = (share: number): number => mood * (BUTTON_FLOOR + (1 - BUTTON_FLOOR) * share)
  let left = scaleRgb(theme.green, level(up / counted))
  let right = scaleRgb(theme.red, level(down / counted))
  if (marketState === 'open') {
    left = breathe(left, nowMs, BUTTON_BREATHE_MS, BUTTON_BREATHE_DEPTH)
    right = breathe(right, nowMs, BUTTON_BREATHE_MS, BUTTON_BREATHE_DEPTH)
  }
  return [left, right]
}

/**
 * One tape segment per priced symbol: `NVDA 188.92 +3.41%`, coloured by the
 * same `trendOf` the tile uses. A stale symbol dims its own segment only.
 * Every character is one 13 px Menlo advance; see `stocks-tape.ts`.
 */
export function tapeSegments(
  quotes: ReadonlyMap<string, Quote>,
  isStale: (symbol: string) => boolean,
  symbols: readonly string[],
): TapeSegment[] {
  const segments: TapeSegment[] = []
  for (const symbol of symbols) {
    const quote = quotes.get(symbol)
    if (!quote || quote.price === null) continue
    segments.push({
      text: `${symbol} ${formatPrice(quote.price)} ${formatSignedPct(quote.changePercent)}`,
      color: isStale(symbol) ? theme.textDim : trendColor(trendOf(quote.changePercent)),
    })
  }
  return segments
}

/** What one grid key is. ONE function, read by `render` and `onKeyPress`, so
 * a key can never draw as one thing and answer a press as another. */
export type GridRole =
  | { kind: 'tile'; symbol: string }
  | { kind: 'breadth' }
  | { kind: 'mascot' }
  | { kind: 'empty' }

/**
 * With six or fewer symbols the last two keys are free: key 7 (index 6)
 * shows breadth and key 8 (index 7) the mood mascot. With seven, only the
 * mascot fits. With eight, neither.
 */
export function gridRole(index: number, symbols: readonly string[]): GridRole {
  const n = Math.min(8, symbols.length)
  if (index < 0 || index > 7) return { kind: 'empty' }
  if (index < n) return { kind: 'tile', symbol: symbols[index]! }
  if (index === 6 && n <= 6) return { kind: 'breadth' }
  if (index === 7 && n <= 7) return { kind: 'mascot' }
  return { kind: 'empty' }
}

/** The part of `StockSource` this page needs. */
export interface StockReader {
  /** The watchlist, in key order. The page must never assume a default. */
  getSymbols(): readonly string[]
  getQuotes(): Map<string, Quote>
  getStatus(): StockStatus
  getMarketState(): MarketState
  /** The next session edge the upstream reported, or null when unknown. */
  getNextBoundary(): MarketBoundary | null
  /** True when THIS symbol's own quote has gone stale. */
  isSymbolStale(symbol: string): boolean
  setVisible(visible: boolean): void
  /** Read-only. Never triggers a fetch — see `setWatchedSymbol`. */
  getYearlyState(symbol: string): YearlyState
  /** Tells the source which symbol's detail view is open, or null. Called
   * from `onKeyPress` and `onLeave` only, never from `render`. */
  setWatchedSymbol(symbol: string | null): void
}

type ChartMode = '1d' | '52wk'

interface ChartSeries {
  values: number[]
  label: string
  stale: boolean
  color: Rgb
  baseline?: number
  minHalfRange?: number
}

/**
 * The board the user leaves on all day. One tile per symbol with the day's
 * change as the hero; breadth and a mood mascot on free keys; a strip that
 * rotates useful facts above a tape that rests on each quote; buttons that
 * glow by breadth; and a few rare moments — the bells and the first ±2 %
 * crossing of a day.
 *
 * Presses carry no clock, so a press only records intent (a pending peek,
 * a pending heart). The next `render`, which the daemon runs straight after
 * every press, stamps it with its own `nowMs`. That keeps every animation
 * on the injected clock.
 */
export class StocksPage implements Page {
  readonly name = 'stocks'

  /** The symbol shown in detail mode, or null on the grid. */
  private selected: string | null = null
  private chartMode: ChartMode = '1d'
  /** Symbol to the `nowMs` its peek started. Pruned on every render, so at
   * most one entry per symbol and only for 3 s. */
  private peeks = new Map<string, number>()
  private pendingPeeks = new Set<string>()
  private pendingHearts = false
  private heartsAtMs: number | null = null
  private pendingLeaders = false
  private leadersAtMs: number | null = null
  /** The clock of the last render, for press decisions and `tickMs`. */
  private lastRenderMs: number | null = null
  private readonly moments = new StockMoments()

  constructor(private readonly source: StockReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.selected = null
    this.chartMode = '1d'
    this.peeks.clear()
    this.pendingPeeks.clear()
    this.pendingHearts = false
    this.pendingLeaders = false
    this.heartsAtMs = null
    this.leadersAtMs = null
    this.source.setWatchedSymbol(null)
    this.source.setVisible(false)
    // `moments` keeps its once-a-day keys across a leave, so coming back
    // never rings a bell twice. Its observation clock also goes stale while
    // hidden, which is what stops a transition that happened while nobody
    // watched from firing on return.
  }

  private activeQuote(quotes: Map<string, Quote>): Quote | null {
    if (this.selected === null) return null
    return quotes.get(this.selected) ?? null
  }

  render(now: number, nowMs?: number): DeckFrame {
    const ms = nowMs ?? now * 1000
    const quotes = this.source.getQuotes()
    const symbols = this.source.getSymbols()
    const marketState = this.source.getMarketState()

    this.stampPending(ms)
    this.moments.observe({
      nowMs: ms,
      state: marketState,
      boundary: this.source.getNextBoundary(),
      quotes,
      symbols,
      isStale: (s) => this.source.isSymbolStale(s),
    })
    this.lastRenderMs = ms

    const quote = this.activeQuote(quotes)
    if (quote) return this.detailFrame(this.selected!, quote, now, marketState)
    return this.gridFrame(quotes, symbols, marketState, ms)
  }

  /** Gives every press recorded since the last render this render's clock,
   * and drops peeks and pops that have finished. */
  private stampPending(ms: number): void {
    for (const s of this.pendingPeeks) this.peeks.set(s, ms)
    this.pendingPeeks.clear()
    if (this.pendingHearts) this.heartsAtMs = ms
    if (this.pendingLeaders) this.leadersAtMs = ms
    this.pendingHearts = false
    this.pendingLeaders = false
    for (const [s, at] of this.peeks) {
      if (!(ms - at < PEEK_MS) || ms < at) this.peeks.delete(s)
    }
  }

  /** A peek counts as showing while it is pending or in `peeks`; every
   * render prunes `peeks` at 3 s, so the map alone is the answer as of the
   * last frame the user saw. */
  private peekActive(symbol: string): boolean {
    return this.pendingPeeks.has(symbol) || this.peeks.has(symbol)
  }

  // ---------------------------------------------------------------- grid

  private gridFrame(
    quotes: Map<string, Quote>, symbols: readonly string[], marketState: MarketState, ms: number,
  ): DeckFrame {
    const watch = symbols.slice(0, 8).map((s) => quotes.get(s))
    const keys: KeySpec[] = []
    for (let i = 0; i < 8; i++) {
      const role = gridRole(i, symbols)
      if (role.kind === 'tile') {
        const at = this.peeks.get(role.symbol)
        keys.push(at !== undefined && ms >= at && ms - at < PEEK_MS
          ? this.peekKey(role.symbol, quotes.get(role.symbol))
          : this.tileKey(role.symbol, quotes.get(role.symbol), marketState, ms))
      } else if (role.kind === 'breadth') {
        keys.push(this.breadthKey(watch))
      } else if (role.kind === 'mascot') {
        keys.push(this.mascotKey(watch, marketState, ms))
      } else {
        keys.push({ kind: 'blank' })
      }
    }

    // The opening bell: a mint sweep cascades left to right, 90 ms apart.
    const bell = this.moments.bell
    if (bell && bell.kind === 'open' && ms - bell.atMs < SWEEP_MS + 8 * SWEEP_STAGGER_MS) {
      keys.forEach((key, i) => {
        if (key.kind === 'blank') return
        key.effects = [
          ...(key.effects ?? []),
          { variant: 'sweep', startedAtMs: bell.atMs + i * SWEEP_STAGGER_MS, nowMs: ms },
        ]
      })
    }

    let buttons = breadthButtons(watch, marketState, this.source.getStatus(), ms)
    if (bell && bell.kind === 'open' && ms >= bell.atMs && ms - bell.atMs < BELL_PULSE_MS) {
      const pulse = breathe(theme.green, ms - bell.atMs, 500, 0.75)
      buttons = [pulse, pulse]
    }

    return { keys, strip: this.gridStrip(quotes, symbols, marketState, ms), buttons }
  }

  private tileKey(symbol: string, quote: Quote | undefined, marketState: MarketState, ms: number): KeySpec {
    const cp = quote?.changePercent ?? null
    const trend = trendOf(cp)
    const color = trendColor(trend)
    const unknown = !quote || quote.price === null
    const key: KeySpec = {
      kind: 'gauge',
      lines: [symbol, formatShortPrice(quote?.price), formatSignedPct(cp)],
      lineSizes: [11, 11, HERO_SIZES],
      lineY: [6, 6, 22],
      lineAligns: ['left', 'right', 'center'],
      lineWeights: ['bold', undefined, 'bold'],
      lineColors: [theme.textDim, theme.textDim, color],
    }
    const wash = heatWash(cp, marketState)
    if (wash) key.bg = wash

    const values = downsample(quote?.spark ?? [], TILE_SPARK_POINTS)
    if (values.length >= 2) {
      const prev = quote?.previousClose
      key.spark = { values, color, style: 'line' }
      if (isFiniteNumber(prev) && prev > 0) {
        key.spark.baseline = prev
        key.spark.minHalfRange = prev * SPARK_MIN_HALF_RANGE
      } else if (isFiniteNumber(quote?.price) && quote.price > 0) {
        key.spark.minHalfRange = quote.price * SPARK_MIN_HALF_RANGE
      }
    }

    // The first crossing of ±2 % today: confetti and a pop up, a brick down.
    const effects: OneShotSpec[] = []
    for (const m of this.moments.recentMoves) {
      if (m.symbol !== symbol) continue
      if (m.kind === 'up') {
        effects.push({ variant: 'burst', startedAtMs: m.atMs, nowMs: ms, seed: symbol.length })
        key.linePop = { line: 2, startedAtMs: m.atMs, nowMs: ms }
      } else {
        effects.push({ variant: 'brick', startedAtMs: m.atMs, nowMs: ms })
      }
    }
    if (effects.length > 0) key.effects = effects

    if (this.source.isSymbolStale(symbol) || unknown) key.dim = true
    return key
  }

  /** The back of a tile: the day's range as a gauge, then the volume. */
  private peekKey(symbol: string, quote: Quote | undefined): KeySpec {
    const lo = quote?.dayLow ?? null
    const hi = quote?.dayHigh ?? null
    const price = quote?.price ?? null
    const pct = rangePercent(lo, hi, price)
    const lines = [symbol, formatShortPrice(price), 'DAY RANGE', formatShortPrice(lo), formatShortPrice(hi)]
    const sizes: (number | number[])[] = [11, 11, 10, 10, 10]
    const ys = [6, 6, 22, 52, 52]
    const aligns: ('left' | 'center' | 'right' | undefined)[] = ['left', 'right', 'left', 'left', 'right']
    const weights: ('normal' | 'bold' | undefined)[] = ['bold', undefined, 'bold', undefined, undefined]
    const colors: (Rgb | undefined)[] = [theme.text, theme.textDim, theme.textDim, theme.textDim, theme.textDim]

    // Volume only when the quote carries it. The source has no average
    // volume, so this is the raw day volume; unknown omits the line rather
    // than printing a 0 nobody measured.
    const volume = quote?.volume ?? null
    if (isFiniteNumber(volume) && volume >= 0) {
      lines.push('VOLUME', formatVolume(volume))
      sizes.push(10, [13, 11])
      ys.push(66, 78)
      aligns.push('left', 'left')
      weights.push('bold', 'bold')
      colors.push(theme.textDim, theme.text)
    } else if (pct !== null) {
      lines.push(`${pct}% of range`)
      sizes.push(10)
      ys.push(72)
      aligns.push('left')
      weights.push(undefined)
      colors.push(theme.text)
    }

    const key: KeySpec = {
      kind: 'gauge',
      bg: PEEK_BG,
      lines,
      lineSizes: sizes,
      lineY: ys,
      lineAligns: aligns,
      lineWeights: weights,
      lineColors: colors,
    }
    if (isFiniteNumber(lo) && isFiniteNumber(hi) && isFiniteNumber(price) && hi > lo) {
      key.range = {
        lo, hi, value: price, y: 39, height: 6,
        gradient: [theme.red, theme.green], marker: 'tick', color: theme.white,
      }
    }
    if (this.source.isSymbolStale(symbol)) key.dim = true
    return key
  }

  /** Free key 7: how many are up and down, their share, and the average. */
  private breadthKey(watch: readonly (Quote | undefined)[]): KeySpec {
    const { up, down, counted } = breadth(watch)
    const avg = averageChange(watch)
    if (counted === 0 || avg === null) {
      return {
        kind: 'gauge',
        lines: ['BREADTH', '--'],
        lineSizes: [10, 20],
        lineY: [6, 34],
        align: 'center',
        lineWeights: ['bold', 'bold'],
        lineColors: [theme.textDim, theme.textDim],
      }
    }
    const avgTrend = trendOf(avg)
    const key: KeySpec = {
      kind: 'gauge',
      lines: ['BREADTH', `▲${up}`, `▼${down}`, `avg ${formatSignedPct(avg)}`],
      lineSizes: [10, 20, 20, 10],
      lineY: [6, 26, 26, 80],
      lineAligns: ['center', 'left', 'right', 'center'],
      lineWeights: ['bold', 'bold', 'bold', undefined],
      lineColors: [theme.textDim, theme.green, theme.red, trendColor(avgTrend)],
    }
    // The share up as one two-tone bar: green for up, red for the rest that
    // moved. A board with nothing up or down (all flat) leaves it grey.
    if (up + down > 0) {
      key.bar = { value: up / (up + down), color: theme.green, bg: scaleRgb(theme.red, 0.55) }
    } else {
      key.bar = { value: 0, color: theme.gray, bg: theme.barTrack }
    }
    if (this.source.getStatus() === 'offline') key.dim = true
    return key
  }

  /** Free key 8: a bull on a green average day, a bear on a red one. It
   * only moves while something trades; a pressed mascot pops hearts. */
  private mascotKey(watch: readonly (Quote | undefined)[], marketState: MarketState, ms: number): KeySpec {
    const avg = averageChange(watch)
    if (avg === null) return { kind: 'blank' }
    const bull = avg >= 0
    const key: KeySpec = {
      kind: 'gauge',
      mascot: { kind: bull ? 'bull' : 'bear', nowMs: isLive(marketState) ? ms : 0 },
      lines: [bull ? 'BULLISH' : 'BEARISH'],
      lineSizes: [9],
      lineY: [84],
      align: 'center',
      lineWeights: ['bold'],
      lineColors: [bull ? theme.green : theme.red],
    }
    if (this.heartsAtMs !== null && ms - this.heartsAtMs < HEARTS_MS && ms >= this.heartsAtMs) {
      key.effects = [{ variant: 'hearts', startedAtMs: this.heartsAtMs, nowMs: ms, count: 6, y: 40 }]
    }
    if (this.source.getStatus() === 'offline') key.dim = true
    return key
  }

  // --------------------------------------------------------------- strip

  /** Whether the grid strip carries a tape. Read by `gridStrip` and
   * `tickMs`, so the render rate never disagrees with the motion. */
  private hasTape(quotes: Map<string, Quote>): boolean {
    if (this.source.getStatus() === 'offline') return false
    return tapeSegments(quotes, (s) => this.source.isSymbolStale(s), this.source.getSymbols()).length > 0
  }

  private gridStrip(
    quotes: Map<string, Quote>, symbols: readonly string[], marketState: MarketState, ms: number,
  ): StripSpec {
    const bell = this.moments.bell
    if (bell && ms >= bell.atMs && ms - bell.atMs < BELL_BANNER_MS) {
      const open = bell.kind === 'open'
      const banner: StripBanner = {
        text: open ? '🔔 OPENING BELL' : '🔔 CLOSING BELL',
        color: open ? theme.green : theme.amber,
        sub: formatEasternTime(bell.labelMs),
        pop: { startedAtMs: bell.atMs, nowMs: ms },
      }
      return { lines: [], banner }
    }

    // A fresh big move. A banner, not line 1: plain strip lines draw in
    // Menlo alone, and measured, `🚀` renders there as a tofu box. The
    // banner carries the colour-emoji fallback, and it is louder, which a
    // once-a-day event earns.
    const moves = this.moments.recentMoves.filter((m) => ms - m.atMs < BIG_MOVE_STRIP_MS && ms >= m.atMs)
    const latest = moves[moves.length - 1]
    if (latest) {
      const q = quotes.get(latest.symbol)
      const up = latest.kind === 'up'
      const banner: StripBanner = {
        text: up ? `🚀 ${latest.symbol} crossed +2%` : `🧱 ${latest.symbol} crossed −2%`,
        color: up ? theme.green : theme.red,
        size: 17,
        sub: `${formatPrice(q?.price)} · ${formatSignedPct(q?.changePercent)} today`,
      }
      return { lines: [], banner }
    }

    const status = this.source.getStatus()
    const watch = symbols.slice(0, 8).map((s) => quotes.get(s))
    const line1 = truncate(this.line1(quotes, symbols, watch, marketState, ms), STRIP_CHARS)
    const { up, down } = breadth(watch)
    const line2 = status === 'offline' ? 'offline' : `${up} up · ${down} down`
    const spec: StripSpec = { lines: [line1, truncate(line2, STRIP_CHARS)] }
    if (this.hasTape(quotes)) {
      const segments = tapeSegments(quotes, (s) => this.source.isSymbolStale(s), symbols)
      spec.tape = snapTape(segments, ms, isLive(marketState) ? LIVE_PACE : CRAWL_PACE)
    }
    return spec
  }

  /**
   * Line 1, by priority: the leaders a breadth press
   * asked for, then the closing summary, then the rotating facts.
   */
  private line1(
    quotes: Map<string, Quote>, symbols: readonly string[], watch: readonly (Quote | undefined)[],
    marketState: MarketState, ms: number,
  ): string {
    const lead = leaders(symbols, quotes)
    if (lead && this.leadersAtMs !== null && ms >= this.leadersAtMs && ms - this.leadersAtMs < LEADERS_MS) {
      return `▲ ${lead.best.symbol} ${formatSignedPct(lead.best.changePercent)}  ▼ ${lead.worst.symbol} ${formatSignedPct(lead.worst.changePercent)}`
    }

    const closedAt = this.moments.closedAtMs
    if (lead && closedAt !== null && ms >= closedAt && ms - closedAt < CLOSE_SUMMARY_MS) {
      // Alternates every 4 s: one line holds BEST or WORST at a readable size,
      // where both together would shrink to unreadable.
      const worst = Math.floor((ms - closedAt) / 4000) % 2 === 1
      const q = worst ? lead.worst : lead.best
      return `CLOSED · ${worst ? 'WORST' : 'BEST'} ${q.symbol} ${formatSignedPct(q.changePercent)}`
    }

    const facts: string[] = []
    const countdown = this.countdownFact(ms)
    if (countdown) facts.push(countdown)
    const { up, down, counted } = breadth(watch)
    if (counted > 0 && lead) {
      facts.push(`▲${up} ▼${down} · BEST ${lead.best.symbol} ${formatSignedPct(lead.best.changePercent)}`)
    }
    facts.push(`${STATE_LABELS[marketState]} · ${formatEasternTime(ms)}`)
    const index = Math.floor(ms / FACT_ROTATE_MS)
    return facts[((index % facts.length) + facts.length) % facts.length]!
  }

  /** `CLOSES IN 2h14m`, from the boundary the upstream reported. Null when
   * there is none — never a countdown to a guessed time. */
  private countdownFact(ms: number): string | null {
    const b = this.source.getNextBoundary()
    if (!b || !isFiniteNumber(b.atMs) || b.atMs <= ms) return null
    const verb: Record<MarketBoundary['kind'], string> = {
      'pre-start': 'PRE-MARKET IN',
      'pre-end': 'OPENS IN',
      open: 'OPENS IN',
      close: 'CLOSES IN',
      'post-start': 'AFTER HOURS IN',
      'post-end': 'AFTER HOURS ENDS IN',
    }
    return `${verb[b.kind]} ${formatCountdown(b.atMs - ms)}`
  }

  // -------------------------------------------------------------- detail

  /**
   * The detail view for one symbol: the hero, the day range, the volume,
   * the 52-week range, one chart across three keys, and BACK.
   */
  private detailFrame(symbol: string, quote: Quote, now: number, marketState: MarketState): DeckFrame {
    const trend = trendOf(quote.changePercent)
    const color = trendColor(trend)
    const dim = this.source.isSymbolStale(symbol) || quote.price === null
    const chart = this.chartSeries(symbol, quote, now, color)
    const chartDim = dim || chart.stale

    const keys: KeySpec[] = [
      this.heroKey(quote, trend, marketState, dim),
      this.gaugeKey('DAY RANGE', quote.dayLow, quote.dayHigh, quote.price, dim),
      this.volumeKey(quote, dim),
      this.gaugeKey('52 WEEKS', quote.week52Low, quote.week52High, quote.price, dim),
      this.chartKey(chart, chartDim, 0),
      this.chartKey(chart, chartDim, 1),
      this.chartKey(chart, chartDim, 2),
      this.backKey(),
    ]

    const lights = scaleRgb(color, MOOD_BY_STATE[marketState])
    return { keys, strip: this.detailStrip(quote, marketState), buttons: [lights, lights] }
  }

  private chartSeries(symbol: string, quote: Quote, now: number, color: Rgb): ChartSeries {
    if (this.chartMode === '52wk') {
      const yearly = this.source.getYearlyState(symbol)
      if (yearly.status === 'ok' && yearly.values.length >= 2) {
        const first = yearly.values[0]!
        const last = yearly.values[yearly.values.length - 1]!
        return {
          values: yearly.values,
          label: '52 WK',
          stale: now - yearly.updatedAt > YEARLY_REFRESH_SECONDS,
          color: last > first ? theme.green : last < first ? theme.red : theme.gray,
        }
      }
    }
    const series: ChartSeries = {
      values: downsample(quote.spark, DETAIL_SPARK_POINTS),
      label: '1D',
      stale: false,
      color,
    }
    if (isFiniteNumber(quote.previousClose) && quote.previousClose > 0) {
      series.baseline = quote.previousClose
      series.minHalfRange = quote.previousClose * SPARK_MIN_HALF_RANGE
    }
    return series
  }

  /** Key 1: symbol, price, the change, and the change amount. */
  private heroKey(quote: Quote, trend: Trend, marketState: MarketState, dim: boolean): KeySpec {
    const color = trendColor(trend)
    const key: KeySpec = {
      kind: 'gauge',
      lines: [quote.symbol, formatPrice(quote.price), formatSignedPct(quote.changePercent),
        formatChangeValue(quote.price, quote.previousClose)],
      lineSizes: [DETAIL_SYMBOL_SIZES, DETAIL_NUMBER_SIZES, DETAIL_NUMBER_SIZES, 11],
      lineY: [8, 36, 58, 80],
      align: 'center',
      lineWeights: ['bold', undefined, 'bold', undefined],
      lineColors: [theme.text, theme.text, color, theme.textDim],
    }
    const wash = heatWash(quote.changePercent, marketState)
    if (wash) key.bg = wash
    if (dim) key.dim = true
    return key
  }

  /** Keys 2 and 4: a range gauge with the price marked, and where in the
   * range the price sits. Unknown ends print `--` and draw no gauge. */
  private gaugeKey(
    label: string, lo: number | null, hi: number | null, value: number | null, dim: boolean,
  ): KeySpec {
    const pct = rangePercent(lo, hi, value)
    const key: KeySpec = {
      kind: 'gauge',
      lines: [label, formatShortPrice(lo), formatShortPrice(hi), pct === null ? '--' : `${pct}% of range`],
      lineSizes: [10, 10, 10, 10],
      lineY: [10, 58, 58, 78],
      lineAligns: ['center', 'left', 'right', 'center'],
      lineWeights: ['bold', undefined, undefined, undefined],
      lineColors: [theme.textDim, theme.textDim, theme.textDim, theme.text],
    }
    if (isFiniteNumber(lo) && isFiniteNumber(hi) && isFiniteNumber(value) && hi > lo) {
      key.range = { lo, hi, value, gradient: [theme.red, theme.green] }
    }
    if (dim) key.dim = true
    return key
  }

  /** Key 3: the day's volume. The source carries no average volume, so this
   * is the raw count; unknown prints `--`, never 0. */
  private volumeKey(quote: Quote, dim: boolean): KeySpec {
    const known = isFiniteNumber(quote.volume) && quote.volume >= 0
    const key: KeySpec = {
      kind: 'gauge',
      lines: ['VOLUME', formatVolume(quote.volume), known ? 'shares today' : 'not reported'],
      lineSizes: [10, [24, 20, 17], 10],
      lineY: [10, 36, 72],
      align: 'center',
      lineWeights: ['bold', 'bold', undefined],
      lineColors: [theme.textDim, known ? theme.text : theme.textDim, theme.textDim],
    }
    if (dim) key.dim = true
    return key
  }

  /** Keys 5 to 7: one line chart across three keys, the previous close
   * dotted through it on the 1D view. Fewer than 4 points draws whole on
   * key 5; fewer than 2 shows only the caption (I4). */
  private chartKey(chart: ChartSeries, dim: boolean, index: number): KeySpec {
    const key: KeySpec = { kind: 'gauge' }
    const n = chart.values.length
    const base = {
      values: chart.values,
      color: chart.color,
      style: 'line' as const,
      fullHeight: true,
      labelBand: true,
      ...(chart.baseline !== undefined ? { baseline: chart.baseline } : {}),
      ...(chart.minHalfRange !== undefined ? { minHalfRange: chart.minHalfRange } : {}),
    }
    if (n >= MIN_SLICE_POINTS) {
      key.spark = { ...base, slice: { index, count: CHART_SPAN }, label: index === 0 ? chart.label : undefined }
    } else if (n >= 2) {
      if (index === 0) key.spark = { ...base, label: chart.label }
    } else if (index === 0) {
      key.lines = [chart.label]
      key.lineSizes = [11]
      key.lineY = [6]
    }
    if (dim) key.dim = true
    return key
  }

  private backKey(): KeySpec {
    return {
      kind: 'control',
      bg: [20, 22, 28],
      lines: ['←', 'BACK'],
      lineSizes: [26, 11],
      lineY: [24, 60],
      align: 'center',
      lineWeights: [undefined, 'bold'],
      lineColors: [theme.text, theme.textDim],
    }
  }

  /** Company name, then the market state and the last trade time. `right`
   * carries `offline`, so a view left open across an outage says so (I4). */
  private detailStrip(quote: Quote, marketState: MarketState): StripSpec {
    const line1 = truncate(quote.name, STRIP_CHARS)
    const asOf = quote.asOf > 0 ? formatEasternTime(quote.asOf * 1000) : '--'
    const line2 = truncate(`${STATE_LABELS[marketState]} · ${asOf}`, STRIP_CHARS)
    const right = this.source.getStatus() === 'offline' ? 'offline' : undefined
    return { lines: [line1, line2], right }
  }

  // ---------------------------------------------------------------- rate

  /** True while a one-shot needs the fast tick, judged at the last render. */
  private animating(): boolean {
    if (this.pendingPeeks.size > 0 || this.pendingHearts || this.pendingLeaders) return true
    const ms = this.lastRenderMs
    if (ms === null) return false
    const bell = this.moments.bell
    if (bell && ms - bell.atMs < BELL_BANNER_MS) return true
    if (this.moments.recentMoves.some((m) => ms - m.atMs < BURST_MS)) return true
    if (this.heartsAtMs !== null && ms - this.heartsAtMs < HEARTS_MS) return true
    return false
  }

  /**
   * 40 ms while the tape moves at its live pace or a one-shot runs; 100 ms
   * for a hopping mascot; 200 ms for the closed-market crawl; the default
   * otherwise.
   * Idle frames are byte-identical, so a fast tick writes nothing extra.
   */
  get tickMs(): number | undefined {
    const quotes = this.source.getQuotes()
    if (this.activeQuote(quotes) !== null) return undefined
    const live = isLive(this.source.getMarketState())
    const tape = this.hasTape(quotes)
    if ((tape && live) || this.animating()) return FAST_TICK_MS
    if (live) return MASCOT_TICK_MS
    if (tape) return CRAWL_TICK_MS
    return undefined
  }

  // --------------------------------------------------------------- press

  onKeyPress(index: number): PressOutcome {
    const quotes = this.source.getQuotes()
    if (this.activeQuote(quotes) !== null) return this.detailPress(index)

    const symbols = this.source.getSymbols()
    const role = gridRole(index, symbols)
    if (role.kind === 'tile') {
      const quote = quotes.get(role.symbol)
      // Nothing to show for a symbol with no priced quote (M1): ignored.
      if (!quote || quote.price === null) return 'ignored'
      if (this.peekActive(role.symbol)) {
        // A second press while the card is flipped opens the full view.
        this.peeks.delete(role.symbol)
        this.pendingPeeks.delete(role.symbol)
        this.selected = role.symbol
        this.chartMode = '1d'
        this.source.setWatchedSymbol(role.symbol)
        return 'handled'
      }
      this.pendingPeeks.add(role.symbol)
      return 'handled'
    }

    const watch = symbols.slice(0, 8).map((s) => quotes.get(s))
    if (role.kind === 'breadth') {
      // Shows the day's best and worst on line 1 for 4 s. Nothing to show
      // when nothing is counted, so that press is ignored.
      if (breadth(watch).counted === 0) return 'ignored'
      this.pendingLeaders = true
      return 'handled'
    }
    if (role.kind === 'mascot') {
      if (averageChange(watch) === null) return 'ignored'
      this.pendingHearts = true
      return 'handled'
    }
    return 'ignored'
  }

  private detailPress(index: number): PressOutcome {
    if (index === 7) {
      this.selected = null
      this.chartMode = '1d'
      this.source.setWatchedSymbol(null)
      return 'handled'
    }
    if (index >= 4 && index <= 6 && this.selected !== null) {
      // The chart keys switch between today and the year — but only when
      // the year has loaded, or the press would change nothing.
      if (this.chartMode === '52wk') {
        this.chartMode = '1d'
        return 'handled'
      }
      const yearly = this.source.getYearlyState(this.selected)
      if (yearly.status === 'ok' && yearly.values.length >= 2) {
        this.chartMode = '52wk'
        return 'handled'
      }
    }
    return 'ignored'
  }
}
