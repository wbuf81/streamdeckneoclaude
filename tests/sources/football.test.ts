import { describe, it, expect, vi, afterEach } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import {
  FootballSource,
  parseEvent,
  parseRecord,
  parseKickoffEpochMs,
  splitEventName,
  splitShortName,
  compositeLogo,
  JAGUARS_ESPN_ID,
  GATORS_ESPN_ID,
  LOGO_URLS,
  LOGO_ART_FRACTION,
} from '../../src/sources/football.js'
import { theme } from '../../src/render/theme.js'
import { log, setDefaultSink } from '../../src/log.js'

const NOW = 1_755_000_000 // 2025-08-12T12:00:00Z-ish, an arbitrary fixed clock

/**
 * Test quality: a source's fetch parameter must never fall back to the real
 * global `fetch` inside the suite — that is one edit away from live network
 * I/O. A test that genuinely never expects a call passes this instead of
 * `undefined`, so the constructor's own default parameter never kicks in.
 */
const neverFetch = (): Promise<never> => {
  throw new Error('test: fetch must not be called')
}

// ---------------------------------------------------------------------------
// Real captured payloads, measured live 2026-08-14 against
// sports.core.api.espn.com (the open ESPN core host). Trimmed to the fields
// this source reads; every value below is a REAL measurement, not invented
// — see docs/VERIFIED-FACTS.md's "Football" section for the full probe.
// ---------------------------------------------------------------------------

/** Jaguars away at New Orleans Saints. */
function jaguarsAwayFixture() {
  return {
    id: '401873281',
    date: '2026-08-15T20:00Z',
    name: 'Jacksonville Jaguars at New Orleans Saints',
    shortName: 'JAX @ NO',
    timeValid: true,
    competitions: [{ competitors: [{ id: '18', homeAway: 'home' }, { id: JAGUARS_ESPN_ID, homeAway: 'away' }] }],
  }
}

/** Carolina Panthers away at Jaguars (Jaguars home). */
function jaguarsHomeFixture() {
  return {
    id: '401873287',
    date: '2026-08-21T23:30Z',
    name: 'Carolina Panthers at Jacksonville Jaguars',
    shortName: 'CAR @ JAX',
    timeValid: true,
    competitions: [{ competitors: [{ id: JAGUARS_ESPN_ID, homeAway: 'home' }, { id: '29', homeAway: 'away' }] }],
  }
}

/** Washington at Jaguars, far out (Week 18) — `timeValid: false`, ESPN's
 * own TBD signal, measured live. */
function jaguarsTbdFixture() {
  return {
    id: '401873160',
    date: '2027-01-03T05:00Z',
    name: 'Washington Commanders at Jacksonville Jaguars',
    shortName: 'WSH @ JAX',
    timeValid: false,
    competitions: [{ competitors: [{ id: JAGUARS_ESPN_ID, homeAway: 'home' }, { id: '28', homeAway: 'away' }] }],
  }
}

/** Florida Atlantic away at the Gators (Gators home). */
function gatorsHomeFixture() {
  return {
    id: '401856637',
    date: '2026-09-05T23:45Z',
    name: 'Florida Atlantic Owls at Florida Gators',
    shortName: 'FAU @ FLA',
    timeValid: true,
    competitions: [{ competitors: [{ id: GATORS_ESPN_ID, homeAway: 'home' }, { id: '2226', homeAway: 'away' }] }],
  }
}

/** The Florida-Georgia game: `neutralSite`, and `shortName` uses "VS"
 * instead of "@" — but `name` still uses " at ", and the Gators (57) are
 * marked `away` for playoff-seeding purposes despite the fixed neutral
 * venue. Measured live. */
function gatorsNeutralFixture() {
  return {
    id: '401856734',
    date: '2026-10-31T19:30Z',
    name: 'Florida Gators at Georgia Bulldogs',
    shortName: 'FLA VS UGA',
    timeValid: true,
    competitions: [{ competitors: [{ id: '61', homeAway: 'home' }, { id: GATORS_ESPN_ID, homeAway: 'away' }] }],
  }
}

/** An event that does not actually name the requested team — the same
 * measured-trap shape the previous TheSportsDB version of this source
 * guarded against, reproduced here for the new host. */
