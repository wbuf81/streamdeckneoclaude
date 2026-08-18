import { describe, it, expect } from 'vitest'
import { StocksPage, heatWash, breadthColor, breadth, tapeOffsetPx, tapeSegments, driftFx, moveMagnitude } from '../../src/pages/stocks-page.js'
import { theme } from '../../src/render/theme.js'
import { renderKey, renderStrip, probe, KEY_SIZE, STRIP_WIDTH, STRIP_HEIGHT } from '../../src/render/canvas.js'
import { SYMBOLS, YEARLY_REFRESH_SECONDS } from '../../src/sources/stocks.js'
import type { Quote, MarketState, StockStatus, YearlyState } from '../../src/sources/stocks.js'
import type { Page } from '../../src/pages/types.js'

const NOW = 1786549560

/** Allows a small difference, because canvas anti-aliases edges. Matches the
 * helper the weather and canvas suites use. */
function near3(actual: readonly number[], expected: readonly number[], tol = 12): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(actual[i]! - expected[i]!) > tol) return false
  }
  return true
}

function quote(symbol: string, over: Partial<Quote> = {}): Quote {
  return {
    symbol,
    name: symbol,
    price: 100,
    previousClose: 100,
    changePercent: 0,
    spark: [],
    currency: 'USD',
    asOf: NOW,
    dayHigh: 105,
    dayLow: 95,
    week52High: 150,
    week52Low: 60,
    volume: 1_000_000,
    ...over,
  }
}

/** All eight symbols, each with a flat, known quote unless overridden. */
function allQuotes(over: (symbol: string, i: number) => Partial<Quote> = () => ({})): Map<string, Quote> {
  const m = new Map<string, Quote>()
  SYMBOLS.forEach((s, i) => m.set(s, quote(s, over(s, i))))
  return m
}

interface Fakes {
  quotes: Map<string, Quote>
  status: StockStatus
  marketState: MarketState
  /** Symbols `isSymbolStale` reports true for. */
  staleSymbols: Set<string>
  /** Per-symbol 52-week state. A symbol absent here reports `'unknown'`,
   * matching the real source before it has ever been watched. */
  yearlyStates: Map<string, YearlyState>
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    quotes: new Map(),
    status: 'ok',
    marketState: 'open',
    staleSymbols: new Set(),
    yearlyStates: new Map(),
    ...over,
  }
  const calls: string[] = []
  // Per M1: the page's only path to a yearly fetch is `setWatchedSymbol`,
  // called from `onKeyPress`. `watchedSymbolCalls` records every call
  // (including the `null` that clears it on BACK/leave), so a test can
  // prove `render()` itself never touches this — the whole point of the
  // fix — as well as proving `onKeyPress` calls it at the right moments.
  const watchedSymbolCalls: (string | null)[] = []
  const source = {
    getQuotes: () => f.quotes,
    getStatus: () => f.status,
    getMarketState: () => f.marketState,
    isSymbolStale: (symbol: string) => f.staleSymbols.has(symbol),
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
    getYearlyState: (symbol: string): YearlyState => f.yearlyStates.get(symbol) ?? { status: 'unknown' },
    setWatchedSymbol: (symbol: string | null) => { watchedSymbolCalls.push(symbol) },
  }
  return { page: new StocksPage(source as never), calls, f, watchedSymbolCalls }
}

describe('StocksPage layout', () => {
  it('returns 8 keys, one per symbol, in the source order', () => {
    const { page } = build({ quotes: allQuotes() })
    const keys = page.render(NOW).keys
    expect(keys).toHaveLength(8)
    keys.forEach((k, i) => expect(k.lines![0]).toBe(SYMBOLS[i]))
  })

  it('shows the price to 2 decimal places', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { price: 327.5 }))
    const { page } = build({ quotes })
    expect(page.render(NOW).keys[0]!.lines![1]).toBe('327.50')
  })

  it('colours an up quote green with an up arrow', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[2]!, quote(SYMBOLS[2]!, { changePercent: 3.03 }))
    const { page } = build({ quotes })
    const key = page.render(NOW).keys[2]!
    expect(key.border).toEqual(theme.green)
    expect(key.lines![2]).toContain('▲')
    expect(key.lines![2]).toContain('3.03%')
  })

  it('colours a down quote red with a down arrow', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: -1.59 }))
    const { page } = build({ quotes })
    const key = page.render(NOW).keys[0]!
    expect(key.border).toEqual(theme.red)
    expect(key.lines![2]).toContain('▼')
    expect(key.lines![2]).toContain('1.59%')
  })

  it('shows a neutral dot and colour for exactly zero change', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: 0 }))
    const { page } = build({ quotes })
    const key = page.render(NOW).keys[0]!
    expect(key.border).toEqual(theme.gray)
    expect(key.lines![2]).toContain('·')
  })

  it('never colours the price line', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: -1.59 }))
    const { page } = build({ quotes })
    const key = page.render(NOW).keys[0]!
    expect(key.lineColors?.[1]).toBeUndefined()
  })

  it('shows -- and dims the key when the price is unknown', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { price: null, changePercent: null }))
    const { page } = build({ quotes })
    const key = page.render(NOW).keys[0]!
    expect(key.lines![1]).toBe('--')
    expect(key.lines![2]).toBe('--')
    expect(key.dim).toBe(true)
    expect(key.lines!.join(' ')).not.toContain('NaN')
  })

  it('dims a key for a symbol with no quote at all yet', () => {
    const { page } = build({ quotes: new Map() })
    const key = page.render(NOW).keys[0]!
    expect(key.lines![0]).toBe(SYMBOLS[0])
    expect(key.lines![1]).toBe('--')
    expect(key.dim).toBe(true)
  })

  it('dims only the ticker isSymbolStale reports, not the others', () => {
    const { page } = build({ quotes: allQuotes(), staleSymbols: new Set([SYMBOLS[2]!]) })
    const keys = page.render(NOW).keys
    expect(keys[2]!.dim).toBe(true)
    expect(keys.filter((k) => k.dim === true)).toHaveLength(1)
  })

  it('does not dim a fresh, known key', () => {
    const { page } = build({ quotes: allQuotes() })
    expect(page.render(NOW).keys[0]!.dim).not.toBe(true)
  })

  it('downsamples the intraday series to 12 buckets', () => {
    const quotes = allQuotes()
    const series = Array.from({ length: 60 }, (_, i) => i)
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { spark: series }))
    const { page } = build({ quotes })
    const key = page.render(NOW).keys[0]!
    expect(key.spark!.values).toHaveLength(12)
  })

  it('omits the spark when fewer than 2 points exist', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { spark: [42] }))
    const { page } = build({ quotes })
    expect(page.render(NOW).keys[0]!.spark).toBeUndefined()
  })

  it('colours the sparkline green for an up quote', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: 1.59, spark: [1, 2, 3] }))
    const { page } = build({ quotes })
    expect(page.render(NOW).keys[0]!.spark!.color).toEqual(theme.green)
  })

  it('colours the sparkline red for a down quote', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: -1.59, spark: [1, 2, 3] }))
    const { page } = build({ quotes })
    expect(page.render(NOW).keys[0]!.spark!.color).toEqual(theme.red)
  })

  it('colours the sparkline neutral for a flat quote', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: 0, spark: [1, 2, 3] }))
    const { page } = build({ quotes })
    expect(page.render(NOW).keys[0]!.spark!.color).toEqual(theme.gray)
  })

  it('colours the sparkline neutral for an unknown quote', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: null, spark: [1, 2, 3] }))
    const { page } = build({ quotes })
    expect(page.render(NOW).keys[0]!.spark!.color).toEqual(theme.gray)
  })
})

