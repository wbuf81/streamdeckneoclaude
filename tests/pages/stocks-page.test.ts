import { describe, it, expect } from 'vitest'
import {
  StocksPage, heatWash, breadth, breadthButtons, tapeSegments, gridRole, averageChange, leaders,
  PEEK_MS, LEADERS_MS, FACT_ROTATE_MS, SWEEP_STAGGER_MS,
} from '../../src/pages/stocks-page.js'
import { theme } from '../../src/render/theme.js'
import { renderKey, renderStrip, probe, KEY_SIZE, STRIP_WIDTH } from '../../src/render/canvas.js'
import { keyHash, stripHash, type KeySpec, type Rgb } from '../../src/render/specs.js'
import { YEARLY_REFRESH_SECONDS } from '../../src/sources/stocks.js'
import type { MarketBoundary, Quote, MarketState, StockStatus, YearlyState } from '../../src/sources/stocks.js'

/** 2026-08-12 15:46 UTC = 11:46 AM EDT, a Wednesday mid-session. Fixed, so a
 * test never depends on the machine's zone or the date it runs. */
const NOW = 1786549560
const NOW_MS = NOW * 1000
/** 9:30 AM and 4:00 PM EDT that day. */
const OPEN_MS = NOW_MS - (2 * 60 + 16) * 60_000
const CLOSE_MS = OPEN_MS + 390 * 60_000

const SIX = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'] as const
const EIGHT = [...SIX, 'GGG', 'HHH'] as const

/** A 78-point five-minute series from the previous close to `price`. */
function series(prev: number, price: number, wiggle = 0): number[] {
  return Array.from({ length: 78 }, (_, k) => prev + (price - prev) * (k / 77) + wiggle * Math.sin(k / 3))
}

function quote(symbol: string, over: Partial<Quote> = {}): Quote {
  const changePercent = over.changePercent === undefined ? 0 : over.changePercent
  const previousClose = over.previousClose === undefined ? 100 : over.previousClose
  const price = over.price === undefined
    ? (changePercent === null || previousClose === null ? 100 : previousClose * (1 + changePercent / 100))
    : over.price
  return {
    symbol,
    name: `${symbol} Corp`,
    price,
    previousClose,
    changePercent,
    spark: price === null || previousClose === null ? [] : series(previousClose, price),
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

function quotesFor(symbols: readonly string[], change: (s: string, i: number) => number | null = () => 0): Map<string, Quote> {
  const m = new Map<string, Quote>()
  symbols.forEach((s, i) => m.set(s, quote(s, { changePercent: change(s, i) })))
  return m
}

interface Fakes {
  symbols: readonly string[]
  quotes: Map<string, Quote>
  status: StockStatus
  marketState: MarketState
  boundary: MarketBoundary | null
  staleSymbols: Set<string>
  yearlyStates: Map<string, YearlyState>
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    symbols: SIX,
    quotes: new Map(),
    status: 'ok',
    marketState: 'open',
    boundary: null,
    staleSymbols: new Set(),
    yearlyStates: new Map(),
    ...over,
  }
  const calls: string[] = []
  const watched: (string | null)[] = []
  const source = {
    getSymbols: () => f.symbols,
    getQuotes: () => f.quotes,
    getStatus: () => f.status,
    getMarketState: () => f.marketState,
    getNextBoundary: () => f.boundary,
    isSymbolStale: (s: string) => f.staleSymbols.has(s),
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
    getYearlyState: (s: string): YearlyState => f.yearlyStates.get(s) ?? { status: 'unknown' },
    setWatchedSymbol: (s: string | null) => { watched.push(s) },
  }
  return { page: new StocksPage(source), f, calls, watched }
}

// ------------------------------------------------------------ pixel helpers

const lum = (c: readonly number[]): number => c[0]! + c[1]! + c[2]!

/** Pixels in a region whose colour is near `target`. A REGION, never one
 * column (lesson 22). */
function countNear(buf: Buffer, target: Rgb, x0: number, y0: number, x1: number, y1: number, tol = 60, width = KEY_SIZE): number {
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = probe(buf, x, y, width)
      if (Math.abs(p[0] - target[0]) + Math.abs(p[1] - target[1]) + Math.abs(p[2] - target[2]) < tol) n++
    }
  }
  return n
}

/** Rows in a band that carry any pixel near `target`. */
function rowsWithInk(buf: Buffer, target: Rgb, y0: number, y1: number): number {
  let rows = 0
  for (let y = y0; y < y1; y++) {
    let hit = false
    for (let x = 9; x < 90 && !hit; x++) {
      const p = probe(buf, x, y)
      if (Math.abs(p[0] - target[0]) + Math.abs(p[1] - target[1]) + Math.abs(p[2] - target[2]) < 90) hit = true
    }
    if (hit) rows++
  }
  return rows
}

// =================================================================== layout

