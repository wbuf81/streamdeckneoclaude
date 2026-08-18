import type { DeckFrame, KeySpec, Rgb, StripSpec, TapeSegment } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate, formatEasternTime } from '../render/text.js'
import type { Page, PressOutcome } from './types.js'
import type { MarketState, Quote, StockStatus, YearlyState } from '../sources/stocks.js'
import { SYMBOLS, downsample, YEARLY_REFRESH_SECONDS } from '../sources/stocks.js'

/** How many buckets the intraday series downsamples to for the tile. */
const SPARK_BUCKETS = 12
/** Measured limit for one strip line. See `render/canvas.ts`. */
const STRIP_CHARS = 30
/**
 * Candidate sizes for the detail view's numeric lines, largest first. 16 px
 * fits a 7-character price like `1234.56`; 13 and 11 extend the list
 * downward for the widest realistic case, a three-digit change percent like
 * `▲ 150.00%` (86.7 px at 16 px — the review's exact repro, past the 81 px
 * usable width). This page passes the array itself: it declares intent, and
 * `renderKey` measures with a real canvas and picks the size that actually
 * fits — see `KeySpec.lineSizes`'s doc comment. That keeps this page pure
 * (no canvas import, not even transitively) and lets the renderer shrink
 * further than any single fixed candidate ever could.
 */
const PRICE_SIZES = [24, 20, 16, 13, 11]
/** Fixed size for the detail view's symbol and label lines. Every symbol is
 * at most 4 characters and every label ("DAY", "52 WK") is short, so these
 * never need fitting — a plain number, drawn as given. */
const SYMBOL_SIZE = 24
const LABEL_SIZE = 16
const BACK_SIZE = 16
/** How many of the detail view's tiles the intraday chart spans. */
const CHART_SPAN = 3
/**
 * Fewer than this many points cannot be sliced sensibly across `CHART_SPAN`
 * keys (I4): `render/canvas.ts`'s `drawSpark` divides the series into
 * `CHART_SPAN` virtual-width slices, and with 2 or 3 points that geometry
 * puts the whole chart's bars on the wrong key, or draws none at all on the
 * first one — measured: a 2-point rising series draws zero bars on key 4 and
 * the caption ends up sitting alone over an empty tile. Below this count,
 * `chartKey` draws the WHOLE (tiny) series, un-sliced, on the first key only
 * — the same "no slice" mode the grid ticker's own sparkline already uses —
 * rather than asking the renderer to spread 2 or 3 points across 3 keys.
 */
const MIN_SLICE_POINTS = 4

const STATE_LABELS: Record<MarketState, string> = {
  open: 'MARKET OPEN',
  pre: 'PRE-MARKET',
  post: 'AFTER HOURS',
  closed: 'MARKET CLOSED',
  // Per I1: a market state that was never measured (no symbol has ever
  // carried a usable `currentTradingPeriod`) must say so, not claim
  // "closed" — lesson 18, an absent signal is unknown, not a fact.
  unknown: 'MARKET UNKNOWN',
}

type Trend = 'up' | 'down' | 'flat' | 'unknown'

function trendOf(changePercent: number | null): Trend {
  if (typeof changePercent !== 'number' || !Number.isFinite(changePercent)) return 'unknown'
  if (changePercent > 0) return 'up'
  if (changePercent < 0) return 'down'
  return 'flat'
}

function trendColor(trend: Trend): Rgb {
  if (trend === 'up') return theme.green
  if (trend === 'down') return theme.red
  return theme.gray
}

function trendArrow(trend: Trend): string {
  if (trend === 'up') return '▲'
  if (trend === 'down') return '▼'
  if (trend === 'flat') return '·'
  return ''
}

/**
 * The move size at which a tile's heat wash reaches full strength, in percent.
 *
 * The scale is ABSOLUTE, deliberately, not normalised against the board's
 * biggest mover. A relative scale would always look contrasty, but it would
 * paint a 0.3 percent nudge exactly as brightly as a 5 percent crash — and this
 * page never misrepresents its data. A flat day is allowed to look calm,
 * because it IS calm.
 *
 * Measured live on 2026-08-18: the eight real symbols spanned -3.47 to +2.33
 * percent, with two of them inside ±0.2. So 3 percent puts a real board across
 * most of the range and still leaves headroom above it.
 */
