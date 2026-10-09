import { describe, it, expect, vi, afterEach } from 'vitest'
import { StockSource } from '../../src/sources/stocks.js'
import {
  deriveSessionState,
  easternEpoch,
  nextCandidateStart,
  nextBoundary,
  parsePeriod,
} from '../../src/sources/stocks-session.js'

/**
 * Captured live from Yahoo's chart endpoint (MSFT, range=1d, interval=5m)
 * on Friday 2026-10-09 at 1:00 PM EDT. These are the real epochs:
 * pre 04:00-09:30, regular 09:30-16:00, post 16:00-20:00 EDT.
 */
const FRI = {
  pre: { timezone: 'EDT', start: 1791532800, end: 1791552600, gmtoffset: -14400 },
  regular: { timezone: 'EDT', start: 1791552600, end: 1791576000, gmtoffset: -14400 },
  post: { timezone: 'EDT', start: 1791576000, end: 1791590400, gmtoffset: -14400 },
}
const FRI_0100 = FRI.pre.start - 3 * 3600
const FRI_PRE = FRI.pre.start
const FRI_OPEN = FRI.regular.start
const FRI_CLOSE = FRI.regular.end
const FRI_POST_END = FRI.post.end
const SAT_0400 = FRI_POST_END + 8 * 3600
const SAT_0930 = SAT_0400 + 5.5 * 3600
const MON_1000 = FRI_PRE + 3 * 86400 + 6 * 3600

/** Moves both the fake timers and `Date.now`, which the source's clock reads. */
function fakeClockAt(epochSeconds: number): () => number {
  vi.useFakeTimers()
  vi.setSystemTime(epochSeconds * 1000)
  return () => Math.floor(Date.now() / 1000)
}

function body(symbol: string, period: unknown) {
  return {
    chart: {
      result: [{
        meta: {
          symbol,
          currency: 'USD',
          shortName: symbol,
          regularMarketPrice: 100,
          previousClose: 99,
          regularMarketTime: Math.floor(Date.now() / 1000),
          currentTradingPeriod: period,
          exchangeTimezoneName: 'America/New_York',
        },
        indicators: { quote: [{ close: [99, 100] }] },
      }],
      error: null,
    },
  }
}

interface Upstream {
  /** What `currentTradingPeriod` the next replies carry, per symbol. */
  period: Record<string, unknown>
  /** Every reply fails at the network layer. */
  fail: boolean
  /** Replies settle this long after the request starts. */
  latencyMs: number
}

function harness(startSec: number, initial: Partial<Upstream> = {}) {
  const clock = fakeClockAt(startSec)
  const up: Upstream = { period: { AAA: FRI, BBB: FRI }, fail: false, latencyMs: 0, ...initial }
  const fetchFn = vi.fn(async (url: string) => {
    const symbol = decodeURIComponent(url.split('/').pop()!.split('?')[0]!)
    if (up.latencyMs > 0) await new Promise((r) => setTimeout(r, up.latencyMs))
    if (up.fail) throw new Error('ENOTFOUND')
    return { ok: true, status: 200, json: async () => body(symbol, up.period[symbol]) }
  })
  const src = new StockSource(['AAA', 'BBB'], fetchFn as never, clock)
  /** Completed-or-started polls: one poll is one request per symbol. */
  const polls = () => fetchFn.mock.calls.filter((c) => String(c[0]).includes('range=1d')).length / 2
  return { src, up, fetchFn, polls }
}

/** Advances fake time to exactly `epochSeconds`, firing every timer on the way. */
async function advanceTo(epochSeconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(epochSeconds * 1000 - Date.now())
}

/**
 * Jumps the wall clock to a few seconds before `epochSeconds` without firing
 * timers on the way (a sleep), then lets the heartbeat catch up. Simulating
 * eight hours one heartbeat at a time is too slow for a unit test.
 */
