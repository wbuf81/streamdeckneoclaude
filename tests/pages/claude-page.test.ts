import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import {
  ClaudePage, crabFrame, CRAB_STATE_PRIORITY, mostUrgentCrabState,
  formatResetIn, isWindowEnded, RESET_SIZES, EVIDENCE_SIZES,
} from '../../src/pages/claude-page.js'
import { theme } from '../../src/render/theme.js'
import { loadCrabFrames } from '../../src/render/sprites.js'
import { renderKey, renderStrip, probe, STRIP_WIDTH, STRIP_HEIGHT } from '../../src/render/canvas.js'
import type { Session } from '../../src/sources/claude.js'
import type { UsageSnapshot, SessionMeta } from '../../src/sources/usage.js'

const NOW = 1786549560
const FIVE_HOURS = 5 * 3600

/** The strip's own left/right inset, matching `render/canvas.ts`'s private
 * `PAD` — same documented value codex-page.test.ts hardcodes for the same
 * reason. */
const STRIP_PAD = 6

/** I5/I6-lesson (see codex-page.test.ts's own, fuller doc comment): the
 * furthest column a LEFT-ALIGNED key line can ever legitimately reach, and
 * the key's own last column. A probe must sweep this whole band, not one
 * column — a single column can sit inside an overflowing line's own
 * inter-glyph gap and miss real ink either side of it. */
const KEY_TEXT_RIGHT_EDGE = 90
const KEY_TEXT_RIGHT_BAND_END = 95

function rightBandIsBackground(buf: Buffer, y: number): boolean {
  for (let x = KEY_TEXT_RIGHT_EDGE; x <= KEY_TEXT_RIGHT_BAND_END; x++) {
    const [r, g, b] = probe(buf, x, y)
    if (r !== theme.bg[0] || g !== theme.bg[1] || b !== theme.bg[2]) return false
  }
  return true
}

/** Allows a small difference, because canvas anti-aliases edges. */
function near(actual: readonly number[], expected: readonly number[], tol = 12) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(tol)
  }
}

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 'aaaa', state: 'tool', label: 'Running command', tool: 'Bash',
    project: 'streamdeckneoclaude', cwd: '/x', termProgram: 'ghostty',
    pid: 4242, startedAt: NOW - 840, ts: NOW, ...over,
  }
}

interface Fakes {
  sessions: Session[]
  usage: UsageSnapshot | null
  stale: boolean
  meta: Map<string, SessionMeta>
  focused: { pid: number; term: string; cwd: string; project: string }[]
  /** What the injected `focus` fake resolves to. A test sets this to false to
   * simulate `focusWindow` failing, without needing the real implementation. */
  focusResult: boolean
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    sessions: [], usage: null, stale: false,
    meta: new Map(), focused: [], focusResult: true, ...over,
  }
  const page = new ClaudePage(
    { getSessions: () => f.sessions, directoryExists: () => true },
    { getUsage: () => f.usage, isStale: () => f.stale, getMeta: (id) => f.meta.get(id) ?? null },
    async (pid, term, cwd, project) => {
      f.focused.push({ pid, term, cwd, project })
      return f.focusResult
    },
  )
  return { page, f }
}

function freshUsage(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    fiveHourPct: 62, fiveHourResetsAt: NOW + FIVE_HOURS / 2,
    sevenDayPct: 34, sevenDayResetsAt: NOW + 345600, ts: NOW, ...over,
  }
}

