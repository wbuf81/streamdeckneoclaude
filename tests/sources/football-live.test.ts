import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  applyLiveFailure,
  applyLiveReading,
  classifyScore,
  detectScore,
  normalizeRef,
  parseLiveRefs,
  parsePlay,
  parseScore,
  parseSituation,
  parseStatus,
  toLiveGame,
  SCORE_FRESH_MS,
  type LiveEntry,
  type LiveReading,
  type PlaySnapshot,
} from '../../src/sources/football-live.js'
import {
  FootballSource,
  LIVE_LEAD_MS,
  LIVE_POLL_MS,
  LIVE_TAIL_MS,
  WINDOW_POLL_MS,
  liveWindowGame,
  nextKickoff,
  parseEvent,
  type Game,
} from '../../src/sources/football.js'
import type { TeamPair } from '../../src/config.js'
import { log } from '../../src/log.js'

/**
 * Every fixture under `tests/fixtures/football/` is a REAL response body,
 * captured from `sports.core.api.espn.com` on 2026-10-09 at 17:04 UTC, except
 * `reconstructed-in-status.json`, which says why it is not.
 *
 * - `final-*`: Tampa Bay at Dallas (event 401872980), final 24-16, played
 *   2026-10-08. Dallas is ESPN team 6 (home), Tampa Bay is 27 (away).
 * - `pre-*`: Philadelphia at Jacksonville (event 401872981), not yet played.
 * - `play-*`: three consecutive real plays from the 4th quarter of 401872980:
 *   an incompletion at 24-10, Dallas's touchdown to 24-16, and the kickoff.
 * - `live-status-soccer.json`: a real LIVE status from the same host (a 2.
 *   Bundesliga match). No football game was live at capture time; this file
 *   proves the host's live `state: 'in'` shape on a real payload.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/football/${name}`, import.meta.url), 'utf8'))
}
function obj(name: string): Record<string, unknown> {
  return fixture(name) as Record<string, unknown>
}

const DAL = '6'
const TB = '27'
const GAME_ID = '401872980'
const KICKOFF_MS = Date.parse('2026-10-09T00:15Z')
const PLAY_BEFORE_TD = '4018729803719'
const PLAY_TD = '4018729803742'
const PLAY_KICKOFF = '4018729803781'

/** A real score body, with its value set to `n`. The mid-game scores come from
 * the real plays' own `homeScore`/`awayScore`, because a score ref answers
 * only the CURRENT score and the game is over. */
function scoreBody(n: number): Record<string, unknown> {
  return { ...obj('final-score-home-6.json'), value: n, displayValue: String(n) }
}

function playRef(id: string): string {
  return `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${GAME_ID}/competitions/${GAME_ID}/plays/${id}?lang=en&region=us`
}

/** The real final situation, pointing at a chosen real play. */
function situationFor(playId: string, isRedZone: boolean): Record<string, unknown> {
  return { ...obj('final-situation.json'), lastPlay: { $ref: playRef(playId) }, isRedZone }
}

function playOf(id: string): PlaySnapshot {
  const p = parsePlay(fixture(`play-${id}.json`))
  if (!p) throw new Error(`fixture play ${id} did not parse`)
  return p
}

/** The real home and away scores right after a real play. */
function scoresAfter(id: string): { home: number; away: number } {
  const p = obj(`play-${id}.json`)
  return { home: p['homeScore'] as number, away: p['awayScore'] as number }
}

// ---------------------------------------------------------------------------
// Parsers, against real payloads
// ---------------------------------------------------------------------------

