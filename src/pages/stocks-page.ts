import type { DeckFrame, KeySpec, Rgb, StripSpec } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate } from '../render/text.js'
import type { Page } from './types.js'
import type { MarketState, Quote, StockStatus } from '../sources/stocks.js'
import { SYMBOLS, downsample } from '../sources/stocks.js'

/** How many buckets the intraday series downsamples to for the tile. */
const SPARK_BUCKETS = 12
/** Measured limit for one strip line. See `render/canvas.ts`. */
const STRIP_CHARS = 30
/** The exchange timezone for every symbol on this page. All eight tickers
 * trade on a US exchange, so one timezone covers them all. */
const EXCHANGE_TZ = 'America/New_York'

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

/** The newest `asOf` across all quotes, or null when none is known yet. */
function latestAsOf(quotes: Map<string, Quote>): number | null {
  let max: number | null = null
  for (const q of quotes.values()) {
    if (q.asOf > 0 && (max === null || q.asOf > max)) max = q.asOf
  }
  return max
}

/** `16:20 EDT` in the exchange timezone. Never throws: a formatting failure
 * is not worth losing the whole strip line over. */
function formatAsOf(epochSeconds: number): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: EXCHANGE_TZ,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date(epochSeconds * 1000))
  } catch {
    return ''
  }
}

/** The part of `StockSource` this page needs. */
export interface StockReader {
  getQuotes(): Map<string, Quote>
  getStatus(): StockStatus
  getMarketState(): MarketState
  isStale(): boolean
  setVisible(visible: boolean): void
}

/**
 * One ticker per key, eight keys, eight symbols, no empty key and no
 * overflow. The whole key dims when the shared quote snapshot is stale, so a
 * stale price never presents as current.
 */
export class StocksPage implements Page {
  readonly name = 'stocks'

  constructor(private readonly source: StockReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.source.setVisible(false)
  }

  render(now: number): DeckFrame {
    const quotes = this.source.getQuotes()
    const stale = this.source.isStale()
    const keys = SYMBOLS.map((symbol) => this.tickerKey(quotes.get(symbol), symbol, stale))

    return {
      keys,
      strip: this.strip(quotes, now),
      buttons: [theme.gray, theme.gray],
    }
  }

  private tickerKey(quote: Quote | undefined, symbol: string, sourceStale: boolean): KeySpec {
    const trend = trendOf(quote?.changePercent ?? null)
    const unknown = !quote || quote.price === null

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

    if (sourceStale || unknown) key.dim = true

    return key
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

  onKeyPress(_index: number): void {
    // Read-only for now. No refresh-on-press, no browser.
  }
}
