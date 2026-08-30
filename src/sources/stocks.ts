import { EventEmitter } from 'node:events'
import { log } from '../log.js'
import { DEFAULT_SYMBOLS } from '../config.js'

/**
 * The tickers the deck shows, in the order they fill its eight keys.
 *
 * This was the author's own watchlist, compiled in. It is configuration now
 * (`stocks.symbols` in `config.json`); this re-export is the DEFAULT the
 * config falls back to, and it is deliberately generic — broad-market ETFs
 * and the largest listed names, which say nothing about whoever installed
 * the deck.
 */
export { DEFAULT_SYMBOLS as SYMBOLS } from '../config.js'

/**
 * `'unknown'` per finding I1 and docs/LESSONS.md lesson 18: an absent or
 * malformed `currentTradingPeriod` is a signal that never arrived, not a
 * measured closed market. Only a real window that `now` genuinely falls
 * outside of earns `'closed'`.
 */
export type MarketState = 'pre' | 'open' | 'post' | 'closed' | 'unknown'
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
  /** Today's high and low. Absent renders as `--`, never `0`. */
  dayHigh: number | null
  dayLow: number | null
  /** The 52-week high and low. Absent renders as `--`, never `0`. */
  week52High: number | null
  week52Low: number | null
  /** Today's share volume. Absent renders as `--`, never `0`. */
  volume: number | null
}

const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart'
/** Yahoo can reject a request with no User-Agent. */
const USER_AGENT = 'Mozilla/5.0'
const POLL_OPEN_MS = 60_000
const POLL_CLOSED_MS = 15 * 60 * 1000
/** A quote older than this, while the market is open, counts as stale. */
const STALE_SECONDS = 15 * 60
/**
 * The yearly series is daily-interval data, so it does not need to be as
 * fresh as the intraday poll. Measured live on 2026-08-13 (see
 * docs/VERIFIED-FACTS.md "Stocks"): a full year of TSLA gave 251 points, one
 * per trading day, no `null` holes. A cache this long avoids re-fetching a
 * series that only grows by one point per trading day.
 */
export const YEARLY_REFRESH_SECONDS = 6 * 60 * 60
/**
 * Lesson 10 in docs/LESSONS.md: a guard cleared on failure is a request
 * storm, not a guard. A failed yearly fetch waits this long before the next
 * attempt, instead of retrying on every selection or render.
 */
const YEARLY_COOLDOWN_SECONDS = 5 * 60

function urlFor(symbol: string): string {
  return `${BASE_URL}/${encodeURIComponent(symbol)}?range=1d&interval=5m`
}

function urlForYearly(symbol: string): string {
  return `${BASE_URL}/${encodeURIComponent(symbol)}?range=1y&interval=1d`
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

  // Per M4: the yearly path (`doFetchYearly`) already discards a body whose
  // `meta.symbol` names a DIFFERENT symbol than the one requested, rather
  // than caching it under the requested key. This path used to disagree —
  // it kept such a body and resolved `quote.symbol` to the ALIASED name,
  // which the detail view renders directly (`priceKey`'s `quote.symbol`
  // line), so an aliased reply could show the wrong ticker's name on the
  // symbol the user actually pressed. Treating it as a failed parse, the
  // same as the yearly path, keeps the two consistent. A body with no
  // `meta.symbol` at all carries nothing to cross-check and is accepted, as
  // before.
  if (typeof meta.symbol === 'string' && meta.symbol && meta.symbol !== symbol) {
    return null
  }

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
    dayHigh: numberOrNull(meta.regularMarketDayHigh),
    dayLow: numberOrNull(meta.regularMarketDayLow),
    week52High: numberOrNull(meta.fiftyTwoWeekHigh),
    week52Low: numberOrNull(meta.fiftyTwoWeekLow),
    volume: numberOrNull(meta.regularMarketVolume),
  }
}

/** True when `window` is a usable `{ start, end }` pair — both numeric. */
function isWindow(window: unknown): boolean {
  if (!window || typeof window !== 'object') return false
  const start = (window as Record<string, unknown>).start
  const end = (window as Record<string, unknown>).end
  return typeof start === 'number' && typeof end === 'number'
}

