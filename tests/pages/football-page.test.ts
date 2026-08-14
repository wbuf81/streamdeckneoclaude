import { describe, it, expect } from 'vitest'
import type { Image } from '@napi-rs/canvas'
import { FootballPage, formatShortDate, formatKickoff, formatScore, wrapText } from '../../src/pages/football-page.js'
import { theme } from '../../src/render/theme.js'
import { renderKey, probe, KEY_SIZE } from '../../src/render/canvas.js'
import { keyHash } from '../../src/render/specs.js'
import type { KeySpec } from '../../src/render/specs.js'
import type { FootballStatus, GameSummary, Slot, Team } from '../../src/sources/football.js'

const NOW = 1786549560 // arbitrary fixed clock, seconds

function game(over: Partial<GameSummary> = {}): GameSummary {
  return {
    id: '2475347',
    opponent: 'New Orleans Saints',
    isHome: false,
    kickoffEpochMs: Date.UTC(2026, 7, 15, 20, 0, 0), // 4:00 PM EDT
    venue: 'Caesars Superdome',
    city: 'New Orleans, LA',
    finished: false,
    teamScore: null,
    opponentScore: null,
    ...over,
  }
}

interface Fakes {
  games: Partial<Record<`${Team}:${Slot}`, GameSummary | null>>
  status: FootballStatus
  stale: boolean
  lastUpdatedAt: number
  logos: Partial<Record<Team, Image | null>>
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    games: {},
    status: 'ok',
    stale: false,
    lastUpdatedAt: NOW,
    logos: {},
    ...over,
  }
  const calls: string[] = []
  const source = {
    getGame: (team: Team, slot: Slot) => f.games[`${team}:${slot}`] ?? null,
    getStatus: () => f.status,
    getLastUpdatedAt: () => f.lastUpdatedAt,
    isStale: () => f.stale,
    getLogo: (team: Team) => f.logos[team] ?? null,
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
  }
  return { page: new FootballPage(source as never), calls, f }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe('formatShortDate', () => {
  it('formats a UTC kickoff as its Eastern calendar date', () => {
    // 2026-08-15T20:00:00Z is 4:00 PM EDT the SAME day.
    expect(formatShortDate(Date.UTC(2026, 7, 15, 20, 0, 0))).toBe('AUG 15')
  })

  it('rolls back to the PREVIOUS Eastern day for a late UTC kickoff (measured: Oregon vs Portland State)', () => {
    // dateEvent 2026-09-19, strTime 02:30:00 UTC -> 2026-09-18 22:30 EDT.
    expect(formatShortDate(Date.UTC(2026, 8, 19, 2, 30, 0))).toBe('SEP 18')
  })

  it('is -- when the kickoff instant is unknown', () => {
    expect(formatShortDate(null)).toBe('--')
  })
})

describe('formatKickoff', () => {
  it('renders a known kickoff through the shared Eastern time formatter', () => {
    expect(formatKickoff(Date.UTC(2026, 7, 15, 20, 0, 0))).toBe('4:00 PM EDT')
  })

  it('renders TBA, never a fabricated time, when the kickoff is unknown', () => {
    // Break the fix (return '00:00 AM EST' or any computed fallback instead
    // of the literal string) and this fails.
    expect(formatKickoff(null)).toBe('TBA')
  })
})

describe('formatScore', () => {
  it('formats a win', () => {
    expect(formatScore(game({ finished: true, teamScore: 27, opponentScore: 24 }))).toBe('W 27-24')
  })

  it('formats a loss', () => {
    expect(formatScore(game({ finished: true, teamScore: 24, opponentScore: 27 }))).toBe('L 24-27')
  })

  it('formats a tie', () => {
    expect(formatScore(game({ finished: true, teamScore: 20, opponentScore: 20 }))).toBe('T 20-20')
  })

  it('is -- for a game not yet played, never a fabricated 0-0', () => {
    expect(formatScore(game({ finished: false, teamScore: null, opponentScore: null }))).toBe('--')
  })
})