describe('parseStatus', () => {
  it('reads a real final status as post, with no clock or period', () => {
    expect(parseStatus(fixture('final-status.json'))).toEqual({
      state: 'post', name: 'STATUS_FINAL', detail: 'Final', period: null, clock: null, clockSeconds: null,
    })
  })

  it('reads a real scheduled status as pre, and drops its 0:00 placeholder clock', () => {
    const s = parseStatus(fixture('pre-status.json'))
    expect(s?.state).toBe('pre')
    expect(s?.detail).toBe('10/11 - 9:30 AM EDT')
    expect(s?.clock).toBeNull()
    expect(s?.period).toBeNull()
  })

  it('reads a real live status from the same host as in, with its clock and period', () => {
    const s = parseStatus(fixture('live-status-soccer.json'))
    expect(s?.state).toBe('in')
    expect(s?.period).toBe(1)
    expect(s?.clockSeconds).toBe(2100)
    expect(s?.clock).toBe("35'")
  })

  it('reads the football in-progress shape: quarter, clock, and short detail', () => {
    expect(parseStatus(fixture('reconstructed-in-status.json'))).toEqual({
      state: 'in', name: 'STATUS_IN_PROGRESS', detail: '5:35 - 4th', period: 4, clock: '5:35', clockSeconds: 335,
    })
  })

  it('reads a missing period or clock as unknown, never as 0', () => {
    const body = obj('reconstructed-in-status.json')
    delete body['period']
    delete body['clock']
    delete body['displayClock']
    const s = parseStatus(body)
    expect(s?.state).toBe('in')
    expect(s?.period).toBeNull()
    expect(s?.clockSeconds).toBeNull()
    expect(s?.clock).toBeNull()
  })

  it('rejects an unknown or missing state rather than reading it as not started', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { type: {} }, { type: { state: 'live' } }, { type: 'in' }]) {
      expect(parseStatus(bad)).toBeNull()
    }
  })
})

describe('parseScore', () => {
  it('reads the real score bodies', () => {
    expect(parseScore(fixture('final-score-home-6.json'))).toBe(16)
    expect(parseScore(fixture('final-score-away-27.json'))).toBe(24)
  })

  it('falls back to an all-digit displayValue', () => {
    expect(parseScore({ value: 'x', displayValue: '7' })).toBe(7)
  })

  it('reads a missing or malformed score as unknown, never as 0', () => {
    for (const bad of [null, {}, { value: null }, { value: -3 }, { value: 2.5 }, { value: Number.NaN }, { displayValue: '' }, { displayValue: '7a' }]) {
      expect(parseScore(bad)).toBeNull()
    }
  })
})

describe('parseLiveRefs', () => {
  it('reads the real event links for either side, upgraded to https', () => {
    const forDal = parseLiveRefs(fixture('final-event.json'), DAL)
    expect(forDal).toEqual({
      statusUrl: `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${GAME_ID}/competitions/${GAME_ID}/status?lang=en&region=us`,
      situationUrl: `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${GAME_ID}/competitions/${GAME_ID}/situation?lang=en&region=us`,
      myScoreUrl: `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${GAME_ID}/competitions/${GAME_ID}/competitors/6/score?lang=en&region=us`,
      opponentScoreUrl: `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${GAME_ID}/competitions/${GAME_ID}/competitors/27/score?lang=en&region=us`,
      opponentEspnId: TB,
    })
    expect(parseLiveRefs(fixture('final-event.json'), TB)?.opponentEspnId).toBe(DAL)
    expect(parseLiveRefs(fixture('pre-event.json'), '30')?.opponentEspnId).toBe('21')
  })

  it('returns null for a team the event does not name', () => {
    expect(parseLiveRefs(fixture('final-event.json'), '30')).toBeNull()
  })

  it('returns null when a status or score link is missing or points off ESPN', () => {
    const noStatus = obj('final-event.json')
    const comp = (noStatus['competitions'] as Record<string, unknown>[])[0]!
    delete comp['status']
    expect(parseLiveRefs(noStatus, DAL)).toBeNull()

    const foreign = obj('final-event.json')
    const c2 = (foreign['competitions'] as Record<string, unknown>[])[0]!
    const competitors = c2['competitors'] as Record<string, unknown>[]
    competitors[0]!['score'] = { $ref: 'https://evil.example.com/score' }
    expect(parseLiveRefs(foreign, DAL)).toBeNull()

    for (const bad of [null, {}, { competitions: 'x' }, { competitions: [{ competitors: [] }] }]) {
      expect(parseLiveRefs(bad, DAL)).toBeNull()
    }
  })

  it('normalizeRef refuses other hosts and other schemes', () => {
    expect(normalizeRef('http://sports.core.api.espn.com/a?b=1')).toBe('https://sports.core.api.espn.com/a?b=1')
    expect(normalizeRef('https://site.api.espn.com/a')).toBeNull()
    expect(normalizeRef('file:///etc/passwd')).toBeNull()
    expect(normalizeRef('not a url')).toBeNull()
    expect(normalizeRef(7)).toBeNull()
  })
})