const HEAT_SATURATION_PCT = 3

/**
 * How fast the ticker tape crawls, in pixels per second, and how often the page
 * renders while it does.
 *
 * The strip was measured at 1218 writes per second (docs/VERIFIED-FACTS.md), so
 * it is nowhere near the constraint; 50 ms is 20 strip writes per second.
 *
 * Both were tuned against a rendered preview, not guessed.
 *
 * The real loop measures 1448 px at 13 px Menlo — more than the 1130 px first
 * estimated, because eight `SYMBOL price ▲change%` segments plus separators run
 * wider than a character count suggests (lesson 17 again: measure, do not
 * reason). At the first speed, 32 px per second, the whole board took **45
 * seconds** to pass, so waiting for one particular ticker meant most of a
 * minute. 60 px per second brings that to about 24 seconds.
 *
 * The tick then has to keep the motion smooth at that speed: 60 px per second at
 * 40 ms is 2.4 px per frame. The strip was measured at 1218 writes per second,
 * so 25 frames per second costs nothing.
 *
 * If the tape ever needs to be faster still, the PRICE comes out of each segment
 * before the speed goes up again — an unreadable tape is worse than a slow one.
 */
const TAPE_PX_PER_SEC = 60
const TAPE_TICK_MS = 40

/**
 * The smallest share of the wash any real, non-zero move gets, so a small move
 * is a faint hint rather than rounding away to nothing.
 *
 * Kept LOW on purpose. At the first value, 0.22, a 0.05 percent nudge — no real
 * movement at all — already drew 23 percent of the full wash, and a rendered
 * flat day (every symbol inside ±0.35 percent) was almost indistinguishable
 * from a real mixed day. That directly contradicted this feature's own design
 * decision to keep the scale absolute and let a calm day look calm.
 *
 * Measured on 2026-08-18: at 0.22 the strength ratio between a 0.12 percent
 * nudge and a saturating 3 percent move was only 4.0x. At this value it is
 * about 10x, so a real mover stands out and a quiet day stays quiet.
 */
const HEAT_FLOOR = 0.06

/**
 * The largest share of the trend colour a wash may ever blend in. The key's
 * white text has to stay crisp on top of it, which is the same constraint the
 * weather page's condition tints live under — see `conditionTint` there, where
 * every value is hand-picked dark. Here the values are computed, so the ceiling
 * has to be explicit and tested.
 */
const HEAT_MAX_BLEND = 0.3

/**
 * How strongly the board presents, by market state. One multiplier, applied to
 * both the heat wash and the breadth buttons, so the whole page shares one mood.
 *
 * `unknown` shares `closed`'s multiplier but NOT its meaning. We do not know the
 * market is live, so it must not LOOK live — but claiming it is closed would be
 * a lie, and `STATE_LABELS` already refuses to (lesson 18: an absent signal is
 * unknown, not a fact). The strip is what states it, in words.
 */
const MOOD_BY_STATE: Record<MarketState, number> = {
  open: 1,
  pre: 0.55,
  post: 0.55,
  closed: 0.3,
  unknown: 0.3,
}

/** How many symbols are up and how many are down.
 *
 * ONE function, read by both the strip's "5 up · 3 down" text and the round
 * buttons' colour. Two callers counting this separately would eventually
 * disagree, and then the lights would contradict the words on the same frame
 * (lesson 21: one decision, one function).
 */
export function breadth(quotes: Iterable<Quote>): { up: number; down: number } {
  let up = 0
  let down = 0
  for (const q of quotes) {
    const trend = trendOf(q.changePercent)
    if (trend === 'up') up++
    else if (trend === 'down') down++
  }
  return { up, down }
}

/**
 * Blends the plain key background toward `target` by `fraction`, capped at
 * `HEAT_MAX_BLEND`. Exported so a test can prove the cap and the contrast
 * without going through a whole rendered frame.
 */