describe('wrapText', () => {
  it('wraps a long venue name across multiple lines without breaking a word', () => {
    const lines = wrapText('Ben Hill Griffin Stadium', 12, 3)
    expect(lines.join(' ')).toBe('Ben Hill Griffin Stadium')
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(12)
  })

  it('folds overflow onto the last line with an ellipsis rather than dropping it', () => {
    const lines = wrapText('a very extremely long venue name that will not fit in three lines at all', 12, 3)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toMatch(/…$/)
  })
})

// ---------------------------------------------------------------------------
// Grid layout
// ---------------------------------------------------------------------------

describe('FootballPage grid layout', () => {
  it('returns 8 keys: logo, next, last, blank, logo, next, last, blank', () => {
    const { page } = build({
      games: {
        'jaguars:next': game({ opponent: 'New Orleans Saints' }),
        'jaguars:last': game({
          opponent: 'Buffalo Bills',
          finished: true,
          teamScore: 24,
          opponentScore: 27,
          kickoffEpochMs: Date.UTC(2026, 0, 11, 18, 0, 0),
        }),
        'gators:next': game({ opponent: 'Florida Atlantic' }),
        'gators:last': game({ opponent: 'Florida State', finished: true, teamScore: 40, opponentScore: 21 }),
      },
    })
    const keys = page.render(NOW).keys
    expect(keys).toHaveLength(8)
    expect(keys[3]!.kind).toBe('blank')
    expect(keys[7]!.kind).toBe('blank')
    expect(keys[1]!.lines).toEqual(['NEXT', 'New Orleans Saints', 'AUG 15', '4:00 PM EDT'])
    expect(keys[2]!.lines).toEqual(['LAST', 'Buffalo Bills', 'JAN 11', 'L 24-27'])
    expect(keys[5]!.lines![1]).toBe('Florida Atlantic')
    expect(keys[6]!.lines![1]).toBe('Florida State')
  })

  it('shows a dashed placeholder, dimmed, for a slot with no game yet', () => {
    const { page } = build({ games: {} })
    const keys = page.render(NOW).keys
    expect(keys[1]!.lines).toEqual(['NEXT', '--', '--'])
    expect(keys[1]!.dim).toBe(true)
    expect(keys[2]!.dim).toBe(true)
  })

  it('shows the team name as a fallback on the logo tile while the image has not loaded', () => {
    const { page } = build({ logos: {} })
    const keys = page.render(NOW).keys
    expect(keys[0]!.kind).toBe('control')
    expect(keys[0]!.lines).toEqual(['JAGUARS'])
    expect(keys[4]!.lines).toEqual(['GATORS'])
  })

  it('draws the decoded logo as an image tile once loaded', () => {
    const fakeImage = { width: 500, height: 500 } as unknown as Image
    const { page } = build({ logos: { jaguars: fakeImage } })
    const key = page.render(NOW).keys[0]!
    expect(key.kind).toBe('image')
    expect(key.image).toBe(fakeImage)
    expect(key.imageKey).toBe('jaguars')
  })

  it('dims every tile when the schedule has gone stale', () => {
    const { page } = build({
      stale: true,
      games: { 'jaguars:next': game() },
    })
    const keys = page.render(NOW).keys
    expect(keys[1]!.dim).toBe(true)
  })

  it('dims every tile when the status is not ok (offline or empty), even if not stale', () => {
    const { page } = build({
      status: 'offline',
      stale: false,
      games: { 'jaguars:next': game() },
    })
    const keys = page.render(NOW).keys
    expect(keys[1]!.dim).toBe(true)
  })

  it('does not dim a fresh, ok schedule', () => {
    const { page } = build({
      status: 'ok',
      stale: false,
      games: { 'jaguars:next': game() },
    })
    const keys = page.render(NOW).keys
    expect(keys[1]!.dim).toBeFalsy()
  })

  it('renders the widest measured opponent names without throwing and without overflowing the key', () => {
    // JACKSONVILLE and TEXAS A&M are the task brief's own examples of long
    // opponent names; both must render, at whichever candidate size fits.
    const { page } = build({
      games: {
        'jaguars:next': game({ opponent: 'JACKSONVILLE' }),
        'gators:next': game({ opponent: 'TEXAS A&M' }),
      },
    })
    const keys = page.render(NOW).keys
    expect(() => renderKey(keys[1]!)).not.toThrow()
    expect(() => renderKey(keys[5]!)).not.toThrow()

    // Probe a REGION (not a single column, per docs/LESSONS.md #22) along
    // the key's right edge, inside the border, for every row: real ink must
    // never reach all the way to the key's own edge, which is what an
    // unclamped overflow would look like.
    const buf = renderKey(keys[1]!)
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
      games: {
        'jaguars:next': game({ opponent: 'FSU', kickoffEpochMs: Date.UTC(2026, 7, 20, 20, 0, 0) }),
        'gators:next': game({ opponent: 'FAU', kickoffEpochMs: Date.UTC(2026, 7, 15, 23, 45, 0) }),
      },
    })
    const line1 = page.render(NOW).strip.lines[0]!
    // Gators' game is earlier (Aug 15 vs Aug 20), so it wins. Both team
    // names are short enough here to survive the strip's 30-character
    // truncation whole, so this can assert the full expected text — a
    // longer name's truncation is covered separately by `truncate`'s own
    // tests, not re-proven here.
    expect(line1).toBe('SAT 7:45 PM EDT · UF vs FAU')
  })

  it('prefers a team with a KNOWN kickoff over one with none, regardless of which team it is', () => {
    const { page } = build({
      games: {
        'jaguars:next': game({ opponent: 'Bears', kickoffEpochMs: null }),
        'gators:next': game({ opponent: 'UGA', kickoffEpochMs: Date.UTC(2026, 7, 20, 20, 0, 0) }),
      },
    })
    const line1 = page.render(NOW).strip.lines[0]!
    // The brief's own example strip text, verified end to end.
    expect(line1).toBe('THU 4:00 PM EDT · UF vs UGA')
  })

  it('reports no upcoming games honestly when neither team has one', () => {
    const { page } = build({ games: {}, status: 'empty' })
    const line1 = page.render(NOW).strip.lines[0]!
    expect(line1).toContain('no upcoming games')
  })

  it('shows offline on the second line when the source reports offline', () => {
    const { page } = build({ status: 'offline', games: { 'jaguars:next': game() } })
    expect(page.render(NOW).strip.lines[1]).toBe('offline')
  })
})

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

