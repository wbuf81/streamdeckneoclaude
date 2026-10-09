import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  FootballPage,
  BANNER_MS,
  CELEBRATE_FRESH_MS,
  CELEBRATE_MS,
  NOTE_MS,
  SCOREBOARD_LEAD_MS,
  UNKNOWN,
  celebrationKind,
  formatCountdown,
  formatPeriod,
  formatScore,
  isScoreboard,
  parseFieldPosition,
  type FootballReader,
} from '../../src/pages/football-page.js'
import {
  applyLiveReading,
  parsePlay,
  parseScore,
  parseSituation,
  parseStatus,
  toLiveGame,
  type LiveEntry,
  type LiveReading,
  type LiveStatus,
} from '../../src/sources/football-live.js'
import { nextKickoff, parseEvent } from '../../src/sources/football.js'
import type { Game, LiveGame, ScoringEvent, Team } from '../../src/sources/football.js'
import { renderKey, renderStrip, KEY_SIZE, STRIP_WIDTH } from '../../src/render/canvas.js'
import { keyHash, stripHash } from '../../src/render/specs.js'
import type { DeckFrame, Rgb } from '../../src/render/specs.js'
import { theme } from '../../src/render/theme.js'

/**
 * The live scoreboard, driven through the source's REAL parsers and its real
 * scoring detection, fed with the real captured bodies in
 * `tests/fixtures/football/`: Tampa Bay at Dallas (event 401872980), from
 * Dallas's side. Two consecutive real plays: an incompletion at `TB 18` with
 * Dallas trailing 10-24, then Dallas's touchdown to 16-24.
 *
 * The `in` status is `reconstructed-in-status.json` — the one fixture that is
 * not a capture; its provenance note says why.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/football/${name}`, import.meta.url), 'utf8'))
}

const DAL = '6'
const TB = '27'
const GAME_ID = '401872980'
/** The real event body, parsed by the real schedule parser from Dallas's side. */
const DAL_GAME: Game = parseEvent(fixture('final-event.json'), DAL)!
const KICKOFF_MS = DAL_GAME.kickoffEpochMs!
/** A clock inside the 4th quarter of the real game. */
const T0 = KICKOFF_MS + 3 * 60 * 60 * 1000
const STATUS_IN: LiveStatus = parseStatus(fixture('reconstructed-in-status.json'))!
const PLAY_BEFORE = parsePlay(fixture('play-4018729803719.json'))!
const PLAY_TD = parsePlay(fixture('play-4018729803742.json'))!
const SITUATION = parseSituation(fixture('final-situation.json'))

function reading(over: Partial<LiveReading>): LiveReading {
  return {
    gameId: GAME_ID,
    kickoffEpochMs: KICKOFF_MS,
    myEspnId: DAL,
    opponentEspnId: TB,
    status: STATUS_IN,
    myScore: null,
    opponentScore: null,
    situation: SITUATION,
    play: null,
    ...over,
  }
}

/** Read 1: the incompletion, 10-24 (the play body's own real scores). */
function beforeTd(prev: LiveEntry | null, atMs: number): LiveEntry {
  const play = fixture('play-4018729803719.json') as { homeScore: number; awayScore: number }
  return applyLiveReading(prev, reading({ myScore: play.homeScore, opponentScore: play.awayScore, play: PLAY_BEFORE }), atMs)
}
/** Read 2: the touchdown, 16-24 (the real score bodies). */
function afterTd(prev: LiveEntry | null, atMs: number): LiveEntry {
  return applyLiveReading(
    prev,
    reading({
      myScore: parseScore(fixture('final-score-home-6.json')),
      opponentScore: parseScore(fixture('final-score-away-27.json')),
      play: PLAY_TD,
    }),
    atMs,
  )
}

const DAL_COLOR: Rgb = [250, 70, 22]
const OTHER_COLOR: Rgb = [0, 140, 160]
const TEAMS: readonly [Team, Team] = ['dal', 'other']