export function blendToward(target: Rgb, fraction: number): Rgb {
  const f = Math.max(0, Math.min(HEAT_MAX_BLEND, fraction))
  return [
    Math.round(theme.bg[0] + (target[0] - theme.bg[0]) * f),
    Math.round(theme.bg[1] + (target[1] - theme.bg[1]) * f),
    Math.round(theme.bg[2] + (target[2] - theme.bg[2]) * f),
  ]
}

/**
 * The background wash for one ticker tile, or undefined for a tile that must
 * keep the plain background.
 *
 * An unknown change (null, or non-finite) and a real flat 0.00 percent both get
 * undefined. Those two cases mean different things — "we do not know" against
 * "it did not move" — but neither is a direction, and inventing a colour for
 * either would be a fabricated reading.
 */
export function heatWash(
  changePercent: number | null, marketState: MarketState,
): Rgb | undefined {
  const trend = trendOf(changePercent)
  if (trend === 'unknown' || trend === 'flat') return undefined
  const magnitude = Math.min(1, Math.abs(changePercent as number) / HEAT_SATURATION_PCT)
  const scaled = HEAT_FLOOR + (1 - HEAT_FLOOR) * magnitude
  return blendToward(trendColor(trend), scaled * HEAT_MAX_BLEND * MOOD_BY_STATE[marketState])
}

/**
 * The colour both round buttons take on the grid. Grey whenever nothing was
 * counted or the source is offline — never a colour the data does not support.
 */
export function breadthColor(
  quotes: Iterable<Quote>, marketState: MarketState, status: StockStatus,
): Rgb {
  if (status === 'offline') return theme.gray
  const { up, down } = breadth(quotes)
  if (up === 0 && down === 0) return theme.gray
  const target = up > down ? theme.green : down > up ? theme.red : theme.amber
  // The same mood multiplier the wash uses, so a closed market's lights are as
  // quiet as its tiles.
  const mood = MOOD_BY_STATE[marketState]
  return [
    Math.round(target[0] * mood),
    Math.round(target[1] * mood),
    Math.round(target[2] * mood),
  ]
}

/** `123.5` becomes `123.50`. Never NaN, because it checks finiteness first. */
function formatPrice(price: number | null): string {
  return typeof price === 'number' && Number.isFinite(price) ? price.toFixed(2) : '--'
}

/** `-1.586` becomes `▼ 1.59%`. `null` and non-finite values become `--`. */
function formatChange(changePercent: number | null, trend: Trend): string {
  if (typeof changePercent !== 'number' || !Number.isFinite(changePercent)) return '--'
  return `${trendArrow(trend)} ${Math.abs(changePercent).toFixed(2)}%`
}

/** `price - previousClose` as a signed currency string: `-5.30`, `5.30`
 * (flat needs no sign), `12.00`. `null` when either side is unknown. */
function formatChangeValue(price: number | null, previousClose: number | null): string {
  if (typeof price !== 'number' || typeof previousClose !== 'number') return '--'
  if (!Number.isFinite(price) || !Number.isFinite(previousClose)) return '--'
  const diff = price - previousClose
  const magnitude = Math.abs(diff).toFixed(2)
  // M8 — the sign comes from the ROUNDED magnitude, not the raw diff: a diff
  // in (-0.005, 0) has a negative raw sign but rounds its magnitude to
  // `0.00`, and printing that combination gave `-0.00` — a "loss" of
  // nothing, self-contradictory the same way `STALE 0m` was for I3.
  const sign = diff < 0 && magnitude !== '0.00' ? '-' : ''
  return `${sign}${magnitude}`
}

/** The newest `asOf` across all quotes, or null when none is known yet. */
function latestAsOf(quotes: Map<string, Quote>): number | null {
  let max: number | null = null
  for (const q of quotes.values()) {
    if (q.asOf > 0 && (max === null || q.asOf > max)) max = q.asOf
  }
  return max
}

/** `4:20 PM EDT` — the exchange trades US Eastern hours, which is also the
 * project's one timestamp zone, per `AGENTS.md`'s "Product conventions".
 * Measured at 211.3 px for the widest case, `MARKET CLOSED · 4:05 PM EDT`,
 * well inside the strip's 236 px usable width, so the zone abbreviation
 * stays on. */