describe('FootballPage detail view', () => {
  function withSelection(over: Partial<GameSummary> = {}) {
    const { page, f } = build({
      games: { 'jaguars:next': game(over) },
    })
    page.onKeyPress(1)
    return { page, f }
  }

  it('opens on pressing a populated NEXT tile and shows date, kickoff, status, venue, city, score', () => {
    const { page } = withSelection({ venue: 'Caesars Superdome', city: 'New Orleans, LA' })
    const keys = page.render(NOW).keys
    expect(keys[1]!.lines).toEqual(['DATE', 'AUG 15'])
    expect(keys[2]!.lines).toEqual(['KICKOFF', '4:00 PM EDT'])
    expect(keys[3]!.lines).toEqual(['STATUS', 'AWAY'])
    expect(keys[4]!.lines).toEqual(['VENUE', 'Caesars', 'Superdome'])
    expect(keys[5]!.lines).toEqual(['CITY', 'New Orleans,', 'LA'])
    expect(keys[6]!.lines).toEqual(['SCORE', '--'])
  })

  it('shows FINAL and a real score for a finished (LAST) game', () => {
    const { page } = build({
      games: {
        'jaguars:last': game({
          finished: true,
          teamScore: 24,
          opponentScore: 27,
          isHome: true,
        }),
      },
    })
    page.onKeyPress(2)
    const keys = page.render(NOW).keys
    expect(keys[3]!.lines).toEqual(['STATUS', 'FINAL'])
    expect(keys[6]!.lines).toEqual(['SCORE', 'L 24-27'])
  })

  it('shows TBA on the KICKOFF key and -- for DATE when the kickoff is unknown', () => {
    const { page } = withSelection({ kickoffEpochMs: null })
    const keys = page.render(NOW).keys
    expect(keys[1]!.lines).toEqual(['DATE', '--'])
    expect(keys[2]!.lines).toEqual(['KICKOFF', 'TBA'])
  })

  it('key 7 is BACK, distinct from a data tile', () => {
    const { page } = withSelection()
    const key = page.render(NOW).keys[7]!
    expect(key.lines!.join('')).toContain('BACK')
    expect(key.border).toEqual(theme.gray)
  })

  it('falls back to the grid if the selected game disappears from the source on a later render', () => {
    const { page, f } = withSelection()
    f.games['jaguars:next'] = null
    const keys = page.render(NOW).keys
    // Back on the grid: key 0 is the logo tile again, not a DATE/KICKOFF key.
    expect(keys[1]!.lines![0]).toBe('NEXT')
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
    const { page } = build({ games: { 'jaguars:next': game() } })
    page.onKeyPress(1)
    expect(page.render(NOW).keys[1]!.lines).toEqual(['DATE', 'AUG 15'])
    page.onLeave()
    expect(page.render(NOW).keys[1]!.lines![0]).toBe('NEXT')
  })
})

