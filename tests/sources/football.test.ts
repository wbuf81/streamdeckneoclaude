import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  FootballSource,
  parseEvent,
  JAGUARS_TEAM_ID,
  GATORS_TEAM_ID,
  LOGO_URLS,
} from '../../src/sources/football.js'
import { log, setDefaultSink } from '../../src/log.js'

const NOW = 1_755_000_000 // 2025-08-12T12:00:00Z-ish, an arbitrary fixed clock

/**
 * Test quality: a source's fetch parameter must never fall back to the real
 * global `fetch` inside the suite — that is one edit away from live network
 * I/O. A test that genuinely never expects a call passes this instead of
 * `undefined`, so the constructor's own default parameter
 * (`fetch as unknown as FetchLike`) never kicks in.
 */
const neverFetch = (): Promise<never> => {
  throw new Error('test: fetch must not be called')
}

// ---------------------------------------------------------------------------
// Real captured payloads, measured live 2026-08-14 against TheSportsDB's
// free tier (public test key 3). See the task 40 report / VERIFIED-FACTS.md
// for the full measurement notes.
// ---------------------------------------------------------------------------

/** Jaguars' next game, `eventsnext.php?id=134928`, captured live. */
function jaguarsNextFixture() {
  return {
    events: [
      {
        idEvent: '2475347',
        strTimestamp: '2026-08-15T20:00:00',
        strEvent: 'New Orleans Saints vs Jacksonville Jaguars',
        strHomeTeam: 'New Orleans Saints',
        strAwayTeam: 'Jacksonville Jaguars',
        intHomeScore: null,
        intAwayScore: null,
        dateEvent: '2026-08-15',
        strTime: '20:00:00',
        idHomeTeam: '134944',
        idAwayTeam: JAGUARS_TEAM_ID,
        strVenue: 'Caesars Superdome',
        strCity: 'New Orleans, LA',
        strStatus: 'NS',
      },
    ],
  }
}

/** Florida's next game, `eventsnext.php?id=136887`, captured live. */
function floridaNextFixture() {
  return {
    events: [
      {
        idEvent: '2498650',
        strTimestamp: '2026-09-05T23:45:00',
        strEvent: 'Florida vs Florida Atlantic',
        strHomeTeam: 'Florida',
        strAwayTeam: 'Florida Atlantic',
        intHomeScore: null,
        intAwayScore: null,
        dateEvent: '2026-09-05',
        strTime: '23:45:00',
        idHomeTeam: GATORS_TEAM_ID,
        idAwayTeam: '136888',
        strVenue: 'Ben Hill Griffin Stadium',
        strCity: 'Gainesville, FL',
        strStatus: 'NS',
      },
    ],
  }
}

/** Jaguars' last finished game, `eventslast.php?id=134928`, captured live. */
function jaguarsLastFixture() {
  return {
    results: [
      {
        idEvent: '2400001',
        strEvent: 'Jacksonville Jaguars vs Buffalo Bills',
        strHomeTeam: 'Jacksonville Jaguars',
        strAwayTeam: 'Buffalo Bills',
        intHomeScore: '24',
        intAwayScore: '27',
        dateEvent: '2026-01-11',
        strTime: '18:00:00',
        idHomeTeam: JAGUARS_TEAM_ID,
        idAwayTeam: '134918',
        strVenue: 'EverBank Stadium',
        strCity: 'Jacksonville, FL',
        strStatus: 'FT',
      },
    ],
  }
}

/** The measured trap: id `134938` (not one of ours) returns a totally
 * different, unrelated matchup — used to prove the id cross-check. */
function wrongTeamFixture() {
  return {
    events: [
      {
        idEvent: '9999999',
        strHomeTeam: 'Chicago Bears',
        strAwayTeam: 'Cleveland Browns',
        idHomeTeam: '134924',
        idAwayTeam: '134921',
        dateEvent: '2026-08-15',
        strTime: '17:00:00',
        intHomeScore: null,
        intAwayScore: null,
      },
    ],
  }
}

function emptyEvents() {
  return { events: [] }
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) }
}

// ---------------------------------------------------------------------------
// parseEvent
// ---------------------------------------------------------------------------