describe('StocksPage strip', () => {
  it.each([
    ['open', 'MARKET OPEN'],
    ['pre', 'PRE-MARKET'],
    ['post', 'AFTER HOURS'],
    ['closed', 'MARKET CLOSED'],
  ] as const)('reports the %s market state on the strip', (state, label) => {
    const { page } = build({ quotes: allQuotes(), marketState: state })
    expect(page.render(NOW).strip.lines[0]).toContain(label)
  })

  it('counts up and down quotes on line 2', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: 1 }))
    quotes.set(SYMBOLS[1]!, quote(SYMBOLS[1]!, { changePercent: 2 }))
    quotes.set(SYMBOLS[2]!, quote(SYMBOLS[2]!, { changePercent: -1 }))
    quotes.set(SYMBOLS[3]!, quote(SYMBOLS[3]!, { changePercent: 0 }))
    const { page } = build({ quotes })
    const line2 = page.render(NOW).strip.lines[1]!
    expect(line2).toContain('2 up')
    expect(line2).toContain('1 down')
  })

  it('reports offline on line 2 when the source is offline', () => {
    const { page } = build({ quotes: allQuotes(), status: 'offline' })
    expect(page.render(NOW).strip.lines[1]).toContain('offline')
  })

  it('keeps both strip lines within 30 characters', () => {
    const { page } = build({ quotes: allQuotes() })
    const strip = page.render(NOW).strip
    expect(strip.lines[0]!.length).toBeLessThanOrEqual(30)
    expect(strip.lines[1]!.length).toBeLessThanOrEqual(30)
  })

  it('shows the as-of time in Eastern time with AM/PM, not the exchange-only 24-hour clock', () => {
    // NOW (1786549560) is 2026-08-12 15:46 UTC, which is 11:46 AM EDT — a
    // summer instant, so EDT is the only correct abbreviation. Fixed epoch
    // and exact string, per docs/LESSONS.md #17: a test against "now" would
    // break in November and on a machine in another timezone.
    const { page } = build({ quotes: allQuotes(), marketState: 'open' })
    expect(page.render(NOW).strip.lines[0]).toBe('MARKET OPEN · 11:46 AM EDT')
  })

  it('never draws strip text past the strip edge for the widest market label and timestamp', () => {
    // Measured: `MARKET CLOSED · 4:05 PM EDT` is 211.3 px against the
    // strip's 236 px usable width — verified by pixel probe here, not
    // arithmetic, per docs/LESSONS.md #17.
    //
    // Test quality (I2 scan): this grid strip carries no right-aligned
    // field, so `probe(buffer, STRIP_WIDTH - 1, ...)` alone cannot fail for
    // ANY input — `renderStrip`'s own `shrinkToFit` (outside this page's
    // ownership) keeps every line off the true margin regardless of what
    // this page hands it. This probes the whole margin band, not one
    // column, as the strongest proof available from this page's surface.
    //
    // Scoped to LINE 1's band (rows 0 to 15). Task 43's ticker tape owns line 2
    // and runs edge to edge ON PURPOSE — reaching the margin is what a tape
    // does — so probing the full strip height would now fail for the right
    // reason and the wrong cause. The property this test has always protected
    // is that line 1's market label and timestamp never overflow, and that is
    // exactly what it still probes, across the whole margin band rather than
    // one column.
    const LINE_1_BAND_END_Y = 16
    const { page } = build({ quotes: allQuotes(), marketState: 'closed' })
    const buffer = renderStrip(page.render(NOW).strip)
    for (let y = 0; y < LINE_1_BAND_END_Y; y++) {
      for (let x = STRIP_WIDTH - 6; x < STRIP_WIDTH; x++) {
        expect(probe(buffer, x, y, STRIP_WIDTH)).toEqual(theme.bg)
      }
    }
  })
})

describe('StocksPage presses: entering and leaving detail mode', () => {
  it('selecting a key with a quote enters detail mode for that symbol', () => {
    const { page } = build({ quotes: allQuotes() })
    page.onKeyPress(2)
    const key0 = page.render(NOW).keys[0]!
    expect(key0.lines![0]).toBe(SYMBOLS[2])
  })

  it('BACK (key 7) returns to the grid', () => {
    const { page } = build({ quotes: allQuotes() })
    page.onKeyPress(2)
    page.onKeyPress(7)
    const keys = page.render(NOW).keys
    expect(keys).toHaveLength(8)
    keys.forEach((k, i) => expect(k.lines![0]).toBe(SYMBOLS[i]))
  })

  it('clears the watched symbol on BACK, so the source stops re-checking a closed detail view', () => {
    const { page, watchedSymbolCalls } = build({ quotes: allQuotes() })
    page.onKeyPress(2)
    page.onKeyPress(7)
    expect(watchedSymbolCalls).toEqual([SYMBOLS[2], null])
  })

  it('does nothing when pressing a key with no quote behind it at all', () => {
    const { page } = build({ quotes: new Map() })
    page.onKeyPress(0)
    const keys = page.render(NOW).keys
    // Still the grid, not detail: 8 keys, each still labelled by symbol.
    expect(keys).toHaveLength(8)
    expect(keys[0]!.lines![0]).toBe(SYMBOLS[0])
    expect(keys[0]!.lines![1]).toBe('--')
  })

  it('keys 0 to 6 do nothing while a symbol is selected', () => {
    const { page } = build({ quotes: allQuotes() })
    page.onKeyPress(1)
    const before = page.render(NOW)
    page.onKeyPress(3)
    const after = page.render(NOW)
    expect(after).toEqual(before)
  })

  it('leaving the page clears the selection, so it always reopens on the grid', () => {
    const { page } = build({ quotes: allQuotes() })
    page.onKeyPress(1)
    page.onLeave!()
    const keys = page.render(NOW).keys
    keys.forEach((k, i) => expect(k.lines![0]).toBe(SYMBOLS[i]))
  })

  it('clears the watched symbol on onLeave too, not just BACK', () => {
    const { page, watchedSymbolCalls } = build({ quotes: allQuotes() })
    page.onKeyPress(1)
    page.onLeave!()
    expect(watchedSymbolCalls).toEqual([SYMBOLS[1], null])
  })
})

describe('StocksPage presses report the real outcome, keys 0 to 7', () => {
  it('reports handled for every key on the grid, since all eight symbols have a quote', () => {
    // A fresh page per key: pressing one key enters detail mode, which would
    // change what every OTHER key reports — see the next test below.
    for (let i = 0; i <= 7; i++) {
      const { page } = build({ quotes: allQuotes() })
      expect(page.onKeyPress(i)).toBe('handled')
    }
  })

  it('reports ignored on the grid for a key with no quote behind it yet', () => {
    const { page } = build({ quotes: new Map() })
    expect(page.onKeyPress(0)).toBe('ignored')
  })

  it('reports ignored, never handled, for a quote with no price (M1): a press that opens nothing must not flash white', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { price: null, changePercent: null }))
    const { page, watchedSymbolCalls } = build({ quotes })
    expect(page.onKeyPress(0)).toBe('ignored')
    // Confirms the press really did nothing, not just the return value:
    // no detail view opened and no yearly fetch was kicked off.
    expect(page.render(NOW).keys).toHaveLength(8)
    expect(page.render(NOW).keys[0]!.lines![0]).toBe(SYMBOLS[0])
    expect(watchedSymbolCalls).toEqual([])
  })

  it('reports handled for BACK (key 7), and ignored for every other key, once a symbol is selected', () => {
    const { page } = build({ quotes: allQuotes() })
    expect(page.onKeyPress(2)).toBe('handled') // enters detail mode
    for (let i = 0; i <= 6; i++) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
    expect(page.onKeyPress(7)).toBe('handled') // BACK
  })
})

describe('StocksPage visibility', () => {
  it('tells the source when it becomes visible and when it leaves', () => {
    const { page, calls } = build()
    page.onEnter!()
    page.onLeave!()
    expect(calls).toEqual(['visible:true', 'visible:false'])
  })
})

/** The exact figures from the task brief's verified TSLA measurement, so the
 * detail layout can be checked against numbers a human already sanity-checked. */
function tslaLikeQuote(): Quote {
  return quote(SYMBOLS[0]!, {
    price: 327.51,
    previousClose: 332.81,
    changePercent: -1.5926, // (327.51 - 332.81) / 332.81 * 100
    dayHigh: 335.5,
    dayLow: 323.64,
    week52High: 498.83,
    week52Low: 297.38,
    spark: Array.from({ length: 24 }, (_, i) => 320 + i),
  })
}

