import { describe, it, expect } from 'vitest'
import type { Image } from '@napi-rs/canvas'
import {
  FootballPage,
  formatShortDate,
  formatKickoff,
  formatRecord,
  scheduleWindow,
  recordWash,
  kickoffWarmth,
  warmthWash,
  resultWash,
} from '../../src/pages/football-page.js'
import { theme } from '../../src/render/theme.js'
import { renderKey, probe, KEY_SIZE } from '../../src/render/canvas.js'
import { keyHash } from '../../src/render/specs.js'
import type { KeySpec, Rgb } from '../../src/render/specs.js'
import type { FootballStatus, Game, Team, TeamRecord } from '../../src/sources/football.js'

const NOW_S = 1755000000 // arbitrary fixed clock, seconds
/** Stands in for a decoded crest. Spec-level only: it draws nothing, which is
 * fine for tests that read KeySpec fields rather than pixels. */
const FAKE_LOGO = { width: 200, height: 200 } as unknown as Image
const NOW_MS = NOW_S * 1000

function game(over: Partial<Game> = {}): Game {
  return {
    id: '401873281',
    opponent: 'New Orleans Saints',
    opponentShort: 'NO',
    isHome: false,
    kickoffEpochMs: NOW_MS + 3 * 24 * 60 * 60 * 1000, // 3 days out
    timeTbd: false,
    // Upcoming by default: no result yet.
    result: null,
    ...over,
  }
}

interface Fakes {
  schedules: Partial<Record<Team, Game[]>>
  records: Partial<Record<Team, TeamRecord | null>>
  status: FootballStatus
  stale: boolean
  lastUpdatedAt: number
  logos: Partial<Record<Team, Image | null>>
  teamColors: Partial<Record<Team, Rgb | null>>
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    schedules: {},
    records: {},
    status: 'ok',
    stale: false,
    lastUpdatedAt: NOW_S,
    logos: {},
    teamColors: {},
    ...over,
  }
  const calls: string[] = []
  const source = {
    getSchedule: (team: Team) => f.schedules[team] ?? [],
    getRecord: (team: Team) => f.records[team] ?? null,
    getStatus: () => f.status,
    getLastUpdatedAt: () => f.lastUpdatedAt,
    isStale: () => f.stale,
    getLogo: (team: Team) => f.logos[team] ?? null,
    getTeamColor: (team: Team) => {
      calls.push(`teamColor:${team}`)
      return f.teamColors[team] ?? null
    },
    setVisible: (v: boolean) => {
      calls.push(`visible:${v}`)
    },
  }
  return { page: new FootballPage(source as never), calls, f }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe('formatShortDate', () => {
  it('formats a UTC kickoff as its Eastern calendar date', () => {
    expect(formatShortDate(Date.UTC(2026, 7, 15, 20, 0, 0))).toBe('AUG 15')
  })

  it('rolls back to the PREVIOUS Eastern day for a late UTC kickoff', () => {
    expect(formatShortDate(Date.UTC(2026, 8, 19, 2, 30, 0))).toBe('SEP 18')
  })

  it('is -- when the kickoff instant is unknown', () => {
    expect(formatShortDate(null)).toBe('--')
  })
})

describe('formatKickoff', () => {
  it('renders a known, non-TBD kickoff through the shared Eastern time formatter', () => {
    expect(formatKickoff({ kickoffEpochMs: Date.UTC(2026, 7, 15, 20, 0, 0), timeTbd: false })).toBe('4:00 PM EDT')
  })

  it('renders TBA when the kickoff instant itself is unknown', () => {
    expect(formatKickoff({ kickoffEpochMs: null, timeTbd: false })).toBe('TBA')
  })

  it('renders TBA when ESPN marks the game timeTbd, even though a placeholder instant exists', () => {
    // Break the fix (drop the `game.timeTbd` check) and this fails: a real,
    // still-unannounced kickoff would show a confident, likely-wrong time.
    expect(formatKickoff({ kickoffEpochMs: Date.UTC(2027, 0, 3, 5, 0, 0), timeTbd: true })).toBe('TBA')
  })
})

describe('formatRecord', () => {
  it('formats a real record', () => {
    expect(formatRecord({ wins: 8, losses: 3, ties: 0, started: true })).toBe('8-3')
  })

  it('appends a tie only when there is one', () => {
    expect(formatRecord({ wins: 7, losses: 3, ties: 1, started: true })).toBe('7-3-1')
  })

  it('is -- for a real record where gamesPlayed is 0 — never a fabricated 0-0 (lesson 18)', () => {
    // Break the fix (drop the `started` check) and this fails: an unstarted
    // season's real 0-0 would render as if the team had actually gone 0-0.
    expect(formatRecord({ wins: 0, losses: 0, ties: 0, started: false })).toBe('--')
  })

  it('is -- when the record itself is unknown', () => {
    expect(formatRecord(null)).toBe('--')
  })
})