function wrongTeamFixture() {
  return {
    id: '9999999',
    date: '2026-08-15T17:00Z',
    name: 'Chicago Bears at Cleveland Browns',
    shortName: 'CHI @ CLE',
    timeValid: true,
    competitions: [{ competitors: [{ id: '5', homeAway: 'home' }, { id: '8', homeAway: 'away' }] }],
  }
}

/** The Jaguars' real regular-season record fixture, captured live
 * 2026-08-14 (preseason: the regular season has not started, so every stat
 * is a real zero). */
function recordNotStartedFixture() {
  return {
    items: [
      {
        name: 'overall',
        stats: [
          { name: 'gamesPlayed', value: 0 },
          { name: 'losses', value: 0 },
          { name: 'ties', value: 0 },
          { name: 'wins', value: 0 },
        ],
      },
    ],
  }
}

/** The same real shape, with the numbers changed to a mid-season record —
 * proves the `started: true` branch, since the live probe itself could not
 * (the 2026 season has not started as of the measurement date). */
function recordStartedFixture() {
  return {
    items: [
      {
        name: 'overall',
        stats: [
          { name: 'gamesPlayed', value: 11 },
          { name: 'losses', value: 3 },
          { name: 'ties', value: 1 },
          { name: 'wins', value: 7 },
        ],
      },
    ],
  }
}

function eventsListFixture(refs: string[]) {
  return { items: refs.map((r) => ({ $ref: r })) }
}

function refUrl(league: string, id: string): string {
  return `http://sports.core.api.espn.com/v2/sports/football/leagues/${league}/events/${id}?lang=en&region=us`
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) }
}

