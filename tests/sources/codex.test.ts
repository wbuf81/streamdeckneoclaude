import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexSource,
  parseRolloutTail,
  readRolloutTail,
  COLD_START_TAIL_BYTES,
  THREAD_QUERY,
  type RolloutRead,
} from '../../src/sources/codex.js'

const TOKEN_EVENT = JSON.stringify({
  timestamp: '2026-08-13T12:00:00.000Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { total_tokens: 1_250_000 } },
    rate_limits: {
      primary: { used_percent: 27, window_minutes: 10080, resets_at: 1787068486 },
      secondary: null,
      plan_type: 'team',
    },
  },
})

/** Fixed reader for tests that inject their own `readTail`. Matches the
 * `RolloutTailReader` shape, including `consumedTo`. */
function fixedRead(text: string): RolloutRead {
  return { text, size: text.length, consumedTo: text.length }
}

describe('parseRolloutTail', () => {
  it('reports a task active when the newest lifecycle event is task_started', () => {
    const text = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    ].join('\n')
    expect(parseRolloutTail(text).active).toBe(true)
  })

  it('reports a task complete when completion follows its start', () => {
    const text = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n')
    expect(parseRolloutTail(text).active).toBe(false)
  })

  it('extracts limits, plan and total tokens without reading message bodies', () => {
    const state = parseRolloutTail(TOKEN_EVENT)
    expect(state.usage).toMatchObject({ totalTokens: 1_250_000, plan: 'team' })
    expect(state.usage?.limits[0]).toEqual({
      usedPct: 27, windowMinutes: 10080, resetsAt: 1787068486,
    })
  })

  it('ignores malformed and unrelated lines', () => {
    expect(parseRolloutTail('not json\n{"type":"response_item"}')).toEqual({
      active: false, usage: null,
    })
  })

  // C1 — the review's exact repro: Codex renames `used_percent` and the
  // total-tokens field. A missing or renamed field must parse as UNKNOWN
  // (null), never as a fabricated, confident `0`.
  it('reports usedPct and totalTokens as unknown, not 0, when their fields are renamed', () => {
    const event = JSON.stringify({
      timestamp: '2026-08-13T12:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { renamed_total_tokens: 1_250_000 } },
        rate_limits: {
          primary: { used_percentage_renamed: 95, window_minutes: 10080, resets_at: 1787068486 },
          secondary: null,
          plan_type: 'team',
        },
      },
    })
    const state = parseRolloutTail(event)
    expect(state.usage?.totalTokens).toBeNull()
    expect(state.usage?.limits[0]).toEqual({
      usedPct: null, windowMinutes: 10080, resetsAt: 1787068486,
    })
  })

  it('still fails the whole limit closed when window_minutes itself is absent', () => {
    const event = JSON.stringify({
      timestamp: '2026-08-13T12:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {},
        rate_limits: { primary: { used_percent: 50 }, secondary: null, plan_type: 'team' },
      },
    })
    expect(parseRolloutTail(event).usage?.limits).toEqual([])
  })

  // M2 — a resets_at that looks like epoch milliseconds (Codex's own sqlite
  // already writes updated_at_ms and created_at_ms that way) must not render
  // a multi-million-day countdown. Treated as unknown instead of guessed at.
  it('treats an out-of-range resets_at (looks like milliseconds) as unknown', () => {
    const event = JSON.stringify({
      timestamp: '2026-08-13T12:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {},
        rate_limits: {
          primary: { used_percent: 10, window_minutes: 10080, resets_at: 1_787_068_486_000 },
          secondary: null,
          plan_type: 'team',
        },
      },
    })
    expect(parseRolloutTail(event).usage?.limits[0]?.resetsAt).toBeNull()
  })
})