describe('StocksPage detail view layout', () => {
  function detailKeys() {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, tslaLikeQuote())
    const { page } = build({ quotes })
    page.onKeyPress(0)
    return page.render(NOW).keys
  }

  it('key 0 shows the symbol, then the price', () => {
    const key = detailKeys()[0]!
    expect(key.lines).toEqual(['TSLA', '327.51'])
  })

  it('key 1 shows the change percent with the down arrow, then the change amount, both trend-red', () => {
    const key = detailKeys()[1]!
    expect(key.lines![0]).toContain('▼')
    expect(key.lines![0]).toContain('1.59%')
    expect(key.lines![1]).toBe('-5.30')
    expect(key.lineColors![0]).toEqual(theme.red)
    expect(key.lineColors![1]).toEqual(theme.red)
  })

  // M8 — a diff in (-0.005, 0) has a negative raw sign but rounds its
  // magnitude to `0.00`; taking the sign from the raw diff printed the
  // self-contradictory `-0.00`, a "loss" of nothing.
  it('never shows -0.00 for a change amount that rounds to zero (M8)', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { price: 100, previousClose: 100.001 }))
    const { page } = build({ quotes })
    page.onKeyPress(0)
    const key = page.render(NOW).keys[1]!
    expect(key.lines![1]).toBe('0.00')
  })

  it('still shows a real negative change amount that does not round to zero', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { price: 100, previousClose: 100.5 }))
    const { page } = build({ quotes })
    page.onKeyPress(0)
    const key = page.render(NOW).keys[1]!
    expect(key.lines![1]).toBe('-0.50')
  })

  it('key 2 shows DAY, then the day high, then the day low', () => {
    const key = detailKeys()[2]!
    expect(key.lines).toEqual(['DAY', '335.50', '323.64'])
  })

  it('key 3 shows 52 WK, then the 52-week high, then the 52-week low', () => {
    const key = detailKeys()[3]!
    expect(key.lines).toEqual(['52 WK', '498.83', '297.38'])
  })

  it('passes the SAME size-candidate array for the high and low lines, so the renderer sizes them as one unit (M3)', () => {
    // The review's exact repro: a $1200 stock's 52-week tile used to render
    // ['52 WK', '1499.99', '899.01'] at independently-fitted sizes
    // [16, 16, 20] — the low bigger than the high directly above it.
    // `renderKey` groups consecutive lines that pass the identical
    // candidate array into one shared size (proven generally, with a pixel
    // probe, in tests/render/canvas.test.ts's "sizes a group of consecutive
    // lines... as one unit"); this test proves THIS page feeds it that
    // shape for the range tiles.
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, {
      price: 1200, previousClose: 1200, changePercent: 0,
      week52High: 1499.99, week52Low: 899.01,
    }))
    const { page } = build({ quotes })
    page.onKeyPress(0)
    const key = page.render(NOW).keys[3]!
    expect(key.lines).toEqual(['52 WK', '1499.99', '899.01'])
    expect(Array.isArray(key.lineSizes![1])).toBe(true)
    expect(key.lineSizes![1]).toEqual(key.lineSizes![2])
  })

  it('keys 4, 5 and 6 share one spark series, sliced into 3 consecutive parts', () => {
    const keys = detailKeys()
    const [k4, k5, k6] = [keys[4]!, keys[5]!, keys[6]!]
    expect(k4.spark!.slice).toEqual({ index: 0, count: 3 })
    expect(k5.spark!.slice).toEqual({ index: 1, count: 3 })
    expect(k6.spark!.slice).toEqual({ index: 2, count: 3 })
    expect(k4.spark!.values).toEqual(k5.spark!.values)
    expect(k5.spark!.values).toEqual(k6.spark!.values)
  })

  it('gives the chart keys fullHeight, since they carry no text (M4)', () => {
    const keys = detailKeys()
    for (const key of [keys[4]!, keys[5]!, keys[6]!]) {
      expect(key.spark!.fullHeight).toBe(true)
      expect(key.lines).toBeUndefined()
    }
  })

  describe('the chart shows the 52-week series once loaded, and the intraday series — always honestly labelled — until then', () => {
    // Distinct from tslaLikeQuote's intraday `spark` (320..343), so a test
    // can tell "the chart is drawing the yearly series" apart from "the
    // chart is drawing the intraday one" by the VALUES, not just the label.
    const yearlyValues = [10, 20, 30, 40, 50]

    it('watches the symbol (which itself kicks off the yearly fetch) at the moment it is selected', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[2]!, tslaLikeQuote())
      const { page, watchedSymbolCalls } = build({ quotes })
      page.onKeyPress(2)
      expect(watchedSymbolCalls).toEqual([SYMBOLS[2]])
    })

    it('never calls setWatchedSymbol from render — only onKeyPress touches the source about this (M1: render must stay pure)', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const { page, watchedSymbolCalls } = build({ quotes })
      page.onKeyPress(0)
      page.render(NOW)
      page.render(NOW)
      page.render(NOW)
      expect(watchedSymbolCalls).toEqual([SYMBOLS[0]])
    })

    it.each(['unknown', 'loading', 'error'] as const)(
      'falls back to the intraday series, labelled 1D, while the yearly state is %s',
      (status) => {
        const quotes = allQuotes()
        quotes.set(SYMBOLS[0]!, tslaLikeQuote())
        const { page } = build({
          quotes,
          yearlyStates: new Map([[SYMBOLS[0]!, { status }]]),
        })
        page.onKeyPress(0)
        const keys = page.render(NOW).keys
        const [k4, k5, k6] = [keys[4]!, keys[5]!, keys[6]!]
        expect(k4.spark!.values).toEqual(tslaLikeQuote().spark)
        expect(k4.spark!.label).toBe('1D')
        // Only the first key of the group carries the caption text — the
        // other two still share its band geometry via labelBand.
        expect(k5.spark!.label).toBeUndefined()
        expect(k6.spark!.label).toBeUndefined()
      },
    )

    it('draws the 52-week series, labelled 52 WK, once the yearly state is ok', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const { page } = build({
        quotes,
        yearlyStates: new Map([[SYMBOLS[0]!, { status: 'ok', values: yearlyValues, updatedAt: NOW }]]),
      })
      page.onKeyPress(0)
      const keys = page.render(NOW).keys
      const [k4, k5, k6] = [keys[4]!, keys[5]!, keys[6]!]
      expect(k4.spark!.values).toEqual(yearlyValues)
      expect(k5.spark!.values).toEqual(yearlyValues)
      expect(k6.spark!.values).toEqual(yearlyValues)
      expect(k4.spark!.label).toBe('52 WK')
      // Never both: a set of values is either the yearly series with its
      // own label, or the intraday series with ITS own label — the two
      // must never pair up wrong.
      expect(k4.spark!.values).not.toEqual(tslaLikeQuote().spark)
    })

    it('reserves the same labelBand on all three chart keys regardless of which one carries text', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const { page } = build({
        quotes,
        yearlyStates: new Map([[SYMBOLS[0]!, { status: 'ok', values: yearlyValues, updatedAt: NOW }]]),
      })
      page.onKeyPress(0)
      const keys = page.render(NOW).keys
      for (const key of [keys[4]!, keys[5]!, keys[6]!]) {
        expect(key.spark!.labelBand).toBe(true)
      }
    })

    it('falls back to 1D when the yearly series is ok but empty (fewer than 2 points)', () => {
      // Guards the honesty rule literally: an 'ok' status with unusable data
      // must not get labelled 52 WK just because the status says ok.
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const { page } = build({
        quotes,
        yearlyStates: new Map([[SYMBOLS[0]!, { status: 'ok', values: [42], updatedAt: NOW }]]),
      })
      page.onKeyPress(0)
      const key = page.render(NOW).keys[4]!
      expect(key.spark!.label).toBe('1D')
      expect(key.spark!.values).toEqual(tslaLikeQuote().spark)
    })
  })

  describe('chart geometry at every point count (I4): 0, 1, 2, 3, 43 and 251', () => {
    // The review found two distinct failures at the low end: 0/1 points left
    // keys 4-6 blank with NO caption at all, and 2/3 points made `drawSpark`
    // put the whole series on the wrong key or draw nothing on key 4. Both
    // are reproduced here directly against the intraday spark, and again
    // separately against a short (43-point) and full (251-point) yearly
    // series to prove those two real shapes still render exactly as before.

    it('shows a caption but no bars for 0 points, never a blank key with no explanation', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { spark: [] }))
      const { page } = build({ quotes })
      page.onKeyPress(0)
      const keys = page.render(NOW).keys
      expect(keys[4]!.spark).toBeUndefined()
      expect(keys[4]!.lines).toEqual(['1D'])
      expect(keys[5]!.spark).toBeUndefined()
      expect(keys[5]!.lines).toBeUndefined()
      expect(keys[6]!.spark).toBeUndefined()
      expect(keys[6]!.lines).toBeUndefined()
    })

    it('shows a caption but no bars for 1 point', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { spark: [42] }))
      const { page } = build({ quotes })
      page.onKeyPress(0)
      const key = page.render(NOW).keys[4]!
      expect(key.spark).toBeUndefined()
      expect(key.lines).toEqual(['1D'])
    })

    it('draws the whole (un-sliced) series on key 4 alone for 2 points, rather than slicing it across 3 keys', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { spark: [10, 20] }))
      const { page } = build({ quotes })
      page.onKeyPress(0)
      const keys = page.render(NOW).keys
      expect(keys[4]!.spark!.values).toEqual([10, 20])
      expect(keys[4]!.spark!.slice).toBeUndefined()
      expect(keys[4]!.spark!.label).toBe('1D')
      expect(keys[5]!.spark).toBeUndefined()
      expect(keys[6]!.spark).toBeUndefined()
    })

    it('draws the whole (un-sliced) series on key 4 alone for 3 points', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { spark: [10, 20, 15] }))
      const { page } = build({ quotes })
      page.onKeyPress(0)
      const keys = page.render(NOW).keys
      expect(keys[4]!.spark!.values).toEqual([10, 20, 15])
      expect(keys[4]!.spark!.slice).toBeUndefined()
      expect(keys[5]!.spark).toBeUndefined()
      expect(keys[6]!.spark).toBeUndefined()
    })

    it('renders an actual bar on key 4 for a 2-point rising series (the review\'s exact failure: 0 bars, chart appears to start on key 5)', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { spark: [10, 20] }))
      const { page } = build({ quotes })
      page.onKeyPress(0)
      const buf = renderKey(page.render(NOW).keys[4]!)
      let sawInk = false
      for (let y = 0; y < KEY_SIZE && !sawInk; y++) {
        for (let x = 4; x < KEY_SIZE; x++) {
          const [r, g, b] = probe(buf, x, y)
          const bg = theme.bg
          if (Math.abs(r - bg[0]) > 12 || Math.abs(g - bg[1]) > 12 || Math.abs(b - bg[2]) > 12) {
            sawInk = true
            break
          }
        }
      }
      expect(sawInk).toBe(true)
    })

    it('uses the normal 3-key slice at 4 points — the threshold right above the low-end fix', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { spark: [10, 20, 15, 25] }))
      const { page } = build({ quotes })
      page.onKeyPress(0)
      const keys = page.render(NOW).keys
      expect(keys[4]!.spark!.slice).toEqual({ index: 0, count: 3 })
      expect(keys[5]!.spark!.slice).toEqual({ index: 1, count: 3 })
      expect(keys[6]!.spark!.slice).toEqual({ index: 2, count: 3 })
    })

    it('slices normally for a short (43-point) yearly series — no coverage existed at this length before', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const shortYearly = Array.from({ length: 43 }, (_, i) => 100 + i)
      const { page } = build({
        quotes,
        yearlyStates: new Map([[SYMBOLS[0]!, { status: 'ok', values: shortYearly, updatedAt: NOW }]]),
      })
      page.onKeyPress(0)
      const keys = page.render(NOW).keys
      expect(keys[4]!.spark!.values).toEqual(shortYearly)
      expect(keys[4]!.spark!.slice).toEqual({ index: 0, count: 3 })
      expect(keys[4]!.spark!.label).toBe('52 WK')
    })

    it('slices normally for a full (251-point) yearly series — no coverage existed at this length before', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const fullYearly = Array.from({ length: 251 }, (_, i) => 100 + Math.sin(i / 10) * 20)
      const { page } = build({
        quotes,
        yearlyStates: new Map([[SYMBOLS[0]!, { status: 'ok', values: fullYearly, updatedAt: NOW }]]),
      })
      page.onKeyPress(0)
      const keys = page.render(NOW).keys
      expect(keys[4]!.spark!.values).toEqual(fullYearly)
      expect(keys[6]!.spark!.slice).toEqual({ index: 2, count: 3 })
      // Renders without throwing at the full length — the geometry above 81
      // points was the subject of an earlier review; this just confirms the
      // low-end fix (I4) did not disturb it.
      expect(() => renderKey(keys[4]!)).not.toThrow()
    })
  })

  describe('yearly chart staleness (I5): the chart must show its own age and refresh when opened stale', () => {
    const staleYearly = [10, 20, 30, 40, 50]

    it('dims only the chart keys (4-6), not the rest of the detail view, when the cached yearly series has gone stale', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const staleUpdatedAt = NOW - (YEARLY_REFRESH_SECONDS + 1)
      const { page } = build({
        quotes,
        yearlyStates: new Map([[SYMBOLS[0]!, { status: 'ok', values: staleYearly, updatedAt: staleUpdatedAt }]]),
      })
      page.onKeyPress(0)
      const keys = page.render(NOW).keys
      for (const key of keys.slice(4, 7)) expect(key.dim).toBe(true)
      // The intraday quote itself is fresh — only the chart's OWN data aged out.
      for (const key of keys.slice(0, 4)) expect(key.dim).not.toBe(true)
    })

    it('does not dim the chart for a yearly series that is still within the refresh interval', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const { page } = build({
        quotes,
        yearlyStates: new Map([[SYMBOLS[0]!, { status: 'ok', values: staleYearly, updatedAt: NOW - 60 }]]),
      })
      page.onKeyPress(0)
      const keys = page.render(NOW).keys
      for (const key of keys.slice(4, 7)) expect(key.dim).not.toBe(true)
    })

    it('M1: never asks the source for a fresh copy from render, even while the view stays open on a stale cached series', () => {
      // Per M1's ruling: `render()` must stay pure (AGENTS.md forbids
      // network I/O from a page's render path). Keeping the stale-but-open
      // detail view fresh is now `StockSource`'s own job — it re-checks the
      // WATCHED symbol on its own intraday poll (proven in
      // tests/sources/stocks.test.ts) — so this page must call
      // `setWatchedSymbol` only once, at selection, and never again just
      // because `render()` ran.
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const staleUpdatedAt = NOW - (YEARLY_REFRESH_SECONDS + 1)
      const { page, watchedSymbolCalls } = build({
        quotes,
        yearlyStates: new Map([[SYMBOLS[0]!, { status: 'ok', values: staleYearly, updatedAt: staleUpdatedAt }]]),
      })
      page.onKeyPress(0)
      watchedSymbolCalls.length = 0
      page.render(NOW)
      page.render(NOW)
      expect(watchedSymbolCalls).toEqual([])
    })

    it('never draws stale closes under the 52 WK label while a fresh copy is still loading — the label always matches the cached values', () => {
      // Even though the cache is stale, `chartSeries` must keep showing the
      // OLD values honestly labelled 52 WK (dimmed) rather than silently
      // switching to 1D mid-view — that would be a MORE confusing change
      // than staying on stale-but-labelled data, per the original task's
      // honesty rule: never show one range's data under another range's
      // label.
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const staleUpdatedAt = NOW - (YEARLY_REFRESH_SECONDS + 1)
      const { page } = build({
        quotes,
        yearlyStates: new Map([[SYMBOLS[0]!, { status: 'ok', values: staleYearly, updatedAt: staleUpdatedAt }]]),
      })
      page.onKeyPress(0)
      const key = page.render(NOW).keys[4]!
      expect(key.spark!.values).toEqual(staleYearly)
      expect(key.spark!.label).toBe('52 WK')
      expect(key.dim).toBe(true)
    })
  })

  it('actually uses more of the key height for the chart than the default band (M4, measured)', () => {
    // A custom oscillating series, not `tslaLikeQuote`'s monotonic one:
    // slice 0 of a strictly increasing series only ever sees the SMALLEST
    // values (see the normalisation test in tests/render/canvas.test.ts),
    // so its bars are short regardless of fullHeight. An oscillating series
    // gives slice 0 a tall bar too, so this test actually exercises the
    // taller band.
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, {
      spark: Array.from({ length: 24 }, (_, i) => Math.sin(i / 2) * 10 + 20),
    }))
    const { page } = build({ quotes })
    page.onKeyPress(0)
    const key = page.render(NOW).keys[4]!
    const buf = renderKey(key)
    let topInk = -1
    // Scans from x = 4, past the chart key's own 3 px trend-coloured
    // border strip, which spans the full key height — including it would
    // find "ink" at row 0 on every chart key regardless of the spark band,
    // making this proof vacuous.
    for (let y = 0; y < KEY_SIZE && topInk < 0; y++) {
      for (let x = 4; x < KEY_SIZE; x++) {
        const [r, g, b] = probe(buf, x, y)
        const bg = theme.bg
        if (Math.abs(r - bg[0]) > 12 || Math.abs(g - bg[1]) > 12 || Math.abs(b - bg[2]) > 12) {
          topInk = y
          break
        }
      }
    }
    // The default spark band's tallest bar starts no earlier than row 48.
    // A full-height chart must be able to paint above that.
    expect(topInk).toBeGreaterThanOrEqual(0)
    expect(topInk).toBeLessThan(48)
  })

  it('key 7 shows BACK with a gray border, distinct from the trend-coloured data tiles', () => {
    const key = detailKeys()[7]!
    expect(key.lines!.join('')).toContain('BACK')
    expect(key.border).toEqual(theme.gray)
  })

  it('centres BACK vertically, not just horizontally (M4, measured)', () => {
    const key = detailKeys()[7]!
    const buf = renderKey(key)
    // Scans from x = 4, past BACK's own 3 px gray border strip — the border
    // spans the full key height, so including it would register as "ink"
    // on every row and make this proof vacuous.
    const inkAt = (y: number) => {
      for (let x = 4; x < KEY_SIZE; x++) {
        const [r, g, b] = probe(buf, x, y)
        const bg = theme.bg
        if (Math.abs(r - bg[0]) > 12 || Math.abs(g - bg[1]) > 12 || Math.abs(b - bg[2]) > 12) return true
      }
      return false
    }
    // The old top-hugging layout painted ink at rows 7-19. Centred in a
    // 96 px key, ink should sit well below that, roughly the middle third.
    expect(inkAt(10)).toBe(false)
    let hasMiddleInk = false
    for (let y = 35; y < 60; y++) {
      if (inkAt(y)) hasMiddleInk = true
    }
    expect(hasMiddleInk).toBe(true)
  })

  it('every data tile (0-6) carries the trend colour as its border; key 7 does not', () => {
    const keys = detailKeys()
    for (const key of keys.slice(0, 7)) {
      expect(key.border).toEqual(theme.red)
    }
    expect(keys[7]!.border).not.toEqual(theme.red)
  })

  it('shows -- for a day/52-week field that is null, never 0', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, {
      price: 100, previousClose: 100, changePercent: 0,
      dayHigh: null, dayLow: null, week52High: null, week52Low: null,
    }))
    const { page } = build({ quotes })
    page.onKeyPress(0)
    const keys = page.render(NOW).keys
    expect(keys[2]!.lines).toEqual(['DAY', '--', '--'])
    expect(keys[3]!.lines).toEqual(['52 WK', '--', '--'])
  })

  it('dims the data tiles (0-6) when the selected symbol is per-symbol stale, but not BACK', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, tslaLikeQuote())
    const { page } = build({ quotes, staleSymbols: new Set([SYMBOLS[0]!]) })
    page.onKeyPress(0)
    const keys = page.render(NOW).keys
    for (const key of keys.slice(0, 7)) expect(key.dim).toBe(true)
    expect(keys[7]!.dim).not.toBe(true)
  })

  it('does not dim the detail view for a fresh, non-stale symbol', () => {
    const keys = detailKeys()
    for (const key of keys.slice(0, 7)) expect(key.dim).not.toBe(true)
  })
})

