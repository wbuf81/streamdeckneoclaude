import { describe, it, expect, vi } from 'vitest'
import { ClaudePage } from '../../src/pages/claude-page.js'
import { theme } from '../../src/render/theme.js'
import type { Session } from '../../src/sources/claude.js'
import type { UsageSnapshot, SessionMeta } from '../../src/sources/usage.js'

const NOW = 1786549560
const FIVE_HOURS = 5 * 3600

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
  focused: { pid: number; term: string }[]
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    sessions: [], usage: null, stale: false,
    meta: new Map(), focused: [], ...over,
  }
  const page = new ClaudePage(
    { getSessions: () => f.sessions, directoryExists: () => true },
    { getUsage: () => f.usage, isStale: () => f.stale, getMeta: (id) => f.meta.get(id) ?? null },
    async (pid, term) => { f.focused.push({ pid, term }); return true },
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
    // Halfway through the 5-hour window (elapsed 50%), used only 20%: delta
    // is -30, well past the -5 dead band.
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 20, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
    })
    const key = page.render(NOW).keys[6]!
    expect(key.lines![1]).toBe('UNDER')
    expect(key.lineSizes![1]).toBe(16)
    expect(key.lineColors![1]).toEqual(theme.green)
  })

  it('shows ON PACE in amber within the 5 point dead band', () => {
    // Elapsed 50%, used 52%: delta is +2, inside the band.
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 52, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
    })
    const key = page.render(NOW).keys[6]!
    expect(key.lines![1]).toBe('ON PACE')
    expect(key.lineColors![1]).toEqual(theme.amber)
  })

  it('stays ON PACE exactly at the +5 point boundary', () => {
    // Elapsed 50%, used 55%: delta is exactly +5, still inside the band.
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 55, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
    })
    expect(page.render(NOW).keys[6]!.lines![1]).toBe('ON PACE')
  })

  it('shows OVER in red once usage leads elapsed time by more than 5 points', () => {
    // Elapsed 50%, used 90%: delta is +40, well past the +5 dead band.
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 90, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
    })
    const key = page.render(NOW).keys[6]!
    expect(key.lines![1]).toBe('OVER')
    expect(key.lineColors![1]).toEqual(theme.red)
  })

  it('tips over to OVER just past the +5 point boundary', () => {
    // Elapsed 50%, used 55.1%: delta is +5.1, just outside the band.
    const { page } = build({
      usage: freshUsage({ fiveHourPct: 55.1, fiveHourResetsAt: NOW + FIVE_HOURS / 2 }),
    })
    expect(page.render(NOW).keys[6]!.lines![1]).toBe('OVER')
  })

  it('shows the rounded used and elapsed percent as evidence on the third line', () => {
    // Elapsed is exactly 44% of the window; used is 20%.
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

  it('shows an overflow count past four sessions', () => {
    const sessions = [1, 2, 3, 4, 5, 6].map((n) =>
      session({ sessionId: `s${n}`, ts: NOW - n }))
    const { page } = build({ sessions })
    expect(page.render(NOW).strip.lines.join(' ')).toContain('+2 more')
  })

  it('omits the overflow count at four sessions', () => {
    const sessions = [1, 2, 3, 4].map((n) => session({ sessionId: `s${n}`, ts: NOW - n }))
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
    const { page, f } = build({ sessions: [session({ pid: 4242 })] })
    page.render(NOW)
    await page.onKeyPress(0)
    expect(f.focused).toEqual([{ pid: 4242, term: 'ghostty' }])
  })

  it('does nothing for an empty session key', async () => {
    const { page, f } = build()
    page.render(NOW)
    await page.onKeyPress(2)
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