describe('StocksPage grid layout: free keys follow the watchlist size', () => {
  it('gives every one of eight symbols a tile, and no free keys', () => {
    expect(EIGHT.map((_, i) => gridRole(i, EIGHT).kind)).toEqual(Array(8).fill('tile'))
  })

  it('puts breadth on key 7 and the mascot on key 8 for six symbols', () => {
    expect(gridRole(6, SIX)).toEqual({ kind: 'breadth' })
    expect(gridRole(7, SIX)).toEqual({ kind: 'mascot' })
  })

  it('keeps only the mascot for seven symbols', () => {
    const seven = EIGHT.slice(0, 7)
    expect(gridRole(6, seven)).toEqual({ kind: 'tile', symbol: 'GGG' })
    expect(gridRole(7, seven)).toEqual({ kind: 'mascot' })
  })

  it('leaves the gap blank for a shorter list, and still shows both free keys', () => {
    const four = SIX.slice(0, 4)
    expect([4, 5, 6, 7].map((i) => gridRole(i, four).kind)).toEqual(['empty', 'empty', 'breadth', 'mascot'])
    const { page } = build({ symbols: four, quotes: quotesFor(four) })
    const keys = page.render(NOW).keys
    expect(keys).toHaveLength(8)
    expect(keys[4]!.kind).toBe('blank')
  })

  it('draws the tiles in the configured order', () => {
    const { page } = build({ quotes: quotesFor(SIX) })
    expect(page.render(NOW).keys.slice(0, 6).map((k) => k.lines?.[0])).toEqual([...SIX])
  })
})

describe('StocksPage tile: the change is the hero', () => {
  const tile = (change: number | null, over: Partial<Quote> = {}): KeySpec => {
    const quotes = quotesFor(SIX)
    quotes.set('AAA', quote('AAA', { changePercent: change, ...over }))
    return build({ quotes }).page.render(NOW).keys[0]!
  }

  it('shows symbol and price small and dim on the top row, the signed change bold and centred', () => {
    const key = tile(3.41)
    expect(key.lines).toEqual(['AAA', '103.41', '+3.41%'])
    expect(key.lineY).toEqual([6, 6, 22])
    expect(key.lineAligns).toEqual(['left', 'right', 'center'])
    expect(key.lineWeights?.[2]).toBe('bold')
    expect(key.lineColors).toEqual([theme.textDim, theme.textDim, theme.green])
    expect((key.lineSizes?.[2] as number[])[0]).toBe(20)
  })

  it('uses the real minus sign, and no sign for a move that rounds to zero', () => {
    expect(tile(-2.144).lines?.[2]).toBe('−2.14%')
    expect(tile(-0.001).lines?.[2]).toBe('0.00%')
    expect(tile(null).lines?.[2]).toBe('--')
  })

  it('makes the hero the biggest ink on the tile (region probe)', () => {
    const buf = renderKey(tile(3.41))
    const hero = countNear(buf, theme.green, 4, 22, 92, 44, 90)
    const topRow = countNear(buf, theme.textDim, 4, 4, 92, 20, 60)
    expect(hero).toBeGreaterThan(topRow * 1.5)
    expect(hero).toBeGreaterThan(250)
  })

  it('draws a line spark with the previous close as its dotted baseline', () => {
    const key = tile(1.5, { previousClose: 200 })
    expect(key.spark?.style).toBe('line')
    expect(key.spark?.baseline).toBe(200)
    expect(key.spark?.minHalfRange).toBeCloseTo(2, 6)
    expect(key.spark!.values.length).toBeLessThanOrEqual(48)
  })

  it('keeps a quiet stock flat and lets a real mover fill the band (region probe)', () => {
    // A 0.1 % day against the ±1 % floor stays in a thin band; a 3 % day
    // spans most of it. Without `minHalfRange` both would fill the band.
    const quiet = renderKey(tile(0.1))
    const loud = renderKey(tile(3))
    const quietRows = rowsWithInk(quiet, theme.green, 48, 90)
    const loudRows = rowsWithInk(loud, theme.green, 48, 90)
    expect(quietRows).toBeLessThan(12)
    expect(loudRows).toBeGreaterThan(quietRows * 2)
  })

  it('omits the spark for fewer than two points', () => {
    expect(tile(1, { spark: [101] }).spark).toBeUndefined()
  })

  it('dims a stale tile and an unpriced one, and no other', () => {
    const quotes = quotesFor(SIX)
    quotes.set('BBB', quote('BBB', { price: null, changePercent: null }))
    const { page } = build({ quotes, staleSymbols: new Set(['AAA']) })
    const keys = page.render(NOW).keys
    expect(keys[0]!.dim).toBe(true)
    expect(keys[1]!.dim).toBe(true)
    expect(keys[2]!.dim).toBeUndefined()
  })

  it('no longer carries the drift particles, which fought the line spark', () => {
    const quotes = quotesFor(SIX, () => 2.5)
    const keys = build({ quotes }).page.render(NOW).keys
    expect(keys.some((k) => k.fx !== undefined)).toBe(false)
  })
})