describe('parseSituation and parsePlay', () => {
  it('reads the real final situation', () => {
    expect(parseSituation(fixture('final-situation.json'))).toEqual({
      lastPlayUrl: `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${GAME_ID}/competitions/${GAME_ID}/plays/4018729804255?lang=en&region=us`,
      redZone: false,
    })
  })

  it('reads the real empty pre-game situation as all unknown', () => {
    expect(parseSituation(fixture('pre-situation.json'))).toEqual({ lastPlayUrl: null, redZone: null })
  })

  it('reads down, distance, spot and possession from a real play', () => {
    expect(playOf(PLAY_BEFORE_TD)).toEqual({
      id: PLAY_BEFORE_TD,
      text: 'Dak Prescott Incomplete Pass, Intended For Jonathan Mingo',
      scoringPlay: false,
      typeText: 'Pass Incompletion',
      possessionEspnId: DAL,
      downDistance: '2nd & 10',
      fieldPosition: 'TB 18',
    })
  })

  it('reads a real touchdown as a scoring play with no down after it', () => {
    const td = playOf(PLAY_TD)
    expect(td.scoringPlay).toBe(true)
    expect(td.typeText).toBe('Passing Touchdown')
    expect(td.downDistance).toBeNull()
    expect(td.fieldPosition).toBeNull()
  })

  it('reads possession as the receiving team after a real kickoff', () => {
    expect(playOf(PLAY_KICKOFF).possessionEspnId).toBe(TB)
    expect(playOf(PLAY_KICKOFF).fieldPosition).toBe('TB 35')
  })

  it('reads the real final last play, which has no down and trims ESPN\'s trailing space', () => {
    expect(parsePlay(fixture('final-lastplay.json'))).toMatchObject({
      id: '4018729804255', text: 'End Game', scoringPlay: false, possessionEspnId: TB, downDistance: null,
    })
  })

  it('reads a play with no id as nothing', () => {
    expect(parsePlay({ shortText: 'x' })).toBeNull()
    expect(parsePlay(null)).toBeNull()
  })
})

describe('classifyScore', () => {
  it('uses the scoring play type, and the point rise when there is no scoring play', () => {
    expect(classifyScore(6, playOf(PLAY_TD))).toBe('touchdown')
    expect(classifyScore(7, null)).toBe('touchdown')
    expect(classifyScore(3, null)).toBe('field-goal')
    expect(classifyScore(1, null)).toBe('conversion')
    expect(classifyScore(2, null)).toBe('other')
    expect(classifyScore(2, { ...playOf(PLAY_TD), typeText: 'Safety' })).toBe('safety')
    // A non-scoring last play is not evidence of what scored.
    expect(classifyScore(2, { ...playOf(PLAY_KICKOFF), typeText: 'Safety' })).toBe('other')
  })
})

// ---------------------------------------------------------------------------
// Scoring detection, driven by the real plays of the real game
// ---------------------------------------------------------------------------

const T0 = KICKOFF_MS + 3 * 60 * 60 * 1000

/** A live reading for Dallas (home) right after the real play `playId`. */
function dalReading(playId: string, state: 'pre' | 'in' | 'post' = 'in'): LiveReading {
  const s = scoresAfter(playId)
  const statusFile = state === 'in' ? 'reconstructed-in-status.json' : state === 'pre' ? 'pre-status.json' : 'final-status.json'
  const status = parseStatus(fixture(statusFile))
  if (!status) throw new Error('status fixture did not parse')
  return {
    gameId: GAME_ID,
    kickoffEpochMs: KICKOFF_MS,
    myEspnId: DAL,
    opponentEspnId: TB,
    status,
    myScore: s.home,
    opponentScore: s.away,
    situation: parseSituation(situationFor(playId, false)),
    play: playOf(playId),
  }
}