describe('parseEvent', () => {
  it('parses the Jaguars next-game fixture: opponent, away side, unplayed', () => {
    const g = parseEvent(jaguarsNextFixture(), JAGUARS_TEAM_ID)!
    expect(g.opponent).toBe('New Orleans Saints')
    expect(g.isHome).toBe(false)
    expect(g.finished).toBe(false)
    expect(g.teamScore).toBeNull()
    expect(g.opponentScore).toBeNull()
    expect(g.venue).toBe('Caesars Superdome')
    expect(g.city).toBe('New Orleans, LA')
  })

  it('parses the kickoff as a UTC instant, not the raw local clock reading', () => {
    const g = parseEvent(jaguarsNextFixture(), JAGUARS_TEAM_ID)!
    // dateEvent 2026-08-15, strTime 20:00:00 -> that literal instant in UTC.
    expect(g.kickoffEpochMs).toBe(Date.UTC(2026, 7, 15, 20, 0, 0))
  })

  it('parses the Florida fixture: home side, opponent Florida Atlantic', () => {
    const g = parseEvent(floridaNextFixture(), GATORS_TEAM_ID)!
    expect(g.opponent).toBe('Florida Atlantic')
    expect(g.isHome).toBe(true)
    expect(g.venue).toBe('Ben Hill Griffin Stadium')
  })

  it('parses a finished game, assigning teamScore/opponentScore by home/away side', () => {
    // eventslast.php uses a `results` key in some responses; parseEvent reads
    // `events`, so this fixture is fed to it under that key to prove the
    // finished-game SHAPE (scores, status) rather than the wrapper key,
    // matching how FootballSource normalizes the body before calling this.
    const body = { events: jaguarsLastFixture().results }
    const g = parseEvent(body, JAGUARS_TEAM_ID)!
    expect(g.finished).toBe(true)
    expect(g.isHome).toBe(true)
    // Jaguars (home) scored 24, Bills (away) scored 27 -> a loss.
    expect(g.teamScore).toBe(24)
    expect(g.opponentScore).toBe(27)
  })

  it('never reports 0 for scores that are genuinely absent (numeric strings parsed, not coerced)', () => {
    const g = parseEvent(jaguarsNextFixture(), JAGUARS_TEAM_ID)!
    expect(g.teamScore).toBeNull()
    expect(g.opponentScore).toBeNull()
    expect(g.finished).toBe(false)
  })

  it('returns null for an empty events array', () => {
    expect(parseEvent(emptyEvents(), JAGUARS_TEAM_ID)).toBeNull()
  })

  it('returns null for a missing or malformed body', () => {
    expect(parseEvent({}, JAGUARS_TEAM_ID)).toBeNull()
    expect(parseEvent(null, JAGUARS_TEAM_ID)).toBeNull()
    expect(parseEvent({ events: 'not-an-array' }, JAGUARS_TEAM_ID)).toBeNull()
  })

  it('the measured trap: rejects an event that does not actually name the requested team id', () => {
    // Break the fix by deleting the `idHome !== teamId && idAway !== teamId`
    // guard in src/sources/football.ts and this test fails: it would
    // silently accept a Bears/Browns game under the Jaguars' id, exactly the
    // brief's own measured trap (id 134938).
    expect(parseEvent(wrongTeamFixture(), JAGUARS_TEAM_ID)).toBeNull()
  })

  it('renders kickoff as unknown (null), never a fabricated instant, when dateEvent or strTime is missing', () => {
    const noDate = parseEvent(
      { events: [{ ...jaguarsNextFixture().events[0], dateEvent: '' }] },
      JAGUARS_TEAM_ID,
    )!
    expect(noDate.kickoffEpochMs).toBeNull()

    const noTime = parseEvent(
      { events: [{ ...jaguarsNextFixture().events[0], strTime: '' }] },
      JAGUARS_TEAM_ID,
    )!
    expect(noTime.kickoffEpochMs).toBeNull()

    const malformed = parseEvent(
      { events: [{ ...jaguarsNextFixture().events[0], strTime: 'TBD' }] },
      JAGUARS_TEAM_ID,
    )!
    expect(malformed.kickoffEpochMs).toBeNull()
  })

  it('does not treat a literal 00:00:00 UTC kickoff as unknown — it is a real, measured value (an 8 PM Eastern game)', () => {
    // Measured live: Houston Texans @ LA Chargers, dateEvent 2026-08-14,
    // strTime 00:00:00, strStatus FT — a real, already-played game, not a
    // placeholder. This must resolve to a real epoch, not null.
    const g = parseEvent(
      { events: [{ ...jaguarsNextFixture().events[0], strTime: '00:00:00', dateEvent: '2026-08-14' }] },
      JAGUARS_TEAM_ID,
    )!
    expect(g.kickoffEpochMs).toBe(Date.UTC(2026, 7, 14, 0, 0, 0))
  })
})

// ---------------------------------------------------------------------------
// FootballSource
// ---------------------------------------------------------------------------