describe('StocksPage heat wash', () => {
  it('washes up green and down red, growing with the move', () => {
    const up = heatWash(1, 'open')!
    const bigUp = heatWash(3, 'open')!
    expect(up[1]).toBeGreaterThan(up[0])
    expect(lum(bigUp)).toBeGreaterThan(lum(up))
    const down = heatWash(-1, 'open')!
    expect(down[0]).toBeGreaterThan(down[1])
  })

  it('has no wash for flat or unknown', () => {
    expect(heatWash(0, 'open')).toBeUndefined()
    expect(heatWash(null, 'open')).toBeUndefined()
  })

  it('keeps every wash dark enough for white text', () => {
    for (const state of ['open', 'pre', 'post', 'closed', 'unknown'] as const) {
      for (const pct of [3, -3, 12, -12]) expect(lum(heatWash(pct, state)!)).toBeLessThan(lum(theme.text) * 0.45)
    }
  })

  it('is quieter when the market is closed', () => {
    expect(lum(heatWash(3, 'closed')!)).toBeLessThan(lum(heatWash(3, 'open')!))
  })
})

// ============================================================ free keys

describe('StocksPage breadth key', () => {
  it('counts up and down, shows the share as a bar, and the average', () => {
    const changes = [1, 2, -1, 0.5, -0.5, 3]
    const { page } = build({ quotes: quotesFor(SIX, (_, i) => changes[i]!) })
    const key = page.render(NOW).keys[6]!
    expect(key.lines).toEqual(['BREADTH', '▲4', '▼2', 'avg +0.83%'])
    expect(key.bar?.value).toBeCloseTo(4 / 6, 6)
  })

  it('says -- when nothing is counted, and ignores a press then', () => {
    const quotes = quotesFor(SIX, () => null)
    const { page } = build({ quotes })
    expect(page.render(NOW).keys[6]!.lines).toEqual(['BREADTH', '--'])
    expect(page.onKeyPress(6)).toBe('ignored')
  })

  it('shows the leaders on line 1 for 4 s when pressed', () => {
    const changes = [1, 2, -1.5, 0.5, -0.5, 3]
    const { page } = build({ quotes: quotesFor(SIX, (_, i) => changes[i]!) })
    page.render(NOW, NOW_MS)
    expect(page.onKeyPress(6)).toBe('handled')
    const at = NOW_MS + 30
    expect(page.render(NOW, at).strip.lines[0]).toBe('▲ FFF +3.00%  ▼ CCC −1.50%')
    expect(page.render(NOW, at + LEADERS_MS - 1).strip.lines[0]).toContain('▲ FFF')
    expect(page.render(NOW, at + LEADERS_MS).strip.lines[0]).not.toContain('▲ FFF')
  })
})

describe('StocksPage mood mascot', () => {
  it('is a bull when the average is up or flat, a bear when down', () => {
    const bull = build({ quotes: quotesFor(SIX, () => 0) }).page.render(NOW).keys[7]!
    expect(bull.mascot?.kind).toBe('bull')
    expect(bull.lines).toEqual(['BULLISH'])
    const bear = build({ quotes: quotesFor(SIX, () => -0.2) }).page.render(NOW).keys[7]!
    expect(bear.mascot?.kind).toBe('bear')
  })

  it('moves only while something trades, so a closed night writes nothing for it', () => {
    const { page, f } = build({ quotes: quotesFor(SIX, () => 1), marketState: 'closed' })
    const a = page.render(NOW, NOW_MS).keys[7]!
    const b = page.render(NOW, NOW_MS + 700).keys[7]!
    expect(keyHash(a)).toBe(keyHash(b))
    f.marketState = 'open'
    const c = page.render(NOW, NOW_MS + 1400).keys[7]!
    expect(c.mascot?.nowMs).toBe(NOW_MS + 1400)
  })

  it('pops hearts when pressed, on the clock of the next render (region probe)', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => 1) })
    page.render(NOW, NOW_MS)
    expect(page.onKeyPress(7)).toBe('handled')
    const key = page.render(NOW, NOW_MS + 40).keys[7]!
    expect(key.effects).toEqual([{ variant: 'hearts', startedAtMs: NOW_MS + 40, nowMs: NOW_MS + 40, count: 6, y: 40 }])
    const later = page.render(NOW, NOW_MS + 440).keys[7]!
    const plain = build({ quotes: quotesFor(SIX, () => 1) }).page.render(NOW, NOW_MS + 440).keys[7]!
    const pink: Rgb = [255, 79, 122]
    expect(countNear(renderKey(later), pink, 0, 0, 96, 96, 120)).toBeGreaterThan(countNear(renderKey(plain), pink, 0, 0, 96, 96, 120) + 20)
  })

  it('is blank and ignores a press when no change is known', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => null) })
    expect(page.render(NOW).keys[7]!.kind).toBe('blank')
    expect(page.onKeyPress(7)).toBe('ignored')
  })
})

// ================================================================= strip