function formatAsOf(epochSeconds: number): string {
  return formatEasternTime(epochSeconds * 1000)
}

/**
 * `asOf`, formatted, or `--` when unknown. Per I1: `asOf` is 0 when a
 * quote's `regularMarketTime` never arrived, and both strips used to
 * substitute the RENDER clock there — a page must never do that (never
 * `Date.now()`, and never the `now` it is handed either, standing in for a
 * measurement that was never taken). `--` is the same honesty convention
 * every other unknown value on this page already uses.
 */
function formatAsOfOrUnknown(asOf: number | null): string {
  return asOf !== null && asOf > 0 ? formatAsOf(asOf) : '--'
}

/** The part of `StockSource` this page needs. */
export interface StockReader {
  getQuotes(): Map<string, Quote>
  getStatus(): StockStatus
  getMarketState(): MarketState
  /** True when THIS symbol's own quote has gone stale. Drives dimming for
   * both the grid tile and the detail view, so one lagging ticker dims on
   * its own instead of the whole board dimming for it. */
  isSymbolStale(symbol: string): boolean
  setVisible(visible: boolean): void
  /** Read-only. Never triggers a fetch — see `setWatchedSymbol`. */
  getYearlyState(symbol: string): YearlyState
  /**
   * Tells the source which symbol's detail view is open (or `null` when
   * none is). Per M1, this is the ONLY way this page ever asks for a yearly
   * fetch — `render()` must stay pure, so the source itself is what
   * re-checks freshness on its own poll while a symbol stays watched. The
   * page calls this from `onKeyPress` alone, on selection and on leaving
   * detail mode — never from `render`.
   */
  setWatchedSymbol(symbol: string | null): void
}

/**
 * How far the tape has scrolled at `nowMs`. Pure, and exported so a test can
 * prove the motion without rasterising anything.
 *
 * It grows without bound on purpose. The RENDERER wraps it, because only the
 * renderer can measure the tape's real width in the real font — a page is not
 * allowed to reason about pixel widths (lesson 17).
 */
export function tapeOffsetPx(nowMs: number, pxPerSec: number = TAPE_PX_PER_SEC): number {
  if (!Number.isFinite(nowMs)) return 0
  return (nowMs / 1000) * pxPerSec
}

/**
 * One tape segment per symbol: `SYMBOL price ▲change%`, coloured by the SAME
 * `trendOf` call the tile's border, its change line and its heat wash use — so
 * all four agree about direction.
 *
 * A per-symbol stale quote takes the dim colour for its own segment only. One
 * lagging ticker never dims the whole tape, matching how the tiles behave.
 */
export function tapeSegments(
  quotes: Map<string, Quote>,
  isStale: (symbol: string) => boolean,
): TapeSegment[] {
  const segments: TapeSegment[] = []
  for (const symbol of SYMBOLS) {
    const quote = quotes.get(symbol)
    if (!quote || quote.price === null) continue
    const trend = trendOf(quote.changePercent)
    const text = `${symbol} ${formatPrice(quote.price)} ${formatChange(quote.changePercent, trend)}`
    segments.push({
      text,
      color: isStale(symbol) ? theme.textDim : trendColor(trend),
    })
  }
  return segments
}

/**
 * One ticker per key, eight keys, eight symbols, no empty key and no
 * overflow. Pressing a ticker enters a detail mode for that one symbol,
 * spread across all eight keys, with BACK on key 7. A key dims when ITS OWN
 * symbol's quote has gone stale, so one lagging ticker never dims tiles that
 * are still fresh.
 */
export class StocksPage implements Page {
  readonly name = 'stocks'

  /** The symbol shown in detail mode, or null on the grid. `onLeave` always
   * clears this, so the page reopens on the grid every time. */
  private selected: string | null = null

  constructor(private readonly source: StockReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.selected = null
    this.source.setWatchedSymbol(null)
    this.source.setVisible(false)
  }