interface Harness {
  page: FootballPage
  set(team: Team, live: LiveGame | null): void
  schedules: Record<Team, Game[]>
}

function harness(opts: { stale?: boolean } = {}): Harness {
  const lives: Record<Team, LiveGame | null> = { dal: null, other: null }
  const schedules: Record<Team, Game[]> = {
    dal: [DAL_GAME],
    other: [
      { id: 'o1', opponent: 'Houston Texans', opponentShort: 'HOU', isHome: true, kickoffEpochMs: T0 + (2 * 24 + 3.5) * 3_600_000, timeTbd: false, result: null },
      { id: 'o2', opponent: 'Tennessee Titans', opponentShort: 'TEN', isHome: false, kickoffEpochMs: T0 + 9 * 24 * 3_600_000, timeTbd: false, result: null },
    ],
  }
  const reader: FootballReader = {
    getTeams: () => TEAMS,
    getLabel: (t) => (t === 'dal' ? 'COWBOYS' : 'OTHERS'),
    getShort: (t) => (t === 'dal' ? 'DAL' : 'OTH'),
    getSchedule: (t) => schedules[t] ?? [],
    getRecord: () => null,
    getStatus: () => 'ok',
    getLastUpdatedAt: () => Math.floor(T0 / 1000),
    isStale: () => opts.stale === true,
    getLogo: () => null,
    getTeamColor: (t) => (t === 'dal' ? DAL_COLOR : OTHER_COLOR),
    getLive: (t) => lives[t] ?? null,
    getNextKickoff: (t, nowMs) => nextKickoff(schedules[t] ?? [], nowMs),
    setVisible: () => {},
  }
  return { page: new FootballPage(reader), set: (t, l) => { lives[t] = l }, schedules }
}

function render(page: FootballPage, nowMs: number): DeckFrame {
  return page.render(Math.floor(nowMs / 1000), nowMs)
}

/** The live game after read 1 (no score seen yet) and after read 2 (the TD). */
function realSequence(): { before: LiveGame; after: LiveGame; event: ScoringEvent } {
  const e1 = beforeTd(null, T0)
  const e2 = afterTd(e1, T0 + 20_000)
  const after = toLiveGame(e2, T0 + 20_000)
  return { before: toLiveGame(e1, T0), after, event: after.lastScore! }
}

/** Mean colour of a rectangle of an RGBA key or strip buffer. */
function regionMean(buf: Buffer, x0: number, y0: number, x1: number, y1: number, width = KEY_SIZE): Rgb {
  let r = 0, g = 0, b = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * width + x) * 4
      r += buf[at]!; g += buf[at + 1]!; b += buf[at + 2]!; n++
    }
  }
  return [r / n, g / n, b / n]
}

/** How many pixels in a rectangle are near-white. */
function whiteCount(buf: Buffer, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * KEY_SIZE + x) * 4
      if (buf[at]! > 200 && buf[at + 1]! > 200 && buf[at + 2]! > 200) n++
    }
  }
  return n
}

// ---------------------------------------------------------------------------

describe('the real fixture sequence this suite relies on', () => {
  it('is what the source says it is: Dallas has the ball at TB 18, then scores a touchdown', () => {
    const { before, after, event } = realSequence()
    expect(before).toMatchObject({ myScore: 10, opponentScore: 24, possession: 'mine', fieldPosition: 'TB 18', downDistance: '2nd & 10', lastScore: null })
    expect(after.myScore).toBe(16)
    expect(event).toMatchObject({ side: 'mine', kind: 'touchdown', points: 6 })
    expect(DAL_GAME.opponentShort).toBe('TB')
  })
})