describe('scheduleWindow', () => {
  function games(n: number, base = 0): Game[] {
    return Array.from({ length: n }, (_, i) =>
      game({ id: String(i), kickoffEpochMs: base + i * 86400000, opponent: `Opponent ${i}` }),
    )
  }

  it('returns the whole schedule unchanged when it already fits', () => {
    const g = games(5)
    expect(scheduleWindow(g, NOW_MS, 7)).toEqual(g)
  })

  it('shows the next N games when there are more upcoming games than fit', () => {
    const g = games(10, NOW_MS - 86400000) // game 0 is already 1 day past
    const w = scheduleWindow(g, NOW_MS, 7)
    expect(w).toHaveLength(7)
    // Game 0 already happened; the window starts from game 1 (the first
    // still-upcoming one).
    expect(w[0]!.opponent).toBe('Opponent 1')
  })

  it('backfills with the most recent past games once fewer than a full window remain upcoming', () => {
    // 10 games, all but the last 2 already in the past.
    const g = games(10, NOW_MS - 8 * 86400000)
    const w = scheduleWindow(g, NOW_MS, 7)
    expect(w).toHaveLength(7)
    // Break the fix (clamp `start` to `idx` with no backfill) and this
    // shrinks to 2 — the window would show only the 2 upcoming games
    // instead of filling all 7 slots.
    expect(w[w.length - 1]!.opponent).toBe('Opponent 9')
  })
})

// ---------------------------------------------------------------------------
// Grid layout
// ---------------------------------------------------------------------------