  /** The quote `this.selected` names, or null when nothing is selected OR
   * the selected symbol has no quote (this should not happen — quotes are
   * only ever added, never removed — but a page must never throw). Computed
   * fresh from `quotes` every call rather than cached, so `render` never
   * needs to mutate `this.selected` to fall back to the grid (M3: a page
   * must not mutate its own state inside `render`) — `onKeyPress` calls
   * this too, so the two stay consistent about whether a symbol is really
   * selected. */
  private activeQuote(quotes: Map<string, Quote>): Quote | null {
    if (this.selected === null) return null
    return quotes.get(this.selected) ?? null
  }

  render(now: number, nowMs?: number): DeckFrame {
    const quotes = this.source.getQuotes()
    // A page never reads the wall clock. The daemon injects both, and the
    // seconds value is the documented fallback for the millisecond one.
    const ms = nowMs ?? now * 1000

    const quote = this.activeQuote(quotes)
    if (quote) return this.detailFrame(this.selected!, quote, now)

    const marketState = this.source.getMarketState()
    const keys = SYMBOLS.map((symbol) => this.tickerKey(quotes.get(symbol), symbol, marketState))
    // Both buttons take ONE colour. They are page navigation, so two different
    // colours would read as two different controls; one board-level signal is
    // what this surface can honestly carry.
    const board = breadthColor(quotes.values(), marketState, this.source.getStatus())
    return {
      keys,
      strip: this.strip(quotes, ms),
      buttons: [board, board],
    }
  }

  private tickerKey(
    quote: Quote | undefined, symbol: string, marketState: MarketState,
  ): KeySpec {
    const trend = trendOf(quote?.changePercent ?? null)
    const unknown = !quote || quote.price === null
    const stale = this.source.isSymbolStale(symbol)

    const key: KeySpec = {
      kind: 'gauge',
      lines: [symbol, formatPrice(quote?.price ?? null), formatChange(quote?.changePercent ?? null, trend)],
      // Only the border and the change line carry the trend colour. The
      // price stays in the default text colour so it always reads clean.
      lineColors: [undefined, undefined, trendColor(trend)],
      border: trendColor(trend),
    }

    // The wash comes from the SAME `trendOf` result the border and the change
    // line use, so the three cannot disagree about direction.
    const wash = heatWash(quote?.changePercent ?? null, marketState)
    if (wash) key.bg = wash

    const spark = downsample(quote?.spark ?? [], SPARK_BUCKETS)
    if (spark.length >= 2) {
      key.spark = { values: spark, color: trendColor(trend) }
    }

    if (stale || unknown) key.dim = true

    return key
  }

  /**
   * The detail view for one symbol, spread across all eight keys. Every data
   * tile (0 to 6) shares one border colour — the symbol's trend — so BACK's
   * fixed gray border reads as visibly different, not as more data.
   */
  private detailFrame(symbol: string, quote: Quote, now: number): DeckFrame {
    const trend = trendOf(quote.changePercent)
    const border = trendColor(trend)
    const dim = this.source.isSymbolStale(symbol) || quote.price === null
    const chart = this.chartSeries(symbol, quote, now)
    // I5: the chart itself dims when its OWN yearly series has gone stale,
    // even while the intraday quote (keys 0-3) is perfectly fresh — a
    // detail view left open for days must not keep drawing old closes as
    // if they were just fetched.
    const chartDim = dim || chart.stale

    const keys: KeySpec[] = [
      this.priceKey(quote, border, dim),
      this.changeKey(quote, trend, border, dim),
      this.rangeKey('DAY', quote.dayHigh, quote.dayLow, border, dim),
      this.rangeKey('52 WK', quote.week52High, quote.week52Low, border, dim),
      this.chartKey(chart, trend, border, chartDim, 0),
      this.chartKey(chart, trend, border, chartDim, 1),
      this.chartKey(chart, trend, border, chartDim, 2),
      this.backKey(),
    ]

    // The whole frame is about ONE symbol, so the buttons carry that symbol's
    // trend rather than the board's breadth.
    const mood = MOOD_BY_STATE[this.source.getMarketState()]
    const lights: Rgb = [
      Math.round(border[0] * mood),
      Math.round(border[1] * mood),
      Math.round(border[2] * mood),
    ]

    return {
      keys,
      strip: this.detailStrip(quote),
      buttons: [lights, lights],
    }
  }

