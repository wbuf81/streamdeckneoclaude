import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { StocksPage } from '../../src/pages/stocks-page.js'
import { theme } from '../../src/render/theme.js'
import { renderKey, renderStrip, probe, KEY_SIZE, STRIP_WIDTH, STRIP_HEIGHT } from '../../src/render/canvas.js'
import { SYMBOLS, YEARLY_REFRESH_SECONDS } from '../../src/sources/stocks.js'
import type { Quote, MarketState, StockStatus, YearlyState } from '../../src/sources/stocks.js'

const NOW = 1786549560

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
   * matching the real source before `requestYearly` has ever been called
   * for it. */
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
  const yearlyRequests: string[] = []
  const source = {
    getQuotes: () => f.quotes,
    getStatus: () => f.status,
    getMarketState: () => f.marketState,
    isSymbolStale: (symbol: string) => f.staleSymbols.has(symbol),
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
    getYearlyState: (symbol: string): YearlyState => f.yearlyStates.get(symbol) ?? { status: 'unknown' },
    requestYearly: (symbol: string) => { yearlyRequests.push(symbol) },
  }
  return { page: new StocksPage(source as never), calls, f, yearlyRequests }
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
    const { page } = build({ quotes: allQuotes(), marketState: 'closed' })
    const buffer = renderStrip(page.render(NOW).strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      expect(probe(buffer, STRIP_WIDTH - 1, y, STRIP_WIDTH)).toEqual(theme.bg)
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
    const { page, yearlyRequests } = build({ quotes })
    expect(page.onKeyPress(0)).toBe('ignored')
    // Confirms the press really did nothing, not just the return value:
    // no detail view opened and no yearly fetch was kicked off.
    expect(page.render(NOW).keys).toHaveLength(8)
    expect(page.render(NOW).keys[0]!.lines![0]).toBe(SYMBOLS[0])
    expect(yearlyRequests).toEqual([])
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

    it('requests the yearly series for the symbol at the moment it is selected', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[2]!, tslaLikeQuote())
      const { page, yearlyRequests } = build({ quotes })
      page.onKeyPress(2)
      expect(yearlyRequests).toEqual([SYMBOLS[2]])
    })

    it('does not re-request on every render — only on selection', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const { page, yearlyRequests } = build({ quotes })
      page.onKeyPress(0)
      page.render(NOW)
      page.render(NOW)
      page.render(NOW)
      expect(yearlyRequests).toEqual([SYMBOLS[0]])
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

    it('asks the source for a fresh copy while the view stays open on a stale cached series (never re-requests once fresh)', () => {
      const quotes = allQuotes()
      quotes.set(SYMBOLS[0]!, tslaLikeQuote())
      const staleUpdatedAt = NOW - (YEARLY_REFRESH_SECONDS + 1)
      const { page, yearlyRequests } = build({
        quotes,
        yearlyStates: new Map([[SYMBOLS[0]!, { status: 'ok', values: staleYearly, updatedAt: staleUpdatedAt }]]),
      })
      page.onKeyPress(0) // clears yearlyRequests below, since selection itself always requests once
      yearlyRequests.length = 0
      page.render(NOW)
      page.render(NOW)
      expect(yearlyRequests).toEqual([SYMBOLS[0], SYMBOLS[0]])
      // (The real source's own cooldown/in-flight guards, proven in
      // tests/sources/stocks.test.ts, are what keep this from becoming an
      // actual network request per render tick — this page is only asking,
      // never fetching directly.)
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

describe('StocksPage grid rendering, before and after the 52-week detail chart change', () => {
  // Task 33 adds a 52-week chart to the DETAIL view only. The grid keeps its
  // intraday sparkline untouched. This hash was captured from `renderKey`
  // against this exact grid key BEFORE task 33 touched any source file, and
  // must still match after — proof, not assertion, that the grid path was
  // never edited.
  it('renders the grid ticker key byte-identically to the pre-task-33 snapshot', () => {
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, tslaLikeQuote())
    const { page } = build({ quotes })
    const key = page.render(NOW).keys[0]!
    const buf = renderKey(key)
    expect(createHash('sha256').update(buf).digest('hex')).toBe(
      'fec8075230a539849e863956e7e9d6768962ff59d78b3b49a35be3d837df7bac',
    )
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
    const quotes = allQuotes()
    quotes.set(SYMBOLS[0]!, tslaLikeQuote())
    const { page } = build({ quotes, marketState: 'closed' })
    page.onKeyPress(0)
    const buffer = renderStrip(page.render(NOW).strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      expect(probe(buffer, STRIP_WIDTH - 1, y, STRIP_WIDTH)).toEqual(theme.bg)
    }
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
