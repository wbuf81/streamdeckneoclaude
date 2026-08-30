import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SYMBOLS,
  StockSource,
  parseQuote,
  deriveMarketState,
  downsample,
  YEARLY_REFRESH_SECONDS,
} from '../../src/sources/stocks.js'
import { log, setDefaultSink } from '../../src/log.js'

const NOW = 1_755_000_000

/**
 * Test quality: a source's fetch parameter must never fall back to the real
 * global `fetch` inside the suite — that is one edit away from live network
 * I/O, per the review's exact finding. A test that genuinely never expects a
 * call passes this instead of `undefined`, so the constructor's own default
 * parameter (`fetch as unknown as FetchLike`) never kicks in.
 */
const neverFetch = (): Promise<never> => {
  throw new Error('test: fetch must not be called')
}

/** A window relative to NOW, in seconds. */
function windowAround(now: number, offsetStart: number, offsetEnd: number) {
  return { start: now + offsetStart, end: now + offsetEnd, timezone: 'EDT', gmtoffset: -14400 }
}

const REGULAR_OPEN = windowAround(NOW, -1800, 1800)

function chartBody(overrides: Record<string, unknown> = {}, metaOverrides: Record<string, unknown> = {}) {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol: 'TSLA',
            currency: 'USD',
            shortName: 'Tesla, Inc.',
            longName: 'Tesla, Inc.',
            fullExchangeName: 'NasdaqGS',
            regularMarketPrice: 250.5,
            previousClose: 245,
            chartPreviousClose: 244.5,
            regularMarketDayHigh: 252,
            regularMarketDayLow: 248,
            regularMarketVolume: 12345678,
            regularMarketTime: NOW,
            fiftyTwoWeekHigh: 300,
            fiftyTwoWeekLow: 150,
            currentTradingPeriod: {
              pre: windowAround(NOW, -18000, -1800),
              regular: REGULAR_OPEN,
              post: windowAround(NOW, 1800, 18000),
            },
            exchangeTimezoneName: 'America/New_York',
            timezone: 'EDT',
            ...metaOverrides,
          },
          indicators: {
            quote: [{ close: [248.1, null, 249.3, 250.5] }],
          },
        },
      ],
      error: null,
      ...overrides,
    },
  }
}

describe('parseQuote', () => {
  it('reads price, previousClose, changePercent, name, and spark from a realistic fixture', () => {
    const q = parseQuote('TSLA', chartBody())!
    expect(q.symbol).toBe('TSLA')
    expect(q.name).toBe('Tesla, Inc.')
    expect(q.price).toBe(250.5)
    expect(q.previousClose).toBe(245)
    expect(q.changePercent).not.toBeNull()
    expect(q.changePercent!).toBeGreaterThan(0)
    expect(q.changePercent!).toBeCloseTo(((250.5 - 245) / 245) * 100, 5)
    expect(q.spark).toEqual([248.1, 249.3, 250.5])
    expect(q.currency).toBe('USD')
    expect(q.asOf).toBe(NOW)
  })

  it('reads dayHigh, dayLow, week52High, week52Low and volume from the same fixture', () => {
    const q = parseQuote('TSLA', chartBody())!
    expect(q.dayHigh).toBe(252)
    expect(q.dayLow).toBe(248)
    expect(q.week52High).toBe(300)
    expect(q.week52Low).toBe(150)
    expect(q.volume).toBe(12345678)
  })

  it('gives dayHigh, dayLow, week52High, week52Low and volume as null, never 0, when absent', () => {
    const q = parseQuote(
      'TSLA',
      chartBody(
        {},
        {
          regularMarketDayHigh: undefined,
          regularMarketDayLow: undefined,
          fiftyTwoWeekHigh: undefined,
          fiftyTwoWeekLow: undefined,
          regularMarketVolume: undefined,
        },
      ),
    )!
    expect(q.dayHigh).toBeNull()
    expect(q.dayLow).toBeNull()
    expect(q.week52High).toBeNull()
    expect(q.week52Low).toBeNull()
    expect(q.volume).toBeNull()
  })

  it('gives a negative changePercent when price is below previousClose', () => {
    const q = parseQuote('TSLA', chartBody({}, { regularMarketPrice: 200 }))!
    expect(q.changePercent!).toBeLessThan(0)
  })

  it('returns null for a body with no meta', () => {
    expect(parseQuote('TSLA', { chart: { result: null, error: { code: 'x' } } })).toBeNull()
    expect(parseQuote('TSLA', {})).toBeNull()
    expect(parseQuote('TSLA', null)).toBeNull()
  })

  it('gives changePercent null, never NaN, when price is missing', () => {
    const q = parseQuote('TSLA', chartBody({}, { regularMarketPrice: undefined }))!
    expect(q.price).toBeNull()
    expect(q.changePercent).toBeNull()
    expect(Number.isNaN(q.changePercent as unknown as number)).toBe(false)
  })

  it('gives changePercent null when previousClose and chartPreviousClose are both missing', () => {
    const q = parseQuote(
      'TSLA',
      chartBody({}, { previousClose: undefined, chartPreviousClose: undefined }),
    )!
    expect(q.previousClose).toBeNull()
    expect(q.changePercent).toBeNull()
  })

  it('falls back to chartPreviousClose when previousClose is absent', () => {
    const q = parseQuote('TSLA', chartBody({}, { previousClose: undefined }))!
    expect(q.previousClose).toBe(244.5)
  })

  it('falls back to the symbol for name when shortName is absent', () => {
    const q = parseQuote('TSLA', chartBody({}, { shortName: undefined }))!
    expect(q.name).toBe('TSLA')
  })

  it('filters null holes out of the spark series', () => {
    const q = parseQuote(
      'TSLA',
      {
        chart: {
          result: [
            {
              meta: chartBody().chart.result[0]!.meta,
              indicators: { quote: [{ close: [null, 1, null, 2, null] }] },
            },
          ],
        },
      },
    )!
    expect(q.spark).toEqual([1, 2])
  })

  it('M4: rejects a body whose meta.symbol names a DIFFERENT symbol than requested, same as the yearly path', () => {
    // Before this fix, this path disagreed with `doFetchYearly`'s own
    // cross-check: it kept the aliased body and resolved `quote.symbol` to
    // the WRONG name, which the detail view renders directly. Treating it
    // as a failed parse — like a malformed body — keeps the two paths
    // consistent, per the review's M4 finding.
    expect(parseQuote('TSLA', chartBody({}, { symbol: 'AAPL' }))).toBeNull()
  })

  it('M4: still accepts a body with no meta.symbol at all — nothing to cross-check', () => {
    const q = parseQuote('TSLA', chartBody({}, { symbol: undefined }))!
    expect(q).not.toBeNull()
    expect(q.symbol).toBe('TSLA')
  })

  it('accepts a body whose meta.symbol matches the requested symbol exactly', () => {
    const q = parseQuote('TSLA', chartBody({}, { symbol: 'TSLA' }))!
    expect(q.symbol).toBe('TSLA')
  })
})