function httpError(status: number) {
  return { ok: false, status, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
}

// ---------------------------------------------------------------------------
// parseKickoffEpochMs
// ---------------------------------------------------------------------------

describe('parseKickoffEpochMs', () => {
  it('parses a real ESPN date as a UTC instant', () => {
    expect(parseKickoffEpochMs('2026-08-15T20:00Z')).toBe(Date.UTC(2026, 7, 15, 20, 0))
  })

  it('returns null for a missing or malformed date, never a fabricated instant', () => {
    expect(parseKickoffEpochMs('')).toBeNull()
    expect(parseKickoffEpochMs('2026-08-15')).toBeNull()
    expect(parseKickoffEpochMs('TBD')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// splitEventName / splitShortName
// ---------------------------------------------------------------------------

describe('splitEventName', () => {
  it('splits "Away at Home", measured order on 32/32 real events', () => {
    expect(splitEventName('Jacksonville Jaguars at New Orleans Saints')).toEqual({
      away: 'Jacksonville Jaguars',
      home: 'New Orleans Saints',
    })
  })

  it('still uses " at " on a neutral-site game, even though shortName says VS', () => {
    expect(splitEventName('Florida Gators at Georgia Bulldogs')).toEqual({
      away: 'Florida Gators',
      home: 'Georgia Bulldogs',
    })
  })

  it('returns null with no separator, or more than one — never a guess', () => {
    expect(splitEventName('Jacksonville Jaguars vs New Orleans Saints')).toBeNull()
    expect(splitEventName('Team at at Other')).toBeNull()
  })
})

describe('splitShortName', () => {
  it('splits on "@" for a normal game', () => {
    expect(splitShortName('JAX @ NO')).toEqual({ away: 'JAX', home: 'NO' })
  })

  it('splits on "VS" for a neutral-site game', () => {
    expect(splitShortName('FLA VS UGA')).toEqual({ away: 'FLA', home: 'UGA' })
  })

  it('returns null for an unrecognized shape', () => {
    expect(splitShortName('JAX-NO')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseEvent
// ---------------------------------------------------------------------------

/**
 * Fixtures for the `winner` flag, built from the REAL payload shape probed live on
 * 2026-08-18. Each competitor carries `winner` inline beside `homeAway`, and
 * `score` is a `$ref` this parser deliberately does not follow:
 *
 *   { id: '18', homeAway: 'home', winner: false, score: { $ref: '...' } }
 *   { id: '30', homeAway: 'away', winner: true,  score: { $ref: '...' } }
 */
function decidedFixture(jaguarsWon: boolean) {
  return {
    id: '401873281',
    date: '2026-08-15T20:00Z',
    name: 'Jacksonville Jaguars at New Orleans Saints',
    shortName: 'JAX @ NO',
    timeValid: true,
    competitions: [
      {
        competitors: [
          { id: '18', homeAway: 'home', winner: !jaguarsWon, score: { $ref: 'http://example/score' } },
          { id: JAGUARS_ESPN_ID, homeAway: 'away', winner: jaguarsWon, score: { $ref: 'http://example/score' } },
        ],
      },
    ],
  }
}

describe('parseEvent: the result ESPN already sends inline', () => {
  it('reads a win for the team being asked about', () => {
    expect(parseEvent(decidedFixture(true), JAGUARS_ESPN_ID)!.result).toBe('win')
  })

  it('reads a loss from the OPPONENT being the winner, not from its own flag alone', () => {
    // My side's `winner: false` means nothing by itself — it is also false on an
    // undecided game. The loss is only knowable from the other competitor.
    expect(parseEvent(decidedFixture(false), JAGUARS_ESPN_ID)!.result).toBe('loss')
  })

  it('reads the same game from the OTHER team\'s point of view, inverted', () => {
    // The Saints (id 18) won the game the Jaguars lost.
    expect(parseEvent(decidedFixture(false), '18')!.result).toBe('win')
    expect(parseEvent(decidedFixture(true), '18')!.result).toBe('loss')
  })

  it('reports no result for an undecided game, where both flags are false', () => {
    const undecided = {
      ...decidedFixture(true),
      competitions: [
        {
          competitors: [
            { id: '18', homeAway: 'home', winner: false },
            { id: JAGUARS_ESPN_ID, homeAway: 'away', winner: false },
          ],
        },
      ],
    }
    expect(parseEvent(undecided, JAGUARS_ESPN_ID)!.result).toBeNull()
  })

  it('reports no result when the flags are missing entirely, as on an unplayed game', () => {
    // The existing fixtures carry no `winner` at all — the shape ESPN sends before
    // a game is played.
    expect(parseEvent(jaguarsAwayFixture(), JAGUARS_ESPN_ID)!.result).toBeNull()
    expect(parseEvent(jaguarsHomeFixture(), JAGUARS_ESPN_ID)!.result).toBeNull()
  })

  it('treats a non-boolean winner as no result rather than as truthy', () => {
    const hostile = {
      ...decidedFixture(true),
      competitions: [
        {
          competitors: [
            { id: '18', homeAway: 'home', winner: 'yes' },
            { id: JAGUARS_ESPN_ID, homeAway: 'away', winner: 'true' },
          ],
        },
      ],
    }
    expect(parseEvent(hostile, JAGUARS_ESPN_ID)!.result).toBeNull()
  })

  it('never follows the score $ref, so parsing costs no extra request', () => {
    // The scores are behind their own refs. This parser reads only what the event
    // payload already contains; fetching them is separate, deliberate work.
    const fixture = decidedFixture(true)
    const g = parseEvent(fixture, JAGUARS_ESPN_ID)!
    expect(g.result).toBe('win')
    expect(Object.keys(g)).not.toContain('score')
  })
})

describe('parseEvent', () => {
  it('parses an away game: opponent, home/away, kickoff, not TBD', () => {
    const g = parseEvent(jaguarsAwayFixture(), JAGUARS_ESPN_ID)!
    expect(g.id).toBe('401873281')
    expect(g.opponent).toBe('New Orleans Saints')
    expect(g.opponentShort).toBe('NO')
    expect(g.isHome).toBe(false)
    expect(g.kickoffEpochMs).toBe(Date.UTC(2026, 7, 15, 20, 0))
    expect(g.timeTbd).toBe(false)
  })

  it('parses a home game: opponent is the AWAY side of the pair', () => {
    const g = parseEvent(jaguarsHomeFixture(), JAGUARS_ESPN_ID)!
    expect(g.opponent).toBe('Carolina Panthers')
    expect(g.opponentShort).toBe('CAR')
    expect(g.isHome).toBe(true)
  })

  it('marks a game TBD when ESPN\'s own timeValid is false — a real, distinguishable signal this host has that TheSportsDB did not', () => {
    const g = parseEvent(jaguarsTbdFixture(), JAGUARS_ESPN_ID)!
    expect(g.timeTbd).toBe(true)
    // The date itself (the scheduled week) is still shown — only the exact
    // kickoff TIME is treated as unknown by the page, per the source's own
    // documented contract.
    expect(g.kickoffEpochMs).toBe(Date.UTC(2027, 0, 3, 5, 0))
  })

  it('parses a neutral-site game correctly: home/away from the competitors field, not from shortName order', () => {
    const g = parseEvent(gatorsNeutralFixture(), GATORS_ESPN_ID)!
    // Break the fix by reading `isHome` from shortName's "VS" order instead
    // of `competitors[].homeAway`, and this flips to true — Georgia (61) is
    // actually the nominal home team here.
    expect(g.isHome).toBe(false)
    expect(g.opponent).toBe('Georgia Bulldogs')
    expect(g.opponentShort).toBe('UGA')
  })

  it('the measured trap: returns null for an event that does not actually name the requested team', () => {
    expect(parseEvent(wrongTeamFixture(), JAGUARS_ESPN_ID)).toBeNull()
  })

  it('returns null for a missing or malformed body', () => {
    expect(parseEvent({}, JAGUARS_ESPN_ID)).toBeNull()
    expect(parseEvent(null, JAGUARS_ESPN_ID)).toBeNull()
    expect(parseEvent({ id: '1', competitions: 'nope' }, JAGUARS_ESPN_ID)).toBeNull()
  })

  it('opponent and opponentShort are empty (never guessed) when name/shortName do not match the expected shape', () => {
    const g = parseEvent({ ...jaguarsAwayFixture(), name: 'weird shape', shortName: 'also weird' }, JAGUARS_ESPN_ID)!
    expect(g.opponent).toBe('')
    expect(g.opponentShort).toBe('')
  })
})

// ---------------------------------------------------------------------------
// parseRecord
// ---------------------------------------------------------------------------

describe('parseRecord', () => {
  it('reports started: false for a real 0-0 preseason record — never treated as a played 0-0', () => {
    const r = parseRecord(recordNotStartedFixture())!
    expect(r.wins).toBe(0)
    expect(r.losses).toBe(0)
    expect(r.ties).toBe(0)
    expect(r.started).toBe(false)
  })

  it('reports a real mid-season record once gamesPlayed is nonzero', () => {
    const r = parseRecord(recordStartedFixture())!
    expect(r).toEqual({ wins: 7, losses: 3, ties: 1, started: true })
  })

  it('returns null for a missing or malformed body, never a fabricated record', () => {
    expect(parseRecord({})).toBeNull()
    expect(parseRecord({ items: [] })).toBeNull()
    expect(parseRecord({ items: [{ name: 'overall', stats: 'nope' }] })).toBeNull()
    expect(parseRecord({ items: [{ name: 'overall', stats: [{ name: 'wins', value: 1 }] }] })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FootballSource.refresh — schedules
// ---------------------------------------------------------------------------

describe('FootballSource.refresh', () => {
  afterEach(() => {
    setDefaultSink(() => {})
  })

  const jagListUrl = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/teams/30/events?limit=100'
  const gatListUrl =
    'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/teams/57/events?limit=100'
  const jagRecordUrl =
    'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/types/2/teams/30/record'
  const gatRecordUrl =
    'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/types/2/teams/57/record'

  const jagRef1 = refUrl('nfl', '401873281')
  const jagRef2 = refUrl('nfl', '401873287')
  const gatRef1 = refUrl('college-football', '401856637')

  it('fetches the events list, follows each ref, and fetches the record, for both teams', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === jagListUrl) return okJson(eventsListFixture([jagRef1, jagRef2]))
      if (url === gatListUrl) return okJson(eventsListFixture([gatRef1]))
      if (url === jagRef1) return okJson(jaguarsAwayFixture())
      if (url === jagRef2) return okJson(jaguarsHomeFixture())
      if (url === gatRef1) return okJson(gatorsHomeFixture())
      if (url === jagRecordUrl) return okJson(recordNotStartedFixture())
      if (url === gatRecordUrl) return okJson(recordNotStartedFixture())
      throw new Error(`unexpected url ${url}`)
    })
    const src = new FootballSource(fetchFn as never, () => NOW)

    await src.refresh()

    const jagSchedule = src.getSchedule('jaguars')
    expect(jagSchedule).toHaveLength(2)
    // Sorted ascending by kickoff: the Aug 15 game before the Aug 21 one.
    expect(jagSchedule[0]!.opponent).toBe('New Orleans Saints')
    expect(jagSchedule[1]!.opponent).toBe('Carolina Panthers')

    const gatSchedule = src.getSchedule('gators')
    expect(gatSchedule).toHaveLength(1)
    expect(gatSchedule[0]!.opponent).toBe('Florida Atlantic Owls')

    expect(src.getRecord('jaguars')!.started).toBe(false)
    expect(src.getStatus()).toBe('ok')
    expect(src.getLastUpdatedAt()).toBe(NOW)
  })

  it('reports empty before any successful fetch, with an empty schedule and no record', () => {
    const src = new FootballSource(neverFetch as never, () => NOW)
    expect(src.getStatus()).toBe('empty')
    expect(src.getSchedule('jaguars')).toEqual([])
    expect(src.getRecord('jaguars')).toBeNull()
  })

  it('keeps the last known schedule and reports offline when every fetch fails', async () => {
    let fail = false
    const fetchFn = vi.fn(async (url: string) => {
      if (fail) return httpError(500)
      if (url === jagListUrl) return okJson(eventsListFixture([jagRef1]))
      if (url === jagRef1) return okJson(jaguarsAwayFixture())
      if (url === jagRecordUrl) return okJson(recordNotStartedFixture())
      return okJson(eventsListFixture([]))
    })
    const src = new FootballSource(fetchFn as never, () => NOW)

    await src.refresh()
    expect(src.getStatus()).toBe('ok')

    fail = true
    await src.refresh()
    expect(src.getStatus()).toBe('offline')
    // The stale Jaguars schedule survives the failed refresh.
    expect(src.getSchedule('jaguars')).toHaveLength(1)
    expect(src.getSchedule('jaguars')[0]!.opponent).toBe('New Orleans Saints')
  })

  it('one bad event ref keeps the OTHER games in that team\'s schedule, and keeps the ref\'s own prior value on the next refresh', async () => {
    let ref2Fails = false
    const fetchFn = vi.fn(async (url: string) => {
      if (url === jagListUrl) return okJson(eventsListFixture([jagRef1, jagRef2]))
      if (url === jagRef1) return okJson(jaguarsAwayFixture())
      if (url === jagRef2) return ref2Fails ? httpError(500) : okJson(jaguarsHomeFixture())
      if (url === jagRecordUrl) return okJson(recordNotStartedFixture())
      return okJson(eventsListFixture([]))
    })
    const src = new FootballSource(fetchFn as never, () => NOW)

    await src.refresh()
    expect(src.getSchedule('jaguars')).toHaveLength(2)

    ref2Fails = true
    await src.refresh()
    // Break the fix (drop the `oldById` fallback in `refreshSchedule`) and
    // this drops to 1 — the failed ref silently vanishes from the schedule.
    const schedule = src.getSchedule('jaguars')
    expect(schedule).toHaveLength(2)
    expect(schedule.some((g) => g.opponent === 'Carolina Panthers')).toBe(true)
  })

  it('a failed events LIST for one team does not affect the other team or the records', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === jagListUrl) return httpError(500)
      if (url === gatListUrl) return okJson(eventsListFixture([gatRef1]))
      if (url === gatRef1) return okJson(gatorsHomeFixture())
      if (url === jagRecordUrl) return okJson(recordNotStartedFixture())
      if (url === gatRecordUrl) return okJson(recordStartedFixture())
      throw new Error(`unexpected ${url}`)
    })
    const src = new FootballSource(fetchFn as never, () => NOW)
    await src.refresh()

    expect(src.getSchedule('jaguars')).toEqual([])
    expect(src.getSchedule('gators')).toHaveLength(1)
    expect(src.getRecord('jaguars')!.started).toBe(false)
    expect(src.getRecord('gators')!.started).toBe(true)
    expect(src.getStatus()).toBe('ok')
  })

  it('emits change only when the whole snapshot actually differs (lesson 7)', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === jagListUrl) return okJson(eventsListFixture([jagRef1]))
      if (url === jagRef1) return okJson(jaguarsAwayFixture())
      if (url === jagRecordUrl) return okJson(recordNotStartedFixture())
      return okJson(eventsListFixture([]))
    })
    const src = new FootballSource(fetchFn as never, () => NOW)
    const changes: number[] = []
    src.on('change', () => changes.push(1))

    await src.refresh()
    expect(changes).toHaveLength(1)

    await src.refresh() // Identical bodies every call.
    expect(changes).toHaveLength(1)
  })

  it('never retries a 403 on the events list (docs/LESSONS.md #10)', async () => {
    let jagListCalls = 0
    const fetchFn = vi.fn(async (url: string) => {
      if (url === jagListUrl) {
        jagListCalls++
        return httpError(403)
      }
      return okJson(eventsListFixture([]))
    })
    const src = new FootballSource(fetchFn as never, () => NOW)

    await src.refresh()
    await src.refresh()
    await src.refresh()

    // Break the fix (delete the `blockedUrls` check at the top of
    // `refreshSchedule`) and this climbs to 3.
    expect(jagListCalls).toBe(1)
  })

  it('returns a copy from getSchedule — mutating the result cannot corrupt the source\'s own cache', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === jagListUrl) return okJson(eventsListFixture([jagRef1]))
      if (url === jagRef1) return okJson(jaguarsAwayFixture())
      if (url === jagRecordUrl) return okJson(recordNotStartedFixture())
      return okJson(eventsListFixture([]))
    })
    const src = new FootballSource(fetchFn as never, () => NOW)
    await src.refresh()

    const g = src.getSchedule('jaguars')[0]!
    g.opponent = 'CORRUPTED'
    expect(src.getSchedule('jaguars')[0]!.opponent).toBe('New Orleans Saints')
  })

  it('does not fire 32 requests from a single call site synchronously beyond the concurrency cap (bounded batch fetch)', async () => {
    // 20 NFL + 12 college refs, matching the real measured season sizes.
    const jagRefs = Array.from({ length: 20 }, (_, i) => refUrl('nfl', String(500000 + i)))
    const gatRefs = Array.from({ length: 12 }, (_, i) => refUrl('college-football', String(600000 + i)))
    let concurrent = 0
    let maxConcurrent = 0
    const fetchFn = vi.fn(async (url: string) => {
      if (url === jagListUrl) return okJson(eventsListFixture(jagRefs))
      if (url === gatListUrl) return okJson(eventsListFixture(gatRefs))
      if (url === jagRecordUrl || url === gatRecordUrl) return okJson(recordNotStartedFixture())
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await Promise.resolve()
      concurrent--
      // Every ref fails to parse (missing shape); that is fine, this test
      // only measures the fetch concurrency, not the parse outcome.
      return okJson({})
    })
    const src = new FootballSource(fetchFn as never, () => NOW)
    await src.refresh()

    // Break the fix (call Promise.all over every ref with no concurrency
    // cap) and this climbs toward 32 — the exact "32 requests" shape the
    // task brief said never to fire from one page action. Both teams
    // refresh in parallel, each capped at 6, so up to 12 is expected and
    // still nowhere near the 32-request burst this guards against.
    expect(maxConcurrent).toBeLessThanOrEqual(12)
    expect(maxConcurrent).toBeGreaterThan(1)
  })
})