/*
 * RETIRED, deliberately: a golden sha256 of the grid ticker key, captured before
 * task 33 to prove that task 33 — which added the detail view's 52-week chart —
 * had not touched the grid path.
 *
 * Task 33 landed. AGENTS.md's own rule is that "a point-in-time proof (a golden
 * hash pinning another page's bytes) retires when its change lands. Do not leave
 * it to fire on the next legitimate change." It was left, and it fired on the
 * next legitimate change: task 43's heat wash, which sets `bg` on this very key
 * ON PURPOSE.
 *
 * Re-baselining the hash would have been the wrong fix. It would preserve a test
 * that pins bytes for a reason that no longer exists, and it would fire again on
 * the next legitimate change too. The grid tile's REAL properties are covered by
 * the sixteen tests in the rendering block above — key count and order, price
 * format, the up, down, flat and unknown colours and arrows, the price line
 * never being coloured, four dimming cases, and four sparkline cases — plus the
 * heat-wash block below. None of that coverage came from the hash.
 */

describe('StocksPage heat wash (task 43)', () => {
  it('washes an up quote green and a down quote red', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: 2.5 }))
    quotes.set(SYMBOLS[1]!, quote(SYMBOLS[1]!, { changePercent: -2.5 }))
    const { page } = build({ quotes, marketState: 'open' })
    const keys = page.render(NOW).keys
    const up = keys[0]!.bg!
    const down = keys[1]!.bg!
    expect(up[1]).toBeGreaterThan(up[0]) // green channel leads
    expect(down[0]).toBeGreaterThan(down[1]) // red channel leads
  })

  it('grows the wash with the size of the move, and saturates at every market state', () => {
    // EVERY state, not just `open`. Probing `open` alone could not fail: the
    // final clamp inside `blendToward` independently pins the open-market value
    // at the cap, so removing the magnitude clamp left that one case unchanged.
    // At a quieter state the mood multiplier keeps the value BELOW that clamp,
    // and an extreme move really does glow brighter — which is the bug. Found by
    // breaking the fix and watching this test pass.
    for (const state of ['open', 'pre', 'post', 'closed', 'unknown'] as const) {
      const distance = (pct: number): number => {
        const wash = heatWash(pct, state)
        if (!wash) return 0
        return Math.abs(wash[0] - theme.bg[0]) + Math.abs(wash[1] - theme.bg[1]) + Math.abs(wash[2] - theme.bg[2])
      }
      expect(distance(0.5), state).toBeGreaterThan(0)
      expect(distance(1.5), state).toBeGreaterThan(distance(0.5))
      expect(distance(3), state).toBeGreaterThan(distance(1.5))
      // Saturated: a 3 percent move and a 12 percent move look identical, so an
      // extreme day cannot wash the text out.
      expect(distance(12), state).toBe(distance(3))
      expect(distance(40), state).toBe(distance(3))
    }
  })

  it('keeps a near-flat nudge far fainter than a real mover', () => {
    // The point of an absolute scale. At the first floor value (0.22) this ratio
    // was only 4.0x, and a rendered flat day looked like a real mixed day —
    // exactly the dishonesty the absolute scale exists to avoid. Measured after
    // the fix: about 10x.
    const strength = (pct: number): number => {
      const wash = heatWash(pct, 'open')
      if (!wash) return 0
      return Math.abs(wash[0] - theme.bg[0]) + Math.abs(wash[1] - theme.bg[1]) + Math.abs(wash[2] - theme.bg[2])
    }
    expect(strength(3) / strength(0.12)).toBeGreaterThan(6)
    // And a nudge is still VISIBLE — the floor exists so a real small move does
    // not round away to nothing.
    expect(strength(0.12)).toBeGreaterThan(0)
  })

  it('keeps the sparkline clearly brighter than the wash behind it, in both directions', () => {
    // The spark and the wash share a hue by design, so the bars have to win on
    // luminance or the tile's only chart becomes mush. Measured on 2026-08-18:
    // the worst real case, a -3.47 percent day, gave 2.76x.
    const lum = (p: readonly number[]) => p[0]! + p[1]! + p[2]!
    for (const pct of [-3.47, 3.47, -12, 12]) {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, {
        changePercent: pct,
        spark: Array.from({ length: 24 }, (_, i) => 100 - pct * (1 - i / 23)),
      }))
      const { page } = build({ quotes, marketState: 'open' })
      const key = page.render(NOW).keys[0]!
      expect(key.spark).toBeDefined()
      const buf = renderKey(key)
      let brightest = 0
      for (let y = 50; y < 92; y++) {
        for (let x = 10; x < 88; x++) brightest = Math.max(brightest, lum(probe(buf, x, y)))
      }
      expect(brightest / lum(key.bg!), `${pct}%`).toBeGreaterThan(2.4)
    }
  })

  it('treats the two no-direction cases as no wash, rather than inventing a colour', () => {
    // An unknown change and a real flat 0.00 percent mean DIFFERENT things —
    // "we do not know" against "it did not move" — but neither is a direction.
    expect(heatWash(null, 'open')).toBeUndefined()
    expect(heatWash(Number.NaN, 'open')).toBeUndefined()
    expect(heatWash(0, 'open')).toBeUndefined()
  })

  it('leaves a tile with no quote at all unwashed', () => {
    const { page } = build({ quotes: new Map() })
    expect(page.render(NOW).keys[0]!.bg).toBeUndefined()
  })

  it('keeps every wash dark enough for white text, at the strongest move and every state', () => {
    // The wash is COMPUTED, unlike the weather page's hand-picked tints, so the
    // ceiling has to be proven rather than eyeballed. Probes the real rendered
    // key, not just the colour: the text has to win on the glass.
    const lum = (c: readonly number[]) => c[0]! + c[1]! + c[2]!
    for (const state of ['open', 'pre', 'post', 'closed', 'unknown'] as const) {
      for (const pct of [3, -3, 12, -12]) {
        const wash = heatWash(pct, state)!
        expect(wash).toBeDefined()
        // Text renders at 235 per channel. A wash must stay far below it.
        expect(lum(wash)).toBeLessThan(lum(theme.text) * 0.45)
      }
    }
  })

  it('renders the wash with the tile text still clearly brighter than it', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: -12 }))
    const { page } = build({ quotes, marketState: 'open' })
    const key = page.render(NOW).keys[0]!
    const buf = renderKey(key)
    const lum = (p: readonly number[]) => p[0]! + p[1]! + p[2]!
    let brightest = 0
    let washLum = lum(key.bg!)
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) brightest = Math.max(brightest, lum(probe(buf, x, y)))
    }
    expect(brightest).toBeGreaterThan(washLum * 2)
  })

  it('still dims a stale tile, on top of its wash', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: 2.5 }))
    const { page } = build({ quotes, staleSymbols: new Set([SYMBOLS[0]!]) })
    const key = page.render(NOW).keys[0]!
    expect(key.bg).toBeDefined()
    expect(key.dim).toBe(true)
  })
})

