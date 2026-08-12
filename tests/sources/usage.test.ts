import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UsageSource,
  computePace,
  parseUsage,
  STALE_USAGE_SECONDS,
} from '../../src/sources/usage.js'

const FIVE_HOURS = 5 * 3600
const NOW = 1786549560

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
})