describe('StocksPage strip line 1 rotates useful facts', () => {
  const closeB: MarketBoundary = { kind: 'close', atMs: CLOSE_MS, next: 'post' }
  const base = Math.floor(NOW_MS / (3 * FACT_ROTATE_MS)) * 3 * FACT_ROTATE_MS

  it('cycles countdown, breadth and best, then clock and state, every 8 s', () => {
    const changes = [1, 3.41, -1, 0.5, -0.5, 0.2]
    const { page } = build({ quotes: quotesFor(SIX, (_, i) => changes[i]!), boundary: closeB })
    const at = (k: number) => page.render(0, base + k * FACT_ROTATE_MS + 100).strip.lines[0]
    const lines = [at(0), at(1), at(2)]
    expect(lines).toContain('▲4 ▼2 · BEST BBB +3.41%')
    expect(lines.some((l) => /^CLOSES IN \d+h\d+m$/.test(l!))).toBe(true)
    expect(lines.some((l) => /^MARKET OPEN · \d{1,2}:\d\d (AM|PM) E[DS]T$/.test(l!))).toBe(true)
  })

  it('counts down to the reported boundary as a duration', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => 1), boundary: { kind: 'close', atMs: NOW_MS + (2 * 60 + 14) * 60_000 + 30_000, next: 'post' } })
    const lines = new Set<string>()
    for (let k = 0; k < 3; k++) lines.add(page.render(0, NOW_MS + k * FACT_ROTATE_MS).strip.lines[0]!)
    expect([...lines].some((l) => l.startsWith('CLOSES IN 2h1'))).toBe(true)
    const soon = build({ quotes: quotesFor(SIX, () => 1), boundary: { kind: 'open', atMs: NOW_MS + 20_000, next: 'open' } })
    const seen = [0, 1, 2].map((k) => soon.page.render(0, base + k * FACT_ROTATE_MS).strip.lines[0])
    expect(seen.some((l) => l === 'OPENS IN <1m' || l?.startsWith('OPENS IN'))).toBe(true)
  })

  it('omits the countdown when the boundary is unknown, never inventing one', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => 1), boundary: null, marketState: 'unknown' })
    for (let k = 0; k < 4; k++) {
      expect(page.render(0, base + k * FACT_ROTATE_MS).strip.lines[0]).not.toMatch(/ IN /)
    }
  })

  it('prints the clock in Eastern 12-hour time with the real zone', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => null), marketState: 'closed' })
    // With nothing counted and no boundary, the clock fact is the only one.
    expect(page.render(NOW).strip.lines[0]).toBe('MARKET CLOSED · 11:46 AM EDT')
  })

  it('never draws line 1 into the strip margin, for the widest fact', () => {
    const { page } = build({
      quotes: quotesFor(SIX, () => -12.34), marketState: 'unknown',
      boundary: { kind: 'post-end', atMs: NOW_MS + 23 * 3600_000 + 59 * 60_000, next: 'closed' },
    })
    for (let k = 0; k < 3; k++) {
      const buf = renderStrip(page.render(0, base + k * FACT_ROTATE_MS).strip)
      expect(countNear(buf, theme.bg, STRIP_WIDTH - 6, 0, STRIP_WIDTH, 16, 3, STRIP_WIDTH)).toBe(6 * 16)
    }
  })

  it('reports offline on line 2 with no tape', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => 1), status: 'offline' })
    const strip = page.render(NOW).strip
    expect(strip.lines[1]).toBe('offline')
    expect(strip.tape).toBeUndefined()
  })
})

describe('StocksPage tape', () => {
  it('writes one segment per priced symbol, signed like the tiles, dimming only a stale one', () => {
    const quotes = quotesFor(SIX, (_, i) => [1, -2.5, 0, 1, 1, 1][i]!)
    quotes.set('DDD', quote('DDD', { price: null, changePercent: null }))
    const segs = tapeSegments(quotes, (s) => s === 'EEE', SIX)
    expect(segs.map((s) => s.text)).toEqual([
      'AAA 101.00 +1.00%', 'BBB 97.50 −2.50%', 'CCC 100.00 0.00%', 'EEE 101.00 +1.00%', 'FFF 101.00 +1.00%',
    ])
    expect(segs[1]!.color).toEqual(theme.red)
    expect(segs[3]!.color).toEqual(theme.textDim)
  })

  it('rests with a whole quote at the left edge, then scrolls', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => 1) })
    const cycle = 2600
    const t0 = Math.floor(NOW_MS / cycle) * cycle
    expect(page.render(0, t0 + 100).strip.tape?.offsetPx).toBe(0)
    expect(page.render(0, t0 + 1400).strip.tape?.offsetPx).toBe(0)
    expect(page.render(0, t0 + 2000).strip.tape!.offsetPx).toBeGreaterThan(0)
  })

  it('writes the strip far less often when the market is closed, however fast the page ticks', () => {
    const writes = (state: MarketState, tick: number): number => {
      const { page } = build({ quotes: quotesFor(SIX, () => 1), marketState: state })
      let last = ''
      let n = 0
      for (let t = 0; t < 18_000; t += tick) {
        const h = stripHash(page.render(0, NOW_MS + t).strip)
        if (h !== last) n++
        last = h
      }
      return n
    }
    // The old tape rewrote the strip on all 450 frames of 18 s at 40 ms.
    expect(writes('closed', 40)).toBeLessThanOrEqual(46)
    expect(writes('open', 40)).toBeLessThan(250)
  })
})

// =============================================================== buttons