  /**
   * Picks what the wide chart (keys 4, 5 and 6) draws: the 52-week daily
   * series once it has loaded, or the intraday series — clearly labelled
   * either way — while that fetch is still loading, has never succeeded for
   * this symbol, or the symbol simply has no yearly data yet. Never hands
   * back the intraday series under the `52 WK` label: the label always
   * matches the values it goes with, so a still-loading or failed yearly
   * fetch shows the grid's own honest range instead of silently
   * mislabelling a day as a year.
   *
   * Per I5, only READS the yearly state — per M1, it triggers no fetch of
   * its own: `render()` must stay pure (AGENTS.md's "does not access ...
   * the network"). `setWatchedSymbol` (called from `onKeyPress`, never from
   * `render`) is what asks the source to keep this symbol's yearly series
   * fresh on the source's own poll, so a detail view left open past the
   * 6-hour refresh interval still gets a fresh copy without this method
   * doing any I/O itself. `stale` still tells the caller the age it can
   * see, purely for dimming.
   */
  private chartSeries(symbol: string, quote: Quote, now: number): { values: number[]; label: string; stale: boolean } {
    const yearly = this.source.getYearlyState(symbol)
    if (yearly.status === 'ok' && yearly.values.length >= 2) {
      const stale = now - yearly.updatedAt > YEARLY_REFRESH_SECONDS
      return { values: yearly.values, label: '52 WK', stale }
    }
    return { values: quote.spark, label: '1D', stale: false }
  }

  /** Key 0: the symbol, then the price sized to fit whatever width the
   * actual digits need. The size candidates are declared here; `renderKey`
   * measures and resolves them — per docs/LESSONS.md #17, and per the A3
   * ruling that pages declare intent while the renderer does the canvas
   * work. */
  private priceKey(quote: Quote, border: Rgb, dim: boolean): KeySpec {
    const priceText = formatPrice(quote.price)
    const key: KeySpec = {
      kind: 'gauge',
      lines: [quote.symbol, priceText],
      lineSizes: [SYMBOL_SIZE, PRICE_SIZES],
      border,
    }
    if (dim) key.dim = true
    return key
  }

  /** Key 1: the change percent (with the existing trend arrow), then the
   * change amount. Both lines carry the trend colour. */
  private changeKey(quote: Quote, trend: Trend, border: Rgb, dim: boolean): KeySpec {
    const pctText = formatChange(quote.changePercent, trend)
    const valText = formatChangeValue(quote.price, quote.previousClose)
    const color = trendColor(trend)
    const key: KeySpec = {
      kind: 'gauge',
      lines: [pctText, valText],
      lineSizes: [PRICE_SIZES, PRICE_SIZES],
      lineColors: [color, color],
      border,
    }
    if (dim) key.dim = true
    return key
  }

  /**
   * Keys 2 and 3: a label, then the high, then the low. Used for both the
   * day range and the 52-week range — the only difference is the label and
   * which two fields feed it.
   *
   * The high and low lines pass the SAME `PRICE_SIZES` array (by value), so
   * `renderKey` sizes them as one group (M3) — otherwise fitting each line
   * independently could render the low bigger than the high directly above
   * it, which reads as two unrelated numbers instead of one range.
   */
  private rangeKey(label: string, high: number | null, low: number | null, border: Rgb, dim: boolean): KeySpec {
    const highText = formatPrice(high)
    const lowText = formatPrice(low)
    const key: KeySpec = {
      kind: 'gauge',
      lines: [label, highText, lowText],
      lineSizes: [LABEL_SIZE, PRICE_SIZES, PRICE_SIZES],
      border,
    }
    if (dim) key.dim = true
    return key
  }