describe('deriveMarketState', () => {
  const p = {
    pre: { start: 100, end: 200 },
    regular: { start: 200, end: 300 },
    post: { start: 300, end: 400 },
  }

  it('reports pre inside the pre window', () => {
    expect(deriveMarketState(p, 150)).toBe('pre')
  })

  it('reports open inside the regular window', () => {
    expect(deriveMarketState(p, 250)).toBe('open')
  })

  it('reports post inside the post window', () => {
    expect(deriveMarketState(p, 350)).toBe('post')
  })

  it('reports closed outside every window', () => {
    expect(deriveMarketState(p, 50)).toBe('closed')
    expect(deriveMarketState(p, 450)).toBe('closed')
  })

  it('is inclusive of start and exclusive of end', () => {
    expect(deriveMarketState(p, 200)).toBe('open')
    expect(deriveMarketState(p, 300)).toBe('post')
    expect(deriveMarketState(p, 400)).toBe('closed')
  })

  it('reports unknown, never a fabricated closed, for a malformed or absent period (I1, lesson 18)', () => {
    // A market state that was never measured is unknown, not closed — the
    // previous behaviour reported "closed" for data that never arrived at
    // all, which reads as a measured fact beside a render-clock timestamp.
    expect(deriveMarketState(null, 250)).toBe('unknown')
    expect(deriveMarketState(undefined, 250)).toBe('unknown')
    expect(deriveMarketState({}, 250)).toBe('unknown')
    expect(deriveMarketState({ regular: 'nope' }, 250)).toBe('unknown')
    expect(deriveMarketState('garbage', 250)).toBe('unknown')
  })

  it('still reports closed when a REAL window exists and now genuinely falls outside every one of them', () => {
    // Distinct from the malformed case above: here at least one window is
    // well-formed, so "outside all three" is an actual measurement, not an
    // absent signal.
    expect(deriveMarketState(p, 50)).toBe('closed')
    expect(deriveMarketState({ regular: p.regular }, 50)).toBe('closed')
  })
})

describe('downsample', () => {
  it('averages values within each bucket for the normal case', () => {
    const out = downsample([1, 2, 3, 4], 2)
    expect(out).toEqual([1.5, 3.5])
  })

  it('returns the values unchanged when there are fewer than the bucket count', () => {
    expect(downsample([1, 2], 5)).toEqual([1, 2])
  })

  it('returns an empty array for an empty input', () => {
    expect(downsample([], 10)).toEqual([])
  })

  it('returns the single value for a one-element input', () => {
    expect(downsample([42], 10)).toEqual([42])
  })

  it('handles a single-value input even against a single bucket', () => {
    expect(downsample([42], 1)).toEqual([42])
  })
})