describe('StocksPage round buttons glow by breadth', () => {
  const qs = (changes: (number | null)[]) => changes.map((c, i) => quote(`S${i}`, { changePercent: c }))

  it('lights left green by the share up and right red by the share down', () => {
    const [l1, r1] = breadthButtons(qs([1, 1, 1, -1]), 'closed', 'ok', 0)
    const [l2, r2] = breadthButtons(qs([1, -1, -1, -1]), 'closed', 'ok', 0)
    expect(l1[1]).toBeGreaterThan(l2[1])
    expect(r2[0]).toBeGreaterThan(r1[0])
    expect(l1[1]).toBeGreaterThan(l1[0])
    expect(r2[0]).toBeGreaterThan(r2[1])
  })

  it('goes grey offline or with nothing counted', () => {
    expect(breadthButtons(qs([1, -1]), 'open', 'offline', 0)).toEqual([theme.gray, theme.gray])
    expect(breadthButtons(qs([null]), 'open', 'ok', 0)).toEqual([theme.gray, theme.gray])
  })

  it('breathes while open and holds steady while closed', () => {
    const q = qs([1, 1, -1])
    const open = new Set([0, 1000, 2000].map((t) => JSON.stringify(breadthButtons(q, 'open', 'ok', t))))
    const closed = new Set([0, 1000, 2000].map((t) => JSON.stringify(breadthButtons(q, 'closed', 'ok', t))))
    expect(open.size).toBeGreaterThan(1)
    expect(closed.size).toBe(1)
  })

  it('agrees with the breadth key and the counting helper', () => {
    const changes = [1, 2, -1, 0, null, 3]
    const watch = changes.map((c, i) => quote(`S${i}`, { changePercent: c }))
    expect(breadth(watch)).toEqual({ up: 3, down: 1, counted: 5 })
    expect(averageChange(watch)).toBeCloseTo(1, 6)
  })
})

// ================================================================== peek

describe('StocksPage peek: the first press flips a tile for 3 s', () => {
  it('shows the day range gauge and volume, stamped by the next render', () => {
    const { page, watched } = build({ quotes: quotesFor(SIX, () => 1) })
    page.render(NOW, NOW_MS)
    expect(page.onKeyPress(2)).toBe('handled')
    const at = NOW_MS + 25
    const key = page.render(NOW, at).keys[2]!
    expect(key.lines).toEqual(['CCC', '101.00', 'DAY RANGE', '95.00', '105.00', 'VOLUME', '1.00M'])
    expect(key.range).toMatchObject({ lo: 95, hi: 105, value: 101 })
    expect(page.render(NOW, at + PEEK_MS - 1).keys[2]!.range).toBeDefined()
    expect(page.render(NOW, at + PEEK_MS).keys[2]!.range).toBeUndefined()
    expect(watched).toEqual([])
  })

  it('omits volume when the quote lacks it, never printing 0', () => {
    const quotes = quotesFor(SIX, () => 1)
    quotes.set('AAA', quote('AAA', { changePercent: 1, volume: null }))
    const { page } = build({ quotes })
    page.onKeyPress(0)
    const key = page.render(NOW, NOW_MS).keys[0]!
    expect(key.lines).not.toContain('VOLUME')
    expect(key.lines?.some((l) => l === '0' || l === '0.00')).toBe(false)
    expect(key.lines).toContain('60% of range')
  })

  it('draws no gauge for an unknown range', () => {
    const quotes = quotesFor(SIX, () => 1)
    quotes.set('AAA', quote('AAA', { changePercent: 1, dayHigh: null }))
    const { page } = build({ quotes })
    page.onKeyPress(0)
    const key = page.render(NOW, NOW_MS).keys[0]!
    expect(key.range).toBeUndefined()
    expect(key.lines).toContain('--')
  })

  it('opens the detail view on a second press inside 3 s', () => {
    const { page, watched } = build({ quotes: quotesFor(SIX, () => 1) })
    page.onKeyPress(1)
    page.render(NOW, NOW_MS)
    page.render(NOW, NOW_MS + PEEK_MS - 100)
    expect(page.onKeyPress(1)).toBe('handled')
    expect(watched).toEqual(['BBB'])
    expect(page.render(NOW, NOW_MS + PEEK_MS).keys[7]!.lines).toEqual(['←', 'BACK'])
  })

  it('peeks again, rather than opening, once the 3 s have passed', () => {
    const { page, watched } = build({ quotes: quotesFor(SIX, () => 1) })
    page.onKeyPress(1)
    page.render(NOW, NOW_MS)
    page.render(NOW, NOW_MS + PEEK_MS + 10)
    page.onKeyPress(1)
    expect(watched).toEqual([])
    expect(page.render(NOW, NOW_MS + PEEK_MS + 50).keys[1]!.range).toBeDefined()
  })

  it('treats two presses before any render as peek then open', () => {
    const { page, watched } = build({ quotes: quotesFor(SIX, () => 1) })
    page.onKeyPress(3)
    page.onKeyPress(3)
    expect(watched).toEqual(['DDD'])
  })

  it('ignores a press on a symbol with no price, and on an empty key', () => {
    const quotes = quotesFor(SIX.slice(0, 4), () => 1)
    quotes.set('BBB', quote('BBB', { price: null, changePercent: null }))
    const { page } = build({ symbols: SIX.slice(0, 4), quotes })
    expect(page.onKeyPress(1)).toBe('ignored')
    expect(page.onKeyPress(4)).toBe('ignored')
    expect(page.render(NOW).keys[1]!.range).toBeUndefined()
  })

  it('forgets peeks on leave, so the page reopens on plain tiles', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => 1) })
    page.onKeyPress(0)
    page.onLeave()
    page.onEnter()
    expect(page.render(NOW, NOW_MS).keys[0]!.range).toBeUndefined()
  })
})

