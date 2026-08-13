import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UsageSource,
  computePace,
  parseUsage,
  elapsedPercent,
  STALE_USAGE_SECONDS,
} from '../../src/sources/usage.js'

const FIVE_HOURS = 5 * 3600
const NOW = 1786549560

// M6, same family as I1: a `resetsAt` already in the past must not produce
// an elapsed percentage past 100. Break the fix (drop the `Math.min(100,
// ...)` clamp) and the first case here fails.
describe('elapsedPercent', () => {
  it('clamps to 100 when resetsAt is already in the past', () => {
    const resetsAt = NOW - FIVE_HOURS
    expect(elapsedPercent(resetsAt, FIVE_HOURS, NOW)).toBe(100)
  })

  it('reports exactly 100 right at the window boundary', () => {
    expect(elapsedPercent(NOW, FIVE_HOURS, NOW)).toBe(100)
  })

  it('reports 50 at the midpoint of a fresh window', () => {
    expect(elapsedPercent(NOW + FIVE_HOURS / 2, FIVE_HOURS, NOW)).toBe(50)
  })
})

describe('computePace', () => {
  it('is fast when usage leads elapsed time', () => {
    // Half the window is gone, so elapsed is 50 percent. Usage is 80 percent.
    const resetsAt = NOW + FIVE_HOURS / 2
    expect(computePace(80, resetsAt, FIVE_HOURS, NOW)).toBe('fast')
  })

  it('is slow when usage trails elapsed time', () => {
    const resetsAt = NOW + FIVE_HOURS / 2
    expect(computePace(20, resetsAt, FIVE_HOURS, NOW)).toBe('slow')
  })

  it('is even inside the 5 point band', () => {
    const resetsAt = NOW + FIVE_HOURS / 2
    expect(computePace(52, resetsAt, FIVE_HOURS, NOW)).toBe('even')
    expect(computePace(48, resetsAt, FIVE_HOURS, NOW)).toBe('even')
  })

  it('is even when resetsAt is missing', () => {
    expect(computePace(50, 0, FIVE_HOURS, NOW)).toBe('even')
  })

  it('is even at the very start of a window', () => {
    expect(computePace(0, NOW + FIVE_HOURS, FIVE_HOURS, NOW)).toBe('even')
  })

  // M6 — before the clamp, a `resetsAt` well in the past drove `elapsedPct`
  // past 100, so `usedPct` (capped at 100) could never catch up and this
  // reported `slow` permanently, regardless of how current usage compared to
  // the window. With the clamp, a fully-used window against a long-expired
  // `resetsAt` is `even`, not `slow`.
  it('does not report permanently slow once resetsAt is long past', () => {
    const resetsAt = NOW - 10 * FIVE_HOURS
    expect(computePace(100, resetsAt, FIVE_HOURS, NOW)).toBe('even')
  })
})

describe('parseUsage', () => {
  it('reads the four rate limit fields', () => {
    const u = parseUsage(JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 62.4, resets_at: NOW + 7860 },
        seven_day: { used_percentage: 34, resets_at: NOW + 345600 },
      },
      ts: NOW,
    }))!
    expect(u.fiveHourPct).toBe(62.4)
    expect(u.fiveHourResetsAt).toBe(NOW + 7860)
    expect(u.sevenDayPct).toBe(34)
    expect(u.ts).toBe(NOW)
  })

  it('returns null percentages when the fields are absent', () => {
    const u = parseUsage(JSON.stringify({ rate_limits: {}, ts: NOW }))!
    expect(u.fiveHourPct).toBeNull()
    expect(u.sevenDayPct).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseUsage('{ nope')).toBeNull()
  })
})