describe('FootballSource.isStale', () => {
  it('is false before the first success', () => {
    const src = new FootballSource(neverFetch as never, () => NOW)
    expect(src.isStale()).toBe(false)
  })

  it('is true once the last success is older than 24 hours', async () => {
    let clock = NOW
    const fetchFn = vi.fn(async () => okJson(eventsListFixture([])))
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
    const fetchFn = vi.fn(async () => okJson(eventsListFixture([])))
    const src = new FootballSource(fetchFn as never, () => NOW)

    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    const firstBatch = fetchFn.mock.calls.length
    expect(firstBatch).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(fetchFn.mock.calls.length).toBe(firstBatch * 2)

    await src.stop()
  })

  it('does not poll while invisible', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => okJson(eventsListFixture([])))
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

    src.setVisible(true)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalled()

    await src.stop()

    resolveFetch(okJson(eventsListFixture([])))
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('stopped is a one-way latch: setVisible(true) after stop() does not restart polling', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => okJson(eventsListFixture([])))
    const src = new FootballSource(fetchFn as never, () => NOW)

    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    await src.stop()
    const callsAfterStop = fetchFn.mock.calls.length

    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchFn.mock.calls.length).toBe(callsAfterStop)
  })
})

// ---------------------------------------------------------------------------
// getLogo / compositeLogo
// ---------------------------------------------------------------------------

