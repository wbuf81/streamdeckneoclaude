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
  type SqliteRead,
} from '../../src/sources/codex.js'

/** A non-degraded `SqliteRead`, for tests that inject a `SqliteRunner` fake
 * and only care about the text — matches what a primary `mode=ro` read
 * returns. */
function ok(text: string): SqliteRead {
  return { text, degraded: false }
}

/** A degraded `SqliteRead`, as if it came from the `immutable=1` fallback.
 * See `runSqlite`'s own doc comment in src/sources/codex.ts for why a
 * degraded read must never satisfy a freshness check or log the same way a
 * total failure does. */
function degraded(text: string): SqliteRead {
  return { text, degraded: true }
}

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

  // I6 — a window_minutes that looks like the same figure in milliseconds
  // (Codex's own sqlite already writes updated_at_ms and created_at_ms that
  // way) must not survive to defeat isUsageUnknown's two-sided check or
  // print a multi-hundred-thousand-day label. The whole limit fails closed,
  // the same pattern already in place for resets_at.
  it('drops the whole limit when window_minutes looks like the same value in milliseconds', () => {
    const event = JSON.stringify({
      timestamp: '2026-08-13T12:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {},
        rate_limits: {
          // 604,800,000 ms is 7 days — the review's exact repro.
          primary: { used_percent: 96, window_minutes: 604_800_000, resets_at: 1787068486 },
          secondary: null,
          plan_type: 'team',
        },
      },
    })
    expect(parseRolloutTail(event).usage?.limits).toEqual([])
  })

  // I1 — `usage.ts` must be `null`, never a fabricated `0` (which rendered
  // as 7:00 PM EST 1969 beside a confident percentage), when the event's own
  // `timestamp` is not a string.
  it('reports ts as null, not a fabricated 0, when timestamp is not a string', () => {
    const event = JSON.stringify({
      timestamp: 1755000000000, // a number, not a string.
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 1 } },
        rate_limits: {
          primary: { used_percent: 96, window_minutes: 10080, resets_at: 1787068486 },
          secondary: null,
          plan_type: 'team',
        },
      },
    })
    expect(parseRolloutTail(event).usage?.ts).toBeNull()
  })

  it('reports ts as null when timestamp is a string Date.parse cannot read', () => {
    const event = JSON.stringify({
      timestamp: 'not-a-date',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {},
        rate_limits: { primary: { used_percent: 1, window_minutes: 10080 }, secondary: null, plan_type: 'team' },
      },
    })
    expect(parseRolloutTail(event).usage?.ts).toBeNull()
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

  // M1 — a shrunken (rotated or compacted) rollout must still respect the
  // cold-start cap, not fall back to an unbounded whole-file read. Before
  // the fix, `requestedStart > size` resolved to `start = 0`.
  it('bounds a read whose remembered offset now exceeds the shrunken file, instead of reading the whole file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const file = join(dir, 'rollout.jsonl')
    try {
      const filler = 'x'.repeat(COLD_START_TAIL_BYTES * 2)
      writeFileSync(file, `${filler}\nMARKER\n`) // the file the cursor was last read at.
      const staleOffset = filler.length * 2 // a remembered offset from BEFORE the shrink.
      const read = readRolloutTail(file, staleOffset)
      expect(read.text.length).toBeLessThanOrEqual(COLD_START_TAIL_BYTES)
      expect(read.text).toContain('MARKER')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // M3 — lesson 5's second half: a full, non-short read must clear the
  // short-read log key, so a LATER short read logs again instead of going
  // silent for the rest of the process. A genuine short read on a local
  // regular file is not reproducible on demand (per the code's own
  // comment), so this seeds the "already logged" state directly through the
  // shared `log` singleton and checks that a normal read clears it.
  it('clears the short-read log key on a normal, full read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const file = join(dir, 'rollout.jsonl')
    const lines: string[] = []
    setDefaultSink((line) => { lines.push(line) })
    log.clearOnce('codex-rollout-short-read')
    try {
      writeFileSync(file, 'hello\n')
      log.once('codex-rollout-short-read', 'seed-message') // simulate a prior short read already logged.
      expect(lines).toHaveLength(1)
      readRolloutTail(file, 0) // a normal, full, non-short read.
      log.once('codex-rollout-short-read', 'after-clear-message')
      expect(lines).toHaveLength(2) // logged again: the key was cleared.
      expect(lines[1]).toContain('after-clear-message')
    } finally {
      setDefaultSink(() => {})
      log.clearOnce('codex-rollout-short-read')
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

  it('reads via mode=ro on the first attempt, tagged non-degraded, and never mentions immutable', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '[]', ''))
    const result = await runSqlite('/tmp/does-not-matter.sqlite', THREAD_QUERY)
    expect(result).toEqual({ text: '[]', degraded: false })
    // A successful primary attempt needs no fallback: exactly one call.
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [cmd, args] = execFileMock.mock.calls[0]!
    expect(cmd).toBe('/usr/bin/sqlite3')
    expect(args).toContain('-json')
    // The `-readonly` flag was measured to add nothing on top of the URI's
    // own `mode=ro` (docs/VERIFIED-FACTS.md) and is dropped as redundant.
    expect(args).not.toContain('-readonly')
    const uri = args.find((arg) => arg.startsWith('file:'))
    expect(uri).toContain('mode=ro')
    expect(uri).not.toContain('immutable')
  })

  // Restores the fallback an earlier version of this file removed entirely
  // on the strength of a now-corrected measurement (docs/VERIFIED-FACTS.md):
  // with the `-wal`/`-shm` sidecars absent, `mode=ro` fails with
  // `SQLITE_CANTOPEN (14)` because a read-only connection cannot create the
  // `-shm` it needs. `immutable=1` succeeds in exactly that case. The
  // fallback's result must come back tagged `degraded: true`, never
  // indistinguishable from a primary success.
  it('falls back to immutable=1 and succeeds, tagged degraded, when mode=ro fails', async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args.some((arg) => arg.includes('immutable'))) { cb(null, '[]', ''); return }
      cb(new Error('exit 1'), '', 'Error: in prepare, unable to open database file (14)\n')
    })
    const result = await runSqlite('/tmp/does-not-matter.sqlite', THREAD_QUERY)
    expect(result).toEqual({ text: '[]', degraded: true })
    expect(execFileMock).toHaveBeenCalledTimes(2)
    const secondUri = execFileMock.mock.calls[1]![1].find((arg: string) => arg.startsWith('file:'))
    expect(secondUri).toContain('mode=ro')
    expect(secondUri).toContain('immutable=1')
  })

  // C1's exact reachability scenario still matters, and is exactly why a
  // degraded read is never trusted outright: a live writer holding the
  // database under an exclusive lock makes `mode=ro` fail with "database is
  // locked (5)" AND makes `immutable=1` succeed, handing back pre-checkpoint
  // rows. This test only covers the shape of the attempt (both modes are
  // tried); `CodexSource`'s handling of the resulting `degraded: true` read
  // — never satisfying a freshness check, always rendering dimmed — is
  // covered separately below and in tests/pages/codex-page.test.ts.
  it('tries both mode=ro and immutable=1 for the exact "database is locked" error a live writer produces, and surfaces the primary error if both fail', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error('exit 1'), '', 'Error: in prepare, database is locked (5)\n')
    })
    let message = ''
    try {
      await runSqlite('/tmp/does-not-matter.sqlite', THREAD_QUERY)
      throw new Error('expected runSqlite to reject')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // Both attempts were made: the primary, then the fallback.
    expect(execFileMock).toHaveBeenCalledTimes(2)
    // The PRIMARY error is what surfaces — the fallback existing at all is
    // an implementation detail a diagnostic message should not dwell on.
    expect(message).toContain('(5)')
    expect(message).not.toContain('SELECT')
    expect(message).not.toContain(THREAD_QUERY)
  })

  it('rejects with a short, query-free error when both mode=ro and immutable=1 fail with SQLITE_CANTOPEN', async () => {
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
    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(message.toLowerCase()).toContain('timed out')
    expect(message).not.toContain(THREAD_QUERY)
  })

  // M2 — a malformed `database` path cannot escape `mode=ro` by injecting a
  // second query parameter. `?` is percent-encoded, so an attempt to smuggle
  // `?mode=rwc` in through the path becomes a literal, harmless filename
  // character instead of a second URI parameter.
  it('percent-encodes a `?` in the database path so it cannot inject a second mode parameter', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '[]', ''))
    await runSqlite('/tmp/evil.sqlite?mode=rwc', THREAD_QUERY)
    const args = execFileMock.mock.calls[0]![1]
    const uri = args.find((arg) => arg.startsWith('file:'))!
    // Exactly one literal, un-escaped `?` in the whole URI — the one this
    // function appends for its own query. The path's OWN `?` was
    // percent-encoded away, so it cannot introduce a second `?mode=` that
    // would override the real one.
    expect(uri.split('?')).toHaveLength(2)
    expect(uri.endsWith('?mode=ro')).toBe(true)
    expect(uri).toContain('%3Fmode=rwc')
  })
})