  /**
   * Keys 4, 5 and 6: one chart, spanning all three — the 52-week series
   * (`chart.label` is `52 WK`) once it has loaded, otherwise the intraday
   * series labelled `1D`, per `chartSeries`. Each key draws only its own
   * slice of the SAME series, so the three stay in scale with each other —
   * see `SparkSpec.slice` in `render/specs.ts`. These three keys carry no
   * text lines, so the chart uses `fullHeight` (M4) to own most of the
   * tile; `labelBand` reserves a strip at the top for the caption, applied
   * identically on all three keys so the bars still line up at the seams,
   * and `label` itself is set only on index 0 so the caption is not
   * repeated three times.
   *
   * Per I4, this now handles every point count sensibly instead of just
   * "4 or more":
   * - 0 or 1 points: nothing to draw at all, but a chart slot must never go
   *   blank with no explanation — key 4 alone still carries `chart.label` as
   *   a plain text line, in the SAME spot `drawSpark`'s own caption would
   *   occupy, so there is always a caption when a chart slot is shown.
   * - 2 or 3 points: too few to slice across `CHART_SPAN` keys — measured,
   *   `drawSpark`'s per-key virtual-width geometry puts the whole series on
   *   the wrong key, or draws none at all on this one. Key 4 alone draws
   *   the whole (tiny) series un-sliced instead, the same "no slice" mode
   *   the grid ticker's own sparkline already uses; keys 5 and 6 stay
   *   blank, since there is no meaningful "next third" of a 2- or 3-point
   *   series to show them.
   * - 4 or more points: the existing 3-key slice, unchanged.
   */
  private chartKey(
    chart: { values: number[]; label: string },
    trend: Trend,
    border: Rgb,
    dim: boolean,
    index: number,
  ): KeySpec {
    const key: KeySpec = { kind: 'gauge', border }
    const n = chart.values.length

    if (n >= MIN_SLICE_POINTS) {
      key.spark = {
        values: chart.values,
        color: trendColor(trend),
        slice: { index, count: CHART_SPAN },
        fullHeight: true,
        labelBand: true,
        label: index === 0 ? chart.label : undefined,
      }
    } else if (n >= 2) {
      if (index === 0) {
        key.spark = {
          values: chart.values,
          color: trendColor(trend),
          fullHeight: true,
          labelBand: true,
          label: chart.label,
        }
      }
    } else if (index === 0) {
      // 0 or 1 points: no bars to draw, but the caption must still appear.
      // Positioned to match exactly where `drawSpark`'s own `label` would
      // land for a `fullHeight`/`labelBand` chart (`x0 = BORDER + PAD`,
      // `y = SPARK_FULL_Y`), so a chart slot with a caption and one with
      // real bars read as the same family of tile.
      key.lines = [chart.label]
      key.lineSizes = [11]
      key.lineY = [6]
    }
    if (dim) key.dim = true
    return key
  }

  /** Key 7: BACK. A gray border and no trend colour, on purpose, so it never
   * reads as one more data tile. Centred vertically as well as
   * horizontally (M4) — with no other line to share the tile, the label
   * reads better in the middle than hugging the top edge. */
  private backKey(): KeySpec {
    return {
      kind: 'control',
      lines: ['◀ BACK'],
      lineSizes: [BACK_SIZE],
      lineY: [40],
      align: 'center',
      border: theme.gray,
    }
  }

  /**
   * I4 — the grid strip's own `offline` honesty signal (see `strip` below)
   * used to disappear entirely in detail mode: `MARKET CLOSED · 4:00 PM
   * EDT` is the last TRADE time, not the last fetch, so a detail view left
   * open for hours after the network dropped read as entirely normal, at
   * full brightness, with nothing on the frame to say the daemon has not
   * reached Yahoo since this morning. Both strip lines are already spoken
   * for (the company name, the market state and trade time), so this
   * mirrors weather's own fix for the identical shape (`weather-page.ts`'s
   * `detailStrip`, its own M2): put the status in `right`, the field
   * `StripSpec` reserves for exactly this, rather than dropping either line.
   */
  private detailStrip(quote: Quote): StripSpec {
    const marketState = this.source.getMarketState()
    const line1 = truncate(quote.name, STRIP_CHARS)
    const line2 = truncate(
      `${STATE_LABELS[marketState]} · ${formatAsOfOrUnknown(quote.asOf > 0 ? quote.asOf : null)}`,
      STRIP_CHARS,
    )
    const right = this.source.getStatus() === 'offline' ? 'offline' : undefined
    return { lines: [line1, line2], right }
  }