describe('FootballSource.getTeamColor (task 45)', () => {
  /** Fetches a real PNG crest through the real decode pipeline, then waits for it.
   * The composite path uses native codecs on libuv's thread pool, so this needs a
   * real macrotask tick rather than a few microtasks. */
  async function loadCrest(paint: (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void) {
    const raw = createCanvas(40, 40)
    paint(raw.getContext('2d'))
    const bytes = raw.toBuffer('image/png')
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }))
    const src = new FootballSource(fetchFn as never, () => NOW)
    src.getLogo('jaguars')
    await new Promise((resolve) => setTimeout(resolve, 50))
    return src
  }

  it('is null before the crest has loaded, and never starts work of its own', () => {
    const src = new FootballSource(neverFetch as never, () => NOW)
    expect(src.getTeamColor('jaguars')).toBeNull()
    expect(src.getTeamColor('gators')).toBeNull()
  })

  it('extracts the crest\'s accent colour once it has loaded', async () => {
    const src = await loadCrest((ctx) => {
      ctx.fillStyle = 'rgb(0, 103, 120)' // Jaguars teal
      ctx.fillRect(0, 0, 40, 40)
    })
    const colour = src.getTeamColor('jaguars')
    expect(colour).not.toBeNull()
    // Teal: blue and green lead, red trails.
    expect(colour![2]).toBeGreaterThan(colour![0]! + 40)
    expect(colour![1]).toBeGreaterThan(colour![0]! + 40)
  })

  it('finds a small vivid mark on a mostly transparent crest', async () => {
    // Most crests are largely transparent, so the accent has to survive being a
    // minority of the pixels. `dominantColor` skips anything under half opacity,
    // which is what makes that work.
    //
    // NOTE on a claim this test does NOT make: the source reads the RAW crest
    // rather than the composited one, whose bottom third is a flat fill of
    // `theme.bg`. That is the right choice — it does not depend on another
    // function's internals — but it is NOT load-bearing, and this suite should not
    // pretend to prove it. Breaking the code to read the composited image instead
    // leaves every assertion here passing, because `theme.bg` is `(10,10,12)`:
    // chroma 2, so the chroma filter discards that whole band anyway. An earlier
    // version of this test was named for that distinction and could not fail on it.
    const src = await loadCrest((ctx) => {
      ctx.clearRect(0, 0, 40, 40)
      ctx.fillStyle = 'rgb(220, 40, 30)'
      ctx.fillRect(4, 4, 10, 10)
    })
    const colour = src.getTeamColor('jaguars')
    expect(colour).not.toBeNull()
    expect(colour![0]).toBeGreaterThan(colour![1]! + 60)
  })

  it('is null for a greyscale crest, rather than inventing a hue', async () => {
    const src = await loadCrest((ctx) => {
      for (let i = 0; i < 5; i++) {
        const v = 40 + i * 40
        ctx.fillStyle = `rgb(${v}, ${v}, ${v})`
        ctx.fillRect(0, i * 8, 40, 8)
      }
    })
    expect(src.getTeamColor('jaguars')).toBeNull()
  })

  it('leaves the other team untouched', async () => {
    const src = await loadCrest((ctx) => {
      ctx.fillStyle = 'rgb(0, 103, 120)'
      ctx.fillRect(0, 0, 40, 40)
    })
    expect(src.getTeamColor('jaguars')).not.toBeNull()
    expect(src.getTeamColor('gators')).toBeNull()
  })
})