describe('ClaudePage layout', () => {
  it('returns exactly 8 keys and two button colours', () => {
    const { page } = build()
    const frame = page.render(NOW)
    expect(frame.keys).toHaveLength(8)
    expect(frame.buttons).toHaveLength(2)
  })

  it('renders a blank key for an unused session slot', () => {
    const { page } = build()
    expect(page.render(NOW).keys[0]!.kind).toBe('blank')
  })

  it('puts the state label and the project on a session key', () => {
    const { page } = build({ sessions: [session()] })
    const key = page.render(NOW).keys[0]!
    expect(key.kind).toBe('session')
    expect(key.lines![0]).toBe('TOOL')
    expect(key.lines![1]).toBe('streamdec…')
  })

  it('truncates a long project name to 10 characters', () => {
    const { page } = build({ sessions: [session({ project: 'regulatory-compliance-agent' })] })
    expect(page.render(NOW).keys[0]!.lines![1]).toHaveLength(10)
  })

  it('leaves a short project name alone', () => {
    const { page } = build({ sessions: [session({ project: 'SNOOP' })] })
    expect(page.render(NOW).keys[0]!.lines![1]).toBe('SNOOP')
  })

  it('shows the model name from the usage cache', () => {
    const meta = new Map([['aaaa', { model: 'Opus 5', ctxPct: 41, costUsd: 1, ts: NOW }]])
    const { page } = build({ sessions: [session()], meta })
    expect(page.render(NOW).keys[0]!.lines).toContain('Opus 5')
  })

  it('omits the model line when the cache has no entry', () => {
    const { page } = build({ sessions: [session()] })
    expect(page.render(NOW).keys[0]!.lines).not.toContain('Opus 5')
  })

  it('colours the border by state', () => {
    const { page } = build({ sessions: [session({ state: 'thinking' })] })
    expect(page.render(NOW).keys[0]!.border).toEqual(theme.blue)
  })

  it('marks a permission key so it pulses', () => {
    const { page } = build({ sessions: [session({ state: 'permission' })] })
    const a = page.render(NOW).keys[0]!
    const b = page.render(NOW + 1).keys[0]!
    expect(a.border).toEqual(theme.amber)
    expect(a.pulseOn).not.toBe(b.pulseOn)
  })

  it('does not pulse a non-permission key', () => {
    const { page } = build({ sessions: [session({ state: 'tool' })] })
    const a = page.render(NOW).keys[0]!
    const b = page.render(NOW + 1).keys[0]!
    expect(a.pulseOn).toBe(b.pulseOn)
  })

  it('only ever fills up to 3 session slots, keys 0 to 2', () => {
    const sessions = [1, 2, 3, 4].map((n) => session({ sessionId: `s${n}`, ts: NOW - n }))
    const { page } = build({ sessions })
    const keys = page.render(NOW).keys
    expect(keys[0]!.kind).toBe('session')
    expect(keys[1]!.kind).toBe('session')
    expect(keys[2]!.kind).toBe('session')
    // Key 3 is the crab mascot tile, never a fourth session, no matter how
    // many sessions are live — a fourth live session is intentionally
    // invisible rather than rotating in.
    expect(keys[3]!.kind).not.toBe('session')
  })
})

describe('ClaudePage key 3: the permanent crab mascot tile', () => {
  it('carries no text lines, ever', () => {
    const { page } = build({ sessions: [session()] })
    expect(page.render(NOW).keys[3]!.lines).toBeUndefined()
  })

  it('is present even with zero sessions', () => {
    const { page } = build()
    const key = page.render(NOW).keys[3]!
    expect(key.kind).toBe('image')
    expect(key.lines).toBeUndefined()
  })

  it('does not move when sessions come and go: it is always key 3', () => {
    const { page } = build({ sessions: [session(), session({ sessionId: 'b', ts: NOW - 1 })] })
    expect(page.render(NOW).keys[3]!.kind).toBe('image')
  })
})

describe('CRAB_STATE_PRIORITY and mostUrgentCrabState', () => {
  it('ranks permission above tool, thinking, done and idle', () => {
    expect(CRAB_STATE_PRIORITY[0]).toBe('permission')
  })

  it('picks idle when there are no sessions at all', () => {
    expect(mostUrgentCrabState([])).toBe('idle')
  })

  it('picks permission over idle when sessions disagree', () => {
    const sessions = [session({ state: 'idle' }), session({ sessionId: 'b', state: 'permission' })]
    expect(mostUrgentCrabState(sessions)).toBe('permission')
  })

  it('picks tool over thinking and done', () => {
    const sessions = [
      session({ state: 'done' }),
      session({ sessionId: 'b', state: 'thinking' }),
      session({ sessionId: 'c', state: 'tool' }),
    ]
    expect(mostUrgentCrabState(sessions)).toBe('tool')
  })

  it('picks thinking over done and idle', () => {
    const sessions = [
      session({ state: 'idle' }),
      session({ sessionId: 'b', state: 'done' }),
      session({ sessionId: 'c', state: 'thinking' }),
    ]
    expect(mostUrgentCrabState(sessions)).toBe('thinking')
  })

  it('picks done over idle', () => {
    const sessions = [session({ state: 'idle' }), session({ sessionId: 'b', state: 'done' })]
    expect(mostUrgentCrabState(sessions)).toBe('done')
  })

  it('treats an unrecognised state as calm as idle', () => {
    const sessions = [session({ state: 'unknown' as never })]
    expect(mostUrgentCrabState(sessions)).toBe('idle')
  })
})