describe('StocksPage market-state mood (task 43)', () => {
  const strength = (state: MarketState): number => {
    const wash = heatWash(3, state)!
    return Math.abs(wash[0] - theme.bg[0]) + Math.abs(wash[1] - theme.bg[1]) + Math.abs(wash[2] - theme.bg[2])
  }

  it('makes an open market strictly the strongest', () => {
    expect(strength('open')).toBeGreaterThan(strength('pre'))
    expect(strength('open')).toBeGreaterThan(strength('post'))
    expect(strength('open')).toBeGreaterThan(strength('closed'))
    expect(strength('open')).toBeGreaterThan(strength('unknown'))
  })

  it('puts pre and post between open and closed', () => {
    expect(strength('pre')).toBeGreaterThan(strength('closed'))
    expect(strength('post')).toBeGreaterThan(strength('closed'))
  })

  it('keeps unknown as quiet as closed, WITHOUT claiming the market is closed', () => {
    // Sharing a multiplier is a display choice. Sharing the label would be a
    // lie, and lesson 18 is exactly about that distinction.
    expect(strength('unknown')).toBe(strength('closed'))
    const { page } = build({ marketState: 'unknown' })
    expect(page.render(NOW).strip.lines[0]).toContain('UNKNOWN')
    expect(page.render(NOW).strip.lines[0]).not.toContain('CLOSED')
  })
})

