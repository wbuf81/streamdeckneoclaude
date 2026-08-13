import { describe, it, expect } from 'vitest'
import { CodexPage, formatTokenCount, formatResetIn, limitLabel } from '../../src/pages/codex-page.js'
import type { CodexSnapshot, CodexTask } from '../../src/sources/codex.js'
import { theme } from '../../src/render/theme.js'
import { renderKey, renderStrip, probe, STRIP_WIDTH, STRIP_HEIGHT } from '../../src/render/canvas.js'

const NOW = 1786622400

function task(over: Partial<CodexTask> = {}): CodexTask {
  return {
    threadId: 'thread-1', title: 'Improve the Stream Deck integration', project: 'deckd',
    model: 'gpt-5.6-sol', updatedAt: NOW, tokensUsed: 1_250_000,
    ...over,
  }
}

function snapshot(over: Partial<CodexSnapshot> = {}): CodexSnapshot {
  return {
    tasks: [task()],
    usage: {
      limits: [{ usedPct: 27, windowMinutes: 10080, resetsAt: NOW + 86400 }],
      totalTokens: 1_250_000, plan: 'team', ts: NOW,
    },
    ...over,
  }
}

function build(
  data = snapshot(),
  available = true,
  stale = false,
  usageUnknown = false,
) {
  return new CodexPage({
    getSnapshot: () => data,
    isAvailable: () => available,
    isStale: () => stale,
    isUsageUnknown: () => usageUnknown,
    setVisible: () => {},
  })
}

