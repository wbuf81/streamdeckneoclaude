/**
 * A deterministic stocks board for the preview scripts (`page-shots.ts`,
 * `stocks-contact-sheet.ts`), so both draw the same day. Generic symbols
 * from the shipped default watchlist, never anyone's real list.
 *
 * The intraday series is 78 five-minute closes, the shape Yahoo's
 * `interval=5m` chart returns for a full session, wandering toward the
 * day's change the way the approved mockup's series does.
 */
import type { MarketBoundary, MarketState, Quote, YearlyState } from '../src/sources/stocks.js'
import { DEFAULT_SYMBOLS } from '../src/config.js'
import type { StockReader } from '../src/pages/stocks-page.js'

/** Six symbols, the size of the user's watchlist today, so the breadth and
 * mascot keys show. Changes follow the mockup's board. */
export const FIXTURE_SYMBOLS: readonly string[] = DEFAULT_SYMBOLS.slice(0, 6)
export const FIXTURE_CHANGES: readonly number[] = [-2.14, 0.42, 3.41, 1.07, -0.38, 0.88]
const PRICES: readonly number[] = [241.18, 512.4, 188.92, 918.3, 31.06, 226.55]
const VOLUMES: readonly (number | null)[] = [96_400_000, 18_200_000, 212_000_000, 1_400_000, null, 41_000_000]

function rnd(s: number): number {
  const x = Math.sin(s * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

export function fixtureQuote(symbol: string, changePercent: number, price: number, seed: number, asOf: number, volume: number | null = 1_000_000): Quote {
  const prev = price / (1 + changePercent / 100)
  const n = 78
  const spark: number[] = []
  for (let k = 0; k < n; k++) {
    const target = changePercent * (k / (n - 1))
    const wiggle = (rnd(seed * 50 + k) - 0.5) * Math.max(0.35, Math.abs(changePercent) * 0.35) * Math.sin(k / 9 + seed)
    const pct = k === n - 1 ? changePercent : target + wiggle
    spark.push(prev * (1 + pct / 100))
  }
  return {
    symbol, name: `${symbol} Inc.`, price, previousClose: prev,
    changePercent, spark, currency: 'USD', asOf,
    dayHigh: Math.max(...spark) * 1.001, dayLow: Math.min(...spark) * 0.999,
    week52High: price * 1.4, week52Low: price * 0.62, volume,
  }
}

export function fixtureQuotes(asOf: number, changes: readonly number[] = FIXTURE_CHANGES): Map<string, Quote> {
  const quotes = new Map<string, Quote>()
  FIXTURE_SYMBOLS.forEach((sym, i) => {
    quotes.set(sym, fixtureQuote(sym, changes[i] ?? 0, PRICES[i] ?? 100, i, asOf, VOLUMES[i] ?? null))
  })
  return quotes
}

export interface FixtureOptions {
  marketState?: MarketState | (() => MarketState)
  boundary?: MarketBoundary | null | (() => MarketBoundary | null)
  symbols?: readonly string[]
  quotes?: Map<string, Quote>
  asOf: number
}

export function fixtureReader(o: FixtureOptions): StockReader {
  const quotes = o.quotes ?? fixtureQuotes(o.asOf)
  const symbols = o.symbols ?? FIXTURE_SYMBOLS
  const state = o.marketState ?? 'open'
  const boundary = o.boundary ?? null
  const yearly = (sym: string): YearlyState => {
    const q = quotes.get(sym)
    const p = q?.price ?? 100
    const values = Array.from({ length: 251 }, (_, k) => p * (0.7 + 0.3 * (k / 250)) * (1 + 0.05 * Math.sin(k / 17)))
    return { status: 'ok', values, updatedAt: o.asOf }
  }
  return {
    getSymbols: () => symbols,
    getQuotes: () => quotes,
    getStatus: () => 'ok',
    getMarketState: () => (typeof state === 'function' ? state() : state),
    getNextBoundary: () => (typeof boundary === 'function' ? boundary() : boundary),
    isSymbolStale: () => false,
    getYearlyState: yearly,
    setWatchedSymbol: () => {},
    setVisible: () => {},
  }
}
