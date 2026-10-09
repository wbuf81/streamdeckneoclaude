import { describe, it, expect } from 'vitest'
import { StockMoments, CLOSE_SUMMARY_MS } from '../../src/pages/stocks-moments.js'
import type { MarketBoundary, MarketState, Quote } from '../../src/sources/stocks.js'

/** 2026-08-12 11:46 AM EDT. */
const NOW_MS = 1786549560_000
/** 9:30 AM EDT the same day. */
const OPEN_MS = NOW_MS - (2 * 60 + 16) * 60_000
const DAY_MS = 24 * 3600_000

function q(symbol: string, changePercent: number | null, asOfMs = NOW_MS): Quote {
  return {
    symbol, name: symbol, price: 100, previousClose: 100, changePercent, spark: [],
    currency: 'USD', asOf: Math.floor(asOfMs / 1000), dayHigh: null, dayLow: null,
    week52High: null, week52Low: null, volume: null,
  }
}

function observer(symbols = ['AAA', 'BBB']) {
  const m = new StockMoments()
  const quotes = new Map<string, Quote>()
  const stale = new Set<string>()
  const see = (nowMs: number, state: MarketState, boundary: MarketBoundary | null = null) =>
    m.observe({ nowMs, state, boundary, quotes, symbols, isStale: (s) => stale.has(s) })
  return { m, quotes, stale, see }
}

describe('StockMoments: big moves fire once, only on a watched crossing', () => {
  it('fires up when a fresh quote crosses +2 % in a continuous watch', () => {
    const { m, quotes, see } = observer()
    quotes.set('AAA', q('AAA', 1.9))
    see(NOW_MS, 'open')
    quotes.set('AAA', q('AAA', 2.05))
    see(NOW_MS + 1000, 'open')
    expect(m.recentMoves).toEqual([{ symbol: 'AAA', kind: 'up', atMs: NOW_MS + 1000 }])
  })

  it('fires down on −2 %', () => {
    const { m, quotes, see } = observer()
    quotes.set('BBB', q('BBB', -1.5))
    see(NOW_MS, 'open')
    quotes.set('BBB', q('BBB', -2.0))
    see(NOW_MS + 40, 'open')
    expect(m.recentMoves.map((x) => x.kind)).toEqual(['down'])
  })

  it('never fires for a value already past the line at the first observation (startup, 9:30)', () => {
    const { m, quotes, see } = observer()
    quotes.set('AAA', q('AAA', 3.4))
    quotes.set('BBB', q('BBB', -4))
    for (let t = 0; t < 3000; t += 40) see(NOW_MS + t, 'open')
    expect(m.recentMoves).toEqual([])
  })

  it('treats yesterday\'s quote as no reading, so the first quote of today only sets the baseline', () => {
    const { m, quotes, see } = observer()
    quotes.set('AAA', q('AAA', 0.2, NOW_MS - DAY_MS))
    see(OPEN_MS, 'open')
    quotes.set('AAA', q('AAA', 2.6, OPEN_MS + 5000))
    see(OPEN_MS + 1000, 'open')
    see(OPEN_MS + 2000, 'open')
    expect(m.recentMoves).toEqual([])
  })

  it('fires each direction once per Eastern day, and again the next day', () => {
    const { m, quotes, see } = observer()
    const seq = [1.9, 2.1, 1.9, 2.2, 1.0, 2.5]
    seq.forEach((v, i) => {
      quotes.set('AAA', q('AAA', v))
      see(NOW_MS + i * 500, 'open')
    })
    expect(m.recentMoves.filter((x) => x.symbol === 'AAA')).toHaveLength(1)
    const next = NOW_MS + DAY_MS
    quotes.set('AAA', q('AAA', 1.9, next))
    see(next, 'open')
    quotes.set('AAA', q('AAA', 2.1, next))
    see(next + 1000, 'open')
    expect(m.recentMoves.map((x) => x.atMs)).toEqual([next + 1000])
  })

  it('ignores a stale quote, a closed market, and a watch with a gap', () => {
    const { m, quotes, stale, see } = observer()
    quotes.set('AAA', q('AAA', 1.9))
    see(NOW_MS, 'open')
    stale.add('AAA')
    quotes.set('AAA', q('AAA', 2.1))
    see(NOW_MS + 1000, 'open')
    expect(m.recentMoves).toEqual([])

    const b = observer()
    b.quotes.set('AAA', q('AAA', 1.9))
    b.see(NOW_MS, 'post')
    b.quotes.set('AAA', q('AAA', 2.1))
    b.see(NOW_MS + 1000, 'post')
    expect(b.m.recentMoves).toEqual([])

    const c = observer()
    c.quotes.set('AAA', q('AAA', 1.9))
    c.see(NOW_MS, 'open')
    c.quotes.set('AAA', q('AAA', 2.1))
    // The page was hidden for a minute: the crossing was not watched.
    c.see(NOW_MS + 60_000, 'open')
    expect(c.m.recentMoves).toEqual([])
  })

  it('stays bounded: events expire and removed symbols are forgotten', () => {
    const { m, quotes, see } = observer(['AAA'])
    quotes.set('AAA', q('AAA', 1.9))
    see(NOW_MS, 'open')
    quotes.set('AAA', q('AAA', 2.1))
    see(NOW_MS + 40, 'open')
    expect(m.recentMoves).toHaveLength(1)
    see(NOW_MS + 4100, 'open')
    expect(m.recentMoves).toHaveLength(0)
    m.observe({ nowMs: NOW_MS + 4200, state: 'open', boundary: null, quotes, symbols: [], isStale: () => false })
    expect((m as unknown as { moves: Map<string, unknown> }).moves.size).toBe(0)
  })
})