describe('ClaudePage gauges: 5-hr and week cap (keys 4 and 5)', () => {
  it('labels key 4 the 5-hour cap and key 5 the week cap', () => {
    const { page } = build({ usage: freshUsage() })
    const keys = page.render(NOW).keys
    expect(keys[4]!.lines![0]).toBe('5-HR CAP')
    expect(keys[5]!.lines![0]).toBe('WEEK CAP')
  })

  it('shows the whole percent as the value, at 28 px', () => {
    const { page } = build({ usage: freshUsage() })
    const keys = page.render(NOW).keys
    expect(keys[4]!.lines![1]).toBe('62%')
    expect(keys[4]!.lineSizes![1]).toBe(28)
    expect(keys[5]!.lines![1]).toBe('34%')
    expect(keys[5]!.lineSizes![1]).toBe(28)
  })

  it('fills the gauge bar to the percentage', () => {
    const { page } = build({ usage: freshUsage() })
    expect(page.render(NOW).keys[4]!.bar!.value).toBeCloseTo(0.62, 2)
  })

  it('colours the bar green below 60 percent', () => {
    const { page } = build({ usage: freshUsage({ fiveHourPct: 40 }) })
    expect(page.render(NOW).keys[4]!.bar!.color).toEqual(theme.green)
  })

  it('colours the bar amber at exactly 60 percent, the lower threshold', () => {
    const { page } = build({ usage: freshUsage({ fiveHourPct: 60 }) })
    expect(page.render(NOW).keys[4]!.bar!.color).toEqual(theme.amber)
  })

  it('colours the bar amber at exactly 85 percent, the upper threshold', () => {
    const { page } = build({ usage: freshUsage({ fiveHourPct: 85 }) })
    expect(page.render(NOW).keys[4]!.bar!.color).toEqual(theme.amber)
  })

  it('colours the bar red above 85 percent', () => {
    const { page } = build({ usage: freshUsage({ fiveHourPct: 92 }) })
    expect(page.render(NOW).keys[4]!.bar!.color).toEqual(theme.red)
  })

  it('shows two dashes and no bar when no usage file exists', () => {
    const { page } = build({ usage: null })
    const key = page.render(NOW).keys[4]!
    expect(key.lines).toEqual(['5-HR CAP', '--'])
    expect(key.bar).toBeUndefined()
    expect(key.dim).toBe(true)
  })

  it('does not dim a fresh gauge', () => {
    const { page } = build({ usage: freshUsage() })
    expect(page.render(NOW).keys[4]!.dim).not.toBe(true)
  })

  it('marks the gauge STALE on the third line and dims it past the limit', () => {
    const { page } = build({ usage: freshUsage(), stale: true })
    const key = page.render(NOW).keys[4]!
    expect(key.lines).toEqual(['5-HR CAP', '62%', 'STALE'])
    expect(key.dim).toBe(true)
  })

  it('suppresses the bar entirely when stale, even though the percent is known', () => {
    const { page } = build({ usage: freshUsage(), stale: true })
    expect(page.render(NOW).keys[4]!.bar).toBeUndefined()
  })
})

describe('ClaudePage gauges: burn rate (key 6)', () => {
  it('labels key 6 BURN RATE', () => {
    const { page } = build({ usage: freshUsage() })
    expect(page.render(NOW).keys[6]!.lines![0]).toBe('BURN RATE')
  })

  it('shows UNDER in green when usage trails elapsed time by more than 5 points', () => {
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 20, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
    })
    const key = page.render(NOW).keys[6]!
    expect(key.lines![1]).toBe('UNDER')
    expect(key.lineSizes![1]).toBe(16)
    expect(key.lineColors![1]).toEqual(theme.green)
  })

  it('shows ON PACE in amber within the 5 point dead band', () => {
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 52, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
    })
    const key = page.render(NOW).keys[6]!
    expect(key.lines![1]).toBe('ON PACE')
    expect(key.lineColors![1]).toEqual(theme.amber)
  })

  it('stays ON PACE exactly at the +5 point boundary', () => {
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 55, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
    })
    expect(page.render(NOW).keys[6]!.lines![1]).toBe('ON PACE')
  })

  it('shows OVER in red once usage leads elapsed time by more than 5 points', () => {
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 90, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
    })
    const key = page.render(NOW).keys[6]!
    expect(key.lines![1]).toBe('OVER')
    expect(key.lineColors![1]).toEqual(theme.red)
  })

  it('tips over to OVER just past the +5 point boundary', () => {
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 55.1, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
    })
    expect(page.render(NOW).keys[6]!.lines![1]).toBe('OVER')
  })

  it('shows the rounded used and elapsed percent as evidence, sized from EVIDENCE_SIZES (M1)', () => {
    // M1: the size is now a candidate array, not a bare 11 — a schema-drift
    // `usedPct` can produce `100% of 1000%`, which measures past the key's
    // usable width at a bare 11 px (see `EVIDENCE_SIZES`'s own doc comment).
    const resetsAt = NOW + Math.round(FIVE_HOURS * 0.56)
    const { page } = build({ usage: freshUsage({ fiveHourPct: 20, fiveHourResetsAt: resetsAt }) })
    const key = page.render(NOW).keys[6]!
    expect(key.lines![2]).toBe('20% of 44%')
    expect(key.lineSizes![2]).toEqual(EVIDENCE_SIZES)
  })

  it('rounds a fractional evidence percent to the nearest whole number', () => {
    const resetsAt = NOW + Math.round(FIVE_HOURS * 0.7)
    const { page } = build({ usage: freshUsage({ fiveHourPct: 33.6, fiveHourResetsAt: resetsAt }) })
    const key = page.render(NOW).keys[6]!
    expect(key.lines![2]).toBe('34% of 30%')
  })

  it('shows two dashes when no usage file exists', () => {
    const { page } = build({ usage: null })
    const key = page.render(NOW).keys[6]!
    expect(key.lines).toEqual(['BURN RATE', '--'])
    expect(key.dim).toBe(true)
  })

  it('replaces the evidence line with STALE and dims the key past the limit', () => {
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 90, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
      stale: true,
    })
    const key = page.render(NOW).keys[6]!
    expect(key.lines).toEqual(['BURN RATE', 'OVER', 'STALE'])
    expect(key.dim).toBe(true)
  })
})