function build(bodies: Record<string, unknown>) {
  const calls: string[] = []
  const fetchFn = vi.fn(async (url: string) => {
    calls.push(url)
    const symbol = decodeURIComponent(url.split('/').pop()!.split('?')[0]!)
    const entry = bodies[symbol]
    if (entry === undefined) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    if (entry === 'network-error') {
      throw new Error('ENOTFOUND')
    }
    return { ok: true, status: 200, json: async () => entry }
  })
  return { fetchFn, calls }
}

const SYMS = ['AAA', 'BBB'] as const

afterEach(() => {
  vi.useRealTimers()
})

describe('StockSource', () => {
  it('reports empty before the first successful refresh', () => {
    const src = new StockSource(SYMS, neverFetch as never, () => NOW)
    expect(src.getStatus()).toBe('empty')
    expect(src.getQuotes().size).toBe(0)
  })

  it('reports the market state as unknown before anything has ever been measured (I1)', () => {
    const src = new StockSource(SYMS, neverFetch as never, () => NOW)
    expect(src.getMarketState()).toBe('unknown')
  })

  it('keeps the market state unknown after a refresh that never carries a currentTradingPeriod for any symbol', async () => {
    const { fetchFn } = build({
      AAA: chartBody({}, { symbol: 'AAA', currentTradingPeriod: undefined }),
      BBB: chartBody({}, { symbol: 'BBB', currentTradingPeriod: undefined }),
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.getMarketState()).toBe('unknown')
  })

  it('fetches all symbols concurrently and reports ok', async () => {
    const { fetchFn } = build({
      AAA: chartBody({}, { symbol: 'AAA' }),
      BBB: chartBody({}, { symbol: 'BBB' }),
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.getStatus()).toBe('ok')
    expect(src.getQuotes().size).toBe(2)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('keeps the last known quote for a symbol whose refresh failed, without blanking the others', async () => {
    const { fetchFn } = build({
      AAA: chartBody({}, { symbol: 'AAA' }),
      BBB: chartBody({}, { symbol: 'BBB' }),
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    const bbbBefore = src.getQuotes().get('BBB')

    const { fetchFn: fetchFn2 } = build({
      AAA: chartBody({}, { symbol: 'AAA', regularMarketPrice: 999 }),
      BBB: 'network-error',
    })
    src.setFetchForTest(fetchFn2 as never)
    await src.refresh()

    expect(src.getStatus()).toBe('ok')
    expect(src.getQuotes().get('AAA')!.price).toBe(999)
    expect(src.getQuotes().get('BBB')).toEqual(bbbBefore)
  })

  it('M4: keeps the last known quote for a symbol whose reply named a DIFFERENT symbol, rather than caching the aliased body under it', async () => {
    const { fetchFn } = build({
      AAA: chartBody({}, { symbol: 'AAA' }),
      BBB: chartBody({}, { symbol: 'BBB' }),
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    const aaaBefore = src.getQuotes().get('AAA')

    const { fetchFn: fetchFn2 } = build({
      // Requested AAA, but the reply itself is BBB's — same class of
      // aliased reply `doFetchYearly` already rejects for the yearly path.
      AAA: chartBody({}, { symbol: 'BBB', regularMarketPrice: 999 }),
      BBB: chartBody({}, { symbol: 'BBB' }),
    })
    src.setFetchForTest(fetchFn2 as never)
    await src.refresh()

    expect(src.getQuotes().get('AAA')).toEqual(aaaBefore)
  })

  it('reports offline and keeps the last prices when every symbol fails', async () => {
    const { fetchFn } = build({
      AAA: chartBody({}, { symbol: 'AAA' }),
      BBB: chartBody({}, { symbol: 'BBB' }),
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    const before = new Map(src.getQuotes())

    const { fetchFn: fetchFn2 } = build({ AAA: 'network-error', BBB: 'network-error' })
    src.setFetchForTest(fetchFn2 as never)
    await src.refresh()

    expect(src.getStatus()).toBe('offline')
    expect(src.getQuotes()).toEqual(before)
  })

  it('emits change on a price move', async () => {
    const { fetchFn } = build({
      AAA: chartBody({}, { symbol: 'AAA' }),
      BBB: chartBody({}, { symbol: 'BBB' }),
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    let changes = 0
    src.on('change', () => { changes += 1 })

    const { fetchFn: fetchFn2 } = build({
      AAA: chartBody({}, { symbol: 'AAA', regularMarketPrice: 300 }),
      BBB: chartBody({}, { symbol: 'BBB' }),
    })
    src.setFetchForTest(fetchFn2 as never)
    await src.refresh()

    expect(changes).toBe(1)
  })

  it('does not emit change when nothing changed', async () => {
    const bodies = {
      AAA: chartBody({}, { symbol: 'AAA' }),
      BBB: chartBody({}, { symbol: 'BBB' }),
    }
    const { fetchFn } = build(bodies)
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    let changes = 0
    src.on('change', () => { changes += 1 })

    const { fetchFn: fetchFn2 } = build(bodies)
    src.setFetchForTest(fetchFn2 as never)
    await src.refresh()

    expect(changes).toBe(0)
  })

  it('derives the poll interval from the market state: open polls faster than closed', async () => {
    vi.useFakeTimers()
    const openBody = chartBody({}, { symbol: 'AAA' })
    const closedPeriod = {
      pre: { start: NOW - 100000, end: NOW - 90000 },
      regular: { start: NOW - 90000, end: NOW - 80000 },
      post: { start: NOW - 80000, end: NOW - 70000 },
    }
    const closedBody = chartBody(
      {},
      { symbol: 'BBB', currentTradingPeriod: closedPeriod },
    )

    const { fetchFn: fetchOpen } = build({ AAA: openBody, BBB: openBody })
    const openSrc = new StockSource(SYMS, fetchOpen as never, () => NOW)
    openSrc.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(openSrc.getMarketState()).toBe('open')
    const afterFirstOpen = fetchOpen.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchOpen.mock.calls.length).toBeGreaterThan(afterFirstOpen)
    await openSrc.stop()

    const { fetchFn: fetchClosed } = build({ AAA: closedBody, BBB: closedBody })
    const closedSrc = new StockSource(SYMS, fetchClosed as never, () => NOW)
    closedSrc.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(closedSrc.getMarketState()).toBe('closed')
    const afterFirstClosed = fetchClosed.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchClosed.mock.calls.length).toBe(afterFirstClosed)
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(fetchClosed.mock.calls.length).toBeGreaterThan(afterFirstClosed)
    await closedSrc.stop()
  })

  it('polls only while visible', async () => {
    vi.useFakeTimers()
    const body = chartBody({}, { symbol: 'AAA' })
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    const afterFirst = fetchFn.mock.calls.length
    src.setVisible(false)
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(fetchFn.mock.calls.length).toBe(afterFirst)
    await src.stop()
  })

  // I5 — `stopped` is a one-way latch, matching `CodexSource`: once `stop()`
  // has run, a later `setVisible(true)` must not resurrect polling. Break
  // the fix (restore `this.stopped = false` inside the `visible` branch) and
  // this fails.
  it('does not restart polling when setVisible(true) is called after stop()', async () => {
    vi.useFakeTimers()
    const body = chartBody({}, { symbol: 'AAA' })
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    const callsBeforeStop = fetchFn.mock.calls.length
    await src.stop()
    src.setVisible(true) // must be a no-op: the source is permanently stopped.
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(fetchFn.mock.calls.length).toBe(callsBeforeStop)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is per-symbol stale when the market is open and the quote is older than 15 minutes', async () => {
    const body = chartBody({}, { symbol: 'AAA', regularMarketTime: NOW - 20 * 60 })
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.isSymbolStale('AAA')).toBe(true)
  })

  it('is not per-symbol stale right after a fresh refresh while the market is open', async () => {
    const body = chartBody({}, { symbol: 'AAA', regularMarketTime: NOW })
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.isSymbolStale('AAA')).toBe(false)
  })

  // I4 — `'unknown'` used to read exactly like `'open'` being false: a
  // one-sided `marketState !== 'open'` treated an absent or malformed
  // `currentTradingPeriod` as a safe reason not to dim (lesson 18 inverted).
  // Break the fix (drop the `marketState === 'unknown'` branch) and this
  // fails, even though the quote itself is fresh by the clock.
  it('is per-symbol stale when the market state is unknown, even for a fresh-by-the-clock quote', async () => {
    const { fetchFn } = build({
      AAA: chartBody({}, { symbol: 'AAA', regularMarketTime: NOW, currentTradingPeriod: undefined }),
      BBB: chartBody({}, { symbol: 'BBB', regularMarketTime: NOW, currentTradingPeriod: undefined }),
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.getMarketState()).toBe('unknown')
    expect(src.isSymbolStale('AAA')).toBe(true)
  })

  it('is not per-symbol stale for a symbol with no quote at all, even while the market state is unknown', async () => {
    const { fetchFn } = build({
      AAA: chartBody({}, { symbol: 'AAA', currentTradingPeriod: undefined }),
      BBB: chartBody({}, { symbol: 'BBB', currentTradingPeriod: undefined }),
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.getMarketState()).toBe('unknown')
    expect(src.isSymbolStale('ZZZ')).toBe(false)
  })

  it('returns a copy from getQuotes, so mutating the result cannot corrupt the source', async () => {
    const { fetchFn } = build({
      AAA: chartBody({}, { symbol: 'AAA' }),
      BBB: chartBody({}, { symbol: 'BBB' }),
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()

    const quotes = src.getQuotes()
    quotes.delete('AAA')
    quotes.set('ZZZ', quotes.get('BBB')!)

    const fresh = src.getQuotes()
    expect(fresh.has('AAA')).toBe(true)
    expect(fresh.has('ZZZ')).toBe(false)
    expect(fresh.size).toBe(2)
  })

  // I2 — a shallow `new Map(this.quotes)` copies the container but shares
  // every `Quote` OBJECT and its `spark` ARRAY with the source's own live
  // cache. A test that only mutates the outer Map (deleting or adding keys,
  // as above) passes against that broken code too — this mutates INSIDE a
  // quote instead. Break the fix (go back to `new Map(this.quotes)`) and
  // both assertions below fail.
  it('deep-copies each quote, so mutating a field or the spark array cannot corrupt the source', async () => {
    const { fetchFn } = build({
      AAA: chartBody({}, { symbol: 'AAA' }),
      BBB: chartBody({}, { symbol: 'BBB' }),
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()

    const quote = src.getQuotes().get('AAA')!
    quote.price = -1
    quote.spark.push(999)

    const fresh = src.getQuotes().get('AAA')!
    expect(fresh.price).not.toBe(-1)
    expect(fresh.spark).not.toContain(999)
  })

  it('is stale for one symbol without affecting a fresher one', async () => {
    // A single lagging symbol must dim on its own, without a fresher
    // symbol's own freshness masking it (and vice versa).
    const freshBody = chartBody({}, { symbol: 'AAA', regularMarketTime: NOW })
    const staleBody = chartBody({}, { symbol: 'BBB', regularMarketTime: NOW - 20 * 60 })
    const { fetchFn } = build({ AAA: freshBody, BBB: staleBody })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()

    expect(src.getMarketState()).toBe('open')
    expect(src.isSymbolStale('AAA')).toBe(false)
    expect(src.isSymbolStale('BBB')).toBe(true)
  })

  it('is not per-symbol stale while the market is closed, even with an old quote', async () => {
    const closedPeriod = {
      pre: { start: NOW - 100000, end: NOW - 90000 },
      regular: { start: NOW - 90000, end: NOW - 80000 },
      post: { start: NOW - 80000, end: NOW - 70000 },
    }
    const body = chartBody(
      {},
      { symbol: 'AAA', regularMarketTime: NOW - 20 * 60, currentTradingPeriod: closedPeriod },
    )
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()

    expect(src.getMarketState()).toBe('closed')
    expect(src.isSymbolStale('AAA')).toBe(false)
  })

  it('is not per-symbol stale for a symbol with no quote at all, even while the market is open', async () => {
    const body = chartBody({}, { symbol: 'AAA' })
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.getMarketState()).toBe('open')
    expect(src.isSymbolStale('ZZZ')).toBe(false)
  })

  // M4 — the poll chain used `void this.refresh().then(() => this.schedule())`
  // with no `.catch`. `refresh()` should not reject in practice, but this
  // loop runs on a `setTimeout` chain: a single rejection would silently
  // stop `schedule()` from ever running again, unlike codex's
  // `setInterval`. Break the fix (revert to the bare `.then` chain) and
  // this fails — polling stops permanently after the injected rejection.
  it('keeps polling after a refresh rejects unexpectedly', async () => {
    vi.useFakeTimers()
    const body = chartBody({}, { symbol: 'AAA' })
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    try {
      src.setVisible(true)
      await vi.advanceTimersByTimeAsync(0)
      const refreshSpy = vi.spyOn(src, 'refresh').mockRejectedValueOnce(new Error('boom'))
      // Force the next scheduled tick to hit the rejecting refresh.
      await vi.advanceTimersByTimeAsync(60_000) // POLL_OPEN_MS, not exported.
      refreshSpy.mockRestore()
      const callsAfterRejection = fetchFn.mock.calls.length
      // If polling died, no further scheduled call ever happens.
      await vi.advanceTimersByTimeAsync(60_000) // POLL_OPEN_MS, not exported.
      expect(fetchFn.mock.calls.length).toBeGreaterThan(callsAfterRejection)
    } finally {
      await src.stop()
    }
  })
})

describe('StockSource stop() during an in-flight refresh', () => {
  // Regression coverage for: stop() must clear its timer AND mark itself
  // stopped. setVisible(true) and the recurring timer both run
  // `refresh().then(() => this.schedule())`. If stop() runs while that
  // refresh is still awaiting the network, the continuation fires
  // afterwards, sees `visible` still true, and arms a brand-new timer — a
  // poll loop that survives shutdown. Mirrors the same regression test in
  // tests/sources/spotify.test.ts.
  it('does not arm a new timer if stop() runs while a refresh is still in flight', async () => {
    vi.useFakeTimers()
    let resolveFetch!: (v: unknown) => void
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve
    })
    const fetchFn = vi.fn(() => fetchPromise)
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)

    src.setVisible(true) // Starts a refresh. It blocks on the unresolved fetch.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(SYMS.length)

    await src.stop() // stop() runs while that refresh is still in flight.

    resolveFetch({ ok: true, status: 200, json: async () => ({}) })
    // Flush the now-resolved refresh's `.then(() => this.schedule())`.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('SYMBOLS', () => {
  it('lists exactly eight tickers, one per key', () => {
    expect(SYMBOLS).toHaveLength(8)
    expect(new Set(SYMBOLS).size).toBe(8)
  })

  it('is a generic default, not anyone in particular\'s watchlist', () => {
    // The list used to be the author's own holdings, compiled in. It is the
    // FALLBACK now, for a deck with no `stocks.symbols` in its config, so it
    // has to say nothing about whoever installed it. Every entry is a
    // broad-market ETF or one of the largest listed companies.
    expect(SYMBOLS).toEqual(['SPY', 'QQQ', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META'])
  })
})

describe('StockSource yearly series (the detail chart\'s 52-week data)', () => {
  // Reuses `chartBody` from the `parseQuote` fixtures above: the yearly
  // response is the SAME `chart.result[0]` shape as the intraday one
  // (measured live on 2026-08-13, docs/VERIFIED-FACTS.md), just `range=1y`
  // with more points. `extractCloses` already reads it generically.

  it('reports unknown for a symbol nobody has ever selected', () => {
    const src = new StockSource(SYMS, neverFetch as never, () => NOW)
    expect(src.getYearlyState('AAA')).toEqual({ status: 'unknown' })
  })

  it('fetches the yearly series once requested, and reports it as ok', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toContain('range=1y&interval=1d')
      expect(url).toContain('AAA')
      return { ok: true, status: 200, json: async () => chartBody({}, { symbol: 'AAA' }) }
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)

    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const state = src.getYearlyState('AAA')
    expect(state.status).toBe('ok')
    if (state.status === 'ok') expect(state.values).toEqual([248.1, 249.3, 250.5])
  })

  // I2 — `getYearlyState` used to hand back the cached entry's `values`
  // array BY REFERENCE. Verified: a caller truncating the returned array (the
  // natural thing to do before drawing a sparkline) blanked the cache to
  // `{ values: [] }`, and since `requestYearly` will not refetch for
  // `YEARLY_REFRESH_SECONDS` (6 hours), that mutation blanked the 52-week
  // chart for six hours. Break the fix (drop the `[...entry.values]` copy)
  // and this fails.
  it('deep-copies the yearly series, so truncating the result cannot blank the cache', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, json: async () => chartBody({}, { symbol: 'AAA' }),
    }))
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const state = src.getYearlyState('AAA')
    if (state.status !== 'ok') throw new Error('expected ok')
    state.values.length = 0 // truncate the array the caller got back.

    const fresh = src.getYearlyState('AAA')
    if (fresh.status !== 'ok') throw new Error('expected ok')
    expect(fresh.values).toEqual([248.1, 249.3, 250.5])
  })

  it('sends the User-Agent header, same as the intraday fetch', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: Record<string, unknown>) => {
      expect((init?.headers as Record<string, string>)?.['User-Agent']).toBe('Mozilla/5.0')
      return { ok: true, status: 200, json: async () => chartBody({}, { symbol: 'AAA' }) }
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('reports loading while the first fetch is in flight, before it resolves', async () => {
    let resolveFetch!: (v: unknown) => void
    const fetchFn = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve }))
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)

    src.requestYearly('AAA')
    await Promise.resolve()
    expect(src.getYearlyState('AAA')).toEqual({ status: 'loading' })

    resolveFetch({ ok: true, status: 200, json: async () => chartBody({}, { symbol: 'AAA' }) })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(src.getYearlyState('AAA').status).toBe('ok')
  })

  it('does not start a second fetch while one is already in flight for the same symbol', async () => {
    const fetchFn = vi.fn(() => new Promise(() => {})) // never resolves within this test
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)

    src.requestYearly('AAA')
    src.requestYearly('AAA')
    src.requestYearly('AAA')
    await Promise.resolve()

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does not refetch a fresh cache within the refresh interval', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, json: async () => chartBody({}, { symbol: 'AAA' }),
    }))
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    src.requestYearly('AAA') // still fresh: no second network call
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('refetches once the cached success is older than the refresh interval', async () => {
    let now = NOW
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, json: async () => chartBody({}, { symbol: 'AAA' }),
    }))
    const src = new StockSource(SYMS, fetchFn as never, () => now)
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    now += 7 * 60 * 60 // past the 6-hour refresh interval
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  // Lesson 10 in docs/LESSONS.md, exactly: a guard cleared on failure (for
  // example in a `finally`) is not a guard, it is a request storm. A failed
  // yearly fetch must wait out a cooldown, not retry on the very next call.
  it('does not retry immediately after a failure — a cooldown, not a guard cleared in finally', async () => {
    let now = NOW
    const fetchFn = vi.fn(async () => { throw new Error('ENOTFOUND') })
    const src = new StockSource(SYMS, fetchFn as never, () => now)

    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(src.getYearlyState('AAA')).toEqual({ status: 'error' })

    // Simulates a render loop calling requestYearly again on every render
    // tick while the symbol stays selected — the exact shape of the album-art
    // request storm. Time has not moved, so the cooldown must still be active.
    for (let i = 0; i < 5; i++) src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    now += 6 * 60 // past the 5-minute cooldown
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  // M5 — `stocks-yearly-network` used to clear only after the LATER
  // `!res.ok` check also passed, so a persistent HTTP error (which never
  // reaches that line) left the network key permanently "seen" from an
  // earlier network failure — a later genuine network failure then logged
  // nothing. Break the fix (bundle the clear back after the http check) and
  // this fails: the third attempt's log line never appears.
  it('logs a network failure again after an intervening HTTP failure, not just the first time (M5)', async () => {
    // Guards against a dedup key left "seen" by another test earlier in
    // this file's shared `log` instance.
    log.clearOnce('stocks-yearly-network-AAA')
    log.clearOnce('stocks-yearly-http-AAA')
    let now = NOW
    let mode: 'network' | 'http' | 'network2' = 'network'
    const fetchFn = vi.fn(async () => {
      if (mode === 'http') return { ok: false, status: 500, json: async () => ({}) }
      throw new Error('ENOTFOUND')
    })
    const src = new StockSource(SYMS, fetchFn as never, () => now)
    const lines: string[] = []
    setDefaultSink((line) => { lines.push(line) })
    try {
      src.requestYearly('AAA') // 1: network failure — logs.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

      now += 6 * 60
      mode = 'http'
      src.requestYearly('AAA') // 2: HTTP failure — must not clear the network key incorrectly.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

      now += 6 * 60
      mode = 'network2'
      src.requestYearly('AAA') // 3: network failure again — must log again.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

      const networkLines = lines.filter((l) => l.includes('Yearly fetch for AAA failed:'))
      expect(networkLines).toHaveLength(2) // attempts 1 and 3, not swallowed by attempt 2.
    } finally {
      setDefaultSink(() => {})
      log.clearOnce('stocks-yearly-network-AAA')
      log.clearOnce('stocks-yearly-http-AAA')
    }
  })

  // M5's other half — `stocks-yearly-json` used to clear only after the
  // LATER `values.length < 2` check also passed, so a body that parsed but
  // carried too short a series left the JSON key permanently "seen" from an
  // earlier JSON failure. Break the fix and the third attempt's log line
  // never appears.
  it('logs a JSON failure again after an intervening too-short series, not just the first time (M5)', async () => {
    // Guards against a dedup key left "seen" by another test earlier in
    // this file's shared `log` instance.
    log.clearOnce('stocks-yearly-json-AAA')
    log.clearOnce('stocks-yearly-parse-AAA')
    let now = NOW
    let mode: 'json' | 'short' | 'json2' = 'json'
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        if (mode === 'short') {
          // A body that parses fine but carries too short a series (fewer
          // than 2 closes) to be a usable yearly series.
          return {
            chart: {
              result: [{ meta: { symbol: 'AAA' }, indicators: { quote: [{ close: [123] }] } }],
              error: null,
            },
          }
        }
        throw new Error('bad json')
      },
    }))
    const src = new StockSource(SYMS, fetchFn as never, () => now)
    const lines: string[] = []
    setDefaultSink((line) => { lines.push(line) })
    try {
      src.requestYearly('AAA') // 1: JSON failure — logs.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

      now += 6 * 60
      mode = 'short'
      src.requestYearly('AAA') // 2: parses, but too short a series.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

      now += 6 * 60
      mode = 'json2'
      src.requestYearly('AAA') // 3: JSON failure again — must log again.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

      const jsonLines = lines.filter((l) => l.includes('is not valid JSON'))
      expect(jsonLines).toHaveLength(2) // attempts 1 and 3, not swallowed by attempt 2.
    } finally {
      setDefaultSink(() => {})
      log.clearOnce('stocks-yearly-json-AAA')
      log.clearOnce('stocks-yearly-parse-AAA')
    }
  })

  it('keeps the last known good series when a later refresh fails, rather than discarding it', async () => {
    let now = NOW
    let fail = false
    const fetchFn = vi.fn(async () => {
      if (fail) throw new Error('ENOTFOUND')
      return { ok: true, status: 200, json: async () => chartBody({}, { symbol: 'AAA' }) }
    })
    const src = new StockSource(SYMS, fetchFn as never, () => now)

    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const firstState = src.getYearlyState('AAA')
    expect(firstState.status).toBe('ok')

    now += 7 * 60 * 60 // stale enough to trigger a refetch
    fail = true
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // The failed refresh must not have blanked or errored the existing cache.
    expect(src.getYearlyState('AAA')).toEqual(firstState)
  })

  it('reports error, never a fabricated ok, for a symbol that has never once succeeded', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(src.getYearlyState('AAA')).toEqual({ status: 'error' })
  })

  it('fetches each symbol independently — one symbol\'s state never leaks into another\'s', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('AAA')) return { ok: true, status: 200, json: async () => chartBody({}, { symbol: 'AAA' }) }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.requestYearly('AAA')
    src.requestYearly('BBB')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(src.getYearlyState('AAA').status).toBe('ok')
    expect(src.getYearlyState('BBB').status).toBe('error')
  })

  // M4: `doFetchYearly` used to cache whatever the response held purely
  // under the REQUESTED symbol, with no check that the body was actually
  // for it — unlike `parseQuote`, which already resolves `meta.symbol` for
  // the intraday body. The reviewer marked this "suspect" (no evidence Yahoo
  // aliases any of the eight real tickers), so this proves the gap in the
  // CODE, not a live alias: a same-shaped response that just carries a
  // different `meta.symbol` must not be cached and reported as `ok`.
  it('reports error, not ok, when the response body is for a different symbol than requested (M4)', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => chartBody({}, { symbol: 'ZZZ' }),
    }))
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(src.getYearlyState('AAA')).toEqual({ status: 'error' })
  })

  it('reports ok normally when the response carries no meta.symbol at all (nothing to cross-check)', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => chartBody({}, { symbol: undefined }),
    }))
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(src.getYearlyState('AAA').status).toBe('ok')
  })

  // Test quality: neither the page tests nor these source tests previously
  // exercised a yearly-length (251-point) or short-series (43-point)
  // response — every fixture reused the 3-point intraday `chartBody` close
  // array. `extractCloses` is generic, but this proves the fetch-and-cache
  // path itself (JSON parse, meta cross-check, caching) handles both real
  // shapes end to end, not just the downstream chart geometry.
  it('caches a full 251-point yearly series end to end', async () => {
    const closes = Array.from({ length: 251 }, (_, i) => 100 + i * 0.5)
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { ...chartBody().chart.result[0]!.meta, symbol: 'AAA' },
              indicators: { quote: [{ close: closes }] },
            },
          ],
        },
      }),
    }))
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const state = src.getYearlyState('AAA')
    expect(state.status).toBe('ok')
    if (state.status === 'ok') {
      expect(state.values).toHaveLength(251)
      expect(state.updatedAt).toBe(NOW)
    }
  })

  it('caches a short (43-point) yearly series end to end, the same shape a recently-listed symbol gives', async () => {
    const closes = Array.from({ length: 43 }, (_, i) => 50 + i)
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              meta: { ...chartBody().chart.result[0]!.meta, symbol: 'AAA' },
              indicators: { quote: [{ close: closes }] },
            },
          ],
        },
      }),
    }))
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.requestYearly('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const state = src.getYearlyState('AAA')
    expect(state.status).toBe('ok')
    if (state.status === 'ok') expect(state.values).toHaveLength(43)
  })
})