describe('CodexPage', () => {
  it('renders exactly eight keys', () => {
    expect(build().render(NOW).keys).toHaveLength(8)
  })

  it('puts active tasks in the first three tiles', () => {
    const key = build().render(NOW).keys[0]!
    expect(key.lines).toEqual(['RUNNING', 'deckd', 'Improve the Stream Deck integration', 'gpt-5.6-sol'])
    expect(key.border).toEqual(theme.green)
    expect(key.dim).toBe(false)
  })

  it('leaves unused task slots blank', () => {
    const keys = build().render(NOW).keys
    expect(keys[1]!.kind).toBe('blank')
    expect(keys[2]!.kind).toBe('blank')
  })

  it('keeps a permanent OpenAI Codex identity tile at key 3', () => {
    expect(build().render(NOW).keys[3]!.lines).toEqual(['OPENAI', 'CODEX', '1 ACTIVE'])
  })

  it('shows the account limit percentage and reset countdown', () => {
    const keys = build().render(NOW).keys
    expect(keys[4]!.lines).toEqual(['WEEK CAP', '27%'])
    expect(keys[4]!.bar?.value).toBeCloseTo(0.27)
    expect(keys[7]!.lines?.[1]).toBe('1d0h')
  })

  it('uses key 5 for the plan when there is no second limit', () => {
    expect(build().render(NOW).keys[5]!.lines?.slice(0, 2)).toEqual(['PLAN', 'TEAM'])
  })

  it('shows task token usage compactly', () => {
    expect(build().render(NOW).keys[6]!.lines?.[1]).toBe('1.3M')
  })

  it('dims unavailable data and explains it on the strip', () => {
    const page = build({ tasks: [], usage: null }, false, true)
    const frame = page.render(NOW)
    expect(frame.keys[3]!.dim).toBe(true)
    expect(frame.strip).toEqual({ lines: ['codex', 'task data unavailable'], dim: true })
  })

  it('renders an explicit unknown, not the last known percentage dimmed, once the usage sample no longer describes the current window', () => {
    // Available and read-fresh (not `readStale`), but `isUsageUnknown()`
    // reports the C2 scenario: the sample's own window has ended, so the
    // true figure is unknowable. A dimmed `27%` under a STALE label would
    // still read as data — the same rule commit 185bcb4 set for schema
    // drift — so this must show `--` outright, with no bar.
    const key = build(snapshot(), true, false, true).render(NOW).keys[4]!
    expect(key.lines).toEqual(['WEEK CAP', '--'])
    expect(key.bar).toBeUndefined()
    expect(key.dim).toBe(true)
  })

  it('still shows the dimmed percentage under a STALE label when only the sqlite read is lagging, not the usage sample', () => {
    // The mirror case: `readStale` true, `isUsageUnknown()` false. The
    // number is probably still true, just not freshly confirmed, so it stays
    // visible — this is the ONE case that keeps the old STALE-label
    // behaviour.
    const key = build(snapshot(), true, true, false).render(NOW).keys[4]!
    expect(key.lines).toEqual(['WEEK CAP', '27%', 'STALE'])
    expect(key.bar).toBeUndefined()
    expect(key.dim).toBe(true)
  })

  it('shows -- for task tokens too, once the usage sample no longer describes the current window', () => {
    const key = build(snapshot(), true, false, true).render(NOW).keys[6]!
    expect(key.lines).toEqual(['TASK TOKENS', '--'])
    expect(key.dim).toBe(true)
  })

  it('shows an explicit -- for the reset countdown when unknown, never a real but WRONG duration', () => {
    // `resetsAt` is a full day out — a real, positive duration if trusted —
    // but `isUsageUnknown()` says the sample does not describe the current
    // window, so the countdown itself cannot be trusted either.
    const key = build(snapshot(), true, false, true).render(NOW).keys[7]!
    expect(key.lines?.[1]).toBe('--')
    expect(key.dim).toBe(true)
  })

  it('keeps ELAPSED for the reset countdown when unknown, since that is already an honest signal on its own', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 27, windowMinutes: 10080, resetsAt: NOW - 5 }],
        totalTokens: 1_250_000, plan: 'team', ts: NOW,
      },
    })
    const key = build(data, true, false, true).render(NOW).keys[7]!
    expect(key.lines?.[1]).toBe('ELAPSED')
  })

  it('dims task tiles when the last sqlite read has gone stale, even while available', () => {
    // I3 — a retained snapshot must not read as current forever.
    const key = build(snapshot(), true, true, true).render(NOW).keys[0]!
    expect(key.lines?.[0]).toBe('RUNNING') // still shows the retained data...
    expect(key.dim).toBe(true) // ...but visibly marked historic.
  })

  it('dims task tiles when the source is unavailable', () => {
    const key = build(snapshot(), false, false, false).render(NOW).keys[0]!
    expect(key.dim).toBe(true)
  })

  it('reports overflow on the strip', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => task({
      threadId: String(i), title: `Task ${i}`, updatedAt: NOW - i,
    }))
    expect(build(snapshot({ tasks })).render(NOW).strip.lines[1]).toBe('+2 more')
  })

  it("renders the usage sample's own time on the strip, right-aligned on line 2", () => {
    // NOW (1786622400) is 2026-08-13T12:00:00Z, which is 8:00 AM EDT — a
    // summer instant, so the zone must read EDT. Exact string, per
    // docs/LESSONS.md #17.
    expect(build().render(NOW).strip.right).toBe('8:00 AM EDT')
  })

  it('shows the explicit -- unknown state, not the timestamp, once the usage sample no longer describes the current window', () => {
    // Same C2 rule the key percentages already follow (commit 360508d): a
    // sample can sit unchanged for hours and stay TRUE, but once its window
    // has ended the figure — and the time it was taken — is no longer
    // presented as current.
    const key = build(snapshot(), true, false, true)
    expect(key.render(NOW).strip.right).toBe('--')
  })

  it('shows the -- unknown state with no timestamp when there is no usage sample at all', () => {
    const page = build(snapshot({ usage: null }), true, false, false)
    expect(page.render(NOW).strip.right).toBe('--')
  })

  it('never overlaps or clips the strip timestamp against line 2 text, for the widest realistic values', () => {
    // The widest realistic clock string, `12:00 AM EDT` (12 chars, measured
    // 93.9 px at 13 px Menlo), beside the widest realistic line-2 count,
    // `3 active` (achieved with exactly TASK_SLOTS tasks and no overflow —
    // measured 62.6 px, wider than any reachable `+N more` string, since
    // the sqlite query caps at 10 rows and 10 - TASK_SLOTS leaves only 7).
    const tasks = Array.from({ length: 3 }, (_, i) => task({
      threadId: String(i), title: `Task ${i}`, updatedAt: NOW - i,
    }))
    // 2026-07-15T04:00:00Z is 12:00 AM EDT.
    const wideTs = Math.floor(Date.parse('2026-07-15T04:00:00.000Z') / 1000)
    const data = snapshot({
      tasks,
      usage: {
        limits: [{ usedPct: 27, windowMinutes: 10080, resetsAt: NOW + 86400 }],
        totalTokens: 1_250_000, plan: 'team', ts: wideTs,
      },
    })
    const frame = build(data).render(NOW)
    expect(frame.strip.right).toBe('12:00 AM EDT')
    const buffer = renderStrip(frame.strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      expect(probe(buffer, STRIP_WIDTH - 1, y, STRIP_WIDTH)).toEqual(theme.bg)
    }
  })

  // C1 — a limit whose window is known but whose percentage field was
  // renamed must render `--`, dimmed, with NO bar — never a measured `0%`
  // with a confident green bar under it.
  it('renders an unknown percentage as -- with no bar, never a measured 0%', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: null, windowMinutes: 10080, resetsAt: NOW + 86400 }],
        totalTokens: null, plan: 'team', ts: NOW,
      },
    })
    const key = build(data).render(NOW).keys[4]!
    expect(key.lines).toEqual(['WEEK CAP', '--'])
    expect(key.bar).toBeUndefined()
    expect(key.dim).toBe(true)
  })

  it('renders unknown task tokens as -- rather than a fabricated 0', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 27, windowMinutes: 10080, resetsAt: NOW + 86400 }],
        totalTokens: null, plan: 'team', ts: NOW,
      },
    })
    const key = build(data).render(NOW).keys[6]!
    expect(key.lines?.[1]).toBe('--')
    expect(key.dim).toBe(true)
  })

  // M1 — an out-of-range percentage must not clip the key.
  it('clamps an out-of-range percentage for display', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 1234.5, windowMinutes: 10080, resetsAt: NOW + 86400 }],
        totalTokens: 1, plan: 'team', ts: NOW,
      },
    })
    const key = build(data).render(NOW).keys[4]!
    expect(key.lines?.[1]).toBe('999%')
  })

  // C2 — an elapsed reset must read as elapsed, not as a permanent `0m`.
  it('reports an elapsed reset time as ELAPSED rather than 0m forever', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 10, windowMinutes: 10080, resetsAt: NOW - 5 }],
        totalTokens: 1, plan: 'team', ts: NOW,
      },
    })
    expect(build(data).render(NOW).keys[7]!.lines?.[1]).toBe('ELAPSED')
  })

  it('reports an unknown reset time as -- rather than 0m', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 10, windowMinutes: 10080, resetsAt: null }],
        totalTokens: 1, plan: 'team', ts: NOW,
      },
    })
    expect(build(data).render(NOW).keys[7]!.lines?.[1]).toBe('--')
  })

  // I7 — the widest realistic values must never draw ink past the key's
  // usable width. Column x=95 (one pixel from the 96 px right edge) must
  // stay pure background for every row, for a task whose project, title and
  // model are all far longer than the OLD fixed-width truncation assumed.
  it('never draws task-tile text past the key edge for the widest realistic values', () => {
    const wide = task({
      project: 'a-fairly-long-project-directory-name-for-a-real-repo',
      title: 'W'.repeat(64), // the SQL layer's own truncation bound (I6).
      model: 'a-fairly-long-model-identifier-string-example',
    })
    const key = build(snapshot({ tasks: [wide] })).render(NOW).keys[0]!
    const buffer = renderKey(key)
    for (let y = 0; y < 96; y++) {
      expect(probe(buffer, 95, y)).toEqual(theme.bg)
    }
  })

  it('never draws strip text past the strip edge for the widest realistic values', () => {
    const wide = task({
      project: 'a-fairly-long-project-directory-name-for-a-real-repo',
      title: 'W'.repeat(64),
    })
    const strip = build(snapshot({ tasks: [wide] })).render(NOW).strip
    const buffer = renderStrip(strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      expect(probe(buffer, STRIP_WIDTH - 1, y, STRIP_WIDTH)).toEqual(theme.bg)
    }
  })
})

describe('CodexPage presses', () => {
  it('ignores every key, 0 to 7 — task tiles are read-only, with no stable URL or command to focus one', () => {
    const page = build()
    for (let i = 0; i <= 7; i++) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
  })
})

describe('Codex page formatting', () => {
  it('formats common rate-limit windows', () => {
    expect(limitLabel(300)).toBe('5-HR CAP')
    expect(limitLabel(10080)).toBe('WEEK CAP')
  })

  it('formats token counts compactly', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(12_400)).toBe('12.4K')
    expect(formatTokenCount(15_200_000)).toBe('15M')
  })

  it('formats a reset countdown', () => {
    expect(formatResetIn(NOW + 3600, NOW)).toBe('1h0m')
    expect(formatResetIn(NOW - 1, NOW)).toBe('ELAPSED')
    expect(formatResetIn(NOW, NOW)).toBe('ELAPSED')
    expect(formatResetIn(null, NOW)).toBe('--')
  })
})