describe('ClaudePage gauges: resets in (key 7)', () => {
  it('labels key 7 RESETS IN', () => {
    const { page } = build({ usage: freshUsage() })
    expect(page.render(NOW).keys[7]!.lines![0]).toBe('RESETS IN')
  })

  it('shows the duration, sized from RESET_SIZES so ELAPSED (C1) also fits', () => {
    // C1: the value line's size is now a candidate array, not a bare 24 —
    // `ELAPSED` (7 characters) measures past the key's usable width at 24 px
    // alone (see `RESET_SIZES`'s own doc comment), so a bare fixed size
    // would have clipped it the way the old `2h11m`-only test never noticed.
    const { page } = build({ usage: freshUsage({ fiveHourResetsAt: NOW + 7860 }) })
    const key = page.render(NOW).keys[7]!
    expect(key.lines![1]).toBe('2h11m')
    expect(key.lineSizes![1]).toEqual(RESET_SIZES)
  })

  it('names the window on the third line, at 11 px', () => {
    const { page } = build({ usage: freshUsage({ fiveHourResetsAt: NOW + 7860 }) })
    const key = page.render(NOW).keys[7]!
    expect(key.lines![2]).toBe('5-hr')
    expect(key.lineSizes![2]).toBe(11)
  })

  it('shows two dashes when no usage file exists', () => {
    const { page } = build({ usage: null })
    const key = page.render(NOW).keys[7]!
    expect(key.lines).toEqual(['RESETS IN', '--'])
    expect(key.dim).toBe(true)
  })

  it('replaces the window line with STALE and dims the key past the limit', () => {
    const { page } = build({
      usage: freshUsage({ fiveHourResetsAt: NOW + 7860 }),
      stale: true,
    })
    const key = page.render(NOW).keys[7]!
    expect(key.lines).toEqual(['RESETS IN', '2h11m', 'STALE'])
    expect(key.dim).toBe(true)
  })
})

describe('isWindowEnded and formatResetIn (C1)', () => {
  it('is false while a window has not yet ended, or is unknown', () => {
    expect(isWindowEnded(0, NOW)).toBe(false)
    expect(isWindowEnded(NOW + 10, NOW)).toBe(false)
  })

  it('is true once resetsAt is at or before now', () => {
    expect(isWindowEnded(NOW, NOW)).toBe(true)
    expect(isWindowEnded(NOW - 60, NOW)).toBe(true)
  })

  it('formats an elapsed reset as ELAPSED rather than a fabricated 0m', () => {
    expect(formatResetIn(NOW - 60, NOW)).toBe('ELAPSED')
    expect(formatResetIn(NOW, NOW)).toBe('ELAPSED')
  })

  it('formats an unknown reset time (resetsAt 0) as --', () => {
    expect(formatResetIn(0, NOW)).toBe('--')
  })

  it('formats a real remaining duration normally', () => {
    expect(formatResetIn(NOW + 7860, NOW)).toBe('2h11m')
  })
})

/**
 * C1 — the review's exact repro, reproduced with the review's own measured
 * values: the five-hour window ended 60 seconds ago, but `usage.json` is
 * only 61 seconds old, so `isStale()` (threshold 900 seconds) reports
 * `false`. Before the fix this rendered `5-HR CAP 87%` under a full red bar,
 * `BURN RATE UNDER`, and `RESETS IN 0m` at full brightness — a cap that had
 * already reset, presented as nearly exhausted and live. `break the fix and
 * watch it fail` (lesson 22): reverting `capKey`/`burnRateKey`/`resetKey` to
 * ignore `windowEnded` reproduces every one of these failures exactly.
 */
