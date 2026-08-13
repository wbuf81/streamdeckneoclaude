import type { DeckFrame, KeySpec, Rgb, StripSpec } from '../render/specs.js'
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
  const sign = diff < 0 ? '-' : ''
  return `${sign}${Math.abs(diff).toFixed(2)}`
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
  /** Read-only. Never triggers a fetch — see `requestYearly`. */
  getYearlyState(symbol: string): YearlyState
  /** Kicks off a lazy, cached fetch of the 52-week series for one symbol.
   * The page calls this once, at the moment a symbol is selected for the
   * detail view — never on every render, and never for all eight symbols. */
  requestYearly(symbol: string): void
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

  render(now: number): DeckFrame {
    const quotes = this.source.getQuotes()

    const quote = this.activeQuote(quotes)
    if (quote) return this.detailFrame(this.selected!, quote, now)

    const keys = SYMBOLS.map((symbol) => this.tickerKey(quotes.get(symbol), symbol))
    return {
      keys,
      strip: this.strip(quotes, now),
      buttons: [theme.gray, theme.gray],
    }
  }

  private tickerKey(quote: Quote | undefined, symbol: string): KeySpec {
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

    return {
      keys,
      strip: this.detailStrip(quote, now),
      buttons: [theme.gray, theme.gray],
    }
  }

  /**
   * Picks what the wide chart (keys 4, 5 and 6) draws: the 52-week daily
   * series once `requestYearly` has loaded it, or the intraday series —
   * clearly labelled either way — while that fetch is still loading, has
   * never succeeded for this symbol, or the symbol simply has no yearly data
   * yet. Never hands back the intraday series under the `52 WK` label: the
   * label always matches the values it goes with, so a still-loading or
   * failed yearly fetch shows the grid's own honest range instead of
   * silently mislabelling a day as a year.
   *
   * Per I5: `requestYearly` used to fire only at the instant of selection,
   * so a detail view left open past the 6-hour refresh interval kept
   * drawing the SAME closes forever with nothing to say they had gone
   * stale. This gives the caller `stale` — the age the page can see — and
   * asks the source for a fresh copy right here. That is safe to call on
   * every render: `requestYearly` is itself cooldown- and in-flight-guarded
   * (docs/LESSONS.md lesson 10), so this can only ever start the ONE fetch
   * the staleness actually justifies, never a request per render tick.
   */
  private chartSeries(symbol: string, quote: Quote, now: number): { values: number[]; label: string; stale: boolean } {
    const yearly = this.source.getYearlyState(symbol)
    if (yearly.status === 'ok' && yearly.values.length >= 2) {
      const stale = now - yearly.updatedAt > YEARLY_REFRESH_SECONDS
      if (stale) this.source.requestYearly(symbol)
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

  private detailStrip(quote: Quote, now: number): StripSpec {
    const marketState = this.source.getMarketState()
    const asOf = quote.asOf > 0 ? quote.asOf : now
    const line1 = truncate(quote.name, STRIP_CHARS)
    const line2 = truncate(`${STATE_LABELS[marketState]} · ${formatAsOf(asOf)}`, STRIP_CHARS)
    return { lines: [line1, line2] }
  }

  private strip(quotes: Map<string, Quote>, now: number): StripSpec {
    const status = this.source.getStatus()
    const marketState = this.source.getMarketState()
    const asOf = latestAsOf(quotes) ?? now
    const line1 = truncate(`${STATE_LABELS[marketState]} · ${formatAsOf(asOf)}`, STRIP_CHARS)

    let line2: string
    if (status === 'offline') {
      line2 = 'offline'
    } else {
      let up = 0
      let down = 0
      for (const q of quotes.values()) {
        const trend = trendOf(q.changePercent)
        if (trend === 'up') up++
        else if (trend === 'down') down++
      }
      line2 = `${up} up · ${down} down`
    }

    return { lines: [line1, truncate(line2, STRIP_CHARS)] }
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
      // every poll. `requestYearly` is itself a no-op when a fresh cache,
      // an in-flight fetch, or a failure cooldown already covers it.
      this.source.requestYearly(symbol)
      return 'handled'
    }

    if (index === 7) {
      this.selected = null
      return 'handled'
    }
    // Keys 0 to 6 do nothing while a symbol is selected. Read-only: no
    // refresh-on-press, no browser.
    return 'ignored'
  }
}