describe('StockMoments: the bells ring on a watched edge only', () => {
  const openB: MarketBoundary = { kind: 'open', atMs: OPEN_MS, next: 'open' }

  it('rings the opening bell on pre → open, labelled with the boundary time', () => {
    const { m, see } = observer()
    see(OPEN_MS - 1000, 'pre', openB)
    see(OPEN_MS + 30, 'open')
    expect(m.bell).toEqual({ kind: 'open', atMs: OPEN_MS + 30, labelMs: OPEN_MS })
  })

  it('does not ring on startup mid-session, nor on unknown → open', () => {
    const a = observer()
    a.see(NOW_MS, 'open')
    expect(a.m.bell).toBeNull()
    const b = observer()
    b.see(OPEN_MS - 1000, 'unknown')
    b.see(OPEN_MS + 30, 'open')
    expect(b.m.bell).toBeNull()
  })

  it('does not ring for a transition that happened while the page was hidden', () => {
    const { m, see } = observer()
    see(OPEN_MS - 60_000, 'pre')
    see(OPEN_MS + 3 * 3600_000, 'open')
    expect(m.bell).toBeNull()
  })

  it('rings just after a boundary it saw coming, even across a short gap', () => {
    const { m, see } = observer()
    see(OPEN_MS - 30_000, 'pre', openB)
    see(OPEN_MS + 4000, 'open')
    expect(m.bell?.kind).toBe('open')
    const late = observer()
    late.see(OPEN_MS - 30_000, 'pre', openB)
    late.see(OPEN_MS + 60_000, 'open')
    expect(late.m.bell).toBeNull()
  })

  it('rings each bell once per Eastern day', () => {
    const { m, see } = observer()
    see(OPEN_MS - 1000, 'pre')
    see(OPEN_MS, 'open')
    const first = m.bell
    see(OPEN_MS + 1000, 'closed')
    see(OPEN_MS + 2000, 'open')
    expect(m.bell).toEqual({ kind: 'close', atMs: OPEN_MS + 1000, labelMs: OPEN_MS + 1000 })
    expect(first?.kind).toBe('open')
  })

  it('rings the closing bell on open → post, and holds the summary window for 10 minutes', () => {
    const { m, see } = observer()
    const close = OPEN_MS + 390 * 60_000
    see(close - 1000, 'open', { kind: 'close', atMs: close, next: 'post' })
    see(close + 10, 'post')
    expect(m.bell?.kind).toBe('close')
    expect(m.bell?.labelMs).toBe(close)
    expect(m.closedAtMs).toBe(close + 10)
    see(close + 10 + CLOSE_SUMMARY_MS, 'post')
    expect(m.closedAtMs).toBeNull()
  })
})