describe('CodexSource', () => {
  it('keeps only active user tasks and publishes the newest usage sample', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const sqlite = vi.fn(async () => ok(JSON.stringify([
      {
        id: 'active', rollout_path: '/active.jsonl', updated_at_ms: 200000,
        title: 'Build the Codex page', cwd: '/work/deckd', model: 'gpt-5.6-sol', tokens_used: 1234,
      },
      {
        id: 'done', rollout_path: '/done.jsonl', updated_at_ms: 100000,
        title: 'Old work', cwd: '/work/old', model: 'gpt-5.6-sol', tokens_used: 99,
      },
    ])))
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

  // This test injects a `SqliteRunner` fake that always throws, standing in
  // for `runSqlite` itself having exhausted BOTH its primary and fallback
  // attempts (see tests/sources/codex-run-sqlite.test.ts for that pair
  // failing together, and the real-database repro in
  // tests/sources/codex-degraded-wal.test.ts). `CodexSource` must report
  // UNAVAILABLE here — never silently substitute a stale snapshot with
  // `available = true`. No task rows or usage sample ever reach the
  // snapshot from this failure.
  it('reports unavailable, never a stale substitute, when the sqlite injector fails with the exact "database is locked" error a live writer produces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const source = new CodexSource(
      database,
      async () => { throw new Error('in prepare, database is locked (5)') },
    )
    try {
      await source.refresh()
      expect(source.isAvailable()).toBe(false)
      expect(source.getSnapshot()).toEqual({ tasks: [], usage: null })
    } finally {
      await source.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // M6 — `stopped` is a one-way latch: once `stop()` has run, a later
  // `setVisible(true)` must not resurrect polling.
  it('does not restart polling when setVisible(true) is called after stop()', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const sqlite = vi.fn(async () => ok('[]'))
    const source = new CodexSource(database, sqlite, () => fixedRead(''), () => 500)
    try {
      source.setVisible(true)
      await vi.advanceTimersByTimeAsync(0)
      const callsBeforeStop = sqlite.mock.calls.length
      await source.stop()
      source.setVisible(true) // must be a no-op: the source is permanently stopped.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sqlite.mock.calls.length).toBe(callsBeforeStop)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
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
    const sqlite = vi.fn(async () => ok(JSON.stringify([{
      id: 'zombie', rollout_path: '/zombie.jsonl', updated_at_ms: veryOldUpdatedAtMs,
      title: 'Stuck task', cwd: '/work/deckd', model: 'gpt-5.6-sol', tokens_used: 1,
    }])))
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
    const sqlite = vi.fn(async () => ok(JSON.stringify([{
      id: 'live', rollout_path: '/live.jsonl', updated_at_ms: 400_000,
      title: 'Live task', cwd: '/work/deckd', model: 'gpt-5.6-sol', tokens_used: 1,
    }])))
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
    const source = new CodexSource('/does/not/matter', async () => ok('[]'), () => fixedRead(''), () => 0)
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
    let resolveSqlite!: (v: SqliteRead) => void
    const sqlite = vi.fn(() => new Promise<SqliteRead>((resolve) => { resolveSqlite = resolve }))
    const readTail = () => fixedRead('')
    const source = new CodexSource(database, sqlite, readTail, () => 500)
    try {
      source.setVisible(true) // Starts a refresh that blocks on the unresolved sqlite call.
      expect(sqlite).toHaveBeenCalledTimes(1)

      const stopPromise = source.stop() // Races the in-flight refresh.

      resolveSqlite(ok('[]'))
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
    const sqlite = vi.fn(async () => ok('[]'))
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
      // Both attempts — the primary `mode=ro` open and the `immutable=1`
      // fallback — are tried on this one failing poll, and both fail.
      expect(execFileMock).toHaveBeenCalledTimes(2)
      await source.refresh()
      await source.refresh()
      expect(source.isAvailable()).toBe(false)
      expect(source.isDegraded()).toBe(false) // unavailable, not degraded: there is no data at all.
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
      expect(source.isDegraded()).toBe(false) // a primary read succeeded directly.

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

  // The other half of the restored fallback's contract: a degraded read
  // must never look as good as a primary one, and must recover cleanly once
  // a primary read succeeds again — including the log dedup key, so a LATER
  // degraded spell (after a genuine recovery in between) logs again instead
  // of going silent for the rest of the process (lesson 5's pattern, this
  // time applied to `codex-state-degraded` rather than `codex-state-read`).
  it('marks a fallback read degraded and never-fresh, then clears both on a primary success, and logs again on a later degraded read', async () => {
    log.clearOnce('codex-state-degraded')
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    const lines: string[] = []
    setDefaultSink((line) => { lines.push(line) })
    const sqlite = vi.fn<(database: string, query: string) => Promise<SqliteRead>>()
    // `now` never advances, so a plain age check alone (without the
    // `degraded` flag folded into `isStale()`) would keep reading this
    // source as fresh throughout — the exact trap this test guards against.
    const source = new CodexSource(database, sqlite, () => fixedRead(''), () => 500)
    const degradedLines = () => lines.filter((line) => line.includes('DEGRADED'))
    try {
      sqlite.mockResolvedValue(degraded('[]'))
      await source.refresh()
      expect(source.isAvailable()).toBe(true) // real data, shown rather than an empty page...
      expect(source.isDegraded()).toBe(true)
      expect(source.isStale()).toBe(true) // ...but it never satisfies a freshness check.

      await source.refresh() // a second degraded poll must not log a second line.
      expect(degradedLines()).toHaveLength(1)
      expect(degradedLines()[0]).toContain(database)
      expect(degradedLines()[0]).not.toContain('SELECT')
      expect(degradedLines()[0]).not.toContain(THREAD_QUERY)

      sqlite.mockResolvedValue(ok('[]'))
      await source.refresh() // a primary read succeeds.
      expect(source.isDegraded()).toBe(false)
      expect(source.isStale()).toBe(false)

      sqlite.mockResolvedValue(degraded('[]'))
      await source.refresh() // degraded again, after a genuine recovery in between.
      expect(source.isDegraded()).toBe(true)
      expect(degradedLines()).toHaveLength(2) // the cleared once-key let this one log again.

      await source.stop()
    } finally {
      setDefaultSink(() => {})
      log.clearOnce('codex-state-degraded')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CodexSource.isUsageUnknown', () => {
  const WINDOW_MINUTES = 300 // A 5-hour rolling window: 18,000 seconds.
  const WINDOW_SECONDS = WINDOW_MINUTES * 60

  function usageEvent(opts: {
    ts: number | 'bad'
    windowMinutes: number
    resetsAt?: number
    secondary?: { windowMinutes: number; resetsAt?: number }
  }): string {
    return JSON.stringify({
      timestamp: opts.ts === 'bad' ? 'not-a-date' : new Date(opts.ts * 1000).toISOString(),
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
          secondary: opts.secondary
            ? {
              used_percent: 96,
              window_minutes: opts.secondary.windowMinutes,
              ...(opts.secondary.resetsAt === undefined ? {} : { resets_at: opts.secondary.resetsAt }),
            }
            : null,
          plan_type: 'team',
        },
      },
    })
  }

  async function isUsageUnknownAt(now: number, event: string, limitIndex = 0): Promise<boolean> {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-'))
    const database = join(dir, 'state.sqlite')
    writeFileSync(database, '')
    // One row so `doRefresh` actually calls `readTail` and parses `event`
    // into `newestUsage` — a sqlite result with no rows never reaches the
    // rollout at all. Its own `active`/task fields are irrelevant here.
    const sqlite = vi.fn(async () => ok(JSON.stringify([
      { id: 'x', rollout_path: '/x.jsonl', updated_at_ms: 0, title: '', cwd: '', model: '', tokens_used: null },
    ])))
    const source = new CodexSource(database, sqlite, () => fixedRead(`${event}\n`), () => now)
    try {
      await source.refresh()
      return source.isUsageUnknown(limitIndex)
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

  // M5 — the window boundary is inclusive: AT resets_at, the window has just
  // ended, matching `formatResetIn`'s own `remaining <= 0` → `ELAPSED`
  // boundary. Before the fix, `remaining < 0` left this one second
  // disagreeing with the reset tile on the very same frame.
  it('treats a sample as unknown exactly at its own resets_at, matching formatResetIn\'s ELAPSED boundary', async () => {
    const resetsAt = 1_000 + WINDOW_SECONDS
    const event = usageEvent({ ts: 1_005, windowMinutes: WINDOW_MINUTES, resetsAt })
    expect(await isUsageUnknownAt(resetsAt, event)).toBe(true)
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

  // C2 — the review's exact repro: a 300-minute (5-hour) window with no
  // resets_at must not stay "known" for the old flat 24-hour backstop. It
  // must be bounded by its OWN window length (18,000 s = 5 h), so a sample
  // well inside the old 10 s/4-day test range — 15 hours old, comfortably
  // under 24 hours — must already read unknown.
  it('treats a sample older than its own window length as unknown, even though it is still under the old 24-hour backstop', async () => {
    const ts = 10_000
    const event = usageEvent({ ts, windowMinutes: WINDOW_MINUTES }) // resets_at absent.
    const fifteenHoursLater = ts + 15 * 3600
    expect(await isUsageUnknownAt(fifteenHoursLater, event)).toBe(true)
  })

  it('keeps a sample live right up to its own window length when resets_at is absent', async () => {
    const ts = 10_000
    const event = usageEvent({ ts, windowMinutes: WINDOW_MINUTES })
    expect(await isUsageUnknownAt(ts + WINDOW_SECONDS - 1, event)).toBe(false)
  })

  it('treats a sample as unknown one second past its own window length when resets_at is absent', async () => {
    const ts = 10_000
    const event = usageEvent({ ts, windowMinutes: WINDOW_MINUTES })
    expect(await isUsageUnknownAt(ts + WINDOW_SECONDS + 1, event)).toBe(true)
  })

  it('treats an old sample as unknown when its own resets_at describes a window that has not started yet', async () => {
    // resets_at (30,000) describes a window starting at 30,000 - 18,000 =
    // 12,000. `now` below (5,000) is still short of that start, so the
    // sample belongs to whatever window preceded it, not the one resets_at
    // names — even though resets_at itself is still ahead of `now`.
    const event = usageEvent({ ts: 0, windowMinutes: WINDOW_MINUTES, resetsAt: 30_000 })
    expect(await isUsageUnknownAt(5_000, event)).toBe(true)
  })

  // I1 — an unparseable sample timestamp forces the WHOLE reading unknown,
  // regardless of what resets_at claims, because the sample as a whole
  // cannot be trusted once its own clock fails to parse.
  it('forces usage unknown when the sample timestamp is unparseable, even though resets_at looks fine', async () => {
    const resetsAt = 1_000 + WINDOW_SECONDS
    const event = usageEvent({ ts: 'bad', windowMinutes: WINDOW_MINUTES, resetsAt })
    expect(await isUsageUnknownAt(2_000, event)).toBe(true)
  })

  // I3/I5 — each limit's freshness is its own question. A primary window
  // still comfortably live must not force the SECONDARY tile to also read
  // known just because index 0 does — and the reverse must hold too.
  it('evaluates the secondary limit independently of the primary, so an ended secondary window reads unknown while the primary stays live', async () => {
    // A realistic, well-positive `now` — a `resetsAt` an hour BEHIND `now`
    // must itself stay positive, or `parseLimit`'s own `resetsAt < 0` sanity
    // check would null it out and mask this scenario behind the backstop
    // branch instead of the two-sided window check this test targets.
    const now = 100_000
    const event = usageEvent({
      ts: now - 995,
      windowMinutes: WINDOW_MINUTES,
      resetsAt: now + 3600, // primary: an hour from ending, still live.
      secondary: { windowMinutes: 10080, resetsAt: now - 3600 }, // secondary: ended an hour ago.
    })
    expect(await isUsageUnknownAt(now, event, 0)).toBe(false)
    expect(await isUsageUnknownAt(now, event, 1)).toBe(true)
  })
})
