import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { StocksPage } from '../../src/pages/stocks-page.js'
import { theme } from '../../src/render/theme.js'
import { FONT } from '../../src/render/canvas.js'
import { SYMBOLS } from '../../src/sources/stocks.js'
import type { Quote, MarketState, StockStatus } from '../../src/sources/stocks.js'

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
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    quotes: new Map(),
    status: 'ok',
    marketState: 'open',
    staleSymbols: new Set(),
    ...over,
  }
  const calls: string[] = []
  const source = {
    getQuotes: () => f.quotes,
    getStatus: () => f.status,
    getMarketState: () => f.marketState,
    isSymbolStale: (symbol: string) => f.staleSymbols.has(symbol),
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
  }
  return { page: new StocksPage(source as never), calls, f }
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

  it('keys 4, 5 and 6 share one spark series, sliced into 3 consecutive parts', () => {
    const keys = detailKeys()
    const [k4, k5, k6] = [keys[4]!, keys[5]!, keys[6]!]
    expect(k4.spark!.slice).toEqual({ index: 0, count: 3 })
    expect(k5.spark!.slice).toEqual({ index: 1, count: 3 })
    expect(k6.spark!.slice).toEqual({ index: 2, count: 3 })
    expect(k4.spark!.values).toEqual(k5.spark!.values)
    expect(k5.spark!.values).toEqual(k6.spark!.values)
  })

  it('key 7 shows BACK with a gray border, distinct from the trend-coloured data tiles', () => {
    const key = detailKeys()[7]!
    expect(key.lines!.join('')).toContain('BACK')
    expect(key.border).toEqual(theme.gray)
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

describe('StocksPage detail view text fits the usable key width', () => {
  const USABLE_WIDTH = 81

  function measure(text: string, size: number): number {
    const ctx = createCanvas(1, 1).getContext('2d')
    ctx.font = `${size}px ${FONT}`
    return ctx.measureText(text).width
  }

  // Every real symbol, across prices spanning a single digit dollar up to a
  // four-digit one (NOW trades near $1000), the exact stress case the brief
  // calls out: a clipped price has already shipped twice in this project.
  it.each(SYMBOLS)('fits every line on keys 0-3 for %s at $9.99, $327.51 and $1234.56', (symbol) => {
    for (const price of [9.99, 327.51, 1234.56]) {
      const quotes = allQuotes()
      quotes.set(
        symbol,
        quote(symbol, {
          price,
          previousClose: price + 5.3,
          changePercent: -1.59,
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
        key.lines?.forEach((line, i) => {
          const size = key.lineSizes?.[i] ?? 11
          expect(measure(line, size)).toBeLessThanOrEqual(USABLE_WIDTH)
        })
      }
    }
  })
})