describe('FootballSource.refresh', () => {
  afterEach(() => {
    setDefaultSink(() => {})
  })

  it('fetches all four endpoints and populates every team/slot', async () => {
    const calls: string[] = []
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('eventsnext') && url.includes(JAGUARS_TEAM_ID)) return okJson(jaguarsNextFixture())
      if (url.includes('eventslast') && url.includes(JAGUARS_TEAM_ID)) return okJson({ events: jaguarsLastFixture().results })
      if (url.includes('eventsnext') && url.includes(GATORS_TEAM_ID)) return okJson(floridaNextFixture())
      if (url.includes('eventslast') && url.includes(GATORS_TEAM_ID)) return okJson(emptyEvents())
      throw new Error(`unexpected url ${url}`)
    })
    const src = new FootballSource(fetchFn as never, () => NOW)

    await src.refresh()

    expect(calls).toHaveLength(4)
    expect(src.getGame('jaguars', 'next')!.opponent).toBe('New Orleans Saints')
    expect(src.getGame('jaguars', 'last')!.opponent).toBe('Buffalo Bills')
    expect(src.getGame('gators', 'next')!.opponent).toBe('Florida Atlantic')
    expect(src.getGame('gators', 'last')).toBeNull()
    expect(src.getStatus()).toBe('ok')
    expect(src.getLastUpdatedAt()).toBe(NOW)
  })

  it('reports empty before any successful fetch, and getGame returns null for every slot', () => {
    const src = new FootballSource(neverFetch as never, () => NOW)
    expect(src.getStatus()).toBe('empty')
    expect(src.getGame('jaguars', 'next')).toBeNull()
    expect(src.getGame('gators', 'last')).toBeNull()
  })

  it('keeps the last known games and reports offline when every fetch fails, rather than blanking the tiles', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okJson(jaguarsNextFixture()))
      .mockResolvedValueOnce(okJson({ events: jaguarsLastFixture().results }))
      .mockResolvedValueOnce(okJson(floridaNextFixture()))
      .mockResolvedValueOnce(okJson(emptyEvents()))
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })
    const src = new FootballSource(fetchFn as never, () => NOW)

    await src.refresh()
    expect(src.getStatus()).toBe('ok')

    await src.refresh()
    expect(src.getStatus()).toBe('offline')
    // The stale Jaguars data survives the failed refresh.
    expect(src.getGame('jaguars', 'next')!.opponent).toBe('New Orleans Saints')
  })

  it('one bad endpoint does not blank the other three (partial failure)', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('eventsnext') && url.includes(JAGUARS_TEAM_ID)) {
        return { ok: false, status: 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
      }
      if (url.includes('eventslast') && url.includes(JAGUARS_TEAM_ID)) return okJson({ events: jaguarsLastFixture().results })
      if (url.includes('eventsnext') && url.includes(GATORS_TEAM_ID)) return okJson(floridaNextFixture())
      return okJson(emptyEvents())
    })
    const src = new FootballSource(fetchFn as never, () => NOW)
    await src.refresh()

    expect(src.getGame('jaguars', 'next')).toBeNull()
    expect(src.getGame('jaguars', 'last')!.opponent).toBe('Buffalo Bills')
    expect(src.getGame('gators', 'next')!.opponent).toBe('Florida Atlantic')
    expect(src.getStatus()).toBe('ok')
  })

  it('emits change only when the whole snapshot actually differs (lesson 7)', async () => {
    const fetchFn = vi.fn(async () => okJson(jaguarsNextFixture()))
    const src = new FootballSource(fetchFn as never, () => NOW)
    const changes: number[] = []
    src.on('change', () => changes.push(1))

    await src.refresh()
    expect(changes).toHaveLength(1)

    await src.refresh() // Identical body every call.
    expect(changes).toHaveLength(1) // No second emission.
  })

  it('never retries a 403 (docs/LESSONS.md #10) — a second refresh does not re-fetch the blocked URL', async () => {
    let jagNextCalls = 0
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('eventsnext') && url.includes(JAGUARS_TEAM_ID)) {
        jagNextCalls++
        return { ok: false, status: 403, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
      }
      return okJson(emptyEvents())
    })
    const src = new FootballSource(fetchFn as never, () => NOW)

    await src.refresh()
    await src.refresh()
    await src.refresh()

    // Break the fix (delete the `blockedUrls` check at the top of
    // `fetchGame`) and this climbs to 3 — one per refresh.
    expect(jagNextCalls).toBe(1)
  })

  it('returns a copy from getGame — mutating the result cannot corrupt the source\'s own cache', async () => {
    const fetchFn = vi.fn(async () => okJson(jaguarsNextFixture()))
    const src = new FootballSource(fetchFn as never, () => NOW)
    await src.refresh()

    const g = src.getGame('jaguars', 'next')!
    g.opponent = 'CORRUPTED'
    expect(src.getGame('jaguars', 'next')!.opponent).toBe('New Orleans Saints')
  })
})