  /**
   * Whether the grid strip would carry a scrolling tape right now. Read by both
   * `strip` and `tickMs`, so the declared render rate can never disagree with
   * whether anything is actually moving (lesson 21: one decision, one function).
   */
  private hasTape(quotes: Map<string, Quote>): boolean {
    if (this.source.getStatus() === 'offline') return false
    // A tape needs at least one real, priced quote. An empty board keeps its
    // static line 2, so an offline or not-yet-loaded deck still says so.
    return tapeSegments(quotes, (sym) => this.source.isSymbolStale(sym)).length > 0
  }

  /**
   * A fast tick ONLY while the tape is scrolling.
   *
   * Unlike the weather effects and the heat wash, this motion does not stop for
   * stale data: the strip shows about 30 of the tape's ~145 characters, so
   * freezing it would make seven of the eight symbols unreachable. The movement
   * carries the content, not just liveliness. Staleness is expressed in each
   * segment's colour and in line 1's timestamp instead. See the design note in
   * docs/superpowers/specs/2026-08-18-stocks-ticker-tape-design.md.
   */
  get tickMs(): number | undefined {
    // A detail view has no tape, so it keeps the default rate.
    const quotes = this.source.getQuotes()
    if (this.activeQuote(quotes) !== null) return undefined
    return this.hasTape(quotes) ? TAPE_TICK_MS : undefined
  }

  private strip(quotes: Map<string, Quote>, nowMs: number): StripSpec {
    const status = this.source.getStatus()
    const marketState = this.source.getMarketState()
    const line1 = truncate(`${STATE_LABELS[marketState]} · ${formatAsOfOrUnknown(latestAsOf(quotes))}`, STRIP_CHARS)

    let line2: string
    if (status === 'offline') {
      line2 = 'offline'
    } else {
      // The SAME count the round buttons' colour reads, so the lights and these
      // words can never contradict each other on one frame.
      const { up, down } = breadth(quotes.values())
      line2 = `${up} up · ${down} down`
    }

    const spec: StripSpec = { lines: [line1, truncate(line2, STRIP_CHARS)] }

    // The tape OWNS line 2's band when it is present, so `line2` above becomes
    // the fallback the offline and not-yet-loaded cases keep.
    if (this.hasTape(quotes)) {
      spec.tape = {
        segments: tapeSegments(quotes, (sym) => this.source.isSymbolStale(sym)),
        offsetPx: tapeOffsetPx(nowMs),
      }
    }

    return spec
  }

  onKeyPress(index: number): PressOutcome {
    const quotes = this.source.getQuotes()
    if (this.activeQuote(quotes) === null) {
      const symbol = SYMBOLS[index]
      if (!symbol) return 'ignored'
      // No quote at all for this key yet, or a quote with no price at all
      // (M1: a halted or non-trading instrument's `meta` can come back with
      // every price field null) — either way there is nothing to show a
      // detail view for, and a press that opens nothing must report
      // `ignored`, not `handled`, so the on-device flash tells the truth
      // (per AGENTS.md's "Press feedback" convention).
      const quote = quotes.get(symbol)
      if (!quote || quote.price === null) return 'ignored'
      this.selected = symbol
      // Lazily kicks off the 52-week fetch for THIS symbol only, right at
      // the moment its detail view opens — never for all eight symbols on
      // every poll. `setWatchedSymbol` is a no-op fetch-wise when a fresh
      // cache, an in-flight fetch, or a failure cooldown already covers it;
      // it also tells the source to keep re-checking freshness on its own
      // poll for as long as this symbol stays watched (see the finding
      // about `render()` never doing network I/O itself).
      this.source.setWatchedSymbol(symbol)
      return 'handled'
    }

    if (index === 7) {
      this.selected = null
      this.source.setWatchedSymbol(null)
      return 'handled'
    }
    // Keys 0 to 6 do nothing while a symbol is selected. Read-only: no
    // refresh-on-press, no browser.
    return 'ignored'
  }
}