/** True when `now` falls in `[start, end)` of a `{ start, end }` window. */
function within(window: unknown, now: number): boolean {
  if (!isWindow(window)) return false
  const w = window as Record<string, unknown>
  return now >= (w.start as number) && now < (w.end as number)
}

/**
 * Derives the market state from `currentTradingPeriod`. Yahoo's chart body
 * has no `marketState` field, so this is the only source of truth.
 *
 * Per finding I1: a malformed or absent period carries NO signal at all —
 * `'unknown'`, never a fabricated `'closed'` (lesson 18). `'closed'` is
 * reserved for the case this function can actually measure: at least one
 * real `{ start, end }` window is present, and `now` genuinely falls
 * outside every one of them. Boundaries are inclusive of start and
 * exclusive of end.
 */
export function deriveMarketState(period: unknown, now: number): MarketState {
  if (!period || typeof period !== 'object') return 'unknown'
  const p = period as Record<string, unknown>
  if (!isWindow(p.regular) && !isWindow(p.pre) && !isWindow(p.post)) return 'unknown'
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
 * The 52-week detail chart's own state for one symbol. `'unknown'` means
 * nobody has asked for this symbol yet. `'loading'` means a fetch is in
 * flight and no cached series exists yet. `'ok'` carries at least 2 daily
 * closes, oldest first, plus `updatedAt` (epoch seconds of the fetch that
 * produced them) — per finding I5, a page drawing this series needs to see
 * its own age, since `requestYearly` only ever runs at the moment a symbol
 * is selected and a detail view can stay open far longer than the 6-hour
 * refresh interval with no other trigger to notice. `'error'` means the
 * last attempt failed and no successful fetch has EVER landed for this
 * symbol — a symbol with older
 * good data keeps reporting `'ok'` with that data while a background retry
 * is in cooldown, per docs/LESSONS.md lesson 10.
 */
export type YearlyState =
  | { status: 'unknown' }
  | { status: 'loading' }
  | { status: 'ok'; values: number[]; updatedAt: number }
  | { status: 'error' }

interface YearlyEntry {
  status: 'ok' | 'error'
  /** Closes, oldest first, null holes filtered. Empty when status is 'error'. */
  values: number[]
  /** Epoch seconds of the last SUCCESSFUL fetch. 0 when never successful. */
  updatedAt: number
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
  /** Per I1: `'unknown'`, never `'closed'` — nothing has been measured yet. */
  private marketState: MarketState = 'unknown'
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

  /** The 52-week series, cached per symbol. Fetched lazily — see
   * `requestYearly` — never for all eight symbols on every poll. */
  private yearly = new Map<string, YearlyEntry>()
  /** Symbols with a fetch in flight right now. */
  private yearlyInFlight = new Set<string>()
  /** Epoch seconds before which a failed symbol will not be retried. A
   * cooldown, not a guard cleared in `finally` — see docs/LESSONS.md #10. */
  private yearlyCooldownUntil = new Map<string, number>()
  /**
   * The symbol whose detail view is open right now, or null. Per M1: a page
   * must never perform network I/O from `render()` (AGENTS.md's "Keep pages
   * pure"), so this source — not the page — is what re-checks the watched
   * symbol's yearly freshness, on the SAME intraday poll tick it already
   * runs on. `setWatchedSymbol` is the only way this changes, and the page
   * calls it from `onKeyPress`, never from `render`.
   */
  private watchedSymbol: string | null = null

  constructor(
    private readonly symbols: readonly string[] = DEFAULT_SYMBOLS,
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super()
  }

  /**
   * The symbols this source actually polls, in key order.
   *
   * The page used to import the module-level `SYMBOLS` for its tile layout.
   * That was correct only while the watchlist was a compiled-in constant that
   * both sides shared. Once the list became configuration, the page kept
   * drawing the DEFAULT eight while this source fetched the configured ones,
   * so five tiles looked up a symbol no quote existed for and rendered empty.
   * The list has exactly one owner now, and it is whoever was constructed with
   * it.
   */
  getSymbols(): readonly string[] {
    return this.symbols
  }

  /** Test helper. Swaps the fetch implementation mid-test. */
  setFetchForTest(f: FetchLike): void {
    this.fetchFn = f
  }

  /**
   * Returns a copy deep enough that the caller cannot mutate the source's
   * own state through the result, and the map keeps being valid even after
   * a later refresh replaces `this.quotes` with a new one.
   *
   * I2: a shallow `new Map(this.quotes)` — this method's own doc comment
   * used to claim exactly the safety property this paragraph now describes,
   * while the code below it copied only the MAP, leaving every `Quote`
   * object and its `spark` array shared with the source's live cache.
   * Verified: `getQuotes().get('TSLA').price = -1` and
   * `.spark.push(999)` both corrupted the source's own state, and the
   * corruption then suppressed the very whole-snapshot `change` key
   * (`doRefresh`) that would have repaired it on the next poll. A new
   * object per quote, with a new array for `spark`, is deep enough — every
   * other field is a primitive.
   */
  getQuotes(): Map<string, Quote> {
    const out = new Map<string, Quote>()
    for (const [symbol, quote] of this.quotes) {
      out.set(symbol, { ...quote, spark: [...quote.spark] })
    }
    return out
  }

  getStatus(): StockStatus {
    return this.status
  }

  getMarketState(): MarketState {
    return this.marketState
  }

  /**
   * True when THIS symbol's own quote is older than 15 minutes while the
   * market is open, OR the market state is unknown at all and a quote
   * exists. False for a symbol with no quote yet — there is nothing stale to
   * show — and false while the market is genuinely `'closed'`, `'pre'`, or
   * `'post'`: a real measured state, not a signal that never arrived.
   *
   * I4: `'unknown'` used to read the SAME as `'open'` being false — a
   * one-sided `if (this.marketState !== 'open') return false` treated an
   * absent or malformed `currentTradingPeriod` as a positive reason NOT to
   * dim, lesson 18 inverted (absence read as a safe state). An unmeasured
   * market state is not evidence of freshness; it is evidence of nothing,
   * and the honest answer is "cannot tell whether this is stale", which
   * dims rather than brightens.
   *
   * (`isStale()`, the whole-source sibling of this method, was deleted: it
   * had no caller anywhere in `src/` — not even `StockReader`, the
   * interface `stocks-page.ts` actually depends on, ever declared it — the
   * same dead-freshness-API trap `docs/LESSONS.md` records for Codex's
   * `usage.ts`. `isSymbolStale` is the one the page uses, at both the grid
   * tile and the detail view.)
   */
  isSymbolStale(symbol: string): boolean {
    const q = this.quotes.get(symbol)
    if (!q) return false
    if (this.marketState === 'unknown') return true
    if (this.marketState !== 'open') return false
    return this.now() - q.asOf > STALE_SECONDS
  }

  /** Called when the stocks page becomes visible. It refreshes at once and
   * starts the poll loop. I5: a source that has already been `stop()`ped
   * stays stopped — this never clears `stopped`, so a stray
   * `setVisible(true)` after shutdown cannot restart polling. Matches
   * `CodexSource`, the one sibling that already made `stopped` a one-way
   * latch. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (this.stopped) return
    if (visible) {
      void this.refreshAndSchedule()
    } else if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** M4: `refresh()` should not reject in practice — every network step
   * inside `doRefresh` already catches its own failure — but this loop runs
   * on a `setTimeout` chain, not `setInterval`: an uncaught rejection here
   * would silently stop `schedule()` from ever running again, unlike
   * `CodexSource`'s `setInterval` (which keeps ticking on its own) or
   * `SpotifySource.pollAndSchedule` (which already has this shape). A stray
   * failure is logged rather than swallowed, and polling continues either
   * way via the `finally`. */
  private async refreshAndSchedule(): Promise<void> {
    try {
      await this.refresh()
    } catch (e) {
      log.once('stocks-refresh-unexpected', `stock refresh failed unexpectedly: ${String(e)}`)
    } finally {
      this.schedule()
    }
  }

  /**
   * Tells the source which symbol's detail view is open, or clears it with
   * `null`. Per M1: this is the seam that lets `render()` stay pure — it
   * kicks off an immediate `requestYearly` for a newly-watched symbol (the
   * same "fetch once, at selection" behaviour the page used to trigger
   * itself), and `doRefresh` re-checks the watched symbol's freshness on
   * every INTRADAY poll after that, so a detail view left open past
   * `YEARLY_REFRESH_SECONDS` still gets a fresh yearly series without the
   * page ever touching the network from `render`.
   */
  setWatchedSymbol(symbol: string | null): void {
    this.watchedSymbol = symbol
    if (symbol) this.requestYearly(symbol)
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
      void this.refreshAndSchedule()
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
    log.clearOnce(`stocks-network-${symbol}`)

    if (!res.ok) {
      log.once(
        `stocks-http-${symbol}`,
        `Stock fetch for ${symbol} failed with status ${res.status}.`,
      )
      return { quote: null, period: null }
    }
    log.clearOnce(`stocks-http-${symbol}`)

    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      // A malformed body must not escape as an unhandled rejection through
      // the poll loop's `.then(() => this.schedule())` continuation.
      log.once(`stocks-json-${symbol}`, `Stock response for ${symbol} is not valid JSON: ${String(e)}`)
      return { quote: null, period: null }
    }
    log.clearOnce(`stocks-json-${symbol}`)

    const quote = parseQuote(symbol, body)
    if (!quote) {
      log.once(`stocks-parse-${symbol}`, `Stock response for ${symbol} has no usable data.`)
    } else {
      log.clearOnce(`stocks-parse-${symbol}`)
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

    // M1: re-check the watched symbol's yearly freshness on the source's own
    // poll tick, so `render()` never has to call `requestYearly` itself.
    // `requestYearly` is already in-flight-, freshness- and
    // cooldown-guarded (docs/LESSONS.md #10), so this can only ever start
    // the one fetch a real staleness justifies, never one per poll.
    if (this.watchedSymbol) this.requestYearly(this.watchedSymbol)

    const key = JSON.stringify({
      quotes: [...this.quotes.entries()],
      status: this.status,
      marketState: this.marketState,
    })
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit('change')
  }

  /**
   * The 52-week series for one symbol, or its current fetch/failure state.
   * Read-only: never triggers a fetch. The detail view calls this on every
   * render, so it must stay a plain lookup with no side effect.
   *
   * I2: `values` used to be handed back by reference to the cache entry
   * itself. Verified: a caller truncating the returned array (the natural
   * thing to do before drawing a sparkline) blanked the cached series down
   * to `{ values: [] }`, and since `requestYearly` will not refetch for
   * `YEARLY_REFRESH_SECONDS` (6 hours), one in-place mutation blanked the
   * 52-week chart for six hours with no way to recover sooner.
   */
  getYearlyState(symbol: string): YearlyState {
    const entry = this.yearly.get(symbol)
    if (entry?.status === 'ok') {
      return { status: 'ok', values: [...entry.values], updatedAt: entry.updatedAt }
    }
    if (this.yearlyInFlight.has(symbol)) return { status: 'loading' }
    if (entry?.status === 'error') return { status: 'error' }
    return { status: 'unknown' }
  }

  /**
   * Fetches the 52-week series for one symbol, but only when there is a real
   * reason to: no cached success yet, or the cached success is older than
   * `YEARLY_REFRESH_SECONDS`, and no cooldown from a recent failure is
   * active, and no fetch for this symbol is already in flight. The stocks
   * page calls this once, when a symbol is selected for the detail view —
   * never for all eight symbols on every poll.
   *
   * Fire-and-forget: the caller reads the result later through
   * `getYearlyState`, the same pattern `setVisible` uses for the intraday
   * poll.
   */
  requestYearly(symbol: string): void {
    if (this.stopped) return
    if (this.yearlyInFlight.has(symbol)) return

    const now = this.now()
    const entry = this.yearly.get(symbol)
    if (entry?.status === 'ok' && now - entry.updatedAt < YEARLY_REFRESH_SECONDS) return
    const cooldownUntil = this.yearlyCooldownUntil.get(symbol) ?? 0
    if (now < cooldownUntil) return

    this.yearlyInFlight.add(symbol)
    void this.doFetchYearly(symbol).finally(() => {
      this.yearlyInFlight.delete(symbol)
    })
  }

  private async doFetchYearly(symbol: string): Promise<void> {
    let res
    try {
      res = await this.fetchFn(urlForYearly(symbol), {
        headers: { 'User-Agent': USER_AGENT },
      })
    } catch (e) {
      // Runs on every failed attempt while a symbol keeps failing, so this
      // must log once per symbol, not once per attempt.
      log.once(`stocks-yearly-network-${symbol}`, `Yearly fetch for ${symbol} failed: ${String(e)}`)
      this.failYearly(symbol)
      return
    }
    // M5: each key clears immediately after the step it belongs to passes —
    // matching `fetchOne`'s own pattern — rather than being bundled after a
    // LATER check. The bundled form left `stocks-yearly-network` cleared
    // only once `!res.ok` also passed, so a persistent HTTP error (which
    // never reaches that line) left the NETWORK key permanently marked
    // "seen" from any earlier network failure, and a later genuine network
    // failure would then log nothing at all.
    log.clearOnce(`stocks-yearly-network-${symbol}`)
    if (this.stopped) return

    if (!res.ok) {
      log.once(
        `stocks-yearly-http-${symbol}`,
        `Yearly fetch for ${symbol} failed with status ${res.status}.`,
      )
      this.failYearly(symbol)
      return
    }
    log.clearOnce(`stocks-yearly-http-${symbol}`)

    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      log.once(`stocks-yearly-json-${symbol}`, `Yearly response for ${symbol} is not valid JSON: ${String(e)}`)
      this.failYearly(symbol)
      return
    }
    // Same fix as the network key above: this used to clear only after the
    // `values.length < 2` check further down also passed, so a body that
    // PARSED fine but carried too short a series left the JSON key
    // permanently "seen" from any earlier JSON failure.
    log.clearOnce(`stocks-yearly-json-${symbol}`)
    if (this.stopped) return

    // M4: `doFetchYearly` used to cache whatever came back purely under the
    // REQUESTED symbol, with no check that the response was actually for
    // it. `parseQuote` already resolves `meta.symbol` for the intraday body;
    // this is the same cross-check for the yearly one, so an aliased or
    // mismatched reply is treated as a failure rather than silently drawing
    // one symbol's year under another symbol's caption.
    const meta = extractMeta(body)
    const metaSymbol = meta && typeof meta.symbol === 'string' ? meta.symbol : ''
    if (metaSymbol && metaSymbol !== symbol) {
      log.once(
        `stocks-yearly-symbol-${symbol}`,
        `Yearly fetch for ${symbol} returned data for ${metaSymbol}; discarding.`,
      )
      this.failYearly(symbol)
      return
    }
    log.clearOnce(`stocks-yearly-symbol-${symbol}`)

    const values = extractCloses(body)
    if (values.length < 2) {
      log.once(`stocks-yearly-parse-${symbol}`, `Yearly response for ${symbol} has no usable series.`)
      this.failYearly(symbol)
      return
    }
    log.clearOnce(`stocks-yearly-parse-${symbol}`)

    this.yearly.set(symbol, { status: 'ok', values, updatedAt: this.now() })
    this.yearlyCooldownUntil.delete(symbol)
  }

  /**
   * Records a failed yearly fetch. Sets a cooldown so the NEXT call to
   * `requestYearly` for this symbol waits rather than retrying immediately
   * (docs/LESSONS.md #10). A symbol with an existing successful cache keeps
   * that cache and reports `'ok'` — a transient failure must not discard
   * good data that is merely a little older than the refresh interval.
   */
  private failYearly(symbol: string): void {
    this.yearlyCooldownUntil.set(symbol, this.now() + YEARLY_COOLDOWN_SECONDS)
    const entry = this.yearly.get(symbol)
    if (!entry || entry.status !== 'ok') {
      this.yearly.set(symbol, { status: 'error', values: [], updatedAt: entry?.updatedAt ?? 0 })
    }
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