describe('FootballSource.isStale', () => {
  it('is false before the first success', () => {
    const src = new FootballSource(neverFetch as never, () => NOW)
    expect(src.isStale()).toBe(false)
  })

  it('is false right after a fresh success', async () => {
    const fetchFn = vi.fn(async () => okJson(emptyEvents()))
    const src = new FootballSource(fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.isStale()).toBe(false)
  })

  it('is true once the last success is older than 24 hours', async () => {
    let clock = NOW
    const fetchFn = vi.fn(async () => okJson(emptyEvents()))
    const src = new FootballSource(fetchFn as never, () => clock)
    await src.refresh()
    clock = NOW + 24 * 60 * 60 + 1
    expect(src.isStale()).toBe(true)
  })
})

describe('FootballSource visibility and polling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes immediately on setVisible(true), and again after the 6-hour poll interval', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => okJson(emptyEvents()))
    const src = new FootballSource(fetchFn as never, () => NOW)

    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchFn).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(fetchFn).toHaveBeenCalledTimes(8)

    await src.stop()
  })

  it('does not poll while invisible', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => okJson(emptyEvents()))
    const src = new FootballSource(fetchFn as never, () => NOW)

    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    src.setVisible(false)
    const callsAtHidden = fetchFn.mock.calls.length

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(fetchFn.mock.calls.length).toBe(callsAtHidden)

    await src.stop()
  })

  it('does not arm a new timer if stop() runs while a refresh is still in flight (lesson 8)', async () => {
    vi.useFakeTimers()
    let resolveFetch!: (v: unknown) => void
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve
    })
    const fetchFn = vi.fn(() => fetchPromise)
    const src = new FootballSource(fetchFn as never, () => NOW)

    src.setVisible(true) // Starts a refresh; blocks on the unresolved fetch.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalled()

    await src.stop() // stop() runs while that refresh is still in flight.

    resolveFetch({ ok: true, status: 200, json: async () => emptyEvents(), arrayBuffer: async () => new ArrayBuffer(0) })
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('stopped is a one-way latch: setVisible(true) after stop() does not restart polling', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => okJson(emptyEvents()))
    const src = new FootballSource(fetchFn as never, () => NOW)

    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    await src.stop()
    const callsAfterStop = fetchFn.mock.calls.length

    src.setVisible(true) // Must be a no-op: the source is permanently stopped.
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchFn.mock.calls.length).toBe(callsAfterStop)
  })
})

describe('FootballSource.getLogo', () => {
  it('returns null and starts a load on first call, then the decoded image once it resolves', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe(LOGO_URLS.jaguars)
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => bytes }
    })
    const decoded = { width: 500, height: 500 } as never
    const loadImageFn = vi.fn(async () => decoded)
    const src = new FootballSource(fetchFn as never, () => NOW, loadImageFn)

    expect(src.getLogo('jaguars')).toBeNull()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(src.getLogo('jaguars')).toBe(decoded)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does not start a second load while the first is still pending (guarded by logoPending)', async () => {
    let resolveFetch!: (v: unknown) => void
    const fetchFn = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )
    const src = new FootballSource(fetchFn as never, () => NOW, (async () => ({ width: 1, height: 1 })) as never)

    src.getLogo('jaguars')
    src.getLogo('jaguars')
    src.getLogo('jaguars')
    await Promise.resolve()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    resolveFetch({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })
  })

  it('cools down after a failure instead of retrying on every call (lesson 10) — never a finally-cleared guard', async () => {
    let clock = NOW
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls++
      return { ok: false, status: 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
    })
    const src = new FootballSource(fetchFn as never, () => clock)

    src.getLogo('jaguars')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)

    // Immediately after the failure, a render-loop-style call must NOT
    // retry. Break the fix (clear `logoRetryAt` unconditionally in
    // `finally`, per docs/LESSONS.md #10) and this second call climbs to 2
    // right away, before any cooldown has elapsed.
    src.getLogo('jaguars')
    await Promise.resolve()
    expect(calls).toBe(1)

    // After the cooldown elapses, a retry is allowed again.
    clock = NOW + 5 * 60 + 1
    src.getLogo('jaguars')
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(2)
  })

  it('never retries a 403 on the logo CDN, even after the normal cooldown elapses', async () => {
    let clock = NOW
    let calls = 0
    const fetchFn = vi.fn(async () => {
      calls++
      return { ok: false, status: 403, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
    })
    const src = new FootballSource(fetchFn as never, () => clock)

    src.getLogo('jaguars')
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)

    clock = NOW + 60 * 60 // Far past any ordinary cooldown.
    src.getLogo('jaguars')
    await Promise.resolve()
    expect(calls).toBe(1)
  })
})

describe('team ids', () => {
  it('are the ones resolved and verified live via searchteams.php on 2026-08-14, not the widely-misreported ones', () => {
    expect(JAGUARS_TEAM_ID).toBe('134928')
    expect(GATORS_TEAM_ID).toBe('136887')
  })
})
