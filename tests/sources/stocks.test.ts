import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SYMBOLS,
  StockSource,
  parseQuote,
  deriveMarketState,
  downsample,
} from '../../src/sources/stocks.js'

const NOW = 1_755_000_000

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

  it('reports closed for a malformed or absent period', () => {
    expect(deriveMarketState(null, 250)).toBe('closed')
    expect(deriveMarketState(undefined, 250)).toBe('closed')
    expect(deriveMarketState({}, 250)).toBe('closed')
    expect(deriveMarketState({ regular: 'nope' }, 250)).toBe('closed')
    expect(deriveMarketState('garbage', 250)).toBe('closed')
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
    const src = new StockSource(SYMS, undefined, () => NOW)
    expect(src.getStatus()).toBe('empty')
    expect(src.getQuotes().size).toBe(0)
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

  it('is stale when the market is open and the newest quote is older than 15 minutes', async () => {
    const body = chartBody({}, { symbol: 'AAA', regularMarketTime: NOW - 20 * 60 })
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.isStale()).toBe(true)
  })

  it('is not stale when the market is closed, even with an old quote', async () => {
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
    expect(src.isStale()).toBe(false)
  })

  it('is not stale right after a fresh refresh while the market is open', async () => {
    const body = chartBody({}, { symbol: 'AAA', regularMarketTime: NOW })
    const { fetchFn } = build({ AAA: body, BBB: body })
    const src = new StockSource(SYMS, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.isStale()).toBe(false)
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
  it('lists exactly the eight tickers, in order', () => {
    expect(SYMBOLS).toEqual(['TSLA', 'MSFT', 'NVDA', 'NOW', 'SOFI', 'HIMS', 'SPCX', 'AMZN'])
  })
})