/** Folds a sequence of readings, `stepMs` apart, and returns every entry. */
function run(readings: LiveReading[], stepMs = LIVE_POLL_MS, start = T0): LiveEntry[] {
  const out: LiveEntry[] = []
  let prev: LiveEntry | null = null
  readings.forEach((r, i) => {
    prev = applyLiveReading(prev, r, start + i * stepMs)
    out.push(prev)
  })
  return out
}

describe('scoring detection', () => {
  it('fires nothing on the first read of a game that is already scored', () => {
    const [first] = run([dalReading(PLAY_BEFORE_TD)])
    expect(first!.myScore).toBe(10)
    expect(first!.opponentScore).toBe(24)
    expect(first!.lastScore).toBeNull()
  })

  it('fires nothing on the first read when only ONE side has scored', () => {
    // The 24-10 case alone cannot prove this: both sides are above zero, so a
    // wrong 0-0 baseline would be hidden by the both-rose rule. Measured: that
    // break passed the 24-10 test.
    for (const [mine, opp] of [[7, 0], [0, 3], [16, 16]] as const) {
      const [first] = run([{ ...dalReading(PLAY_BEFORE_TD), myScore: mine, opponentScore: opp }])
      expect(first!.lastScore).toBeNull()
    }
  })

  it('fires exactly once for the real Dallas touchdown, across every later read', () => {
    const entries = run([
      dalReading(PLAY_BEFORE_TD),
      dalReading(PLAY_TD),
      dalReading(PLAY_KICKOFF),
      dalReading(PLAY_KICKOFF),
      dalReading(PLAY_KICKOFF),
    ])
    const ids = entries.map((e) => e.lastScore?.id ?? null)
    expect(ids).toEqual([null, `${GAME_ID}:1`, `${GAME_ID}:1`, `${GAME_ID}:1`, `${GAME_ID}:1`])
    expect(entries[1]!.lastScore).toEqual({
      id: `${GAME_ID}:1`, seq: 1, side: 'mine', points: 6, kind: 'touchdown',
      atMs: T0 + LIVE_POLL_MS, playId: PLAY_TD, myScore: 16, opponentScore: 24,
    })
    // The count of distinct ids is the count of celebrations a page would fire.
    expect(new Set(ids.filter((x) => x !== null)).size).toBe(1)
  })

  it('reports the same touchdown as the OPPONENT for Tampa Bay', () => {
    const asTb = (r: LiveReading): LiveReading => ({
      ...r, myEspnId: TB, opponentEspnId: DAL, myScore: r.opponentScore, opponentScore: r.myScore,
    })
    const entries = run([asTb(dalReading(PLAY_BEFORE_TD)), asTb(dalReading(PLAY_TD))])
    expect(entries[1]!.lastScore?.side).toBe('opponent')
    expect(entries[1]!.possession).toBe('opponent')
  })

  it('fires a second event, with a new id, for the next score', () => {
    const later = { ...dalReading(PLAY_KICKOFF), myScore: 19, play: null }
    const entries = run([dalReading(PLAY_BEFORE_TD), dalReading(PLAY_TD), later])
    expect(entries[2]!.lastScore).toMatchObject({ id: `${GAME_ID}:2`, seq: 2, points: 3, kind: 'field-goal', playId: null })
  })

  it('fires nothing for a change seen across a gap longer than SCORE_FRESH_MS', () => {
    const entries = run([dalReading(PLAY_BEFORE_TD), dalReading(PLAY_TD)], SCORE_FRESH_MS + 1)
    expect(entries[1]!.lastScore).toBeNull()
    expect(entries[1]!.myScore).toBe(16)
  })

  it('fires for a score on the opening drive after a fresh pre-game read', () => {
    const opening = { ...dalReading(PLAY_KICKOFF), myScore: 7, opponentScore: 0 }
    const entries = run([dalReading(PLAY_KICKOFF, 'pre'), opening], WINDOW_POLL_MS)
    expect(entries[0]!.myScore).toBeNull()
    expect(entries[1]!.lastScore).toMatchObject({ side: 'mine', points: 7, kind: 'touchdown' })
  })

  it('fires nothing for a correction downward, nor for restoring it, then fires for a new high', () => {
    const corrected = { ...dalReading(PLAY_BEFORE_TD), myScore: 7 }
    const restored = { ...dalReading(PLAY_BEFORE_TD), myScore: 10 }
    const rise = { ...dalReading(PLAY_BEFORE_TD), myScore: 13 }
    const entries = run([dalReading(PLAY_BEFORE_TD), corrected, restored, rise])
    expect(entries[1]!.lastScore).toBeNull()
    expect(entries[1]!.myScore).toBe(7)
    expect(entries[2]!.lastScore).toBeNull()
    expect(entries[3]!.lastScore).toMatchObject({ seq: 1, points: 3 })
  })

  it('fires nothing when both sides rose in one read', () => {
    expect(detectScore({ mine: 10, opponent: 24, atMs: T0 }, 16, 27, T0 + 1000)).toBeNull()
  })

  it('a new game starts with no baseline, even right after another game', () => {
    const other = { ...dalReading(PLAY_TD), gameId: '999' }
    const entries = run([dalReading(PLAY_BEFORE_TD), other])
    expect(entries[1]!.lastScore).toBeNull()
  })
})