describe('ClaudePage gauges: an ended window must not present as live (C1)', () => {
  it('shows -- with no bar for the five-hour cap once its window has ended, even though the usage read itself is fresh', () => {
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 87, fiveHourResetsAt: NOW - 60 }),
      stale: false,
    })
    const key = page.render(NOW).keys[4]!
    expect(key.lines).toEqual(['5-HR CAP', '--'])
    expect(key.bar).toBeUndefined()
    expect(key.dim).toBe(true)
  })

  it('shows -- for the week cap too, once ITS OWN window has ended — the seven-day tile has the same hole', () => {
    const { page } = build({
      usage: freshUsage({ sevenDayPct: 41, sevenDayResetsAt: NOW - 60 }),
      stale: false,
    })
    const key = page.render(NOW).keys[5]!
    expect(key.lines).toEqual(['WEEK CAP', '--'])
    expect(key.dim).toBe(true)
  })

  it('shows -- for burn rate once the five-hour window has ended, never a pace verdict computed against a closed window', () => {
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 87, fiveHourResetsAt: NOW - 60 }),
      stale: false,
    })
    const key = page.render(NOW).keys[6]!
    expect(key.lines).toEqual(['BURN RATE', '--'])
    expect(key.dim).toBe(true)
  })

  it('shows ELAPSED, not a fabricated 0m, for the reset countdown once the window has ended', () => {
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 87, fiveHourResetsAt: NOW - 60 }),
      stale: false,
    })
    const key = page.render(NOW).keys[7]!
    expect(key.lines).toEqual(['RESETS IN', 'ELAPSED', '5-hr'])
    expect(key.dim).toBe(true)
  })

  it('still reads ELAPSED, never a frozen 0m, once staleness catches up after the window ends', () => {
    // The review's other failure mode: `RESETS IN 0m` used to persist
    // FOREVER once `isStale()` finally flipped true, a countdown frozen at
    // "resets right now."
    const { page } = build({
      usage: freshUsage({ fiveHourResetsAt: NOW - 1000 }),
      stale: true,
    })
    const key = page.render(NOW).keys[7]!
    expect(key.lines).toEqual(['RESETS IN', 'ELAPSED', 'STALE'])
    expect(key.dim).toBe(true)
  })

  it('keeps the bar and a live percentage while the window is still open', () => {
    const { page } = build({ usage: freshUsage({ fiveHourPct: 62, fiveHourResetsAt: NOW + 60 }) })
    const key = page.render(NOW).keys[4]!
    expect(key.lines).toEqual(['5-HR CAP', '62%'])
    expect(key.bar).toBeDefined()
    expect(key.dim).not.toBe(true)
  })
})

describe('ClaudePage session tile: the model line does not overflow the key (I1)', () => {
  it('never draws a real, unbounded Claude Code display_name past the key edge', () => {
    // The review's own measured repro strings: `Claude Sonnet 4.5` (17
    // characters, measured column 94 at the old bare, unmeasured 11 px) and
    // `Opus 5 (1M context)` (19 characters, same overflow).
    for (const model of ['Claude Sonnet 4.5', 'Opus 5 (1M context)']) {
      const meta = new Map([['aaaa', { model, ctxPct: null, costUsd: null, ts: NOW }]])
      const { page } = build({ sessions: [session()], meta })
      const key = page.render(NOW).keys[0]!
      const buffer = renderKey(key)
      for (let y = 0; y < 96; y++) {
        expect(rightBandIsBackground(buffer, y)).toBe(true)
      }
    }
  })

  it('still renders a short model name in full, unshrunk', () => {
    const meta = new Map([['aaaa', { model: 'Sonnet 4.5', ctxPct: null, costUsd: null, ts: NOW }]])
    const { page } = build({ sessions: [session()], meta })
    expect(page.render(NOW).keys[0]!.lines).toContain('Sonnet 4.5')
  })
})

describe('ClaudePage gauges: no cache at all', () => {
  it('shows -- and dims every one of the four gauges', () => {
    const { page } = build({ usage: null })
    const keys = page.render(NOW).keys.slice(4)
    for (const key of keys) {
      expect(key.lines![1]).toBe('--')
      expect(key.dim).toBe(true)
    }
  })

  it('never shows NaN or 0% for a null percentage', () => {
    const { page } = build({ usage: freshUsage({ fiveHourPct: null }) })
    const key = page.render(NOW).keys[4]!
    expect(key.lines).toContain('--')
    expect(key.lines!.join(' ')).not.toContain('NaN')
    expect(key.lines!.join(' ')).not.toContain('0%')
  })
})