describe('readRolloutTail', () => {
  it('bounds a cold read (no requestedStart) to the trailing window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const file = join(dir, 'rollout.jsonl')
    try {
      const filler = 'x'.repeat(COLD_START_TAIL_BYTES * 2)
      writeFileSync(file, `${filler}\nMARKER\n`)
      const read = readRolloutTail(file)
      expect(read.text.length).toBeLessThanOrEqual(COLD_START_TAIL_BYTES)
      expect(read.text).toContain('MARKER')
      expect(read.consumedTo).toBe(read.size)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('honours an explicit requestedStart of 0 exactly, without treating it as a cold start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const file = join(dir, 'rollout.jsonl')
    try {
      const filler = 'x'.repeat(COLD_START_TAIL_BYTES * 2)
      writeFileSync(file, filler)
      const read = readRolloutTail(file, 0)
      expect(read.text.length).toBe(filler.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('THREAD_QUERY', () => {
  // I6 — a live title measured at 42,081 characters. The column is selected
  // truncated, so neither the 1 MB execFile buffer nor this source's own
  // retained snapshot can grow unbounded from one long title.
  it('truncates title in the SQL itself, rather than retaining it whole', () => {
    expect(THREAD_QUERY).toContain('substr(title, 1, 64)')
  })
})

describe('CodexSource', () => {
  it('keeps only active user tasks and publishes the newest usage sample', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const sqlite = vi.fn(async () => JSON.stringify([
      {
        id: 'active', rollout_path: '/active.jsonl', updated_at_ms: 200000,
        title: 'Build the Codex page', cwd: '/work/deckd', model: 'gpt-5.6-sol', tokens_used: 1234,
      },
      {
        id: 'done', rollout_path: '/done.jsonl', updated_at_ms: 100000,
        title: 'Old work', cwd: '/work/old', model: 'gpt-5.6-sol', tokens_used: 99,
      },
    ]))
    const readTail = (file: string) => {
      const text = file.includes('active')
        ? `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n${TOKEN_EVENT}\n`
        : `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`
      return fixedRead(text)
    }
    const source = new CodexSource(database, sqlite, readTail, () => 500)
    try {
      await source.refresh()
      expect(source.isAvailable()).toBe(true)
      expect(source.getSnapshot().tasks).toEqual([expect.objectContaining({
        threadId: 'active', project: 'deckd', title: 'Build the Codex page',
      })])
      expect(source.getSnapshot().usage?.totalTokens).toBe(1_250_000)
    } finally {
      await source.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed to unavailable when the Codex schema cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const source = new CodexSource(database, async () => { throw new Error('schema changed') })
    try {
      await source.refresh()
      expect(source.isAvailable()).toBe(false)
      expect(source.getSnapshot().tasks).toEqual([])
    } finally {
      await source.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // I4 — Codex dies mid-task: no task_complete line is ever appended, so the
  // rollout alone would say `active` forever. The thread's own updated_at_ms
  // stops moving at the same moment, and that is what this guard reads.
  it('drops a task whose thread row has not updated recently, even though the rollout still marks it active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const veryOldUpdatedAtMs = 1000 // 1 second, in epoch ms
    const sqlite = vi.fn(async () => JSON.stringify([{
      id: 'zombie', rollout_path: '/zombie.jsonl', updated_at_ms: veryOldUpdatedAtMs,
      title: 'Stuck task', cwd: '/work/deckd', model: 'gpt-5.6-sol', tokens_used: 1,
    }]))
    const readTail = () => fixedRead(
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
    )
    // now() is far past updated_at_ms plus the 4-hour age guard.
    const source = new CodexSource(database, sqlite, readTail, () => 1_000_000)
    try {
      await source.refresh()
      expect(source.isAvailable()).toBe(true)
      expect(source.getSnapshot().tasks).toEqual([])
    } finally {
      await source.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps a recently active task whose thread row is well within the age guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const sqlite = vi.fn(async () => JSON.stringify([{
      id: 'live', rollout_path: '/live.jsonl', updated_at_ms: 400_000,
      title: 'Live task', cwd: '/work/deckd', model: 'gpt-5.6-sol', tokens_used: 1,
    }]))
    const readTail = () => fixedRead(
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
    )
    const source = new CodexSource(database, sqlite, readTail, () => 500)
    try {
      await source.refresh()
      expect(source.getSnapshot().tasks).toHaveLength(1)
    } finally {
      await source.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // C2 — the sqlite read can keep succeeding every poll while the usage
  // SAMPLE it carries is days old, because Codex only emits a fresh
  // token_count event when the app itself does work.
  it('reports usage as stale by its own sample age, independent of the read succeeding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const sqlite = vi.fn(async () => JSON.stringify([]))
    // The event's own timestamp is 2026-08-13T12:00:00Z (see TOKEN_EVENT),
    // 1786622400 in epoch seconds. `now()` below is three days later.
    const threeDaysLater = 1786622400 + 3 * 24 * 3600
    const readTail = () => fixedRead(`${TOKEN_EVENT}\n`)
    const source = new CodexSource(database, sqlite, readTail, () => threeDaysLater)
    try {
      await source.refresh()
      expect(source.isStale()).toBe(false) // the read itself just succeeded.
      expect(source.isUsageStale()).toBe(true) // but the sample is three days old.
    } finally {
      await source.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports usage as stale before any sample has ever arrived', () => {
    const source = new CodexSource('/does/not/matter', async () => '[]', () => fixedRead(''), () => 0)
    expect(source.isUsageStale()).toBe(true)
  })

  // I9 / lesson 8 — a refresh triggered by setVisible(true) must not arm a
  // new timer after stop() has already run, even though the refresh itself
  // settles afterwards. The sqlite call is held UNRESOLVED here so the race
  // window is actually open; with fake timers alone the promise would
  // settle before stop() ever runs, and the test would pass against broken
  // code.
  it('does not arm a new timer when stop() runs while a visibility-triggered refresh is still in flight', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    let resolveSqlite!: (v: string) => void
    const sqlite = vi.fn(() => new Promise<string>((resolve) => { resolveSqlite = resolve }))
    const readTail = () => fixedRead('')
    const source = new CodexSource(database, sqlite, readTail, () => 500)
    try {
      source.setVisible(true) // Starts a refresh that blocks on the unresolved sqlite call.
      expect(sqlite).toHaveBeenCalledTimes(1)

      const stopPromise = source.stop() // Races the in-flight refresh.

      resolveSqlite('[]')
      await stopPromise
      await vi.advanceTimersByTimeAsync(0)

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('polls only while the page is visible', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const sqlite = vi.fn(async () => '[]')
    const source = new CodexSource(database, sqlite, () => fixedRead(''), () => 500)
    try {
      source.setVisible(true)
      await vi.advanceTimersByTimeAsync(0)
      const afterFirst = sqlite.mock.calls.length
      source.setVisible(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sqlite.mock.calls.length).toBe(afterFirst)
    } finally {
      vi.useRealTimers()
      await source.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