describe('helpers', () => {
  it('formats unknown scores as the placeholder, never 0', () => {
    expect(formatScore(null)).toBe(UNKNOWN)
    expect(formatScore(0)).toBe('0')
    expect(formatScore(Number.NaN)).toBe(UNKNOWN)
  })

  it('names periods, overtime and halftime', () => {
    expect(formatPeriod({ period: 3, detail: '2:58 - 3rd' })).toBe('Q3')
    expect(formatPeriod({ period: 5, detail: '' })).toBe('OT')
    expect(formatPeriod({ period: 6, detail: '' })).toBe('2OT')
    expect(formatPeriod({ period: 2, detail: 'Halftime' })).toBe('HALF')
    expect(formatPeriod({ period: null, detail: '' })).toBe(UNKNOWN)
  })

  it('counts down coarsely, rounding down, never negative', () => {
    expect(formatCountdown((2 * 24 + 3) * 3_600_000 + 59_000)).toBe('2d 3h')
    expect(formatCountdown(5 * 3_600_000 + 12 * 60_000)).toBe('5h 12m')
    expect(formatCountdown(12 * 60_000 + 59_999)).toBe('12m')
    expect(formatCountdown(30_000)).toBe('<1m')
    expect(formatCountdown(-5)).toBe('NOW')
  })

  it('places the ball from my goal line, using the opponent code to pick the half', () => {
    // The real spot, `TB 18`, is on Tampa Bay's side: 82 yards from Dallas's goal.
    expect(parseFieldPosition('TB 18', 'TB')).toBe(82)
    expect(parseFieldPosition('DAL 25', 'TB')).toBe(25)
    expect(parseFieldPosition('50', 'TB')).toBe(50)
  })

  it('omits the ball for anything it cannot place', () => {
    expect(parseFieldPosition(null, 'TB')).toBeNull()
    expect(parseFieldPosition('TB 18', '')).toBeNull()
    expect(parseFieldPosition('somewhere', 'TB')).toBeNull()
    expect(parseFieldPosition('TB 77', 'TB')).toBeNull()
  })

  it('celebrates only my touchdowns and field goals', () => {
    const e = realSequence().event
    expect(celebrationKind(e)).toBe('touchdown')
    expect(celebrationKind({ ...e, kind: 'field-goal' })).toBe('field-goal')
    expect(celebrationKind({ ...e, side: 'opponent' })).toBe('note')
    expect(celebrationKind({ ...e, kind: 'safety' })).toBe('note')
  })

  it('takes over a row in progress, final, or within the lead before kickoff', () => {
    const { before } = realSequence()
    expect(isScoreboard(before, T0)).toBe(true)
    expect(isScoreboard({ ...before, state: 'post' }, T0)).toBe(true)
    const pre = { ...before, state: 'pre' as const, kickoffEpochMs: T0 + SCOREBOARD_LEAD_MS - 1000 }
    expect(isScoreboard(pre, T0)).toBe(true)
    expect(isScoreboard({ ...pre, kickoffEpochMs: T0 + SCOREBOARD_LEAD_MS + 60_000 }, T0)).toBe(false)
    expect(isScoreboard(null, T0)).toBe(false)
  })
})