describe('ClaudePage strip', () => {
  it('reports no active sessions when the list is empty', () => {
    const { page } = build()
    expect(page.render(NOW).strip.lines.join(' ')).toContain('no active sessions')
  })

  it('shows the project, the tool, and the elapsed time', () => {
    const { page } = build({ sessions: [session({ startedAt: NOW - 840 })] })
    const text = page.render(NOW).strip.lines.join(' ')
    expect(text).toContain('streamdeckneoclaude')
    expect(text).toContain('Bash')
    expect(text).toContain('14m')
  })

  it('shows an overflow count past three sessions', () => {
    const sessions = [1, 2, 3, 4, 5].map((n) =>
      session({ sessionId: `s${n}`, ts: NOW - n }))
    const { page } = build({ sessions })
    expect(page.render(NOW).strip.lines.join(' ')).toContain('+2 more')
  })

  it('omits the overflow count at three sessions', () => {
    const sessions = [1, 2, 3].map((n) => session({ sessionId: `s${n}`, ts: NOW - n }))
    const { page } = build({ sessions })
    expect(page.render(NOW).strip.lines.join(' ')).not.toContain('more')
  })

  // M3 — the strip used to describe `live[0]` (the newest session by `ts`
  // in the RAW list from the source), while key 0 shows whatever the
  // assigner is actually holding there. Those two can differ: the assigner
  // holds a session in its slot until it ends, so a session that claimed
  // slot 0 first keeps key 0 even after a NEWER session arrives and claims
  // a different, later slot.
  it('describes the session key 0 itself shows, not simply the newest session in the raw source list', () => {
    const { page, f } = build({
      sessions: [session({ sessionId: 'a', project: 'held-project', ts: NOW - 100 })],
    })
    page.render(NOW) // 'a' claims slot 0 and, per the assigner's contract, stays there.

    // A newer session arrives. The raw source list puts it FIRST — so
    // `live[0]` and key 0 now name two different sessions.
    f.sessions = [
      session({ sessionId: 'b', project: 'newer-project', ts: NOW }),
      session({ sessionId: 'a', project: 'held-project', ts: NOW - 100 }),
    ]
    const frame = page.render(NOW)
    expect(frame.strip.lines[0]).toContain('held-project')
    expect(frame.strip.lines[0]).not.toContain('newer-project')
  })

  it('never draws strip text past the strip edge for the widest realistic values (I6)', () => {
    // The OLD probe sat at the single column `STRIP_WIDTH - 1` = 247 and
    // carried a comment defending it as "a real, non-vacuous check". It was
    // not: `renderStrip` (`render/canvas.ts`) shrink-fits every line to
    // `STRIP_TEXT_MAX_WIDTH` = 236 px starting at `PAD` = 6, so nothing this
    // page can hand it ever paints past column ~242 — measured, a
    // 500-character line's rightmost ink lands at column 240, and ink at
    // column 247 is zero regardless of what this page does. Moved to a band
    // sweep across the real margin, the same correction
    // codex-page.test.ts's own I6 fix made.
    const longProject = 'p'.repeat(500)
    const longTool = 'x'.repeat(500)
    const { page } = build({ sessions: [session({ project: longProject, tool: longTool })] })
    const strip = page.render(NOW).strip
    const buffer = renderStrip(strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      for (let x = STRIP_WIDTH - STRIP_PAD; x < STRIP_WIDTH; x++) {
        expect(probe(buffer, x, y, STRIP_WIDTH)).toEqual(theme.bg)
      }
    }
  })

  it('reports missing session data when the directory is absent', () => {
    const page = new ClaudePage(
      { getSessions: () => [], directoryExists: () => false },
      { getUsage: () => null, isStale: () => true, getMeta: () => null },
      async () => true,
    )
    expect(page.render(NOW).strip.lines.join(' ')).toContain('no session data')
  })
})

describe('ClaudePage presses', () => {
  it('focuses the terminal of the pressed session', async () => {
    const { page, f } = build({
      sessions: [session({ pid: 4242, cwd: '/x', project: 'streamdeckneoclaude' })],
    })
    page.render(NOW)
    await page.onKeyPress(0)
    expect(f.focused).toEqual([
      { pid: 4242, term: 'ghostty', cwd: '/x', project: 'streamdeckneoclaude' },
    ])
  })

  it('does nothing for an empty session key', async () => {
    const { page, f } = build()
    page.render(NOW)
    await page.onKeyPress(2)
    expect(f.focused).toEqual([])
  })

  it('does nothing for the crab tile', async () => {
    const { page, f } = build({ sessions: [session()], usage: freshUsage() })
    page.render(NOW)
    await page.onKeyPress(3)
    expect(f.focused).toEqual([])
  })

  it('does nothing for a gauge key', async () => {
    const { page, f } = build({ sessions: [session()], usage: freshUsage() })
    page.render(NOW)
    await page.onKeyPress(4)
    await page.onKeyPress(7)
    expect(f.focused).toEqual([])
  })

  it('focuses the right session when two are live', async () => {
    const { page, f } = build({
      sessions: [session({ sessionId: 'a', pid: 1, ts: NOW }),
                 session({ sessionId: 'b', pid: 2, ts: NOW - 5 })],
    })
    page.render(NOW)
    await page.onKeyPress(1)
    expect(f.focused[0]!.pid).toBe(2)
  })

  // M9 — pressing used to read a page-level `this.slots` cache that only
  // `render()` ever populated, making a press target a side effect of
  // rendering. Verified by the review: a page with live sessions that had
  // never rendered a single frame reported `ignored` on every session key.
  // `onKeyPress` now asks the assigner itself, the same call `render`
  // makes, so this must resolve correctly with NO prior `render()` call.
  it('resolves a press correctly even when the page has never rendered a frame', async () => {
    const { page, f } = build({
      sessions: [session({ sessionId: 'a', pid: 1, ts: NOW }),
                 session({ sessionId: 'b', pid: 2, ts: NOW - 5 })],
    })
    // No `page.render(...)` call here on purpose.
    expect(await page.onKeyPress(1)).toBe('handled')
    expect(f.focused[0]!.pid).toBe(2)
  })
})

/**
 * Task 32 moves the press-feedback flash itself out of this page and into
 * the daemon (`src/daemon.ts`), so every page gets it, not just this one.
 * What THIS page owns now is reporting the real `PressOutcome` for every key
 * — the daemon trusts that report completely, so a wrong one here would
 * silently break the feature for the whole page.
 */