describe('StockSource.setWatchedSymbol (M1: keeps render() pure)', () => {
  // Per M1's ruling: a page must never perform network I/O from `render()`.
  // The old design had `StocksPage.render()` call `requestYearly` itself
  // whenever the cached yearly series looked stale. This moves that trigger
  // into the SOURCE: the page only ever calls `setWatchedSymbol`, from
  // `onKeyPress`, and the source re-checks the watched symbol's freshness on
  // its own intraday poll tick from then on.

  it('kicks off an immediate yearly fetch for the newly-watched symbol', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => chartBody({}, { symbol: 'AAA' }),
    }))
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    src.setWatchedSymbol('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(src.getYearlyState('AAA').status).toBe('ok')
  })

  it('does nothing and never throws when cleared with null', () => {
    const src = new StockSource(SYMS, neverFetch as never, () => NOW)
    expect(() => src.setWatchedSymbol(null)).not.toThrow()
  })

  it('re-checks the watched symbol on every INTRADAY poll, refetching once the cached yearly series goes stale', async () => {
    vi.useFakeTimers()
    let clock = NOW
    const body = chartBody({}, { symbol: 'AAA' })
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => clock)
    src.setVisible(true) // starts the intraday poll (market is open in `body`)
    await vi.advanceTimersByTimeAsync(0)

    src.setWatchedSymbol('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const yearlyCallsAfterWatch = fetchFn.mock.calls.filter((c) => String(c[0]).includes('range=1y')).length
    expect(yearlyCallsAfterWatch).toBe(1)

    // Still fresh: the next intraday poll tick must not refetch.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchFn.mock.calls.filter((c) => String(c[0]).includes('range=1y')).length).toBe(1)

    // Age the cached yearly series past its refresh window, then let the
    // next intraday poll tick run.
    clock += YEARLY_REFRESH_SECONDS + 1
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn.mock.calls.filter((c) => String(c[0]).includes('range=1y')).length).toBe(2)

    await src.stop()
  })

  it('stops re-checking once cleared with null, even though the cached series stays stale', async () => {
    vi.useFakeTimers()
    let clock = NOW
    const body = chartBody({}, { symbol: 'AAA' })
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => clock)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)

    src.setWatchedSymbol('AAA')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    src.setWatchedSymbol(null)

    clock += YEARLY_REFRESH_SECONDS + 1
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn.mock.calls.filter((c) => String(c[0]).includes('range=1y')).length).toBe(1)

    await src.stop()
  })
})