async function jumpNear(epochSeconds: number): Promise<void> {
  vi.setSystemTime((epochSeconds - 5) * 1000)
  await vi.advanceTimersByTimeAsync(2000)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('market state is right at READ time, not only at fetch time', () => {
  // The known route: a 15-minute closed-market poll and a state stored at
  // fetch time showed PRE until about 9:45 AM. Break the fix (store the
  // state in doRefresh and return it here) and the 09:30:00 read says pre.
  it('flips pre -> open on the 9:30:00 second with no fetch in between', async () => {
    const { src, up } = harness(FRI_OPEN - 1800)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(src.getMarketState()).toBe('pre')
    up.fail = true // No later fetch can help: only the clock moves.
    await advanceTo(FRI_OPEN - 1)
    expect(src.getMarketState()).toBe('pre')
    await advanceTo(FRI_OPEN)
    expect(src.getMarketState()).toBe('open')
    await src.stop()
  })

  it('flips open -> post at 4:00 PM and post -> closed at 8:00 PM', async () => {
    const { src, up } = harness(FRI_CLOSE - 60)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    up.fail = true
    expect(src.getMarketState()).toBe('open')
    await advanceTo(FRI_CLOSE)
    expect(src.getMarketState()).toBe('post')
    await advanceTo(FRI_POST_END - 1)
    expect(src.getMarketState()).toBe('post')
    await advanceTo(FRI_POST_END)
    expect(src.getMarketState()).toBe('closed')
    await src.stop()
  })

  // Break the fix (restore the plain cadence timer) and the first poll
  // after 9:00 lands at 9:15 and the next at 9:30 only by luck of the
  // arithmetic; from 9:20 it lands at 9:35.
  it('polls within a second of the open and of the close, so prices refresh at the edge', async () => {
    const { src, polls } = harness(FRI_OPEN - 600) // 9:20
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    await advanceTo(FRI_OPEN - 1)
    const beforeOpen = polls()
    await advanceTo(FRI_OPEN + 1)
    expect(polls()).toBe(beforeOpen + 1)

    await src.stop()
    const late = harness(FRI_CLOSE - 30)
    late.src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    await advanceTo(FRI_CLOSE - 1)
    const beforeClose = late.polls()
    await advanceTo(FRI_CLOSE + 1)
    expect(late.polls()).toBe(beforeClose + 1)
    await late.src.stop()
  })

  it('emits change when the state crosses a boundary with no fetch', async () => {
    const { src, up } = harness(FRI_OPEN - 5)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    up.fail = true
    let changes = 0
    src.on('change', () => changes++)
    await advanceTo(FRI_OPEN + 1)
    expect(changes).toBeGreaterThanOrEqual(1)
    await src.stop()
  })
})

describe('other routes to a stale or wrong state', () => {
  // Route: sleep/wake across a boundary. A long setTimeout counts awake
  // time, so the poll armed before sleep fires late by the whole sleep.
  // `vi.setSystemTime` moves the wall clock WITHOUT firing timers, which is
  // exactly what a wake looks like. Break the fix (HEARTBEAT_MS = POLL
  // cadence) and no fetch happens within a second of waking.
  it('after sleeping from Friday evening into Monday 10 AM, reads unknown (not post or closed) and fetches within a second', async () => {
    const { src, polls } = harness(FRI_CLOSE + 3600) // Friday 5 PM, post
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(src.getMarketState()).toBe('post')
    const before = polls()
    vi.setSystemTime(MON_1000 * 1000) // The Mac wakes. No timer fired.
    expect(src.getMarketState()).toBe('unknown')
    await vi.advanceTimersByTimeAsync(1000)
    expect(polls()).toBe(before + 1)
    await src.stop()
  })

  // Route: weekend. Every reported window has ended. "closed" holds until
  // the first instant a session could start (04:00 ET), then decays to
  // unknown until a fetch confirms. The source polls AT that instant. What
  // Yahoo returns on a Saturday is not yet measured; this assumes the last
  // trading day's windows, which reads closed.
  it('reads closed overnight, polls at 4:00 AM Saturday, and stays closed when the upstream still reports Friday', async () => {
    const { src, polls } = harness(FRI_POST_END + 3600)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(src.getMarketState()).toBe('closed')
    expect(src.getNextBoundary()).toBeNull()
    await jumpNear(SAT_0400)
    await advanceTo(SAT_0400 - 1)
    const before = polls()
    expect(src.getMarketState()).toBe('closed')
    await advanceTo(SAT_0400 + 1)
    expect(polls()).toBe(before + 1)
    expect(src.getMarketState()).toBe('closed')
    // The 9:30 candidate is checked too, then closed holds again.
    await jumpNear(SAT_0930)
    await advanceTo(SAT_0930 + 1)
    expect(src.getMarketState()).toBe('closed')
    await src.stop()
  })

  // Route: a failed fetch at the boundary. Break the fix (treat exhausted
  // windows as closed forever) and this reads closed while pre-market may
  // be trading.
  it('reads unknown, not closed, when the fetch at the first possible session start fails, and retries within a minute', async () => {
    const { src, up, polls } = harness(FRI_POST_END + 3600)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    up.fail = true
    await jumpNear(SAT_0400)
    await advanceTo(SAT_0400 + 1)
    expect(src.getMarketState()).toBe('unknown')
    expect(src.getNextBoundary()).toBeNull()
    const afterFail = polls()
    await advanceTo(SAT_0400 + 62)
    expect(polls()).toBeGreaterThan(afterFail)
    up.fail = false
    await advanceTo(SAT_0400 + 130)
    expect(src.getMarketState()).toBe('closed')
    await src.stop()
  })

  // Route: the upstream rolls its windows to the new day a little after
  // the edge. When Yahoo rolls is not yet measured. The fetch at 4:00:00
  // still sees Thursday and reads closed; the grace window polls each
  // minute, so pre shows by 4:01, not 4:15. Break the fix (no grace) and
  // this still reads closed at 4:01:05.
  it('catches a late upstream roll within a minute of the 4:00 AM edge', async () => {
    const shift = (w: { start: number; end: number }) => ({ start: w.start - 86400, end: w.end - 86400 })
    const thu = { pre: shift(FRI.pre), regular: shift(FRI.regular), post: shift(FRI.post) }
    const { src, up } = harness(FRI_PRE - 10, { period: { AAA: thu, BBB: thu } })
    src.setVisible(true)
    await advanceTo(FRI_PRE + 1)
    expect(src.getMarketState()).toBe('closed')
    up.period = { AAA: FRI, BBB: FRI } // Yahoo rolls at 4:00:30.
    await advanceTo(FRI_PRE + 65)
    expect(src.getMarketState()).toBe('pre')
    await src.stop()
  })

  // Route: a fetch that starts before an edge and settles after it. Its
  // reply describes the old side of the edge. Break the fix (stamp the
  // measurement at completion) and this reads closed at 4:00:02.
  it('does not let a fetch that straddled the 4:00 AM edge prove the new side of it', async () => {
    const { src, up, polls } = harness(SAT_0400 - 2)
    up.latencyMs = 3000
    src.setVisible(true)
    await advanceTo(SAT_0400 + 2) // the reply lands at 04:00:01
    expect(src.getMarketState()).toBe('unknown')
    // And the edge is still owed its own fetch, started after it.
    expect(polls()).toBe(2)
    up.latencyMs = 0
    await advanceTo(SAT_0400 + 5)
    expect(src.getMarketState()).toBe('closed')
    await src.stop()
  })

  // Route: the upstream already reports the coming day's windows (a fetch
  // between midnight and 4 AM, or a holiday that reports the next session).
  it('reads closed before a reported pre window and flips to pre at 4:00 AM without a fetch', async () => {
    const { src, up } = harness(FRI_0100)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    up.fail = true
    expect(src.getMarketState()).toBe('closed')
    expect(src.getNextBoundary()).toEqual({ kind: 'pre-start', atMs: FRI_PRE * 1000, next: 'pre' })
    await advanceTo(FRI_PRE)
    expect(src.getMarketState()).toBe('pre')
    await src.stop()
  })

  // Route: an early-close day. The reported windows carry the 1:00 PM
  // close; nothing in the source assumes 4:00 PM.
  it('closes at 1:00 PM on an early-close day the upstream reports', async () => {
    const close = FRI_OPEN + 3.5 * 3600 // 13:00
    const early = {
      pre: FRI.pre,
      regular: { start: FRI_OPEN, end: close },
      post: { start: close, end: close + 4 * 3600 },
    }
    const { src, up } = harness(close - 60, { period: { AAA: early, BBB: early } })
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    up.fail = true
    expect(src.getNextBoundary()).toEqual({ kind: 'close', atMs: close * 1000, next: 'post' })
    await advanceTo(close)
    expect(src.getMarketState()).toBe('post')
    await src.stop()
  })

  // Route: a malformed period on the first symbol hid a good one on the
  // next. Break the fix (take the first non-null raw period) and the state
  // reads unknown.
  it('uses the first USABLE period, not the first present one', async () => {
    const { src } = harness(FRI_OPEN + 60, { period: { AAA: { regular: 'bogus' }, BBB: FRI } })
    await src.refresh()
    expect(src.getMarketState()).toBe('open')
  })

  // Route: a refresh that rejects before it records a poll would leave the
  // due time in the past, and the heartbeat would re-arm at zero delay and
  // spin. Break the fix (drop `lastPollAt` in refreshAndSchedule) and this
  // counts about thirty thousand calls.
  it('does not retry every second when refresh rejects', async () => {
    const { src } = harness(FRI_OPEN + 60)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    const spy = vi.spyOn(src, 'refresh').mockRejectedValue(new Error('boom'))
    // The open-market poll falls due at +60 s and rejects; the next is not
    // due until +120 s.
    await vi.advanceTimersByTimeAsync(90_000)
    expect(spy.mock.calls.length).toBe(1)
    spy.mockRestore()
    await src.stop()
  })
})

describe('getNextBoundary', () => {
  it('names the next reported edge in each state', async () => {
    const { src, up } = harness(FRI_PRE + 60)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    up.fail = true
    expect(src.getNextBoundary()).toEqual({ kind: 'open', atMs: FRI_OPEN * 1000, next: 'open' })
    await advanceTo(FRI_OPEN)
    expect(src.getNextBoundary()).toEqual({ kind: 'close', atMs: FRI_CLOSE * 1000, next: 'post' })
    await advanceTo(FRI_CLOSE)
    expect(src.getNextBoundary()).toEqual({ kind: 'post-end', atMs: FRI_POST_END * 1000, next: 'closed' })
    await advanceTo(FRI_POST_END)
    expect(src.getNextBoundary()).toBeNull()
    await src.stop()
  })

  it('is null before anything has been measured', () => {
    const src = new StockSource(['AAA'], (() => { throw new Error('no fetch') }) as never, () => FRI_OPEN)
    expect(src.getNextBoundary()).toBeNull()
    expect(nextBoundary(null, 0, FRI_OPEN)).toBeNull()
  })
})

describe('Eastern session candidates', () => {
  // Route: DST. 4:00 AM is 08:00Z in EDT and 09:00Z in EST. Break the fix
  // (a fixed -4h offset) and the Sunday after the switch comes out an hour
  // early.
  it('finds 4:00 AM local across the November DST switch', () => {
    const sat2000 = Date.UTC(2026, 10, 1, 0, 0) / 1000 // Sat Oct 31, 20:00 EDT
    expect(nextCandidateStart(sat2000)).toBe(Date.UTC(2026, 10, 1, 9, 0) / 1000) // Sun 04:00 EST
    expect(easternEpoch(2026, 7, 1, 9, 30)).toBe(Date.UTC(2026, 6, 1, 13, 30) / 1000)
    expect(easternEpoch(2026, 12, 1, 9, 30)).toBe(Date.UTC(2026, 11, 1, 14, 30) / 1000)
    expect(easternEpoch(2026, 3, 9, 4, 0)).toBe(Date.UTC(2026, 2, 9, 8, 0) / 1000) // Mon after spring-forward
  })

  it('keeps the I1 contract: no usable window is unknown, never closed', () => {
    expect(deriveSessionState(parsePeriod(null), FRI_OPEN, FRI_OPEN)).toBe('unknown')
    expect(deriveSessionState(parsePeriod({ regular: { start: 'x', end: 1 } }), FRI_OPEN, FRI_OPEN)).toBe('unknown')
    expect(deriveSessionState(parsePeriod({ regular: { start: 5, end: 1 } }), FRI_OPEN, FRI_OPEN)).toBe('unknown')
  })
})