describe('ClaudePage presses report the real outcome, keys 0 to 7', () => {
  it('reports handled when a session slot focuses successfully', async () => {
    const { page } = build({ sessions: [session({ state: 'tool' })] })
    page.render(NOW)
    expect(await page.onKeyPress(0)).toBe('handled')
  })

  it('reports failed when focus itself fails', async () => {
    const { page } = build({ sessions: [session({ state: 'tool' })], focusResult: false })
    page.render(NOW)
    expect(await page.onKeyPress(0)).toBe('failed')
  })

  it('reports ignored for an empty session slot, keys 0 to 2', async () => {
    const { page } = build()
    page.render(NOW)
    expect(await page.onKeyPress(0)).toBe('ignored')
    expect(await page.onKeyPress(1)).toBe('ignored')
    expect(await page.onKeyPress(2)).toBe('ignored')
  })

  it('reports ignored for the crab tile, key 3', async () => {
    const { page } = build({ sessions: [session()], usage: freshUsage() })
    page.render(NOW)
    expect(await page.onKeyPress(3)).toBe('ignored')
  })

  it('reports ignored for every gauge key, 4 to 7', async () => {
    const { page } = build({ sessions: [session()], usage: freshUsage() })
    page.render(NOW)
    for (const i of [4, 5, 6, 7]) {
      expect(await page.onKeyPress(i)).toBe('ignored')
    }
  })

  it('resolves the right session before reporting handled, when two are live', async () => {
    const { page, f } = build({
      sessions: [session({ sessionId: 'a', pid: 1, ts: NOW }),
                 session({ sessionId: 'b', pid: 2, ts: NOW - 5 })],
    })
    page.render(NOW)
    expect(await page.onKeyPress(1)).toBe('handled')
    expect(f.focused[0]!.pid).toBe(2)
  })
})

describe('ClaudePage: no crab drawn behind session text (lesson 14)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deckd-claude-page-no-overlap-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** A crab fixture painted a distinctive, unmistakable solid colour, so a
   * pixel probe can prove whether it was drawn on a given key at all. */
  function tinyMarkerPng(): Buffer {
    const c = createCanvas(2, 2)
    const ctx = c.getContext('2d')
    ctx.fillStyle = 'rgb(9,200,9)'
    ctx.fillRect(0, 0, 2, 2)
    return c.toBuffer('image/png')
  }

  function writeCrabState(state: string): void {
    const dir = join(root, 'crab', state)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ frameCount: 1, delayMs: 100 }))
    writeFileSync(join(dir, '00.png'), tinyMarkerPng())
  }

  it('never paints the crab marker colour on a session key, only on key 3', async () => {
    writeCrabState('tool')
    await loadCrabFrames(root, ['tool'])

    const { page } = build({ sessions: [session({ state: 'tool' })] })
    const keys = page.render(NOW, 0).keys

    // Key 0 is a session tile: text only, no image field at all, and its
    // rendered pixels must never show the crab marker colour anywhere.
    expect(keys[0]!.image).toBeUndefined()
    const sessionBuf = renderKey(keys[0]!)
    for (let y = 0; y < 96; y += 4) {
      for (let x = 0; x < 96; x += 4) {
        const [r, g, b] = probe(sessionBuf, x, y)
        const isMarker = Math.abs(r - 9) < 20 && Math.abs(g - 200) < 20 && Math.abs(b - 9) < 20
        expect(isMarker).toBe(false)
      }
    }

    // Key 3 is the crab's own tile: the marker colour DOES appear there,
    // proving the crab moved rather than simply vanishing.
    const crabBuf = renderKey(keys[3]!)
    near(probe(crabBuf, 48, 48), [9, 200, 9], 30)
  })
})

/** A fresh temporary crab asset tree, so these tests never touch the real
 * `assets/crab/` directory or its committed frame counts and delays. */
function tinyPng(): Buffer {
  const c = createCanvas(2, 2)
  const ctx = c.getContext('2d')
  ctx.fillStyle = 'rgb(9,9,9)'
  ctx.fillRect(0, 0, 2, 2)
  return c.toBuffer('image/png')
}

function writeCrabState(
  root: string,
  state: string,
  meta: { frameCount: number; delayMs: number },
): void {
  const dir = join(root, 'crab', state)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
  for (let i = 0; i < meta.frameCount; i++) {
    writeFileSync(join(dir, `${String(i).padStart(2, '0')}.png`), tinyPng())
  }
}