describe('the live row', () => {
  it('shows my score, the opponent, the clock and the field from the real reading', () => {
    const h = harness()
    h.set('dal', realSequence().before)
    const f = render(h.page, T0)
    expect(f.keys[0]!.lines).toEqual(['COWBOYS', '10', '● BALL'])
    expect(f.keys[1]!.lines).toEqual(['TB', '24', ''])
    expect(f.keys[2]!.lines).toEqual(['Q4', '5:35', '2nd & 10'])
    expect(f.keys[3]!.lines?.[0]).toBe('TB 18')
    expect(f.keys[3]!.range?.value).toBe(82)
  })

  it('draws the ball over its spot: the arrow sits on the right of the field for TB 18', () => {
    const h = harness()
    h.set('dal', realSequence().before)
    const px = renderKey(render(h.page, T0).keys[3]!)
    // The arrow is in the band just above the track (y 57..64). At 82 yards
    // its x is about 10 + 0.82 * 76 = 72; the left half must hold none of it.
    expect(whiteCount(px, 60, 55, 86, 66)).toBeGreaterThan(10)
    expect(whiteCount(px, 4, 55, 50, 66)).toBe(0)
  })

  it('omits the ball, but keeps the field, when the spot is unknown', () => {
    const h = harness()
    h.set('dal', { ...realSequence().before, fieldPosition: null })
    const key = render(h.page, T0).keys[3]!
    expect(key.range).toBeUndefined()
    expect(key.lines?.[0]).toBe(UNKNOWN)
    const px = renderKey(key)
    expect(whiteCount(px, 4, 50, 92, 66)).toBe(0)
    // The empty field still draws: its track is lighter than the background.
    const track = regionMean(px, 20, 67, 80, 73)
    expect(track[2]).toBeGreaterThan(theme.bg[2] + 20)
  })

  it('tints the field red in the red zone, and only there', () => {
    const h = harness()
    const live = realSequence().before
    h.set('dal', { ...live, redZone: true })
    const red = regionMean(renderKey(render(h.page, T0).keys[3]!), 10, 40, 90, 60)
    h.set('dal', { ...live, redZone: false })
    const plain = regionMean(renderKey(render(h.page, T0).keys[3]!), 10, 40, 90, 60)
    expect(red[0] - red[2]).toBeGreaterThan(30)
    expect(plain[0] - plain[2]).toBeLessThan(5)
  })

  it('renders every unknown as the placeholder, never as 0', () => {
    const h = harness()
    h.set('dal', {
      ...realSequence().before,
      myScore: null, opponentScore: null, period: null, clock: null, downDistance: null,
      fieldPosition: null, possession: null, lastPlay: null, redZone: null,
    })
    const f = render(h.page, T0)
    const text = f.keys.slice(0, 4).flatMap((k) => k.lines ?? [])
    expect(text).not.toContain('0')
    expect(f.keys[0]!.lines?.[1]).toBe(UNKNOWN)
    expect(f.keys[1]!.lines?.[1]).toBe(UNKNOWN)
    expect(f.keys[2]!.lines).toEqual([UNKNOWN, UNKNOWN, UNKNOWN])
    expect(f.strip.lines[0]).not.toMatch(/\b0\b/)
  })

  it('dims a stale reading, and only the live row', () => {
    const h = harness()
    h.set('dal', { ...realSequence().before, stale: true })
    const f = render(h.page, T0)
    for (let i = 0; i < 4; i++) expect(f.keys[i]!.dim).toBe(true)
    expect(f.keys[5]!.dim).toBeFalsy()
    expect(f.strip.dim).toBe(true)
  })

  it('writes the score line and the last play to the strip', () => {
    const h = harness()
    h.set('dal', realSequence().before)
    const f = render(h.page, T0)
    expect(f.strip.lines[0]).toBe('DAL 10 – 24 TB · Q4 5:35')
    expect(f.strip.lines[1]).toBe(PLAY_BEFORE.text!.slice(0, 29) + '…')
    expect(f.strip.tape).toBeUndefined()
  })

  it('keeps the schedule strip when no game is live', () => {
    const h = harness()
    const f = render(h.page, T0)
    expect(f.strip.lines[0]).not.toContain('–')
    expect(f.keys[0]!.lines?.[0]).toBe('COWBOYS')
  })

  it('shows FINAL and the result after the game', () => {
    const h = harness()
    h.set('dal', toLiveGame(applyLiveReading(null, reading({
      status: parseStatus(fixture('final-status.json'))!,
      myScore: parseScore(fixture('final-score-home-6.json')),
      opponentScore: parseScore(fixture('final-score-away-27.json')),
    }), T0), T0))
    const f = render(h.page, T0)
    expect(f.keys[0]!.lines?.[1]).toBe('16')
    expect(f.keys[1]!.lines?.[1]).toBe('24')
    expect(f.keys[2]!.lines).toEqual(['FINAL'])
    expect(f.keys[3]!.lines).toEqual(['LOSS'])
    expect(f.strip.lines[0]).toBe('FINAL · DAL 16 – 24 TB')
  })

  it('takes the row 15 minutes before kickoff, from the real pre status, and not earlier', () => {
    const h = harness()
    const pre = (kickoff: number): LiveGame =>
      toLiveGame(applyLiveReading(null, reading({ kickoffEpochMs: kickoff, status: parseStatus(fixture('pre-status.json'))! }), T0), T0)
    h.set('dal', pre(T0 + 12 * 60_000))
    let f = render(h.page, T0)
    expect(f.keys[2]!.lines?.slice(0, 2)).toEqual(['KICKOFF IN', '12m'])
    expect(f.keys[0]!.lines?.[1]).toBe(UNKNOWN)
    h.set('dal', pre(T0 + 40 * 60_000))
    f = render(h.page, T0)
    expect(f.keys[2]!.lines?.[0]).not.toBe('KICKOFF IN')
  })
})