// ================================================================= bells

describe('StocksPage bells', () => {
  function bellPage() {
    const b = build({ quotes: quotesFor(SIX, () => 1), marketState: 'pre', boundary: { kind: 'open', atMs: OPEN_MS, next: 'open' } })
    b.page.render(0, OPEN_MS - 1000)
    b.f.marketState = 'open'
    b.f.boundary = { kind: 'close', atMs: CLOSE_MS, next: 'post' }
    b.page.render(0, OPEN_MS + 20)
    return b
  }

  it('rings the opening bell: banner with the Eastern open time, and a pop', () => {
    const { page } = bellPage()
    const strip = page.render(0, OPEN_MS + 200).strip
    expect(strip.banner).toMatchObject({ text: '🔔 OPENING BELL', sub: '9:30 AM EDT', color: theme.green })
    expect(strip.banner?.pop).toEqual({ startedAtMs: OPEN_MS + 20, nowMs: OPEN_MS + 200 })
    expect(page.render(0, OPEN_MS + 20 + 4000).strip.banner).toBeUndefined()
  })

  it('cascades a sweep left to right, 90 ms apart, over every drawn key', () => {
    const { page } = bellPage()
    const keys = page.render(0, OPEN_MS + 100).keys
    keys.forEach((k, i) => {
      expect(k.effects?.find((e) => e.variant === 'sweep')?.startedAtMs).toBe(OPEN_MS + 20 + i * SWEEP_STAGGER_MS)
    })
  })

  it('lights a key while its sweep runs and not after (region probe)', () => {
    const { page } = bellPage()
    const mint: Rgb = [125, 255, 176]
    const during = renderKey(page.render(0, OPEN_MS + 120).keys[0]!)
    const after = renderKey(page.render(0, OPEN_MS + 1500).keys[0]!)
    expect(countNear(during, mint, 0, 0, 96, 96, 140)).toBeGreaterThan(countNear(after, mint, 0, 0, 96, 96, 140) + 500)
  })

  it('pulses both buttons green for about 2 s', () => {
    const { page } = bellPage()
    const [l, r] = page.render(0, OPEN_MS + 500).buttons
    expect(l).toEqual(r)
    expect(l[1]).toBeGreaterThan(l[0] * 2)
    const later = page.render(0, OPEN_MS + 3000).buttons
    expect(later[1][0]).toBeGreaterThan(later[1][1])
  })

  it('does not ring on startup mid-session', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => 1) })
    expect(page.render(NOW, NOW_MS).strip.banner).toBeUndefined()
    expect(page.render(NOW, NOW_MS + 40).keys.some((k) => k.effects?.length)).toBe(false)
  })

  it('rings the closing bell, then shows the best and the worst for 10 minutes', () => {
    const changes = [1, 3.41, -2.14, 0.5, -0.5, 0.2]
    const { page, f } = build({ quotes: quotesFor(SIX, (_, i) => changes[i]!), boundary: { kind: 'close', atMs: CLOSE_MS, next: 'post' } })
    page.render(0, CLOSE_MS - 1000)
    f.marketState = 'post'
    f.boundary = null
    page.render(0, CLOSE_MS + 10)
    expect(page.render(0, CLOSE_MS + 500).strip.banner).toMatchObject({ text: '🔔 CLOSING BELL', sub: '4:00 PM EDT' })
    const lines = new Set<string>()
    for (let t = 4000; t < 20_000; t += 1000) lines.add(page.render(0, CLOSE_MS + 10 + t).strip.lines[0]!)
    expect(lines).toEqual(new Set(['CLOSED · BEST BBB +3.41%', 'CLOSED · WORST CCC −2.14%']))
    for (let t = 20_000; t <= 10 * 60_000; t += 4000) page.render(0, CLOSE_MS + 10 + t)
    expect(page.render(0, CLOSE_MS + 10 + 10 * 60_000 + 100).strip.lines[0]).not.toMatch(/^CLOSED ·/)
  })
})

// ============================================================ big moves