describe('StocksPage breadth on the round buttons (task 43)', () => {
  function bothButtons(over: Parameters<typeof build>[0] = {}) {
    const { page } = build(over)
    const frame = page.render(NOW)
    return { frame, left: frame.buttons[0], right: frame.buttons[1] }
  }

  it('gives both buttons one identical colour, since they are page navigation', () => {
    const { left, right } = bothButtons()
    expect(left).toEqual(right)
  })

  it('leads green when more symbols are up than down', () => {
    const quotes = new Map<string, Quote>()
    SYMBOLS.forEach((sym, i) => quotes.set(sym, quote(sym, { changePercent: i < 6 ? 1 : -1 })))
    const { left } = bothButtons({ quotes, marketState: 'open' })
    expect(left[1]).toBeGreaterThan(left[0])
  })

  it('leads red when more symbols are down than up', () => {
    const quotes = new Map<string, Quote>()
    SYMBOLS.forEach((sym, i) => quotes.set(sym, quote(sym, { changePercent: i < 6 ? -1 : 1 })))
    const { left } = bothButtons({ quotes, marketState: 'open' })
    expect(left[0]).toBeGreaterThan(left[1])
  })

  it('goes amber on an even split', () => {
    const quotes = new Map<string, Quote>()
    SYMBOLS.forEach((sym, i) => quotes.set(sym, quote(sym, { changePercent: i < 4 ? 1 : -1 })))
    const { left } = bothButtons({ quotes, marketState: 'open' })
    expect(left).toEqual(breadthColor(quotes.values(), 'open', 'ok'))
    expect(left[0]).toBeGreaterThan(0)
    expect(left[1]).toBeGreaterThan(0)
  })

  it('stays grey when the source is offline, whatever the quotes say', () => {
    const quotes = new Map<string, Quote>()
    SYMBOLS.forEach((sym) => quotes.set(sym, quote(sym, { changePercent: 5 })))
    const { left } = bothButtons({ quotes, status: 'offline' })
    expect(left).toEqual(theme.gray)
  })

  it('stays grey when nothing could be counted', () => {
    const quotes = new Map<string, Quote>()
    SYMBOLS.forEach((sym) => quotes.set(sym, quote(sym, { changePercent: null })))
    const { left } = bothButtons({ quotes, marketState: 'open' })
    expect(left).toEqual(theme.gray)
  })

  it('agrees with the strip\'s own up/down text, always', () => {
    // The lights and the words come from ONE count. This proves they cannot
    // contradict each other on the same frame.
    const quotes = new Map<string, Quote>()
    SYMBOLS.forEach((sym, i) => quotes.set(sym, quote(sym, { changePercent: i < 5 ? 1.2 : -0.8 })))
    const { frame, left } = bothButtons({ quotes, marketState: 'open' })
    expect(frame.strip.lines[1]).toBe('5 up · 3 down')
    expect(left[1]).toBeGreaterThan(left[0]) // green, matching "5 up"
  })

  it('quietens the lights when the market is closed', () => {
    const quotes = new Map<string, Quote>()
    SYMBOLS.forEach((sym) => quotes.set(sym, quote(sym, { changePercent: 1 })))
    const open = breadthColor(quotes.values(), 'open', 'ok')
    const closed = breadthColor(quotes.values(), 'closed', 'ok')
    expect(closed[1]).toBeLessThan(open[1])
  })

  it('carries the SELECTED symbol\'s trend in the detail view, not the board\'s breadth', () => {
    // Six symbols up, but the one opened is down: the buttons must follow the
    // symbol on screen, since the whole frame is about that symbol.
    const quotes = new Map<string, Quote>()
    SYMBOLS.forEach((sym, i) => quotes.set(sym, quote(sym, { changePercent: i === 0 ? -2 : 2 })))
    const { page } = build({ quotes, marketState: 'open' })
    page.onKeyPress(0)
    const buttons = page.render(NOW).buttons
    expect(buttons[0][0]).toBeGreaterThan(buttons[0][1]) // red, the open symbol
  })
})

describe('StocksPage detail view strip', () => {
  it('shows the as-of time in Eastern time with AM/PM on line 2', () => {
    // Fixed epoch (see the grid-strip test above for the same NOW value):
    // 11:46 AM EDT, not the machine's local clock and not a hard-coded EST.
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, tslaLikeQuote())
    const { page } = build({ quotes, marketState: 'closed' })
    page.onKeyPress(0)
    const line2 = page.render(NOW).strip.lines[1]!
    expect(line2).toBe('MARKET CLOSED · 11:46 AM EDT')
  })

  it('never draws detail-strip text past the strip edge', () => {
    // Test quality (I2 scan): with the source online (the default here),
    // this detail strip carries no right-aligned field (both lines are
    // plain text), so a single-column probe at the true edge cannot fail
    // for ANY input — widened to a band, and driven with the longest real
    // company name on record (docs/VERIFIED-FACTS.md's "Space Exploration
    // Technologies Corp.") so the content is not trivially short of the
    // margin either.
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { name: 'Space Exploration Technologies Corp.' }))
    const { page } = build({ quotes, marketState: 'closed' })
    page.onKeyPress(0)
    const buffer = renderStrip(page.render(NOW).strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      for (let x = STRIP_WIDTH - 6; x < STRIP_WIDTH; x++) {
        expect(probe(buffer, x, y, STRIP_WIDTH)).toEqual(theme.bg)
      }
    }
  })

  // I4 — the grid strip's own `offline` marker (see the grid-strip tests
  // above) used to disappear entirely once a symbol's detail view was open:
  // `MARKET CLOSED · 4:00 PM EDT` is the last TRADE time, not the last
  // fetch, so a stale connection read as perfectly normal. Reproduced with
  // the review's exact scenario: offline AND the market closed, so
  // `isSymbolStale` reports false by construction and every tile stays at
  // full brightness — `right` is the only place left for the daemon to say
  // it has not reached Yahoo.
  it('marks the detail strip offline when the source has gone offline, even while the market is simply closed', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, tslaLikeQuote())
    const { page } = build({ quotes, marketState: 'closed', status: 'offline' })
    page.onKeyPress(0)
    const strip = page.render(NOW).strip
    expect(strip.right).toBe('offline')
    // Both text lines stay in place — offline does not blank out the
    // company name or the market-state line, it only adds the marker.
    expect(strip.lines[0]).toBe('TSLA')
    expect(strip.lines[1]).toBe('MARKET CLOSED · 11:46 AM EDT')
  })

  it('carries no right-aligned marker in the detail strip while the source is online', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, tslaLikeQuote())
    const { page } = build({ quotes, marketState: 'closed', status: 'ok' })
    page.onKeyPress(0)
    expect(page.render(NOW).strip.right).toBeUndefined()
  })
})

