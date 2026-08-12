import { EventEmitter } from 'node:events'
import { log } from '../log.js'

/** The eight tickers, in the order they fill the deck's eight keys. */
export const SYMBOLS: readonly string[] = [
  'TSLA',
  'MSFT',
  'NVDA',
  'NOW',
  'SOFI',
  'HIMS',
  'SPCX',
  'AMZN',
] as const

export type MarketState = 'pre' | 'open' | 'post' | 'closed'
export type StockStatus = 'ok' | 'offline' | 'empty'

export interface Quote {
  symbol: string
  /** shortName, or the symbol when absent. */
  name: string
  price: number | null
  previousClose: number | null
  /** null when either price is unknown. Never NaN. */
  changePercent: number | null
  /** Intraday closes, nulls removed, oldest first. May be empty. */
  spark: number[]
  currency: string
  /** Epoch seconds of the last regular-market trade. */
  asOf: number
}

const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart'
/** Yahoo can reject a request with no User-Agent. */
const USER_AGENT = 'Mozilla/5.0'
const POLL_OPEN_MS = 60_000
const POLL_CLOSED_MS = 15 * 60 * 1000
/** A quote older than this, while the market is open, counts as stale. */
const STALE_SECONDS = 15 * 60

function urlFor(symbol: string): string {
  return `${BASE_URL}/${encodeURIComponent(symbol)}?range=1d&interval=5m`
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Reads `chart.result[0].meta` from the body. Returns null when absent. */
function extractMeta(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null
  const chart = (body as Record<string, unknown>).chart
  if (!chart || typeof chart !== 'object') return null
  const result = (chart as Record<string, unknown>).result
  if (!Array.isArray(result) || result.length === 0) return null
  const first = result[0]
  if (!first || typeof first !== 'object') return null
  const meta = (first as Record<string, unknown>).meta
  if (!meta || typeof meta !== 'object') return null
  return meta as Record<string, unknown>
}

/** Reads the intraday closes, with null holes filtered out. Never throws. */
function extractCloses(body: unknown): number[] {
  try {
    const chart = (body as Record<string, unknown>).chart as Record<string, unknown>
    const result = chart.result as unknown[]
    const first = result[0] as Record<string, unknown>
    const indicators = first.indicators as Record<string, unknown>
    const quotes = indicators.quote as unknown[]
    const q0 = quotes[0] as Record<string, unknown>
    const close = q0.close
    if (!Array.isArray(close)) return []
    return close.filter((v): v is number => typeof v === 'number')
  } catch {
    return []
  }
}

/** Reads `meta.currentTradingPeriod` from the body. Returns null when absent. */
function extractPeriod(body: unknown): unknown {
  const meta = extractMeta(body)
  return meta ? meta.currentTradingPeriod ?? null : null
}

/**
 * Parses one symbol's chart response. Returns null when the body carries no
 * usable `meta` block, which happens for an unknown symbol or a malformed
 * reply.
 */
export function parseQuote(symbol: string, body: unknown): Quote | null {
  const meta = extractMeta(body)
  if (!meta) return null

  const resolvedSymbol =
    typeof meta.symbol === 'string' && meta.symbol ? meta.symbol : symbol

  const price = numberOrNull(meta.regularMarketPrice)
  // Prefer previousClose; fall back to chartPreviousClose when absent.
  const previousClose =
    numberOrNull(meta.previousClose) ?? numberOrNull(meta.chartPreviousClose)
  const changePercent =
    price !== null && previousClose !== null && previousClose !== 0
      ? ((price - previousClose) / previousClose) * 100
      : null

  return {
    symbol: resolvedSymbol,
    name: typeof meta.shortName === 'string' && meta.shortName ? meta.shortName : resolvedSymbol,
    price,
    previousClose,
    changePercent,
    spark: extractCloses(body),
    currency: typeof meta.currency === 'string' ? meta.currency : '',
    asOf: typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime : 0,
  }
}

/** True when `now` falls in `[start, end)` of a `{ start, end }` window. */
function within(window: unknown, now: number): boolean {
  if (!window || typeof window !== 'object') return false
  const start = (window as Record<string, unknown>).start
  const end = (window as Record<string, unknown>).end
  if (typeof start !== 'number' || typeof end !== 'number') return false
  return now >= start && now < end
}

/**
 * Derives the market state from `currentTradingPeriod`. Yahoo's chart body
 * has no `marketState` field, so this is the only source of truth. A
 * malformed or absent period gives `closed`. Boundaries are inclusive of
 * start and exclusive of end.
 */
export function deriveMarketState(period: unknown, now: number): MarketState {
  if (!period || typeof period !== 'object') return 'closed'
  const p = period as Record<string, unknown>
  if (within(p.regular, now)) return 'open'
  if (within(p.pre, now)) return 'pre'
  if (within(p.post, now)) return 'post'
  return 'closed'
}

/**
 * Reduces `values` to at most `buckets` points, averaging within each
 * bucket. An empty array gives an empty result. Fewer values than buckets
 * gives the values back unchanged, one point per bucket.
 */
export function downsample(values: number[], buckets: number): number[] {
  if (buckets <= 0 || values.length === 0) return []
  if (values.length <= buckets) return [...values]
  const out: number[] = []
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor((i * values.length) / buckets)
    const end = Math.max(start + 1, Math.floor(((i + 1) * values.length) / buckets))
    const slice = values.slice(start, end)
    const sum = slice.reduce((a, b) => a + b, 0)
    out.push(sum / slice.length)
  }
  return out
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

interface FetchResult {
  quote: Quote | null
  period: unknown
}

/**
 * Reads daily price movement for a fixed list of tickers from Yahoo's public
 * chart endpoint. It polls only while the page is visible, at 60 seconds
 * while the market is open and 15 minutes otherwise, so a closed market and
 * an unwatched page do not spend requests for no reason.
 */
export class StockSource extends EventEmitter {
  private quotes = new Map<string, Quote>()
  private status: StockStatus = 'empty'
  private marketState: MarketState = 'closed'
  private timer: NodeJS.Timeout | null = null
  private visible = false
  /** Set by `stop()`, so a refresh continuation already in flight cannot arm
   * a new timer after shutdown. See `schedule()`, which checks this first. */
  private stopped = false
  /** Guards against overlapping refreshes, so a caller that invokes
   * `refresh()` again before the last one settles gets the same in-flight
   * result instead of starting a second round of eight requests. */
  private inFlight: Promise<void> | null = null
  private lastKey = ''

  constructor(
    private readonly symbols: readonly string[] = SYMBOLS,
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super()
  }

  /** Test helper. Swaps the fetch implementation mid-test. */
  setFetchForTest(f: FetchLike): void {
    this.fetchFn = f
  }

  /** Returns a copy. The caller cannot mutate the source's own state through
   * the result, and the map keeps being valid even after a later refresh
   * replaces `this.quotes` with a new one. */
  getQuotes(): Map<string, Quote> {
    return new Map(this.quotes)
  }

  getStatus(): StockStatus {
    return this.status
  }

  getMarketState(): MarketState {
    return this.marketState
  }

  /**
   * True when the newest known quote is older than 15 minutes and the market
   * is open. A closed market is not stale, it is closed, so the page can
   * tell the two apart instead of presenting old prices as current.
   */
  isStale(): boolean {
    if (this.marketState !== 'open') return false
    let newest = -Infinity
    for (const q of this.quotes.values()) {
      if (q.asOf > newest) newest = q.asOf
    }
    if (newest === -Infinity) return false
    return this.now() - newest > STALE_SECONDS
  }

  /**
   * True when THIS symbol's own quote is older than 15 minutes while the
   * market is open. `isStale()` looks only at the newest quote across every
   * symbol, so one lagging symbol can hide behind the others and never dim
   * on its own. This lets a caller check staleness per symbol instead.
   * False for a symbol with no quote yet — there is nothing stale to show.
   */
  isSymbolStale(symbol: string): boolean {
    if (this.marketState !== 'open') return false
    const q = this.quotes.get(symbol)
    if (!q) return false
    return this.now() - q.asOf > STALE_SECONDS
  }

  /** Called when the stocks page becomes visible. It refreshes at once and
   * starts the poll loop. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) {
      this.stopped = false
      void this.refresh().then(() => this.schedule())
    } else if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    // A refresh started before `stop()` can still be in flight when it
    // settles. Its continuation must not arm a new timer after shutdown, so
    // this check runs before anything else, ahead of even the `visible`
    // check below.
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    if (!this.visible) return
    const delay = this.marketState === 'open' ? POLL_OPEN_MS : POLL_CLOSED_MS
    this.timer = setTimeout(() => {
      void this.refresh().then(() => this.schedule())
    }, delay)
  }

  private async fetchOne(symbol: string): Promise<FetchResult> {
    let res
    try {
      res = await this.fetchFn(urlFor(symbol), {
        headers: { 'User-Agent': USER_AGENT },
      })
    } catch (e) {
      // This runs on every poll while a symbol keeps failing, so it must log
      // once per symbol rather than spam the log every cycle.
      log.once(`stocks-network-${symbol}`, `Stock fetch for ${symbol} failed: ${String(e)}`)
      return { quote: null, period: null }
    }

    if (!res.ok) {
      log.once(
        `stocks-http-${symbol}`,
        `Stock fetch for ${symbol} failed with status ${res.status}.`,
      )
      return { quote: null, period: null }
    }

    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      // A malformed body must not escape as an unhandled rejection through
      // the poll loop's `.then(() => this.schedule())` continuation.
      log.once(`stocks-json-${symbol}`, `Stock response for ${symbol} is not valid JSON: ${String(e)}`)
      return { quote: null, period: null }
    }

    const quote = parseQuote(symbol, body)
    if (!quote) {
      log.once(`stocks-parse-${symbol}`, `Stock response for ${symbol} has no usable data.`)
    }
    return { quote, period: extractPeriod(body) }
  }

  /**
   * Fetches all symbols concurrently. One bad symbol keeps its last known
   * quote and does not blank the rest. Emits `change` only when the full
   * snapshot (quotes, status, and market state) actually differs from the
   * last one, following the pattern in `src/sources/claude.ts`: a partial
   * comparison key can miss a real update and leave stale text on the deck.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async doRefresh(): Promise<void> {
    const results = await Promise.all(this.symbols.map((s) => this.fetchOne(s)))

    const next = new Map(this.quotes)
    let anySuccess = false
    let period: unknown = null
    for (let i = 0; i < this.symbols.length; i++) {
      const symbol = this.symbols[i]!
      const r = results[i]!
      if (r.quote) {
        next.set(symbol, r.quote)
        anySuccess = true
      }
      if (period === null && r.period !== null) period = r.period
    }
    this.quotes = next
    this.status = anySuccess ? 'ok' : this.quotes.size > 0 ? 'offline' : 'empty'
    // Keep the last known market state when every symbol failed this round;
    // a total outage must not reset the state to `closed`.
    if (period !== null) this.marketState = deriveMarketState(period, this.now())

    const key = JSON.stringify({
      quotes: [...this.quotes.entries()],
      status: this.status,
      marketState: this.marketState,
    })
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit('change')
  }

  async start(): Promise<void> {
    // Nothing to do until the page becomes visible.
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