describe('StocksPage big-move celebrations', () => {
  function crossing(from: number, to: number) {
    const quotes = quotesFor(SIX, () => 0.5)
    quotes.set('BBB', quote('BBB', { changePercent: from }))
    const b = build({ quotes })
    b.page.render(NOW, NOW_MS)
    quotes.set('BBB', quote('BBB', { changePercent: to }))
    b.page.render(NOW, NOW_MS + 1000)
    return b
  }

  it('bursts and pops the hero on a first +2 % crossing, and says so on the strip', () => {
    const { page } = crossing(1.9, 2.05)
    const frame = page.render(NOW, NOW_MS + 1200)
    expect(frame.keys[1]!.effects?.[0]).toMatchObject({ variant: 'burst', startedAtMs: NOW_MS + 1000 })
    expect(frame.keys[1]!.linePop).toEqual({ line: 2, startedAtMs: NOW_MS + 1000, nowMs: NOW_MS + 1200 })
    expect(frame.strip.banner?.text).toBe('🚀 BBB crossed +2%')
    expect(frame.keys[0]!.effects).toBeUndefined()
    expect(page.render(NOW, NOW_MS + 5000).strip.banner).toBeUndefined()
  })

  it('drops a brick on a first −2 % crossing', () => {
    const { page } = crossing(-1.9, -2.2)
    const frame = page.render(NOW, NOW_MS + 1100)
    expect(frame.keys[1]!.effects?.[0]).toMatchObject({ variant: 'brick' })
    expect(frame.keys[1]!.linePop).toBeUndefined()
    expect(frame.strip.banner?.text).toBe('🧱 BBB crossed −2%')
  })

  it('draws the confetti on the glass (region probe), and stops costing writes once done', () => {
    const { page } = crossing(1.9, 2.05)
    const running = page.render(NOW, NOW_MS + 1400).keys[1]!
    const done = page.render(NOW, NOW_MS + 6000).keys[1]!
    const plain = build({ quotes: (() => { const q = quotesFor(SIX, () => 0.5); q.set('BBB', quote('BBB', { changePercent: 2.05 })); return q })() }).page.render(NOW, NOW_MS + 6000).keys[1]!
    let diff = 0
    const a = renderKey(running)
    const b = renderKey(plain)
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) > 80) diff++
    expect(diff).toBeGreaterThan(80)
    expect(keyHash(done)).toBe(keyHash(plain))
  })

  it('does not celebrate a symbol already past the line at the first quote', () => {
    const quotes = quotesFor(SIX, () => 3)
    const { page } = build({ quotes })
    for (let t = 0; t < 2000; t += 40) {
      const frame = page.render(NOW, NOW_MS + t)
      expect(frame.keys.some((k) => k.effects?.length)).toBe(false)
    }
  })
})

// ================================================================ tickMs

describe('StocksPage render rate', () => {
  it('is 40 ms while the live tape moves', () => {
    expect(build({ quotes: quotesFor(SIX, () => 1) }).page.tickMs).toBe(40)
  })

  it('is 200 ms for the closed-market crawl, and 100 ms for a hopping mascot with no tape', () => {
    expect(build({ quotes: quotesFor(SIX, () => 1), marketState: 'closed' }).page.tickMs).toBe(200)
    expect(build({ quotes: quotesFor(SIX, () => 1), marketState: 'pre', status: 'offline' }).page.tickMs).toBe(100)
  })

  it('goes fast while a one-shot runs even when closed', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => 1), marketState: 'closed' })
    page.render(NOW, NOW_MS)
    page.onKeyPress(7)
    expect(page.tickMs).toBe(40)
    page.render(NOW, NOW_MS + 100)
    expect(page.tickMs).toBe(40)
    page.render(NOW, NOW_MS + 2000)
    expect(page.tickMs).toBe(200)
  })

  it('keeps the default with nothing to move', () => {
    expect(build({ quotes: new Map(), marketState: 'closed' }).page.tickMs).toBeUndefined()
    expect(build({ quotes: quotesFor(SIX, () => 1), status: 'offline', marketState: 'closed' }).page.tickMs).toBeUndefined()
  })

  it('keeps the default in the detail view', () => {
    const { page } = build({ quotes: quotesFor(SIX, () => 1) })
    page.onKeyPress(0)
    page.onKeyPress(0)
    expect(page.tickMs).toBeUndefined()
  })
})

// ================================================================ detail