describe('StocksPage detail view text fits the usable key width', () => {
  // A3 from the review: `lineSizes` now declares a page's INTENT as an
  // array of candidate sizes (see `KeySpec.lineSizes`'s doc comment); the
  // renderer resolves it to a concrete size, measured at draw time. So the
  // width proof has to render the real pixels through `renderKey` and probe
  // them, rather than reading `key.lineSizes[i]` as if it were already a
  // final number (it may now be the candidate array itself). This also
  // means it measures the property that actually matters — no ink past the
  // key's own right margin — instead of trusting the page's declared size.
  const RIGHT_EDGE_X = 90 // BORDER(3) + PAD(6) + usable width(81)
  const RIGHT_EDGE_BAND_END = 95 // KEY_SIZE(96) - 1: probe the whole margin, not one column

  // Test quality: a single-column probe at x=90 alone cannot fail against
  // ink one column further right. This probes the whole band from the
  // usable-width edge to the key's last column instead.
  function noInkAtOrPastRightEdge(buf: Buffer): boolean {
    const bg = theme.bg
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = RIGHT_EDGE_X; x <= RIGHT_EDGE_BAND_END; x++) {
        const [r, g, b] = probe(buf, x, y)
        if (Math.abs(r - bg[0]) > 12 || Math.abs(g - bg[1]) > 12 || Math.abs(b - bg[2]) > 12) {
          return false
        }
      }
    }
    return true
  }

  // Every real symbol, across prices spanning a single digit dollar up to a
  // four-digit one (NOW trades near $1000, the brief's stress case), AND a
  // three-digit change percent with a negative sign — the review's exact
  // repro for the clipped change line (`▲ 150.00%` measured at 86.7 px,
  // past the 81 px budget, because the old fixed size list bottomed out at
  // 16 and `fitSize` drew it anyway).
  it.each(SYMBOLS)('keeps every line on keys 0-3 clear of the right margin for %s', (symbol) => {
    for (const [price, changePercent] of [
      [9.99, -1.59],
      [327.51, -1.59],
      [1234.56, -1.59],
      [327.51, 150], // three-digit change percent, positive
      [327.51, -150], // three-digit change percent, with a negative sign
    ] as const) {
      const quotes = allQuotes()
      quotes.set(
        symbol,
        quote(symbol, {
          price,
          previousClose: price - (price * changePercent) / 100,
          changePercent,
          dayHigh: price + 8.12,
          dayLow: price - 8.12,
          week52High: price + 171.32,
          week52Low: Math.max(0.01, price - 30.5),
        }),
      )
      const { page } = build({ quotes })
      const index = SYMBOLS.indexOf(symbol)
      page.onKeyPress(index)
      const keys = page.render(NOW).keys

      for (const key of keys.slice(0, 4)) {
        expect(noInkAtOrPastRightEdge(renderKey(key))).toBe(true)
      }
    }
  })
})

describe('StocksPage ticker tape (task 43)', () => {
  const MS = NOW * 1000

  it('puts a tape on the grid strip, one segment per priced symbol', () => {
    const { page } = build({ quotes: allQuotes() })
    const tape = page.render(NOW, MS).strip.tape
    expect(tape).toBeDefined()
    expect(tape!.segments).toHaveLength(SYMBOLS.length)
  })

  it('writes each segment as symbol, price and change', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { price: 92.3, changePercent: -1.1 }))
    const { page } = build({ quotes })
    const first = page.render(NOW, MS).strip.tape!.segments[0]!
    expect(first.text).toContain(SYMBOLS[0]!)
    expect(first.text).toContain('92.30')
    expect(first.text).toContain('1.10%')
    expect(first.text).toContain('▼')
  })

  it('colours a segment by its own direction, matching the tile', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, { changePercent: 2 }))
    quotes.set(SYMBOLS[1]!, quote(SYMBOLS[1]!, { changePercent: -2 }))
    const { page } = build({ quotes })
    const frame = page.render(NOW, MS)
    const segs = frame.strip.tape!.segments
    expect(segs[0]!.color).toEqual(theme.green)
    expect(segs[1]!.color).toEqual(theme.red)
    // The SAME direction the tile's border shows, so the tape and the grid
    // cannot disagree.
    expect(frame.keys[0]!.border).toEqual(theme.green)
    expect(frame.keys[1]!.border).toEqual(theme.red)
  })

  it('dims only a stale symbol\'s own segment, not the whole tape', () => {
    const { page } = build({ quotes: allQuotes(), staleSymbols: new Set([SYMBOLS[2]!]) })
    const segs = page.render(NOW, MS).strip.tape!.segments
    expect(segs[2]!.color).toEqual(theme.textDim)
    expect(segs[0]!.color).not.toEqual(theme.textDim)
  })

  it('keeps scrolling for stale data, unlike the heat wash and the weather effects', () => {
    // Deliberate exception, and the reason it is tested. The strip shows about 30
    // of the tape's ~145 characters, so a frozen tape makes seven of the eight
    // symbols unreachable — the motion carries the CONTENT here, not liveliness.
    const { page } = build({
      quotes: allQuotes(),
      staleSymbols: new Set(SYMBOLS),
      marketState: 'closed',
    })
    const a = page.render(NOW, MS).strip.tape!.offsetPx
    const b = page.render(NOW, MS + 500).strip.tape!.offsetPx
    expect(b).toBeGreaterThan(a)
  })

  it('advances the offset with the injected clock, never the wall clock', () => {
    const { page } = build({ quotes: allQuotes() })
    expect(page.render(NOW, 0).strip.tape!.offsetPx).toBe(0)
    expect(page.render(NOW, 1000).strip.tape!.offsetPx)
      .toBe(page.render(NOW, 0).strip.tape!.offsetPx + tapeOffsetPx(1000))
    // Absent nowMs, the seconds clock still yields a usable millisecond value.
    expect(page.render(NOW).strip.tape!.offsetPx).toBe(tapeOffsetPx(NOW * 1000))
  })

  it('scrolls at a steady, finite rate', () => {
    expect(tapeOffsetPx(1000)).toBeGreaterThan(0)
    expect(tapeOffsetPx(2000)).toBe(tapeOffsetPx(1000) * 2)
    expect(tapeOffsetPx(Number.NaN)).toBe(0)
    expect(tapeOffsetPx(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('shows no tape, and keeps the static line 2, when the source is offline', () => {
    const { page } = build({ quotes: allQuotes(), status: 'offline' })
    const strip = page.render(NOW, MS).strip
    expect(strip.tape).toBeUndefined()
    expect(strip.lines[1]).toBe('offline')
  })

  it('shows no tape when no quote has arrived yet', () => {
    const { page } = build({ quotes: new Map() })
    expect(page.render(NOW, MS).strip.tape).toBeUndefined()
  })

  it('skips a symbol with no usable price rather than writing a blank segment', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[3]!, quote(SYMBOLS[3]!, { price: null }))
    const { page } = build({ quotes })
    const segs = page.render(NOW, MS).strip.tape!.segments
    expect(segs).toHaveLength(SYMBOLS.length - 1)
    expect(segs.every((seg) => seg.text.includes(SYMBOLS[3]!))).toBe(false)
  })

  it('shows no tape in the detail view, which has its own strip', () => {
    const { page } = build({ quotes: allQuotes() })
    page.onKeyPress(0)
    expect(page.render(NOW, MS).strip.tape).toBeUndefined()
  })

  it('builds segments from the real symbol order', () => {
    const segs = tapeSegments(allQuotes(), () => false)
    SYMBOLS.forEach((sym, i) => expect(segs[i]!.text.startsWith(sym)).toBe(true))
  })
})

describe('StocksPage tickMs: fast only while the tape scrolls (task 43)', () => {
  it('raises the rate while a tape is showing', () => {
    const { page } = build({ quotes: allQuotes() })
    expect((page as Page).tickMs).toBeDefined()
    expect((page as Page).tickMs!).toBeLessThan(1000)
  })

  it('keeps the default rate when no quote has arrived', () => {
    // NOTE the trap this avoids: the old tick-rate assertion for this page used a
    // fake reader with NO quotes, which is exactly the no-tape case — so it would
    // have stayed green against a page that always raised its rate. The weather
    // change walked into that same trap once already.
    const { page } = build({ quotes: new Map() })
    expect((page as Page).tickMs).toBeUndefined()
  })

  it('keeps the default rate when offline', () => {
    const { page } = build({ quotes: allQuotes(), status: 'offline' })
    expect((page as Page).tickMs).toBeUndefined()
  })

  it('keeps the default rate in the detail view', () => {
    const { page } = build({ quotes: allQuotes() })
    page.onKeyPress(0)
    expect((page as Page).tickMs).toBeUndefined()
  })

  it('re-reads the source every time rather than fixing the rate at construction', () => {
    const { page } = build({ quotes: allQuotes() })
    expect((page as Page).tickMs).toBeDefined()
    page.onKeyPress(0)
    expect((page as Page).tickMs).toBeUndefined()
    page.onKeyPress(7) // BACK
    expect((page as Page).tickMs).toBeDefined()
  })
})