describe('applyLiveReading: the live row', () => {
  it('carries quarter, clock, down, spot, possession and last play from real data', () => {
    const r = { ...dalReading(PLAY_BEFORE_TD), situation: parseSituation(situationFor(PLAY_BEFORE_TD, true)) }
    const g = toLiveGame(applyLiveReading(null, r, T0), T0)
    expect(g).toMatchObject({
      state: 'in', period: 4, clock: '5:35', clockSeconds: 335, detail: '5:35 - 4th',
      myScore: 10, opponentScore: 24, possession: 'mine', downDistance: '2nd & 10',
      fieldPosition: 'TB 18', redZone: true,
      lastPlay: 'Dak Prescott Incomplete Pass, Intended For Jonathan Mingo', stale: false,
    })
  })

  it('shows the final score and no in-game extras once the game is over', () => {
    const r = { ...dalReading(PLAY_KICKOFF, 'post'), myScore: 16, opponentScore: 24 }
    const g = toLiveGame(applyLiveReading(null, r, T0), T0)
    expect(g).toMatchObject({
      state: 'post', detail: 'Final', myScore: 16, opponentScore: 24, period: null, clock: null,
      possession: null, downDistance: null, lastPlay: null, redZone: null,
    })
  })

  it('a failed read keeps every value and marks it stale; age alone also marks it stale', () => {
    const good = applyLiveReading(null, dalReading(PLAY_BEFORE_TD), T0)
    const failed = toLiveGame(applyLiveFailure(good), T0)
    expect(failed.stale).toBe(true)
    expect(failed.myScore).toBe(10)
    expect(toLiveGame(good, T0 + 59_000).stale).toBe(false)
    expect(toLiveGame(good, T0 + 61_000).stale).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The live window and the countdown
// ---------------------------------------------------------------------------

function game(id: string, kickoffEpochMs: number | null, timeTbd = false): Game {
  return { id, opponent: 'X', opponentShort: 'X', isHome: true, kickoffEpochMs, timeTbd, result: null }
}

describe('liveWindowGame and nextKickoff', () => {
  const K = KICKOFF_MS
  it('opens a window shortly before a known kickoff and closes it after the tail', () => {
    const s = [game('a', K)]
    expect(liveWindowGame(s, K - LIVE_LEAD_MS - 1)).toBeNull()
    expect(liveWindowGame(s, K - LIVE_LEAD_MS)?.id).toBe('a')
    expect(liveWindowGame(s, K + LIVE_TAIL_MS)?.id).toBe('a')
    expect(liveWindowGame(s, K + LIVE_TAIL_MS + 1)).toBeNull()
    expect(liveWindowGame(s, K, new Set(['a']))).toBeNull()
  })

  it('opens no window for a TBD or unknown kickoff', () => {
    expect(liveWindowGame([game('a', K, true)], K)).toBeNull()
    expect(liveWindowGame([game('a', null)], K)).toBeNull()
  })

  it('nextKickoff returns the earliest kickoff strictly after now', () => {
    const s = [game('past', K - 1000), game('late', K + 2000), game('soon', K + 1000), game('none', null)]
    expect(nextKickoff(s, K)?.id).toBe('soon')
    expect(nextKickoff(s, K)?.kickoffEpochMs).toBe(K + 1000)
    expect(nextKickoff(s, K + 5000)).toBeNull()
    expect(nextKickoff([game('tbd', K + 1000, true)], K)?.timeTbd).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FootballSource: the live loop end to end, on a fake fetch serving fixtures
// ---------------------------------------------------------------------------

const TEAMS: TeamPair = [
  {
    id: 'cowboys', label: 'COWBOYS', short: 'DAL', league: 'nfl', espnId: DAL,
    fullName: 'Dallas Cowboys', logoUrl: 'https://a.espncdn.com/i/teamlogos/nfl/500/dal.png',
  },
  {
    id: 'gators', label: 'GATORS', short: 'UF', league: 'college-football', espnId: '57',
    fullName: 'Florida Gators', logoUrl: 'https://a.espncdn.com/i/teamlogos/ncaa/500/57.png',
  },
]

/** What the fake ESPN answers right now. Each live field is a JSON body, or
 * `'reject'` (network error), or a number (that HTTP status), or `'badjson'`. */
interface World {
  status: unknown
  home: unknown
  away: unknown
  situation: unknown
  calls: string[]
}

function respond(v: unknown) {
  if (v === 'reject') return Promise.reject(new Error('ECONNRESET'))
  if (typeof v === 'number') return Promise.resolve({ ok: false, status: v, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => {
      if (v === 'badjson') throw new SyntaxError('Unexpected token < in JSON')
      return v
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  })
}

function makeFetch(w: World) {
  return (url: string) => {
    w.calls.push(url)
    const path = new URL(url).pathname
    if (path.endsWith('/teams/6/events')) {
      return respond({ items: [{ $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${GAME_ID}?lang=en&region=us` }] })
    }
    if (path.endsWith('/teams/57/events')) return respond({ items: [] })
    if (path.endsWith('/record')) return respond(404)
    if (path.endsWith(`/events/${GAME_ID}`)) return respond(fixture('final-event.json'))
    if (path.endsWith('/status')) return respond(w.status)
    if (path.endsWith('/competitors/6/score')) return respond(w.home)
    if (path.endsWith('/competitors/27/score')) return respond(w.away)
    if (path.endsWith('/situation')) return respond(w.situation)
    const play = /\/plays\/(\d+)$/.exec(path)
    if (play) return respond(fixture(`play-${play[1]}.json`))
    return respond(404)
  }
}

/** The world right after a real play, live. */
function liveWorld(playId: string): Omit<World, 'calls'> {
  const s = scoresAfter(playId)
  return {
    status: fixture('reconstructed-in-status.json'),
    home: scoreBody(s.home),
    away: scoreBody(s.away),
    situation: situationFor(playId, false),
  }
}

function count(w: World, suffix: string): number {
  return w.calls.filter((u) => new URL(u).pathname.endsWith(suffix)).length
}

describe('FootballSource live loop', () => {
  let nowSec = Math.floor(T0 / 1000)
  let w: World
  let src: FootballSource

  beforeEach(() => {
    nowSec = Math.floor(T0 / 1000)
    w = { ...liveWorld(PLAY_BEFORE_TD), calls: [] }
    src = new FootballSource(TEAMS, makeFetch(w), () => nowSec)
  })

  afterEach(async () => {
    await src.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reads the live row for the team in a window, and nothing for the other team', async () => {
    await src.refresh()
    await src.pollLive()
    const g = src.getLive('cowboys')
    expect(g).toMatchObject({ gameId: GAME_ID, state: 'in', myScore: 10, opponentScore: 24, period: 4, clock: '5:35', possession: 'mine', downDistance: '2nd & 10', stale: false })
    expect(g?.lastScore).toBeNull()
    expect(src.getLive('gators')).toBeNull()
  })

  it('fires nothing on the first poll of a game one side leads', async () => {
    w.home = scoreBody(0)
    w.away = scoreBody(7)
    await src.refresh()
    await src.pollLive()
    expect(src.getLive('cowboys')).toMatchObject({ myScore: 0, opponentScore: 7, lastScore: null })
  })

  it('fires once per score through the real fetch path, and emits change', async () => {
    await src.refresh()
    await src.pollLive()
    const onChange = vi.fn()
    src.on('change', onChange)

    Object.assign(w, liveWorld(PLAY_TD))
    nowSec += 20
    await src.pollLive()
    const fired = src.getLive('cowboys')?.lastScore
    expect(fired).toMatchObject({ side: 'mine', points: 6, kind: 'touchdown', playId: PLAY_TD })
    expect(onChange).toHaveBeenCalled()

    Object.assign(w, liveWorld(PLAY_KICKOFF))
    for (let i = 0; i < 3; i++) {
      nowSec += 20
      await src.pollLive()
      expect(src.getLive('cowboys')?.lastScore?.id).toBe(fired?.id)
    }
    expect(src.getLive('cowboys')?.possession).toBe('opponent')
  })

  it('fetches an unchanged last play only once', async () => {
    await src.refresh()
    await src.pollLive()
    nowSec += 20
    await src.pollLive()
    expect(count(w, `/plays/${PLAY_BEFORE_TD}`)).toBe(1)
    expect(count(w, '/status')).toBe(2)
  })

  for (const [label, bad] of [
    ['a status with no known state', { type: {} }],
    ['a status that is not JSON', 'badjson'],
    ['a status request that rejects', 'reject'],
    ['a status HTTP 500', 500],
    ['a score with no value', 'score'],
  ] as const) {
    it(`survives ${label}: keeps the old row, marks it stale, and recovers`, async () => {
      await src.refresh()
      await src.pollLive()
      const scheduleBefore = src.getSchedule('cowboys')

      if (bad === 'score') w.home = { displayValue: '' }
      else w.status = bad
      nowSec += 20
      await expect(src.pollLive()).resolves.toBeUndefined()
      const g = src.getLive('cowboys')
      expect(g).toMatchObject({ myScore: 10, opponentScore: 24, clock: '5:35', stale: true })
      expect(src.getSchedule('cowboys')).toEqual(scheduleBefore)
      expect(src.getStatus()).toBe('ok')

      Object.assign(w, liveWorld(PLAY_BEFORE_TD))
      nowSec += 20
      await src.pollLive()
      expect(src.getLive('cowboys')?.stale).toBe(false)
    })
  }

  it('logs a repeating live failure once, and again after a recovery', async () => {
    const once = vi.spyOn(log, 'once')
    await src.refresh()
    await src.pollLive()
    w.status = 'reject'
    for (let i = 0; i < 3; i++) {
      nowSec += 20
      await src.pollLive()
    }
    const failedKeys = () => once.mock.calls.filter(([k]) => k === 'football-live-cowboys-failed').length
    // The logger suppresses repeats of one key. A stuck key would hide the
    // NEXT failure too, so the proof is that a good read clears it.
    const clear = vi.spyOn(log, 'clearOnce')
    Object.assign(w, liveWorld(PLAY_BEFORE_TD))
    nowSec += 20
    await src.pollLive()
    expect(failedKeys()).toBeGreaterThan(0)
    expect(clear.mock.calls.some(([k]) => k === 'football-live-cowboys-failed')).toBe(true)
  })

  it('reads a finished game once as final and stops polling it', async () => {
    w.status = fixture('final-status.json')
    w.home = fixture('final-score-home-6.json')
    w.away = fixture('final-score-away-27.json')
    await src.refresh()
    await src.pollLive()
    expect(src.getLive('cowboys')).toMatchObject({ state: 'post', detail: 'Final', myScore: 16, opponentScore: 24, stale: false })
    const before = count(w, '/status')
    nowSec += 120
    await src.pollLive()
    expect(count(w, '/status')).toBe(before)
  })

  it('drops the live row after the window closes', async () => {
    await src.refresh()
    await src.pollLive()
    nowSec = Math.floor((KICKOFF_MS + LIVE_TAIL_MS) / 1000) + 1
    expect(src.getLive('cowboys')).toBeNull()
  })

  it('makes no live request outside every window', async () => {
    nowSec = Math.floor((KICKOFF_MS - LIVE_LEAD_MS) / 1000) - 60
    await src.refresh()
    await src.pollLive()
    expect(count(w, '/status')).toBe(0)
    expect(src.getLive('cowboys')).toBeNull()
  })
})

describe('FootballSource live cadence', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function startAt(ms: number, w: World): Promise<FootballSource> {
    vi.useFakeTimers()
    vi.setSystemTime(ms)
    // The default clock reads Date.now, which fake timers control.
    const src = new FootballSource(TEAMS, makeFetch(w))
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    return src
  }

  it('polls every LIVE_POLL_MS while the game is confirmed live', async () => {
    const w: World = { ...liveWorld(PLAY_BEFORE_TD), calls: [] }
    const src = await startAt(T0, w)
    expect(count(w, '/status')).toBe(1)
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS)
    expect(count(w, '/status')).toBe(2)
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS)
    expect(count(w, '/status')).toBe(3)
    await src.stop()
  })

  it('never polls fast while the state is unknown: a failing status read waits WINDOW_POLL_MS', async () => {
    const w: World = { ...liveWorld(PLAY_BEFORE_TD), status: 'reject', calls: [] }
    const src = await startAt(T0, w)
    expect(count(w, '/status')).toBe(1)
    await vi.advanceTimersByTimeAsync(WINDOW_POLL_MS - 1)
    expect(count(w, '/status')).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(count(w, '/status')).toBe(2)
    await src.stop()
  })

  it('drops from the live cadence to the window cadence after a failure', async () => {
    const w: World = { ...liveWorld(PLAY_BEFORE_TD), calls: [] }
    const src = await startAt(T0, w)
    w.status = { type: { state: 'unheard-of' } }
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS)
    expect(count(w, '/status')).toBe(2)
    expect(src.getLive('cowboys')?.stale).toBe(true)
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3)
    expect(count(w, '/status')).toBe(2)
    await vi.advanceTimersByTimeAsync(WINDOW_POLL_MS - LIVE_POLL_MS * 3)
    expect(count(w, '/status')).toBe(3)
    await src.stop()
  })

  it('polls a scheduled game in its window at WINDOW_POLL_MS', async () => {
    const w: World = { ...liveWorld(PLAY_BEFORE_TD), status: fixture('pre-status.json'), calls: [] }
    const src = await startAt(KICKOFF_MS - 60_000, w)
    expect(count(w, '/status')).toBe(1)
    expect(count(w, '/score')).toBe(0)
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS)
    expect(count(w, '/status')).toBe(1)
    await vi.advanceTimersByTimeAsync(WINDOW_POLL_MS - LIVE_POLL_MS)
    expect(count(w, '/status')).toBe(2)
    await src.stop()
  })

  it('sleeps until the window opens, then reads', async () => {
    const w: World = { ...liveWorld(PLAY_BEFORE_TD), status: fixture('pre-status.json'), calls: [] }
    const opensAt = KICKOFF_MS - LIVE_LEAD_MS
    const src = await startAt(opensAt - 60 * 60 * 1000, w)
    expect(count(w, '/status')).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1)
    expect(count(w, '/status')).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(count(w, '/status')).toBe(1)
    await src.stop()
  })

  it('stops the live loop when the page is hidden', async () => {
    const w: World = { ...liveWorld(PLAY_BEFORE_TD), calls: [] }
    const src = await startAt(T0, w)
    src.setVisible(false)
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 5)
    expect(count(w, '/status')).toBe(1)
    await src.stop()
  })
})

describe('the live fixtures parse as the schedule expects', () => {
  it('the real final event is game 401872980 for Dallas, home, with its real kickoff', () => {
    const g = parseEvent(fixture('final-event.json'), DAL)
    expect(g).toMatchObject({ id: GAME_ID, isHome: true, kickoffEpochMs: KICKOFF_MS, timeTbd: false, result: 'loss' })
  })
})