describe('the other row while one game is live', () => {
  it('shows a kickoff countdown beside its schedule tiles', () => {
    const h = harness()
    h.set('dal', realSequence().before)
    const f = render(h.page, T0)
    expect(f.keys[5]!.lines?.[0]).toBe('vs HOU')
    expect(f.keys[6]!.lines?.slice(0, 2)).toEqual(['KICKOFF IN', '2d 3h'])
    expect(f.keys[7]!.lines?.[0]).toBe('@ TEN')
  })

  it('never counts down to a TBD time of day: it shows the date', () => {
    const h = harness()
    h.schedules.other = [{ ...h.schedules.other![0]!, timeTbd: true }]
    h.set('dal', realSequence().before)
    const lines = render(h.page, T0).keys[6]!.lines ?? []
    expect(lines).toContain('TIME TBA')
    expect(lines.join(' ')).not.toMatch(/\d+[dhm]\b/)
  })

  it('keeps its normal schedule when nothing is live', () => {
    const h = harness()
    const f = render(h.page, T0)
    expect(f.keys.flatMap((k) => k.lines ?? [])).not.toContain('KICKOFF IN')
  })
})

describe('scoring celebrations', () => {
  function scored(): { h: Harness; event: ScoringEvent; tdAt: number } {
    const { before, after, event } = realSequence()
    const h = harness()
    h.set('dal', before)
    render(h.page, T0)
    h.set('dal', after)
    return { h, event, tdAt: T0 + 20_000 }
  }

  it('fires a touchdown once: flood, confetti on the whole row, banner, flashing buttons', () => {
    const { h, tdAt } = scored()
    const f = render(h.page, tdAt)
    for (let i = 0; i < 4; i++) {
      expect(f.keys[i]!.effects?.map((e) => e.variant)).toEqual(['sweep', 'burst'])
    }
    expect(f.keys[4]!.effects).toBeUndefined()
    expect(f.strip.banner).toMatchObject({ text: 'TOUCHDOWN!', sub: PLAY_TD.text })
    const a = render(h.page, tdAt + 100).buttons
    const b = render(h.page, tdAt + 300).buttons
    expect(a).not.toEqual(b)
    expect(a).toContainEqual(DAL_COLOR)
  })

  it('floods the row with the team colour on the glass', () => {
    const { h, tdAt } = scored()
    render(h.page, tdAt)
    const px = renderKey(render(h.page, tdAt + 1200).keys[1]!)
    const bg = regionMean(px, 10, 4, 90, 20)
    // Orange-ish: red well above blue, and far brighter than the dark theme.
    expect(bg[0]).toBeGreaterThan(80)
    expect(bg[0] - bg[2]).toBeGreaterThan(50)
    // And the banner draws in the team's colour family.
    const strip = renderStrip(render(h.page, tdAt + 1200).strip)
    const m = regionMean(strip, 40, 10, 200, 30, STRIP_WIDTH)
    expect(m[0]).toBeGreaterThan(m[2] + 10)
  })

  it('does not fire again for the same score, on later renders or after leaving and coming back', () => {
    const { h, tdAt } = scored()
    render(h.page, tdAt)
    h.page.onLeave()
    h.page.onEnter()
    const later = tdAt + BANNER_MS + 1000
    const f = render(h.page, later)
    expect(f.strip.banner).toBeUndefined()
    // Had it re-fired on re-entry, the banner would be showing now.
    // A finished celebration costs nothing: two later frames hash the same.
    const g = render(h.page, later + 500)
    expect(f.keys.map(keyHash)).toEqual(g.keys.map(keyHash))
    expect(stripHash(f.strip)).toBe(stripHash(g.strip))
    expect(g.buttons).toEqual([DAL_COLOR, OTHER_COLOR])
  })

  it('never fires on the first sight of a game that has already scored', () => {
    const h = harness()
    h.set('dal', realSequence().after)
    const f = render(h.page, T0 + 20_000)
    expect(f.strip.banner).toBeUndefined()
    expect(f.keys.some((k) => k.effects)).toBe(false)
  })

  it('never fires for a score the source saw long ago, while the page was not looking', () => {
    const { h, tdAt } = scored()
    const f = render(h.page, tdAt + CELEBRATE_FRESH_MS + 1000)
    expect(f.strip.banner).toBeUndefined()
    expect(f.keys.some((k) => k.effects)).toBe(false)
  })

  it('a field goal: a small burst on my score only, and a FIELD GOAL banner', () => {
    const { before, after } = realSequence()
    const h = harness()
    h.set('dal', before)
    render(h.page, T0)
    h.set('dal', { ...after, lastScore: { ...after.lastScore!, kind: 'field-goal', points: 3 } })
    const f = render(h.page, T0 + 20_000)
    expect(f.keys[0]!.effects).toEqual([expect.objectContaining({ variant: 'burst', count: 14 })])
    expect(f.keys[1]!.effects).toBeUndefined()
    expect(f.strip.banner?.text).toBe('FIELD GOAL')
    expect(f.buttons).toEqual([DAL_COLOR, OTHER_COLOR])
  })

  it('an opponent score: no celebration, just a quiet strip note', () => {
    const { before, after } = realSequence()
    const h = harness()
    h.set('dal', before)
    render(h.page, T0)
    h.set('dal', { ...after, lastScore: { ...after.lastScore!, side: 'opponent' } })
    const f = render(h.page, T0 + 20_000)
    expect(f.keys.some((k) => k.effects)).toBe(false)
    expect(f.strip.banner).toBeUndefined()
    expect(f.strip.lines[1]).toBe('TB TD · 16-24')
    expect(render(h.page, T0 + 20_000 + NOTE_MS + 1).strip.lines[1]).not.toContain('TD ·')
  })

  it('ticks fast only while the celebration moves', () => {
    const { before, after } = realSequence()
    const h = harness()
    h.set('dal', before)
    render(h.page, T0)
    expect(h.page.tickMs).toBeUndefined()
    h.set('dal', after)
    const tdAt = T0 + 20_000
    render(h.page, tdAt)
    expect(h.page.tickMs).toBe(40)
    render(h.page, tdAt + CELEBRATE_MS + 10)
    expect(h.page.tickMs).toBeUndefined()
  })

  it('keeps an idle live frame byte-identical within a minute', () => {
    const h = harness()
    h.set('dal', realSequence().before)
    const a = render(h.page, T0)
    const b = render(h.page, T0 + 1000)
    expect(a.keys.map(keyHash)).toEqual(b.keys.map(keyHash))
    expect(stripHash(a.strip)).toBe(stripHash(b.strip))
  })
})