// ---------------------------------------------------------------------------
// onKeyPress — every key, both modes
// ---------------------------------------------------------------------------

describe('FootballPage onKeyPress', () => {
  it('grid: selects a populated NEXT/LAST tile and reports handled', () => {
    for (const i of [1, 2, 5, 6]) {
      const { page } = build({
        games: {
          'jaguars:next': game(),
          'jaguars:last': game({ finished: true, teamScore: 1, opponentScore: 0 }),
          'gators:next': game(),
          'gators:last': game({ finished: true, teamScore: 1, opponentScore: 0 }),
        },
      })
      expect(page.onKeyPress(i)).toBe('handled')
    }
  })

  it('grid: reports ignored for an empty NEXT/LAST slot', () => {
    const { page } = build({ games: {} })
    for (const i of [1, 2, 5, 6]) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
  })

  it('grid: logo tiles and blank spacers always report ignored', () => {
    const { page } = build({
      games: {
        'jaguars:next': game(),
        'jaguars:last': game(),
        'gators:next': game(),
        'gators:last': game(),
      },
    })
    for (const i of [0, 3, 4, 7]) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
  })

  it('detail mode: key 7 (BACK) reports handled and returns to the grid', () => {
    const { page } = build({ games: { 'jaguars:next': game() } })
    expect(page.onKeyPress(1)).toBe('handled') // enters detail
    expect(page.onKeyPress(7)).toBe('handled') // BACK
    expect(page.render(NOW).keys[1]!.lines![0]).toBe('NEXT')
  })

  it('detail mode: every other key (0-6) reports ignored', () => {
    const { page } = build({ games: { 'jaguars:next': game() } })
    page.onKeyPress(1)
    for (let i = 0; i <= 6; i++) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
  })
})

// ---------------------------------------------------------------------------
// keyHash coverage — proves the fields this page sets actually change the
// hash the daemon uses for dirty-key detection (docs/LESSONS.md #11).
// ---------------------------------------------------------------------------

describe('keyHash covers every field FootballPage sets', () => {
  it('a different opponent name changes the hash', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['NEXT', 'Buffalo Bills', 'AUG 15', '4:00 PM EDT'] }
    const b: KeySpec = { kind: 'gauge', lines: ['NEXT', 'Miami Dolphins', 'AUG 15', '4:00 PM EDT'] }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('a different imageKey (team) changes the hash even with an identical image reference', () => {
    const img = { width: 1, height: 1 } as unknown as Image
    const a: KeySpec = { kind: 'image', image: img, imageKey: 'jaguars' }
    const b: KeySpec = { kind: 'image', image: img, imageKey: 'gators' }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('dim toggling changes the hash', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['NEXT', 'Buffalo Bills'] }
    const b: KeySpec = { kind: 'gauge', lines: ['NEXT', 'Buffalo Bills'], dim: true }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('a blank key hashes identically to another blank key, and differently from a populated one', () => {
    const a: KeySpec = { kind: 'blank' }
    const b: KeySpec = { kind: 'blank' }
    const c: KeySpec = { kind: 'gauge', lines: ['NEXT'] }
    expect(keyHash(a)).toBe(keyHash(b))
    expect(keyHash(a)).not.toBe(keyHash(c))
  })
})
