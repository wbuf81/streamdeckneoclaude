import { describe, it, expect } from 'vitest'
import type { Image } from '@napi-rs/canvas'
import {
  FootballPage,
  formatShortDate,
  formatKickoff,
  formatRecord,
  scheduleWindow,
} from '../../src/pages/football-page.js'
import { theme } from '../../src/render/theme.js'
import { renderKey, probe, KEY_SIZE } from '../../src/render/canvas.js'
import { keyHash } from '../../src/render/specs.js'
import type { KeySpec } from '../../src/render/specs.js'
import type { FootballStatus, Game, Team, TeamRecord } from '../../src/sources/football.js'

const NOW_S = 1755000000 // arbitrary fixed clock, seconds
const NOW_MS = NOW_S * 1000

function game(over: Partial<Game> = {}): Game {
  return {
    id: '401873281',
    opponent: 'New Orleans Saints',
    opponentShort: 'NO',
    isHome: false,
    kickoffEpochMs: NOW_MS + 3 * 24 * 60 * 60 * 1000, // 3 days out
    timeTbd: false,
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
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    schedules: {},
    records: {},
    status: 'ok',
    stale: false,
    lastUpdatedAt: NOW_S,
    logos: {},
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

    // Probe a REGION (not a single column, per docs/LESSONS.md #22) along
    // the key's right edge, inside the border, for every row.
    const buf = renderKey(keys[5]!)
    const bg = theme.bg
    for (let y = 0; y < KEY_SIZE; y++) {
      const [r, g, b] = probe(buf, KEY_SIZE - 1, y)
      const isBg = Math.abs(r - bg[0]) <= 12 && Math.abs(g - bg[1]) <= 12 && Math.abs(b - bg[2]) <= 12
      expect(isBg).toBe(true)
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
