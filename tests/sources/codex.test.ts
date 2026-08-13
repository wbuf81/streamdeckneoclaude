import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log, setDefaultSink } from '../../src/log.js'

// Isolated exactly the way `tests/sources/codex-run-sqlite.test.ts` isolates
// its own `execFile` mock: `vi.mock`'s factory is hoisted above every
// top-level statement in this file, including a plain `const`, so the mock
// function itself must be created inside `vi.hoisted`. Mocking
// `node:child_process` here is safe for every OTHER test in this file — all
// of them inject their own `SqliteRunner` fake and never call the real
// `runSqlite` at all, so they never reach `execFile` regardless of what it
// is mocked to do.
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (
        error: (Error & { killed?: boolean; code?: unknown; signal?: unknown }) | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => cb(null, '[]', ''),
  ),
}))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  CodexSource,
  parseRolloutTail,
  readRolloutTail,
  runSqlite,
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

describe('runSqlite', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('reads via the primary mode=ro URI when it succeeds', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '[]', ''))
    const result = await runSqlite('/tmp/does-not-matter.sqlite', THREAD_QUERY)
    expect(result).toBe('[]')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [cmd, args] = execFileMock.mock.calls[0]!
    expect(cmd).toBe('/usr/bin/sqlite3')
    expect(args).toContain('-json')
    const uri = args.find((arg) => arg.startsWith('file:'))
    expect(uri).toContain('mode=ro')
    expect(uri).not.toContain('immutable')
  })

  it('falls back to immutable=1 when the primary mode=ro attempt fails with error 14', async () => {
    let call = 0
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      call += 1
      if (call === 1) {
        cb(new Error('exit 1'), '', 'Error: in prepare, unable to open database file (14)\n')
      } else {
        cb(null, '[]', '')
      }
    })
    const result = await runSqlite('/tmp/does-not-matter.sqlite', THREAD_QUERY)
    expect(result).toBe('[]')
    expect(execFileMock).toHaveBeenCalledTimes(2)
    const fallbackArgs = execFileMock.mock.calls[1]![1]
    const fallbackUri = fallbackArgs.find((arg) => arg.startsWith('file:'))
    expect(fallbackUri).toContain('mode=ro')
    expect(fallbackUri).toContain('immutable=1')
  })

  it('rejects with a short, query-free error when both the primary and fallback attempts fail', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error('exit 1'), '', 'Error: in prepare, unable to open database file (14)\n')
    })
    let message = ''
    try {
      await runSqlite('/tmp/does-not-matter.sqlite', THREAD_QUERY)
      throw new Error('expected runSqlite to reject')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(message).toContain('(14)')
    expect(message).not.toContain('SELECT')
    expect(message).not.toContain(THREAD_QUERY)
  })

  it('reports a timeout without leaking the query when both attempts are killed', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(Object.assign(new Error('exit 1'), { killed: true }), '', '')
    })
    let message = ''
    try {
      await runSqlite('/tmp/does-not-matter.sqlite', THREAD_QUERY)
      throw new Error('expected runSqlite to reject')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message.toLowerCase()).toContain('timed out')
    expect(message).not.toContain(THREAD_QUERY)
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

  it('reports usage as unknown before any sample has ever arrived', () => {
    const source = new CodexSource('/does/not/matter', async () => '[]', () => fixedRead(''), () => 0)
    expect(source.isUsageUnknown()).toBe(true)
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

  // Exercises the REAL `runSqlite` (the constructor's default `sqlite`
  // param, not an injected fake), through the mocked `execFile`, so this
  // covers the whole path: both open modes failing shows an honest unknown
  // state rather than a fabricated number (the Critical fix commit 185bcb4
  // established), the daemon logs exactly one line across repeated failing
  // polls rather than filling the log every 5 s (lesson 5), that line
  // carries no SQL body (lesson 20 — Codex's private schema, including its
  // query, must never reach a log), and a later recovery clears the
  // once-key so a SUBSEQUENT failure logs again instead of going silent
  // forever.
  it('shows an honest unknown state and logs exactly once across repeated failures when both sqlite modes fail, then logs again after a recovery and a later failure', async () => {
    // Guards against a dedup key left "seen" by another test earlier in
    // this file's shared `log` instance (module state is shared across all
    // `it` blocks in one test file, even though each file gets its own).
    log.clearOnce('codex-state-read')
    execFileMock.mockReset()
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const lines: string[] = []
    setDefaultSink((line) => { lines.push(line) })
    const failing = (_cmd: string, _args: string[], _opts: unknown, cb: (
      error: Error | null, stdout: string, stderr: string,
    ) => void) => cb(new Error('exit 1'), '', 'Error: in prepare, unable to open database file (14)\n')
    const succeeding = (_cmd: string, _args: string[], _opts: unknown, cb: (
      error: Error | null, stdout: string, stderr: string,
    ) => void) => cb(null, '[]', '')
    try {
      execFileMock.mockImplementation(failing)
      // `sqlite` left at its default (`runSqlite`) by passing `undefined`.
      const source = new CodexSource(database, undefined, () => fixedRead(''), () => 500)
      await source.refresh()
      await source.refresh()
      await source.refresh()
      expect(source.isAvailable()).toBe(false)
      expect(source.getSnapshot()).toEqual({ tasks: [], usage: null }) // unknown, never fabricated.

      const failureLines = lines.filter((line) => line.includes('cannot read Codex task data'))
      expect(failureLines).toHaveLength(1) // one line across three failing polls.
      expect(failureLines[0]).toContain(database)
      expect(failureLines[0]).toContain('(14)')
      expect(failureLines[0]).not.toContain('SELECT')
      expect(failureLines[0]).not.toContain(THREAD_QUERY)

      execFileMock.mockImplementation(succeeding)
      await source.refresh()
      expect(source.isAvailable()).toBe(true) // recovered.

      execFileMock.mockImplementation(failing)
      await source.refresh()
      const failureLinesAfterRecovery = lines.filter((line) => line.includes('cannot read Codex task data'))
      expect(failureLinesAfterRecovery).toHaveLength(2) // the cleared key let this one log again.

      await source.stop()
    } finally {
      setDefaultSink(() => {})
      log.clearOnce('codex-state-read')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CodexSource.isUsageUnknown', () => {
  const WINDOW_MINUTES = 300 // A 5-hour rolling window: 18,000 seconds.
  const WINDOW_SECONDS = WINDOW_MINUTES * 60

  function usageEvent(opts: { ts: number; windowMinutes: number; resetsAt?: number }): string {
    return JSON.stringify({
      timestamp: new Date(opts.ts * 1000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 1 } },
        rate_limits: {
          primary: {
            used_percent: 50,
            window_minutes: opts.windowMinutes,
            ...(opts.resetsAt === undefined ? {} : { resets_at: opts.resetsAt }),
          },
          secondary: null,
          plan_type: 'team',
        },
      },
    })
  }

  async function isUsageUnknownAt(now: number, event: string): Promise<boolean> {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    // One row so `doRefresh` actually calls `readTail` and parses `event`
    // into `newestUsage` — a sqlite result with no rows never reaches the
    // rollout at all. Its own `active`/task fields are irrelevant here.
    const sqlite = vi.fn(async () => JSON.stringify([
      { id: 'x', rollout_path: '/x.jsonl', updated_at_ms: 0, title: '', cwd: '', model: '', tokens_used: null },
    ]))
    const source = new CodexSource(database, sqlite, () => fixedRead(`${event}\n`), () => now)
    try {
      await source.refresh()
      return source.isUsageUnknown()
    } finally {
      await source.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('treats a sample as unknown once the window it describes has since reset', async () => {
    const resetsAt = 1_000
    const event = usageEvent({ ts: resetsAt - 10, windowMinutes: WINDOW_MINUTES, resetsAt })
    expect(await isUsageUnknownAt(resetsAt + 1, event)).toBe(true)
  })

  it('keeps a sample live shortly after the window it describes has started', async () => {
    const resetsAt = 1_000 + WINDOW_SECONDS
    const event = usageEvent({ ts: 1_005, windowMinutes: WINDOW_MINUTES, resetsAt })
    expect(await isUsageUnknownAt(2_000, event)).toBe(false)
  })

  it('keeps a recent sample live when resets_at is absent, via the backstop', async () => {
    const ts = 10_000
    const event = usageEvent({ ts, windowMinutes: WINDOW_MINUTES })
    expect(await isUsageUnknownAt(ts + 10, event)).toBe(false)
  })

  it('treats a four-day-old sample as unknown when resets_at is absent', async () => {
    const ts = 10_000
    const event = usageEvent({ ts, windowMinutes: WINDOW_MINUTES })
    expect(await isUsageUnknownAt(ts + 4 * 24 * 3600, event)).toBe(true)
  })

  it('treats an old sample as unknown when its own resets_at describes a window that has not started yet', async () => {
    // resets_at (30,000) describes a window starting at 30,000 - 18,000 =
    // 12,000. `now` below (5,000) is still short of that start, so the
    // sample belongs to whatever window preceded it, not the one resets_at
    // names — even though resets_at itself is still ahead of `now`.
    const event = usageEvent({ ts: 0, windowMinutes: WINDOW_MINUTES, resetsAt: 30_000 })
    expect(await isUsageUnknownAt(5_000, event)).toBe(true)
  })
})