describe('StocksPage detail view', () => {
  function detail(over: Partial<Quote> = {}, fakes: Partial<Fakes> = {}) {
    const quotes = quotesFor(SIX, () => 1)
    quotes.set('AAA', quote('AAA', { changePercent: -2, ...over }))
    const b = build({ quotes, ...fakes })
    b.page.onKeyPress(0)
    b.page.onKeyPress(0)
    return b
  }

  it('key 1 is the hero: symbol, price, change and amount', () => {
    const key = detail().page.render(NOW).keys[0]!
    expect(key.lines).toEqual(['AAA', '98.00', '−2.00%', '−2.00'])
    expect(key.lineColors?.[2]).toEqual(theme.red)
  })

  it('key 2 is a day-range gauge with where the price sits', () => {
    const key = detail().page.render(NOW).keys[1]!
    expect(key.lines).toEqual(['DAY RANGE', '95.00', '105.00', '30% of range'])
    expect(key.range).toMatchObject({ lo: 95, hi: 105, value: 98 })
  })

  it('guards an empty or unknown range: no gauge, no NaN', () => {
    const key = detail({ dayHigh: 95, dayLow: 95 }).page.render(NOW).keys[1]!
    expect(key.range).toBeUndefined()
    expect(key.lines?.[3]).toBe('--')
    expect(key.lines?.join(' ')).not.toMatch(/NaN/)
  })

  it('key 3 shows the volume, or -- when unknown, never 0', () => {
    expect(detail().page.render(NOW).keys[2]!.lines?.[1]).toBe('1.00M')
    expect(detail({ volume: null }).page.render(NOW).keys[2]!.lines?.[1]).toBe('--')
  })

  it('key 4 is the 52-week gauge', () => {
    const key = detail().page.render(NOW).keys[3]!
    expect(key.lines?.[0]).toBe('52 WEEKS')
    expect(key.range).toMatchObject({ lo: 60, hi: 150 })
  })

  it('keys 5 to 7 are one sliced line chart with the previous close dotted', () => {
    const keys = detail().page.render(NOW).keys
    for (let i = 0; i < 3; i++) {
      const s = keys[4 + i]!.spark!
      expect(s.style).toBe('line')
      expect(s.slice).toEqual({ index: i, count: 3 })
      expect(s.baseline).toBe(100)
      expect(s.labelBand).toBe(true)
      expect(s.values).toBe(keys[4]!.spark!.values)
    }
    expect(keys[4]!.spark!.label).toBe('1D')
  })

  it('handles every point count: 0 and 1 caption only, 2 and 3 whole on key 5, 4 sliced', () => {
    const at = (n: number) => detail({ spark: Array.from({ length: n }, (_, k) => 98 + k) }).page.render(NOW).keys
    expect(at(0)[4]!.lines).toEqual(['1D'])
    expect(at(1)[4]!.spark).toBeUndefined()
    expect(at(2)[4]!.spark?.slice).toBeUndefined()
    expect(at(3)[5]!.spark).toBeUndefined()
    expect(at(4)[5]!.spark?.slice).toEqual({ index: 1, count: 3 })
  })

  it('switches the chart to the year on a chart press once it has loaded, and back', () => {
    const yearly: YearlyState = { status: 'ok', values: [50, 60, 70, 80, 90], updatedAt: NOW }
    const { page } = detail({}, { yearlyStates: new Map([['AAA', yearly]]) })
    expect(page.onKeyPress(5)).toBe('handled')
    const keys = page.render(NOW).keys
    expect(keys[4]!.spark?.label).toBe('52 WK')
    expect(keys[4]!.spark?.baseline).toBeUndefined()
    expect(page.onKeyPress(4)).toBe('handled')
    expect(page.render(NOW).keys[4]!.spark?.label).toBe('1D')
  })

  it('ignores a chart press while the year has not loaded', () => {
    expect(detail().page.onKeyPress(5)).toBe('ignored')
  })

  it('dims only the chart when the cached year has gone stale', () => {
    const yearly: YearlyState = { status: 'ok', values: [50, 60, 70, 80, 90], updatedAt: NOW - YEARLY_REFRESH_SECONDS - 1 }
    const { page } = detail({}, { yearlyStates: new Map([['AAA', yearly]]) })
    page.onKeyPress(5)
    const keys = page.render(NOW).keys
    expect(keys.slice(4, 7).every((k) => k.dim)).toBe(true)
    expect(keys.slice(0, 4).some((k) => k.dim)).toBe(false)
  })

  it('ignores keys 1 to 4, and BACK returns to the grid and clears the watch', () => {
    const { page, watched } = detail()
    for (const i of [0, 1, 2, 3]) expect(page.onKeyPress(i)).toBe('ignored')
    expect(page.onKeyPress(7)).toBe('handled')
    expect(watched).toEqual(['AAA', null])
    expect(page.render(NOW).keys[0]!.lines?.[0]).toBe('AAA')
    expect(page.render(NOW).keys[7]!.mascot).toBeDefined()
  })

  it('never touches the watch from render', () => {
    const { page, watched } = detail()
    for (let t = 0; t < 10; t++) page.render(NOW + t)
    expect(watched).toEqual(['AAA'])
  })

  it('clears the selection and the watch on leave', () => {
    const { page, watched, calls } = detail()
    page.onLeave()
    expect(watched).toEqual(['AAA', null])
    expect(calls).toEqual(['visible:false'])
    expect(page.render(NOW).keys[7]!.lines).not.toEqual(['←', 'BACK'])
  })

  it('keeps the name and the Eastern as-of time on the strip, and says offline', () => {
    const { page, f } = detail()
    const strip = page.render(NOW).strip
    expect(strip.lines).toEqual(['AAA Corp', 'MARKET OPEN · 11:46 AM EDT'])
    f.status = 'offline'
    expect(page.render(NOW).strip.right).toBe('offline')
  })

  it('fits the widest hero inside the key (region probe of the right margin)', () => {
    const key = detail({ price: 123456.78, previousClose: 1000, changePercent: 12245.68 }).page.render(NOW).keys[0]!
    const buf = renderKey(key)
    expect(countNear(buf, key.bg ?? theme.bg, KEY_SIZE - 3, 0, KEY_SIZE, KEY_SIZE, 6)).toBe(3 * KEY_SIZE)
  })
})

describe('StocksPage visibility', () => {
  it('tells the source when it becomes visible and when it leaves', () => {
    const { page, calls } = build()
    page.onEnter()
    page.onLeave()
    expect(calls).toEqual(['visible:true', 'visible:false'])
  })
})

describe('StocksPage helpers', () => {
  it('finds the leaders across the watchlist only', () => {
    const quotes = quotesFor(SIX, (_, i) => [1, 2, -3, 0, null, 0.5][i]!)
    quotes.set('ZZZ', quote('ZZZ', { changePercent: 99 }))
    const l = leaders(SIX, quotes)!
    expect(l.best.symbol).toBe('BBB')
    expect(l.worst.symbol).toBe('CCC')
  })
})