describe('UsageSource', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-usage-'))
    mkdirSync(join(dir, 'sessions'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (obj: unknown) =>
    writeFileSync(join(dir, 'usage.json'), JSON.stringify(obj))

  it('returns null when the usage file is absent', async () => {
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.getUsage()).toBeNull()
    await s.stop()
  })

  it('reads a fresh usage file', async () => {
    write({
      rate_limits: {
        five_hour: { used_percentage: 62, resets_at: NOW + 100 },
        seven_day: { used_percentage: 34, resets_at: NOW + 200 },
      },
      ts: NOW,
    })
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.getUsage()!.fiveHourPct).toBe(62)
    expect(s.isStale()).toBe(false)
    await s.stop()
  })

  it('reports stale past the limit', async () => {
    write({ rate_limits: {}, ts: NOW - STALE_USAGE_SECONDS - 1 })
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.isStale()).toBe(true)
    await s.stop()
  })

  it('is not stale exactly at the limit', async () => {
    write({ rate_limits: {}, ts: NOW - STALE_USAGE_SECONDS })
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.isStale()).toBe(false)
    await s.stop()
  })

  it('reads a per-session model name', async () => {
    writeFileSync(
      join(dir, 'sessions', 'aaaa.json'),
      JSON.stringify({ model: 'Opus 5', ctxPct: 41, costUsd: 1.23, ts: NOW }),
    )
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.getMeta('aaaa')!.model).toBe('Opus 5')
    await s.stop()
  })

  it('returns null meta for an unknown session', async () => {
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.getMeta('nope')).toBeNull()
    await s.stop()
  })

  it('ignores a corrupt per-session file', async () => {
    writeFileSync(join(dir, 'sessions', 'bad.json'), '{ truncated')
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.getMeta('bad')).toBeNull()
    await s.stop()
  })

  it('does not emit change when nothing changed', async () => {
    write({ rate_limits: {}, ts: NOW })
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    let changes = 0
    s.on('change', () => { changes += 1 })
    await s.refresh()
    await s.refresh()
    expect(changes).toBe(0)
    await s.stop()
  })

  it('emits change when only a per-session file changes, usage.json untouched', async () => {
    // usage.json is byte-identical across both refreshes here. Only a
    // per-session file changes. A key built from readUsage() alone would
    // miss this, and getMeta() would return new data with no `change` to
    // tell a listener to redraw. That is the bug ClaudeSource hit once,
    // fixed by keying on the whole snapshot instead of a few fields.
    const usagePayload = {
      rate_limits: {
        five_hour: { used_percentage: 62, resets_at: NOW + 100 },
        seven_day: { used_percentage: 34, resets_at: NOW + 200 },
      },
      ts: NOW,
    }
    write(usagePayload)
    writeFileSync(
      join(dir, 'sessions', 'aaaa.json'),
      JSON.stringify({ model: 'Sonnet 5', ctxPct: 10, costUsd: 0.1, ts: NOW }),
    )
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    let changes = 0
    s.on('change', () => { changes += 1 })

    const before = readFileSync(join(dir, 'usage.json'), 'utf8')
    writeFileSync(
      join(dir, 'sessions', 'aaaa.json'),
      JSON.stringify({ model: 'Opus 5', ctxPct: 10, costUsd: 0.1, ts: NOW }),
    )
    expect(readFileSync(join(dir, 'usage.json'), 'utf8')).toBe(before)

    await s.refresh()
    expect(changes).toBeGreaterThan(0)
    expect(s.getMeta('aaaa')!.model).toBe('Opus 5')
    await s.stop()
  })

  // I2 — `getUsage()` and `getMeta()` used to return the live cached objects
  // directly. Break either fix (drop the `{ ...x }` spread) and the
  // corresponding assertion below fails.
  it('returns a copy from getUsage, so mutating the result cannot corrupt the source', async () => {
    write({
      rate_limits: { five_hour: { used_percentage: 62, resets_at: NOW + 100 } },
      ts: NOW,
    })
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    const usage = s.getUsage()!
    usage.fiveHourPct = -1
    expect(s.getUsage()!.fiveHourPct).toBe(62)
    await s.stop()
  })

  it('returns a copy from getMeta, so mutating the result cannot corrupt the source', async () => {
    writeFileSync(
      join(dir, 'sessions', 'aaaa.json'),
      JSON.stringify({ model: 'Opus 5', ctxPct: 41, costUsd: 1.23, ts: NOW }),
    )
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    const meta = s.getMeta('aaaa')!
    meta.model = 'HACKED'
    expect(s.getMeta('aaaa')!.model).toBe('Opus 5')
    await s.stop()
  })

  // M2 — `usage.ts` watched the same kind of directory as `ClaudeSource`,
  // with the same rename-based writer, but had no debounce: a rename fires
  // more than once, and the statusline wrapper rewrites `usage.json` on
  // every Claude Code render. Exercises the debounce mechanism directly
  // (not real fs.watch timing, which is OS-dependent and would make this
  // test flaky): two events scheduled back to back collapse into one
  // refresh. Break the fix (call `void this.refresh()` straight from the
  // watcher again) and this fails with 2 calls instead of 1.
  it('coalesces a burst of scheduled refreshes into one', async () => {
    vi.useFakeTimers()
    const s = new UsageSource(dir, () => NOW)
    try {
      await s.start()
      const refreshSpy = vi.spyOn(s, 'refresh')
      const scheduleRefresh = (s as unknown as { scheduleRefresh(): void }).scheduleRefresh.bind(s)
      scheduleRefresh()
      scheduleRefresh()
      await vi.advanceTimersByTimeAsync(60)
      expect(refreshSpy).toHaveBeenCalledTimes(1)
    } finally {
      await s.stop()
      vi.useRealTimers()
    }
  })
})
