import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { ClaudePage, crabFrame, CRAB_STATE_PRIORITY, mostUrgentCrabState } from '../../src/pages/claude-page.js'
import { theme } from '../../src/render/theme.js'
import { loadCrabFrames } from '../../src/render/sprites.js'
import { keyHash } from '../../src/render/specs.js'
import { renderKey, probe } from '../../src/render/canvas.js'
import type { Session } from '../../src/sources/claude.js'
import type { UsageSnapshot, SessionMeta } from '../../src/sources/usage.js'

const NOW = 1786549560
const FIVE_HOURS = 5 * 3600

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

  it('shows the rounded used and elapsed percent as evidence on the third line', () => {
    const resetsAt = NOW + Math.round(FIVE_HOURS * 0.56)
    const { page } = build({ usage: freshUsage({ fiveHourPct: 20, fiveHourResetsAt: resetsAt }) })
    const key = page.render(NOW).keys[6]!
    expect(key.lines![2]).toBe('20% of 44%')
    expect(key.lineSizes![2]).toBe(11)
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

  it('shows the duration at 24 px', () => {
    const { page } = build({ usage: freshUsage({ fiveHourResetsAt: NOW + 7860 }) })
    const key = page.render(NOW).keys[7]!
    expect(key.lines![1]).toBe('2h11m')
    expect(key.lineSizes![1]).toBe(24)
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
})

describe('ClaudePage press feedback (flash)', () => {
  it('flashes the pressed key white on a successful press, then reverts', async () => {
    const { page } = build({ sessions: [session({ state: 'tool' })] })
    page.render(NOW, 0) // seeds the page's clock at nowMs 0
    await page.onKeyPress(0)

    const during = page.render(NOW, 100).keys[0]!
    expect(during.bg).toEqual(theme.white)
    // The flash replaces the key's content — no border, no lines — rather
    // than drawing white text on a white fill, which would be a blank key.
    expect(during.border).toBeUndefined()
    expect(during.lines).toBeUndefined()

    const after = page.render(NOW, 350).keys[0]!
    expect(after.bg).toBeUndefined()
    expect(after.border).toEqual(theme.cyan) // the tool state's own colour
  })

  it('flashes the pressed key red on a failed press', async () => {
    const { page } = build({ sessions: [session({ state: 'tool' })], focusResult: false })
    page.render(NOW, 0)
    await page.onKeyPress(0)

    const during = page.render(NOW, 100).keys[0]!
    expect(during.bg).toEqual(theme.red)

    const after = page.render(NOW, 350).keys[0]!
    expect(after.border).toEqual(theme.cyan)
  })

  it('flashes red on an empty session slot, since nothing happened', async () => {
    const { page } = build()
    page.render(NOW, 0)
    await page.onKeyPress(0)
    expect(page.render(NOW, 100).keys[0]!.bg).toEqual(theme.red)
  })

  it('flashes red on the crab tile, since a press there does nothing', async () => {
    const { page } = build()
    page.render(NOW, 0)
    await page.onKeyPress(3)
    expect(page.render(NOW, 100).keys[3]!.bg).toEqual(theme.red)
  })

  it('flashes red on a gauge key, since a press there does nothing', async () => {
    const { page } = build({ usage: freshUsage() })
    page.render(NOW, 0)
    await page.onKeyPress(4)
    expect(page.render(NOW, 100).keys[4]!.bg).toEqual(theme.red)
  })

  it('holds for the full 250 ms from the render that first draws it, then reverts', async () => {
    const { page } = build({ sessions: [session({ state: 'tool' })] })
    page.render(NOW, 0) // seeds this.slots, so the press resolves to the session
    await page.onKeyPress(0)
    // The render at nowMs=1000 is the FIRST one to see this flash, so THAT
    // is what anchors its expiry, at 1000 + 250 = 1250 — not the earlier
    // render(NOW, 0) above, which happened before the press even existed.
    expect(page.render(NOW, 1000).keys[0]!.bg).toEqual(theme.white)
    expect(page.render(NOW, 1249).keys[0]!.bg).toEqual(theme.white)
    expect(page.render(NOW, 1250).keys[0]!.bg).toBeUndefined()
  })

  it('overrides the permission pulse while active, and the pulse resumes after', async () => {
    const { page } = build({ sessions: [session({ state: 'permission' })] })
    page.render(NOW, 0)
    await page.onKeyPress(0)

    const during = page.render(NOW, 100).keys[0]!
    expect(during.bg).toEqual(theme.white)
    expect(during.pulseOn).toBeUndefined()
    expect(during.border).toBeUndefined()

    const after = page.render(NOW, 350).keys[0]!
    expect(after.border).toEqual(theme.amber)
    expect(after.pulseOn).toBe(NOW % 2 === 0)
  })

  it('is per key: flashing key 0 does not touch key 1', async () => {
    const { page } = build({
      sessions: [
        session({ sessionId: 'a', pid: 1, ts: NOW, state: 'tool' }),
        session({ sessionId: 'b', pid: 2, ts: NOW - 1, state: 'tool' }),
      ],
    })
    page.render(NOW, 0)
    await page.onKeyPress(0)

    const frame = page.render(NOW, 100)
    expect(frame.keys[0]!.bg).toEqual(theme.white)
    expect(frame.keys[1]!.border).toEqual(theme.cyan)
  })

  it('leaves no trace in keyHash once the flash has expired', async () => {
    const { page } = build({ sessions: [session({ state: 'tool' })] })
    const before = keyHash(page.render(NOW, 0).keys[0]!)

    await page.onKeyPress(0)
    expect(keyHash(page.render(NOW, 100).keys[0]!)).not.toBe(before)

    const after = keyHash(page.render(NOW, 350).keys[0]!)
    expect(after).toBe(before)
  })

  it('paints the WHOLE key white during a successful flash, not just a left border strip', async () => {
    const { page } = build({ sessions: [session({ state: 'tool' })] })
    page.render(NOW, 0)
    await page.onKeyPress(0)
    const buf = renderKey(page.render(NOW, 100).keys[0]!)
    // Sample points spread across the key, including the far corner well
    // away from the old 3 px left-edge border strip.
    near(probe(buf, 48, 48), theme.white)
    near(probe(buf, 90, 90), theme.white)
    near(probe(buf, 90, 5), theme.white)
    near(probe(buf, 1, 1), theme.white)
  })

  it('leaves no readable text ink on a flashing key: a uniform fill, not white-on-white', async () => {
    const { page } = build({ sessions: [session({ state: 'tool', project: 'streamdeckneoclaude' })] })
    page.render(NOW, 0)
    await page.onKeyPress(0)
    const buf = renderKey(page.render(NOW, 100).keys[0]!)
    // If text were still drawn under the fill, sampling many points across
    // the key would find pixels that deviate from a uniform white — glyph
    // edges, anti-aliasing, or (for coloured text) a different hue. Every
    // sample staying within tolerance of white proves the fill is the only
    // thing drawn.
    for (let y = 4; y < 92; y += 8) {
      for (let x = 4; x < 92; x += 8) {
        near(probe(buf, x, y), theme.white, 5)
      }
    }
  })

  it('does not swallow the flash after a change-driven render already advanced the clock', async () => {
    // Simulates the scenario the review found in bin/deckd.ts: a
    // source-change render passes a `nowMs` that trails real time (there,
    // by up to 999 ms, from `renderOnce`'s `now * 1000` fallback). Anchoring
    // the flash's expiry at PRESS time off that stale clock would make the
    // very next render see it as already expired. Anchoring at first-DRAW
    // time instead means the render immediately after the press is what
    // sets the expiry, using ITS OWN nowMs, so the flash always shows.
    const { page } = build({ sessions: [session({ state: 'tool' })] })
    page.render(NOW, 1_000_000) // a change-triggered render, clock behind
    await page.onKeyPress(0)
    const during = page.render(NOW, 1_000_950).keys[0]! // the real press-time clock
    expect(during.bg).toEqual(theme.white)
  })

  it('shows the flash on the very first render, even when the press came before any render at all', async () => {
    const { page } = build()
    // No render() call at all before the press — `this.slots` is still
    // every key's initial null, so this press hits the "empty session key"
    // path and flashes red. That is a SEPARATE, pre-existing limitation
    // (slot identity is only known after a render), not what this test
    // proves. What it proves is narrower and is the actual A1 fix: the
    // flash mechanism itself must not depend on a render having happened
    // before the press — the very first render afterwards must still show
    // it, not treat it as already expired.
    await page.onKeyPress(0)
    const first = page.render(NOW, 5_000).keys[0]!
    expect(first.bg).toEqual(theme.red)
  })

  it('never sticks: a flash recorded while the page was not visible still expires on schedule once rendering resumes', async () => {
    const { page } = build({ sessions: [session({ state: 'tool' })] })
    page.render(NOW, 0)
    await page.onKeyPress(0)
    // A long gap with no render at all (the page was not visible), then
    // rendering resumes. The flash must still expire 250 ms after the
    // render that FIRST draws it, not sit forever, and not have expired
    // before it was ever drawn.
    const first = page.render(NOW, 50_000).keys[0]!
    expect(first.bg).toEqual(theme.white)
    const later = page.render(NOW, 50_260).keys[0]!
    expect(later.bg).toBeUndefined()
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
    writeCrabState(root, 'thinking', { frameCount: 4, delayMs: 10 })
    await loadCrabFrames(root, ['thinking'])

    const a = crabFrame('thinking', 0)
    const b = crabFrame('thinking', 10)
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
    writeCrabState(root, 'tool', { frameCount: 4, delayMs: 10 })
    await loadCrabFrames(root, ['tool'])

    const { page } = build({ sessions: [session({ state: 'tool' })] })
    const first = page.render(NOW, 0).keys[3]!
    const second = page.render(NOW, 10).keys[3]!
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