describe('crabFrame', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deckd-claude-page-crab-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns null when neither the state nor idle has frames', async () => {
    // Runs before any other test in this block loads 'idle': `frameCache`
    // inside `sprites.ts` is a module singleton that outlives one `it`, so
    // this must run while 'idle' is still genuinely uncached, not merely
    // absent from this test's own fixture.
    await loadCrabFrames(root, ['some-state', 'idle'])
    expect(crabFrame('some-state', 0)).toBeNull()
  })

  it('resolves to the state itself when frames exist for it', async () => {
    writeCrabState(root, 'tool', { frameCount: 4, delayMs: 10 })
    writeCrabState(root, 'idle', { frameCount: 4, delayMs: 10 })
    await loadCrabFrames(root, ['tool', 'idle'])

    const frame = crabFrame('tool', 0)
    expect(frame).not.toBeNull()
    expect(frame!.imageKey.startsWith('crab:tool:')).toBe(true)
  })

  it('falls back to idle when the session state has no cached frames', async () => {
    writeCrabState(root, 'idle', { frameCount: 4, delayMs: 10 })
    // Deliberately do not write 'permission' at all.
    await loadCrabFrames(root, ['idle', 'permission'])

    const frame = crabFrame('permission', 0)
    expect(frame).not.toBeNull()
    expect(frame!.imageKey.startsWith('crab:idle:')).toBe(true)
  })

  it('emits a different frame for two nowMs values one frame apart', async () => {
    // delayMs above sprites.ts's MIN_DELAY_MS (40, a Minor fix elsewhere in
    // this pass floors anything below it) — 10 would now floor to 40 and no
    // longer land on two distinct frames at nowMs 0 and 10.
    writeCrabState(root, 'thinking', { frameCount: 4, delayMs: 50 })
    await loadCrabFrames(root, ['thinking'])

    const a = crabFrame('thinking', 0)
    const b = crabFrame('thinking', 50)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.image).not.toBe(b!.image)
    expect(a!.imageKey).not.toBe(b!.imageKey)
  })

  it('emits the same frame for two nowMs values inside one frame duration', async () => {
    writeCrabState(root, 'thinking', { frameCount: 4, delayMs: 10 })
    await loadCrabFrames(root, ['thinking'])

    const a = crabFrame('thinking', 12)
    const b = crabFrame('thinking', 18)
    expect(a).not.toBeNull()
    expect(a!.image).toBe(b!.image)
    expect(a!.imageKey).toBe(b!.imageKey)
  })
})

describe('ClaudePage renders the crab through the page, not just the helper', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'deckd-claude-page-render-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('sets image and imageKey on key 3 once frames are loaded', async () => {
    writeCrabState(root, 'tool', { frameCount: 4, delayMs: 10 })
    await loadCrabFrames(root, ['tool'])

    const { page } = build({ sessions: [session({ state: 'tool' })] })
    const key = page.render(NOW, 0).keys[3]!
    expect(key.image).toBeDefined()
    expect(key.imageKey).toBe('crab:tool:0')
  })

  it('advances key 3\'s image as nowMs advances, one render call apart', async () => {
    // delayMs above sprites.ts's MIN_DELAY_MS — see the same note above.
    writeCrabState(root, 'tool', { frameCount: 4, delayMs: 50 })
    await loadCrabFrames(root, ['tool'])

    const { page } = build({ sessions: [session({ state: 'tool' })] })
    const first = page.render(NOW, 0).keys[3]!
    const second = page.render(NOW, 50).keys[3]!
    expect(first.image).not.toBe(second.image)
    expect(first.imageKey).not.toBe(second.imageKey)
  })

  it('keeps the same key 3 image for two renders inside one frame duration', async () => {
    writeCrabState(root, 'tool', { frameCount: 4, delayMs: 10 })
    await loadCrabFrames(root, ['tool'])

    const { page } = build({ sessions: [session({ state: 'tool' })] })
    const first = page.render(NOW, 12).keys[3]!
    const second = page.render(NOW, 18).keys[3]!
    expect(first.image).toBe(second.image)
    expect(first.imageKey).toBe(second.imageKey)
  })

  it('does not disturb the once-per-second permission pulse at a 10 fps tick', () => {
    // No crab frames loaded here on purpose: this test isolates the pulse,
    // which must stay driven by whole seconds regardless of the millisecond
    // clock or whether a crab is even present.
    const { page } = build({ sessions: [session({ state: 'permission' })] })
    const a = page.render(NOW, 0).keys[0]!
    const b = page.render(NOW, 40).keys[0]!
    const c = page.render(NOW, 90).keys[0]!
    // Same second (NOW), any millisecond within it: pulseOn must not change.
    expect(a.pulseOn).toBe(b.pulseOn)
    expect(b.pulseOn).toBe(c.pulseOn)
    const d = page.render(NOW + 1, (NOW + 1) * 1000).keys[0]!
    expect(d.pulseOn).not.toBe(a.pulseOn)
  })

  it('picks the most urgent state across sessions for key 3\'s animation', async () => {
    writeCrabState(root, 'idle', { frameCount: 1, delayMs: 100 })
    writeCrabState(root, 'permission', { frameCount: 1, delayMs: 100 })
    await loadCrabFrames(root, ['idle', 'permission'])

    const { page } = build({
      sessions: [
        session({ sessionId: 'a', state: 'idle' }),
        session({ sessionId: 'b', state: 'permission' }),
      ],
    })
    const key = page.render(NOW, 0).keys[3]!
    expect(key.imageKey).toBe('crab:permission:0')
  })
})