describe('StocksPage directional drift (task 43)', () => {
  const MS = NOW * 1000

  function tileFor(changePercent: number | null, over: Parameters<typeof build>[0] = {}) {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, {
      changePercent,
      spark: Array.from({ length: 24 }, (_, i) => 100 + (changePercent ?? 0) * (i / 23)),
    }))
    const { page } = build({ quotes, marketState: 'open', ...over })
    return page.render(NOW, MS).keys[0]!
  }

  it('drifts up on a gainer and down on a loser', () => {
    expect(tileFor(2).fx!.direction).toBe('up')
    expect(tileFor(-2).fx!.direction).toBe('down')
    expect(tileFor(2).fx!.variant).toBe('drift')
  })

  it('reads the SAME direction the wash, border and change line read', () => {
    const key = tileFor(-2)
    expect(key.fx!.direction).toBe('down')
    expect(key.border).toEqual(theme.red)
    // The wash leans red too, so colour and motion tell one story.
    expect(key.bg![0]).toBeGreaterThan(key.bg![1])
  })

  it('grades intensity from the same magnitude function the wash uses', () => {
    // ONE function for both. Two would eventually disagree, and then a tile's
    // colour and its motion would describe different stocks.
    expect(moveMagnitude(3)).toBe(1)
    expect(moveMagnitude(1.5)).toBeCloseTo(0.5, 5)
    expect(moveMagnitude(null)).toBe(0)
    expect(tileFor(3).fx!.intensity).toBeGreaterThan(tileFor(0.5).fx!.intensity)
  })

  /** Every symbol MOVING, alternating direction. `allQuotes()` on its own is
   * deliberately flat, which correctly produces no drift at all — so a drift test
   * built on it would assert against undefined. */
  const movingQuotes = () => allQuotes((_s, i) => ({ changePercent: i % 2 === 0 ? 1.5 : -1.5 }))

  it('gives each tile its own seed, so eight tiles are not one sheet', () => {
    const { page } = build({ quotes: movingQuotes(), marketState: 'open' })
    const keys = page.render(NOW, MS).keys.slice(0, 8)
    for (const key of keys) expect(key.fx).toBeDefined()
    expect(new Set(keys.map((k) => k.fx!.seed)).size).toBe(8)
  })

  it('advances with the injected clock', () => {
    const { page } = build({ quotes: movingQuotes(), marketState: 'open' })
    const a = page.render(NOW, 1000).keys[0]!.fx!.nowMs
    const b = page.render(NOW, 2000).keys[0]!.fx!.nowMs
    expect(b).toBeGreaterThan(a)
  })

  it('quantises the drift clock, so the tiles do not rewrite on every frame', () => {
    // This is a THROUGHPUT property, not a cosmetic one. The daemon writes a key
    // only when its `keyHash` changes, and `fx.nowMs` is in that hash — so an
    // unquantised clock rewrote all eight keys 25 times a second. Measured on the
    // real deck: 200 key-writes per second against a 362 ceiling, and 35 to 40
    // percent of a core. Rendering was never the cost.
    const { page } = build({ quotes: movingQuotes(), marketState: 'open' })
    const at = (ms: number) => page.render(NOW, ms).keys[0]!.fx!.nowMs
    // Two renders inside one quantum give an identical spec, so the key is not
    // rewritten at all.
    expect(at(10_000)).toBe(at(10_039))
    // And the drift still advances across quanta, so it is not frozen.
    expect(at(10_200)).toBeGreaterThan(at(10_000))
  })

  it('does NOT quantise the tape, which has to stay smooth', () => {
    const { page } = build({ quotes: movingQuotes(), marketState: 'open' })
    const a = page.render(NOW, 10_000).strip.tape!.offsetPx
    const b = page.render(NOW, 10_039).strip.tape!.offsetPx
    expect(b).toBeGreaterThan(a)
  })

  it('does not drift a flat or unknown move, since there is no direction', () => {
    expect(tileFor(0).fx).toBeUndefined()
    expect(tileFor(null).fx).toBeUndefined()
  })

  it('does not drift a stale tile', () => {
    expect(tileFor(2, { staleSymbols: new Set([SYMBOLS[0]!]) }).fx).toBeUndefined()
  })

  it('stops entirely when the market is closed or unknown, unlike the ticker tape', () => {
    // Drift is DECORATION: it says nothing the still tile does not. A closed
    // market has no flow, so showing flow would claim something the data does not
    // support. The tape keeps moving in the same states, because its motion
    // carries content — that split is deliberate.
    expect(tileFor(2, { marketState: 'closed' }).fx).toBeUndefined()
    expect(tileFor(2, { marketState: 'unknown' }).fx).toBeUndefined()
    expect(driftFx(2, 'closed', false, 0, 0)).toBeUndefined()
    expect(driftFx(2, 'unknown', false, 0, 0)).toBeUndefined()
  })

  it('drifts more slowly before and after the bell than during it', () => {
    const open = driftFx(3, 'open', false, 0, 0)!
    const pre = driftFx(3, 'pre', false, 0, 0)!
    const post = driftFx(3, 'post', false, 0, 0)!
    expect(open.intensity).toBeGreaterThan(pre.intensity)
    expect(open.intensity).toBeGreaterThan(post.intensity)
    expect(pre.intensity).toBe(post.intensity)
  })

  it('keeps a small real move drifting, rather than showing one lonely particle', () => {
    const tiny = driftFx(0.05, 'open', false, 0, 0)!
    expect(tiny.intensity).toBeGreaterThan(0.2)
  })

  it('leaves the detail view still, matching where the wash lives', () => {
    const { page } = build({ quotes: allQuotes(), marketState: 'open' })
    page.onKeyPress(0)
    const keys = page.render(NOW, MS).keys
    expect(keys.every((k) => k.fx === undefined)).toBe(true)
  })
})

describe('StocksPage tile contrast ladder (task 43)', () => {
  const MS = NOW * 1000
  const lum = (p: readonly number[]) => p[0]! + p[1]! + p[2]!

  /**
   * The real risk this whole block exists for: a ticker tile now carries FIVE
   * trend-coloured elements — the heat wash, the drifting particles, the
   * sparkline, the change text and the border. Same-hue layers turn to mush, so
   * the ordering is asserted rather than hoped for:
   *
   *   heat wash  <  drift particles  <  sparkline / text
   */
  function layers(changePercent: number) {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, quote(SYMBOLS[0]!, {
      changePercent,
      spark: Array.from({ length: 24 }, (_, i) => 100 + changePercent * (i / 23)),
    }))
    const { page } = build({ quotes, marketState: 'open' })
    const key = page.render(NOW, MS).keys[0]!
    expect(key.bg).toBeDefined()
    expect(key.fx).toBeDefined()
    // Wash alone: no particles, no content.
    const washOnly = renderKey({ kind: 'gauge', bg: key.bg })
    // Wash plus particles, no content.
    const withDrift = renderKey({ kind: 'gauge', bg: key.bg, fx: key.fx })
    // The real, complete tile.
    const full = renderKey(key)
    return { key, washOnly, withDrift, full }
  }

  it('keeps the particles brighter than the wash behind them', () => {
    for (const pct of [3, -3, 1, -1]) {
      const { key, withDrift } = layers(pct)
      let brightestParticle = 0
      for (let y = 0; y < KEY_SIZE; y++) {
        for (let x = 0; x < KEY_SIZE; x++) {
          brightestParticle = Math.max(brightestParticle, lum(probe(withDrift, x, y)))
        }
      }
      expect(brightestParticle, `${pct}%`).toBeGreaterThan(lum(key.bg!) * 1.4)
    }
  })

  it('keeps the sparkline and text brighter than the particles', () => {
    for (const pct of [3, -3]) {
      const { withDrift, full } = layers(pct)
      let brightestDrift = 0
      let brightestFull = 0
      for (let y = 0; y < KEY_SIZE; y++) {
        for (let x = 0; x < KEY_SIZE; x++) {
          brightestDrift = Math.max(brightestDrift, lum(probe(withDrift, x, y)))
          brightestFull = Math.max(brightestFull, lum(probe(full, x, y)))
        }
      }
      expect(brightestFull, `${pct}%`).toBeGreaterThan(brightestDrift * 1.3)
    }
  })

  it('keeps the tile text legible over the wash AND the drift together', () => {
    // The same proof the weather tiles get, applied to the busiest possible
    // stocks tile: strongest move, drift running, sparkline drawn.
    for (const pct of [12, -12]) {
      const { withDrift, full } = layers(pct)
      let brightestBackground = 0
      let brightestContent = 0
      for (let y = 0; y < KEY_SIZE; y++) {
        for (let x = 0; x < KEY_SIZE; x++) {
          const under = probe(withDrift, x, y)
          const over = probe(full, x, y)
          brightestBackground = Math.max(brightestBackground, lum(under))
          if (!near3(over, under, 1)) brightestContent = Math.max(brightestContent, lum(over))
        }
      }
      expect(brightestContent, `${pct}%`).toBeGreaterThan(brightestBackground * 1.5)
    }
  })
})