describe('FootballPage grid layout', () => {
  function threeUpcoming(prefix: string): Game[] {
    return [
      game({ id: `${prefix}1`, opponent: `${prefix} Opp 1`, kickoffEpochMs: NOW_MS + 1 * 86400000 }),
      game({ id: `${prefix}2`, opponent: `${prefix} Opp 2`, kickoffEpochMs: NOW_MS + 8 * 86400000 }),
      game({ id: `${prefix}3`, opponent: `${prefix} Opp 3`, kickoffEpochMs: NOW_MS + 15 * 86400000 }),
    ]
  }

  it('returns 8 keys: gators logo, 3 gators games, jaguars logo, 3 jaguars games', () => {
    const { page } = build({
      schedules: { gators: threeUpcoming('UF'), jaguars: threeUpcoming('JAX') },
      records: { gators: { wins: 8, losses: 3, ties: 0, started: true } },
    })
    const keys = page.render(NOW_S).keys
    expect(keys).toHaveLength(8)
    // Logo not loaded yet -> text fallback shows the team name AND record.
    expect(keys[0]!.lines).toEqual(['GATORS', '8-3'])
    expect(keys[1]!.lines![1]).toBe('UF Opp 1')
    expect(keys[2]!.lines![1]).toBe('UF Opp 2')
    expect(keys[3]!.lines![1]).toBe('UF Opp 3')
    expect(keys[5]!.lines![1]).toBe('JAX Opp 1')
    expect(keys[6]!.lines![1]).toBe('JAX Opp 2')
    expect(keys[7]!.lines![1]).toBe('JAX Opp 3')
  })

  it('shows a dashed placeholder, dimmed, when a team has fewer than three upcoming games', () => {
    const { page } = build({ schedules: { gators: [threeUpcoming('UF')[0]!] } })
    const keys = page.render(NOW_S).keys
    expect(keys[1]!.lines![1]).toBe('UF Opp 1')
    expect(keys[2]!.lines).toEqual(['--', '--', '--'])
    expect(keys[2]!.dim).toBe(true)
    expect(keys[3]!.dim).toBe(true)
  })

  it('excludes games already in the past from the next-three selection', () => {
    const { page } = build({
      schedules: {
        gators: [
          game({ id: 'past', opponent: 'Already Played', kickoffEpochMs: NOW_MS - 86400000 }),
          ...threeUpcoming('UF'),
        ],
      },
    })
    const keys = page.render(NOW_S).keys
    expect(keys[1]!.lines![1]).toBe('UF Opp 1')
    expect(keys.slice(1, 4).some((k) => k.lines?.[1] === 'Already Played')).toBe(false)
  })

  it('keeps a game IN PROGRESS on the grid, hot, rather than replacing it with dashes', () => {
    // Before task 45 a game vanished the instant kickoff passed, leaving dashed
    // placeholders at exactly the moment it was the most interesting thing on the
    // deck — and making `kickoffWarmth`'s post-kickoff branch unreachable from the
    // grid. Found by rendering the kickoff-passed case and looking at it.
    const { page } = build({
      teamColors: { gators: [250, 70, 22] },
      schedules: {
        gators: [
          game({ id: 'live', opponent: 'Kicked Off An Hour Ago', kickoffEpochMs: NOW_MS - 60 * 60 * 1000 }),
          ...threeUpcoming('UF'),
        ],
      },
    })
    const keys = page.render(NOW_S).keys
    expect(keys[1]!.lines![1]).toBe('Kicked Off An Hour Ago')
    // And it is the hottest tile on the row, since warmth holds through the game.
    expect(keys[1]!.bg).toBeDefined()
  })

  it('still drops a game once its game window has passed', () => {
    // The window is a few hours, not indefinite: a game from this morning must not
    // still be sitting on the grid tonight.
    const { page } = build({
      schedules: {
        gators: [
          game({ id: 'old', opponent: 'Long Finished', kickoffEpochMs: NOW_MS - 9 * 60 * 60 * 1000 }),
          ...threeUpcoming('UF'),
        ],
      },
    })
    const keys = page.render(NOW_S).keys
    expect(keys.slice(1, 4).some((k) => k.lines?.[1] === 'Long Finished')).toBe(false)
  })

  it('shows the team name and record as a text fallback on the logo tile while the image has not loaded', () => {
    const { page } = build({ records: { jaguars: { wins: 5, losses: 6, ties: 0, started: true } } })
    const keys = page.render(NOW_S).keys
    expect(keys[0]!.kind).toBe('control')
    expect(keys[0]!.lines).toEqual(['GATORS', '--'])
    expect(keys[4]!.kind).toBe('control')
    expect(keys[4]!.lines).toEqual(['JAGUARS', '5-6'])
  })

  it('draws the decoded/composited logo as an image tile, with the record as a text line over it, once loaded', () => {
    const fakeImage = { width: 200, height: 200 } as unknown as Image
    const { page } = build({
      logos: { jaguars: fakeImage },
      records: { jaguars: { wins: 8, losses: 3, ties: 0, started: true } },
    })
    const key = page.render(NOW_S).keys[4]!
    expect(key.kind).toBe('image')
    expect(key.image).toBe(fakeImage)
    expect(key.imageKey).toBe('jaguars')
    expect(key.lines).toEqual(['8-3'])
  })

  it('never shows a fabricated 0-0 on the logo tile for a season that has not started', () => {
    const { page } = build({ records: { jaguars: { wins: 0, losses: 0, ties: 0, started: false } } })
    const keys = page.render(NOW_S).keys
    expect(keys[4]!.lines).toEqual(['JAGUARS', '--'])
  })

  it('dims every tile when the schedule has gone stale', () => {
    const { page } = build({ stale: true, schedules: { jaguars: threeUpcoming('JAX') } })
    const keys = page.render(NOW_S).keys
    expect(keys[5]!.dim).toBe(true)
    expect(keys[4]!.dim).toBe(true)
  })

  it('dims every tile when the status is not ok, even if not stale', () => {
    const { page } = build({ status: 'offline', stale: false, schedules: { jaguars: threeUpcoming('JAX') } })
    const keys = page.render(NOW_S).keys
    expect(keys[5]!.dim).toBe(true)
  })

  it('does not dim a fresh, ok schedule', () => {
    const { page } = build({ status: 'ok', stale: false, schedules: { jaguars: threeUpcoming('JAX') } })
    const keys = page.render(NOW_S).keys
    expect(keys[5]!.dim).toBeFalsy()
  })

  it('renders the widest measured opponent names without throwing and without overflowing the key', () => {
    const { page } = build({
      schedules: {
        jaguars: [game({ opponent: 'JACKSONVILLE' })],
        gators: [game({ opponent: 'TEXAS A&M' })],
      },
    })
    const keys = page.render(NOW_S).keys
    expect(() => renderKey(keys[5]!)).not.toThrow()
    expect(() => renderKey(keys[1]!)).not.toThrow()

    // Probes a REGION, not a single column. The previous version's comment
    // claimed a region but read only `x = KEY_SIZE - 1`, which cannot fail
    // against ink one column further left — the exact gap docs/LESSONS.md #22
    // records. This reads the whole right-hand margin band.
    //
    // And it compares against the key's OWN background, not `theme.bg`: task 45
    // gives these tiles a countdown wash, so the theme colour stopped describing
    // what is behind the text. Comparing to the theme would fail for the right
    // reason and the wrong cause.
    const buf = renderKey(keys[5]!)
    const bg = keys[5]!.bg ?? theme.bg
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = KEY_SIZE - 6; x < KEY_SIZE; x++) {
        const [r, g, b] = probe(buf, x, y)
        const isBg = Math.abs(r - bg[0]!) <= 12 && Math.abs(g - bg[1]!) <= 12 && Math.abs(b - bg[2]!) <= 12
        expect(isBg, `ink at ${x},${y}`).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Strip
// ---------------------------------------------------------------------------

describe('FootballPage strip', () => {
  it('shows the nearer of the two teams\' next games, with weekday, time, and matchup', () => {
    const { page } = build({
      schedules: {
        jaguars: [game({ opponent: 'FSU', isHome: true, opponentShort: 'FSU', kickoffEpochMs: NOW_MS + 5 * 86400000 })],
        gators: [game({ opponent: 'FAU', isHome: true, opponentShort: 'FAU', kickoffEpochMs: NOW_MS + 1 * 86400000 })],
      },
    })
    const line1 = page.render(NOW_S).strip.lines[0]!
    expect(line1).toContain('UF')
    expect(line1).toContain('FAU')
    expect(line1).not.toContain('FSU')
  })

  it('prefers a team with a KNOWN kickoff over one with none', () => {
    const { page } = build({
      schedules: {
        jaguars: [game({ opponent: 'Bears', kickoffEpochMs: null })],
        gators: [game({ opponent: 'UGA', isHome: true, opponentShort: 'UGA', kickoffEpochMs: NOW_MS + 86400000 })],
      },
    })
    const line1 = page.render(NOW_S).strip.lines[0]!
    expect(line1).toContain('UGA')
  })

  it('reports no upcoming games honestly when neither team has one', () => {
    const { page } = build({ schedules: {}, status: 'empty' })
    const line1 = page.render(NOW_S).strip.lines[0]!
    expect(line1).toContain('no upcoming games')
  })

  it('shows offline on the second line when the source reports offline', () => {
    const { page } = build({ status: 'offline', schedules: { jaguars: [game()] } })
    expect(page.render(NOW_S).strip.lines[1]).toBe('offline')
  })
})

// ---------------------------------------------------------------------------
// Schedule drill-down
// ---------------------------------------------------------------------------

describe('FootballPage schedule drill-down', () => {
  function seasonOf(n: number): Game[] {
    return Array.from({ length: n }, (_, i) =>
      game({ id: String(i), opponent: `Opp ${i}`, kickoffEpochMs: NOW_MS + (i - 2) * 86400000 }),
    )
  }

  it('pressing the gators logo (key 0) opens that team\'s schedule, with BACK on key 7', () => {
    const { page } = build({ schedules: { gators: seasonOf(5) } })
    expect(page.onKeyPress(0)).toBe('handled')
    const keys = page.render(NOW_S).keys
    expect(keys).toHaveLength(8)
    expect(keys[7]!.lines!.join('')).toContain('BACK')
    expect(keys[7]!.border).toEqual(theme.gray)
  })

  it('pressing the jaguars logo (key 4) opens that team\'s schedule', () => {
    const { page } = build({ schedules: { jaguars: seasonOf(3) } })
    expect(page.onKeyPress(4)).toBe('handled')
    const keys = page.render(NOW_S).keys
    expect(keys[0]!.lines![1]).toBe('Opp 0')
  })

  it('a logo with no schedule data reports ignored, per the task brief', () => {
    const { page } = build({ schedules: {} })
    expect(page.onKeyPress(0)).toBe('ignored')
    expect(page.onKeyPress(4)).toBe('ignored')
  })

  it('shows up to 7 games from the season, filling every non-BACK key when there are enough', () => {
    const { page } = build({ schedules: { gators: seasonOf(12) } })
    page.onKeyPress(0)
    const keys = page.render(NOW_S).keys
    for (let i = 0; i < 7; i++) {
      expect(keys[i]!.lines).toBeDefined()
      expect(keys[i]!.lines![1]).not.toBe('--')
    }
  })

  it('dims a game already in the past, independent of the page-wide staleness dim', () => {
    const { page } = build({
      schedules: {
        gators: [
          game({ id: 'past', opponent: 'Already Played', kickoffEpochMs: NOW_MS - 86400000 }),
          game({ id: 'future', opponent: 'Not Yet', kickoffEpochMs: NOW_MS + 86400000 }),
        ],
      },
      status: 'ok',
      stale: false,
    })
    page.onKeyPress(0)
    const keys = page.render(NOW_S).keys
    const pastKey = keys.find((k) => k.lines?.[1] === 'Already Played')!
    const futureKey = keys.find((k) => k.lines?.[1] === 'Not Yet')!
    expect(pastKey.dim).toBe(true)
    expect(futureKey.dim).toBeFalsy()
  })

  it('strip shows the team, its record, and how many of the season\'s games are visible', () => {
    const { page } = build({
      schedules: { gators: seasonOf(12) },
      records: { gators: { wins: 8, losses: 3, ties: 0, started: true } },
    })
    page.onKeyPress(0)
    const strip = page.render(NOW_S).strip
    expect(strip.lines[0]).toContain('GATORS')
    expect(strip.lines[0]).toContain('8-3')
    expect(strip.lines[1]).toContain('7')
    expect(strip.lines[1]).toContain('12')
  })

  it('strip reports showing all games when the whole season fits', () => {
    const { page } = build({ schedules: { gators: seasonOf(4) } })
    page.onKeyPress(0)
    const strip = page.render(NOW_S).strip
    expect(strip.lines[1]).toContain('all 4')
  })

  it('game tiles inside the schedule view have no further drill-down: every key 0-6 reports ignored', () => {
    const { page } = build({ schedules: { gators: seasonOf(5) } })
    page.onKeyPress(0)
    for (let i = 0; i <= 6; i++) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
  })

  it('key 7 (BACK) returns to the grid', () => {
    const { page } = build({ schedules: { gators: seasonOf(5) } })
    page.onKeyPress(0)
    expect(page.onKeyPress(7)).toBe('handled')
    const keys = page.render(NOW_S).keys
    // Back on the grid: key 0 is a logo/control tile again (`kind` is
    // 'control' or 'image'), not a schedule game tile.
    expect(['control', 'image']).toContain(keys[0]!.kind)
  })
})

// ---------------------------------------------------------------------------
// onEnter / onLeave
// ---------------------------------------------------------------------------

describe('FootballPage onEnter/onLeave', () => {
  it('tells the source it became visible on enter, and invisible on leave', () => {
    const { page, calls } = build()
    page.onEnter()
    page.onLeave()
    expect(calls).toEqual(['visible:true', 'visible:false'])
  })

  it('clears the selection on leave, so the page reopens on the grid', () => {
    const { page } = build({ schedules: { gators: [game()] } })
    page.onKeyPress(0)
    // In the schedule drill-down, key 7 is BACK.
    expect(page.render(NOW_S).keys[7]!.lines!.join('')).toContain('BACK')
    page.onLeave()
    const keys = page.render(NOW_S).keys
    // Back on the grid: key 7 is the jaguars' third game tile, not BACK.
    expect(keys[7]!.lines?.join('') ?? '').not.toContain('BACK')
    expect(['control', 'image']).toContain(keys[0]!.kind)
  })
})

// ---------------------------------------------------------------------------
// onKeyPress — every key, both modes
// ---------------------------------------------------------------------------

describe('FootballPage onKeyPress', () => {
  it('grid: game tiles (1-3, 5-7) always report ignored, even when populated', () => {
    const { page } = build({
      schedules: {
        gators: [game({ id: 'g1' }), game({ id: 'g2' }), game({ id: 'g3' })],
        jaguars: [game({ id: 'j1' }), game({ id: 'j2' }), game({ id: 'j3' })],
      },
    })
    for (const i of [1, 2, 3, 5, 6, 7]) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
  })

  it('grid: an empty-slot game tile also reports ignored', () => {
    const { page } = build({ schedules: {} })
    for (const i of [1, 2, 3, 5, 6, 7]) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
  })

  it('grid: a populated logo tile reports handled', () => {
    const { page } = build({ schedules: { gators: [game()], jaguars: [game()] } })
    expect(page.onKeyPress(0)).toBe('handled')
  })
})

// ---------------------------------------------------------------------------
// keyHash coverage — proves the fields this page sets actually change the
// hash the daemon uses for dirty-key detection (docs/LESSONS.md #11).
// ---------------------------------------------------------------------------

describe('keyHash covers every field FootballPage sets', () => {
  it('a different opponent name changes the hash', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['@ NO', 'Buffalo Bills', 'AUG 15', '4:00 PM EDT'] }
    const b: KeySpec = { kind: 'gauge', lines: ['@ NO', 'Miami Dolphins', 'AUG 15', '4:00 PM EDT'] }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('a different imageKey (team) changes the hash even with an identical image reference', () => {
    const img = { width: 1, height: 1 } as unknown as Image
    const a: KeySpec = { kind: 'image', image: img, imageKey: 'jaguars' }
    const b: KeySpec = { kind: 'image', image: img, imageKey: 'gators' }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('the record text drawn OVER the logo image changes the hash even with the same imageKey', () => {
    // This page combines `image` with `lines`/`lineY` — a genuinely new
    // combination on this project. Break the fix (drop `lines` from the
    // logo key entirely) and BOTH specs below collapse to the same hash,
    // so a record change (season goes from 7-3 to 8-3) would leave the
    // OLD record on the glass forever.
    const img = { width: 1, height: 1 } as unknown as Image
    const a: KeySpec = { kind: 'image', image: img, imageKey: 'jaguars', lines: ['7-3'], lineY: [70], align: 'center' }
    const b: KeySpec = { kind: 'image', image: img, imageKey: 'jaguars', lines: ['8-3'], lineY: [70], align: 'center' }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('dim toggling changes the hash', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['@ NO', 'Buffalo Bills'] }
    const b: KeySpec = { kind: 'gauge', lines: ['@ NO', 'Buffalo Bills'], dim: true }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('a blank key hashes identically to another blank key, and differently from a populated one', () => {
    const a: KeySpec = { kind: 'blank' }
    const b: KeySpec = { kind: 'blank' }
    const c: KeySpec = { kind: 'gauge', lines: ['@ NO'] }
    expect(keyHash(a)).toBe(keyHash(b))
    expect(keyHash(a)).not.toBe(keyHash(c))
  })
})

describe('FootballPage team colours (task 45)', () => {
  const TEAL: Rgb = [0, 103, 120]
  const ORANGE: Rgb = [250, 70, 22]

  it('gives the two round buttons DIFFERENT colours, one per team row', () => {
    // The one page where the two lights should differ: the deck splits by row,
    // Gators on top and Jaguars beneath, so each light names its own row. Every
    // other page shows one board-level signal and uses two identical lights.
    const { page } = build({ teamColors: { gators: ORANGE, jaguars: TEAL } })
    const frame = page.render(NOW_S)
    expect(frame.buttons[0]).toEqual(ORANGE)
    expect(frame.buttons[1]).toEqual(TEAL)
    expect(frame.buttons[0]).not.toEqual(frame.buttons[1])
  })

  it('borders each row with its own team colour', () => {
    const { page } = build({
      teamColors: { gators: ORANGE, jaguars: TEAL },
      schedules: { gators: [game()], jaguars: [game()] },
    })
    const keys = page.render(NOW_S).keys
    // Row 0 is the Gators (keys 0-3), row 1 the Jaguars (keys 4-7).
    for (const i of [1, 2, 3]) expect(keys[i]!.border, `key ${i}`).toEqual(ORANGE)
    for (const i of [5, 6, 7]) expect(keys[i]!.border, `key ${i}`).toEqual(TEAL)
  })

  it('falls back to the theme when a crest has no usable colour', () => {
    const { page } = build({ teamColors: { gators: null, jaguars: null } })
    const frame = page.render(NOW_S)
    expect(frame.buttons[0]).toEqual(theme.gray)
    expect(frame.buttons[1]).toEqual(theme.gray)
  })

  it('asks the source for the colour rather than computing one, so no pixels are read while rendering', () => {
    const { page, calls } = build({ teamColors: { gators: ORANGE, jaguars: TEAL } })
    for (let i = 0; i < 4; i++) page.render(NOW_S)
    // Two asks per render, one per team, and never more — the extraction itself
    // happens once in the source when the crest is decoded.
    expect(calls.filter((c) => c === 'teamColor:gators')).toHaveLength(4)
    expect(calls.filter((c) => c === 'teamColor:jaguars')).toHaveLength(4)
  })
})

describe('FootballPage record wash (task 45)', () => {
  const dist = (c: Rgb | undefined) =>
    c ? Math.abs(c[0] - theme.bg[0]) + Math.abs(c[1] - theme.bg[1]) + Math.abs(c[2] - theme.bg[2]) : 0

  it('leans green above .500 and red below', () => {
    const winning = recordWash({ wins: 4, losses: 1, ties: 0, started: true })!
    const losing = recordWash({ wins: 1, losses: 4, ties: 0, started: true })!
    expect(winning[1]).toBeGreaterThan(winning[0])
    expect(losing[0]).toBeGreaterThan(losing[1])
  })

  it('draws nothing at exactly .500, and nothing for an unknown record', () => {
    // Neither is a direction, and inventing a tint for either would suggest a
    // reading that does not exist.
    expect(recordWash({ wins: 3, losses: 3, ties: 0, started: true })).toBeUndefined()
    expect(recordWash(null)).toBeUndefined()
  })

  it('grows with the margin and then saturates', () => {
    expect(dist(recordWash({ wins: 2, losses: 0, ties: 0, started: true })))
      .toBeGreaterThan(dist(recordWash({ wins: 1, losses: 0, ties: 0, started: true })))
    // A 12-0 season and a 6-0 one both read as emphatically winning.
    expect(dist(recordWash({ wins: 12, losses: 0, ties: 0, started: true })))
      .toBe(dist(recordWash({ wins: 6, losses: 0, ties: 0, started: true })))
  })

  it('reaches the logo tile, and stays dark enough for the record text', () => {
    const { page } = build({
      records: { gators: { wins: 5, losses: 0, ties: 0, started: true } },
      logos: { gators: FAKE_LOGO },
    })
    const key = page.render(NOW_S).keys[0]!
    expect(key.bg).toBeDefined()
    const lum = key.bg![0]! + key.bg![1]! + key.bg![2]!
    expect(lum).toBeLessThan(200)
  })
})

describe('FootballPage countdown warmth (task 45)', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('is cold a week out and hottest at kickoff', () => {
    expect(kickoffWarmth(NOW_MS + 8 * DAY, NOW_MS)).toBe(0)
    expect(kickoffWarmth(NOW_MS + 3 * DAY, NOW_MS))
      .toBeLessThan(kickoffWarmth(NOW_MS + 1 * DAY, NOW_MS))
    expect(kickoffWarmth(NOW_MS + 60_000, NOW_MS)).toBeGreaterThan(0.9)
  })

  it('stays hot through a game-length window after kickoff, then goes cold', () => {
    // A game that has just started must not be the dullest tile on the deck at
    // exactly the moment it is the most interesting.
    expect(kickoffWarmth(NOW_MS - 60 * 60 * 1000, NOW_MS)).toBe(1)
    expect(kickoffWarmth(NOW_MS - 9 * 60 * 60 * 1000, NOW_MS)).toBe(0)
  })

  it('is zero for a TBD kickoff, rather than warming for a game that might be days away', () => {
    expect(kickoffWarmth(null, NOW_MS)).toBe(0)
  })

  it('survives a hostile clock', () => {
    expect(kickoffWarmth(Number.NaN, NOW_MS)).toBe(0)
    expect(kickoffWarmth(NOW_MS, Number.NaN)).toBe(0)
  })

  it('washes a warm tile and leaves a cold one clean', () => {
    expect(warmthWash(0, [0, 103, 120])).toBeUndefined()
    expect(warmthWash(1, [0, 103, 120])).toBeDefined()
  })

  it('reaches the next-game tiles, hottest nearest', () => {
    const { page } = build({
      teamColors: { gators: [250, 70, 22] },
      schedules: {
        gators: [
          game({ id: 'a', kickoffEpochMs: NOW_MS + 1 * DAY }),
          game({ id: 'b', kickoffEpochMs: NOW_MS + 6 * DAY }),
          game({ id: 'c', kickoffEpochMs: NOW_MS + 40 * DAY }),
        ],
      },
    })
    const keys = page.render(NOW_S).keys
    const dist = (c: Rgb | undefined) =>
      c ? Math.abs(c[0] - theme.bg[0]) + Math.abs(c[1] - theme.bg[1]) + Math.abs(c[2] - theme.bg[2]) : 0
    expect(dist(keys[1]!.bg)).toBeGreaterThan(dist(keys[2]!.bg))
    // Forty days out is beyond the lead window, so that tile stays clean.
    expect(keys[3]!.bg).toBeUndefined()
  })
})

describe('FootballPage result tinting in the drill-down (task 45)', () => {
  it('tints a win green and a loss red, and leaves an undecided game clean', () => {
    expect(resultWash('win')![1]).toBeGreaterThan(resultWash('win')![0]!)
    expect(resultWash('loss')![0]).toBeGreaterThan(resultWash('loss')![1]!)
    // null covers both "not played" and a tie the inline flags cannot tell apart.
    expect(resultWash(null)).toBeUndefined()
  })

  it('reaches the drill-down tiles, so the season shape reads at a glance', () => {
    const DAY = 24 * 60 * 60 * 1000
    const { page } = build({
      schedules: {
        gators: [
          game({ id: 'w', kickoffEpochMs: NOW_MS - 20 * DAY, result: 'win' }),
          game({ id: 'l', kickoffEpochMs: NOW_MS - 13 * DAY, result: 'loss' }),
          game({ id: 'u', kickoffEpochMs: NOW_MS + 5 * DAY, result: null }),
        ],
      },
      logos: { gators: FAKE_LOGO },
    })
    page.onKeyPress(0)
    const keys = page.render(NOW_S).keys
    const byResult = keys.slice(0, 7).map((k) => k.bg)
    // Exactly one green-leaning and one red-leaning tile among the played games.
    const greens = byResult.filter((c) => c && c[1]! > c[0]!).length
    const reds = byResult.filter((c) => c && c[0]! > c[1]!).length
    expect(greens).toBe(1)
    expect(reds).toBe(1)
  })
})

describe('FootballPage schedule tape (task 45)', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('lists both teams in date order, each segment in its own colour', () => {
    const { page } = build({
      teamColors: { gators: [250, 70, 22], jaguars: [0, 103, 120] },
      schedules: {
        gators: [game({ id: 'g1', opponentShort: 'LSU', kickoffEpochMs: NOW_MS + 1 * DAY })],
        jaguars: [game({ id: 'j1', opponentShort: 'IND', kickoffEpochMs: NOW_MS + 2 * DAY })],
      },
    })
    const tape = page.render(NOW_S).strip.tape
    expect(tape).toBeDefined()
    expect(tape!.segments).toHaveLength(2)
    // Gators first: its game is a day earlier.
    expect(tape!.segments[0]!.text).toContain('LSU')
    expect(tape!.segments[1]!.text).toContain('IND')
    expect(tape!.segments[0]!.color).not.toEqual(tape!.segments[1]!.color)
  })

  it('caps the tape so the loop stays short enough to watch', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      game({ id: `g${i}`, kickoffEpochMs: NOW_MS + (i + 1) * DAY }))
    const { page } = build({ schedules: { gators: many, jaguars: many } })
    expect(page.render(NOW_S).strip.tape!.segments.length).toBeLessThanOrEqual(6)
  })

  it('lists exactly what the next-three tiles list, TBD games included or excluded alike', () => {
    // Both read `upcoming`, which excludes a TBD kickoff. That exclusion is a
    // deliberate pre-existing choice — a date-ordered tape has nowhere to put a
    // game with no date — and the point here is that the strip and the tiles
    // AGREE. The drill-down is the one view that shows TBD games, on purpose.
    //
    // Note: `upcoming`'s own doc comment used to claim it kept
    // "unknown-but-not-past" kickoffs, which it has never done. The comment was
    // describing `scheduleWindow`. Corrected while writing this test.
    const { page } = build({
      schedules: {
        gators: [
          game({ id: 'tbd', opponentShort: 'TBD', kickoffEpochMs: null, timeTbd: true }),
          game({ id: 'known', opponent: 'LSU Tigers', opponentShort: 'LSU', kickoffEpochMs: NOW_MS + 1 * DAY }),
        ],
      },
    })
    const frame = page.render(NOW_S)
    const segs = frame.strip.tape!.segments
    expect(segs).toHaveLength(1)
    expect(segs[0]!.text).toContain('LSU')
    // And the tile row shows the same one game, with the other two slots empty.
    expect(frame.keys[1]!.lines![1]).toContain('LSU')
  })

  it('shows no tape when neither team has an upcoming game', () => {
    const { page } = build({ schedules: {} })
    expect(page.render(NOW_S).strip.tape).toBeUndefined()
  })

  it('keeps line 1 readable above the tape, so the nearest game needs no waiting', () => {
    const { page } = build({
      schedules: { gators: [game({ opponent: 'LSU Tigers', kickoffEpochMs: NOW_MS + 1 * DAY })] },
    })
    const strip = page.render(NOW_S).strip
    expect(strip.tape).toBeDefined()
    expect(strip.lines[0]).toContain('LSU')
  })

  it('advances the tape with the injected clock', () => {
    const { page } = build({
      schedules: { gators: [game({ kickoffEpochMs: NOW_MS + 1 * DAY })] },
    })
    const a = page.render(NOW_S, NOW_MS).strip.tape!.offsetPx
    const b = page.render(NOW_S, NOW_MS + 500).strip.tape!.offsetPx
    expect(b).toBeGreaterThan(a)
  })
})

describe('FootballPage tickMs: fast only while the schedule tape scrolls (task 45)', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('raises the rate while a tape is showing', () => {
    const { page } = build({
      schedules: { gators: [game({ kickoffEpochMs: NOW_MS + 1 * DAY })] },
    })
    // The rate depends on the last clock `render` saw, so render first — exactly
    // as the daemon does.
    page.render(NOW_S, NOW_MS)
    expect(page.tickMs).toBeDefined()
    expect(page.tickMs!).toBeLessThan(1000)
  })

  it('keeps the default rate when nothing is upcoming', () => {
    const { page } = build({ schedules: {} })
    page.render(NOW_S, NOW_MS)
    expect(page.tickMs).toBeUndefined()
  })

  it('keeps the default rate before the first render, rather than reading the wall clock', () => {
    const { page } = build({
      schedules: { gators: [game({ kickoffEpochMs: NOW_MS + 1 * DAY })] },
    })
    expect(page.tickMs).toBeUndefined()
  })

  it('keeps the default rate inside the drill-down, which has no tape', () => {
    const { page } = build({
      schedules: { gators: [game({ kickoffEpochMs: NOW_MS + 1 * DAY })] },
      logos: { gators: FAKE_LOGO },
    })
    page.render(NOW_S, NOW_MS)
    expect(page.tickMs).toBeDefined()
    page.onKeyPress(0)
    expect(page.tickMs).toBeUndefined()
  })

  it('re-reads the source every time rather than fixing the rate at construction', () => {
    const { page, f } = build({
      schedules: { gators: [game({ kickoffEpochMs: NOW_MS + 1 * DAY })] },
    })
    page.render(NOW_S, NOW_MS)
    expect(page.tickMs).toBeDefined()
    f.schedules = {}
    expect(page.tickMs).toBeUndefined()
  })
})