describe('FootballSource.getLogo', () => {
  it('returns null and starts a load on first call, then the composited image once it resolves', async () => {
    // A real, tiny, solid-colour PNG — generated locally, no network — so
    // the full real decode -> composite -> re-encode -> re-decode pipeline
    // runs for real rather than through a stub.
    const raw = createCanvas(40, 40)
    const rctx = raw.getContext('2d')
    rctx.fillStyle = 'rgb(200,120,10)'
    rctx.fillRect(0, 0, 40, 40)
    const bytes = raw.toBuffer('image/png')

    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe(LOGO_URLS.jaguars)
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
    })
    const src = new FootballSource(fetchFn as never, () => NOW)

    expect(src.getLogo('jaguars')).toBeNull()
    // The real decode/composite/re-encode/re-decode pipeline goes through
    // libuv's thread pool (native image codecs), not just microtasks, so
    // this needs a real macrotask tick rather than a handful of
    // `Promise.resolve()`s.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const logo = src.getLogo('jaguars')
    expect(logo).not.toBeNull()
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
    const src = new FootballSource(fetchFn as never, () => NOW)

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
      return httpError(500)
    })
    const src = new FootballSource(fetchFn as never, () => clock)

    src.getLogo('jaguars')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)

    src.getLogo('jaguars')
    await Promise.resolve()
    expect(calls).toBe(1)

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
      return httpError(403)
    })
    const src = new FootballSource(fetchFn as never, () => clock)

    src.getLogo('jaguars')
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)

    clock = NOW + 60 * 60
    src.getLogo('jaguars')
    await Promise.resolve()
    expect(calls).toBe(1)
  })
})

describe('compositeLogo', () => {
  it('reserves a plain background band at the bottom for the page\'s record text, leaving the top as real art', async () => {
    const raw = createCanvas(100, 100)
    const rctx = raw.getContext('2d')
    // Fill the WHOLE source image with a distinct, non-background colour so
    // any pixel of it that leaks into the reserved band is detectable.
    rctx.fillStyle = 'rgb(220,40,40)'
    rctx.fillRect(0, 0, 100, 100)
    const { loadImage } = await import('@napi-rs/canvas')
    const rawImage = await loadImage(raw.toBuffer('image/png'))

    const composited = await compositeLogo(rawImage)

    // Draw the composited result the SAME way render/canvas.ts's
    // `drawCroppedImage` does: full-bleed onto a 96x96 key.
    const key = createCanvas(96, 96)
    const kctx = key.getContext('2d')
    kctx.fillStyle = `rgb(${theme.bg[0]},${theme.bg[1]},${theme.bg[2]})`
    kctx.fillRect(0, 0, 96, 96)
    kctx.drawImage(composited, 0, 0, 96, 96)
    const data = kctx.getImageData(0, 0, 96, 96).data

    const bandTop = Math.round(96 * LOGO_ART_FRACTION)
    // A real reserved band, not a degenerate empty range — guards against a
    // vacuous pass if `LOGO_ART_FRACTION` were ever pushed to 1 or beyond.
    expect(bandTop).toBeLessThan(90)
    let checked = 0
    // Every pixel in the reserved band must be the plain key background —
    // break the fix (let the art scale to fit the FULL canvas height
    // instead of the reserved fraction) and this fails: the red fill bleeds
    // into rows the page expects to draw text over.
    for (let y = bandTop + 2; y < 96; y++) {
      for (let x = 0; x < 96; x += 8) {
        const i = (y * 96 + x) * 4
        checked++
        expect(data[i]).toBeLessThan(30)
        expect(data[i + 1]).toBeLessThan(30)
        expect(data[i + 2]).toBeLessThan(30)
      }
    }
    expect(checked).toBeGreaterThan(50)

    // And the top region actually shows the source art (probing a region,
    // not one pixel, per docs/LESSONS.md #22).
    let sawArt = false
    for (let y = 4; y < bandTop - 4; y += 4) {
      for (let x = 4; x < 92; x += 4) {
        const i = (y * 96 + x) * 4
        if (data[i]! > 150 && data[i + 1]! < 100) sawArt = true
      }
    }
    expect(sawArt).toBe(true)
  })
})

describe('team ids', () => {
  it('are the ESPN core-API ids measured live on 2026-08-14, not the old TheSportsDB ones', () => {
    expect(JAGUARS_ESPN_ID).toBe('30')
    expect(GATORS_ESPN_ID).toBe('57')
  })
})
