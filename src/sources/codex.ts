import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import { paths } from '../paths.js'
import { log } from '../log.js'

const POLL_MS = 5000
/** How long the last successful sqlite READ may age before the page treats
 * everything as stale. This says nothing about whether the accounting
 * NUMBERS themselves are still current — see `isUsageUnknown()` for that,
 * which checks the rate-limit window's own boundary rather than a clock. */
export const STALE_CODEX_SECONDS = 60
/**
 * Backstop bound for the rare case `resets_at` is itself missing, or fails
 * `parseLimit`'s sanity check (see `RESET_MAX_SECONDS`). This is NOT the
 * primary rule for whether a usage sample is trustworthy — see
 * `isUsageUnknown()`'s doc comment for why age alone is otherwise the wrong
 * test. Deliberately a full day, so this fallback is never what actually
 * fires against a genuinely fresh sample; it exists only for missing data.
 */
export const USAGE_UNKNOWN_BACKSTOP_SECONDS = 24 * 3600
/** How long an `active` flag may outlive the thread row's own last-updated
 * time before this source stops trusting it.
 *
 * This is a DIFFERENT case from usage, not the same lens with a different
 * number: `RUNNING` is a claim about right now, and it genuinely rots with
 * age — the longer the thread row goes untouched, the less believable "Codex
 * is still working on this" becomes. Usage instead stays true until its
 * window ends (see `isUsageUnknown()`); a fixed age bound would be wrong
 * there but is the right tool here.
 *
 * Bounds the "Codex died mid-task, no `task_complete` line ever arrives"
 * failure: the rollout itself never says the task ended, but the thread
 * INDEX stops moving the moment the app stops touching that row. Four hours
 * is chosen wide enough to cover one legitimately long single tool call — a
 * full test suite, a slow build — that produces no interim row update,
 * while still recovering the tile within the same working day rather than
 * showing `RUNNING` for days after the app quit or the thread died silently.
 * Codex publishes no maximum task duration to derive a tighter number from,
 * so this stays a deliberately generous, round bound rather than one
 * measured from Codex's own behaviour. */
const MAX_ACTIVE_TASK_AGE_SECONDS = 4 * 3600
/** Bounds the very first read of any rollout to this many trailing bytes
 * instead of the whole file, so a multi-megabyte transcript — or several,
 * all cold at once after a daemon restart — cannot block the event loop for
 * seconds. Lifecycle events (`task_started` / `task_complete`) and the
 * newest `token_count` sample sit at or near wherever Codex most recently
 * wrote, so a generous tail window reliably contains the newest one even
 * though it does not contain the file's whole history. Every read AFTER the
 * first is already bounded by the remembered byte offset and needs no
 * separate cap. */
export const COLD_START_TAIL_BYTES = 256 * 1024
/** A `resets_at` outside this range cannot be a real epoch-seconds value —
 * it is comfortably past the year 2096 — and is far more likely to be
 * epoch MILLISECONDS, the unit Codex's own sqlite already uses for
 * `updated_at_ms` and `created_at_ms`. Treated as unknown rather than
 * guessed at, so a millisecond value can never render a multi-million-day
 * countdown. */
const RESET_MAX_SECONDS = 4_000_000_000
/** Bounds a hung `sqlite3` child well under the 5 s poll interval, so a
 * stuck read cannot block `stop()`'s await on `refreshing` forever and
 * delay shutdown past SIGTERM's grace window. Applies to both the primary
 * and fallback attempt in `runSqlite`. */
const SQLITE_TIMEOUT_MS = 4000

export const THREAD_QUERY = `
SELECT id, rollout_path, updated_at_ms, substr(title, 1, 64) AS title, cwd, model, tokens_used
FROM threads
WHERE archived = 0
  AND thread_source = 'user'
  AND preview <> ''
ORDER BY updated_at_ms DESC
LIMIT 10;
`.trim()

export interface CodexTask {
  threadId: string
  title: string
  project: string
  model: string
  /** Epoch seconds. Always a real number — a row whose `updated_at_ms` is
   * missing or too old to still trust an `active` flag never becomes a
   * task in the first place. See `MAX_ACTIVE_TASK_AGE_SECONDS`. */
  updatedAt: number
  /** `null` when Codex's own row carries no usable `tokens_used` value. */
  tokensUsed: number | null
}

export interface CodexLimit {
  /** `null` when the field is absent, renamed, or not a number — unknown,
   * never a fabricated 0. */
  usedPct: number | null
  windowMinutes: number
  /** `null` when absent or outside `RESET_MAX_SECONDS`'s sane range. */
  resetsAt: number | null
}

export interface CodexUsage {
  limits: CodexLimit[]
  /** `null` when the field is absent, renamed, or not a number. */
  totalTokens: number | null
  plan: string
  ts: number
}

export interface CodexSnapshot {
  tasks: CodexTask[]
  usage: CodexUsage | null
}

interface ThreadRow {
  id?: unknown
  rollout_path?: unknown
  updated_at_ms?: unknown
  title?: unknown
  cwd?: unknown
  model?: unknown
  tokens_used?: unknown
}

export interface RolloutState {
  active: boolean
  usage: CodexUsage | null
}

export interface RolloutRead {
  text: string
  /** The file's total size at read time. Used to detect a shrunken
   * (rotated) file. */
  size: number
  /** How far this read actually reached: `start + bytesRead`. Equals `size`
   * on a normal full read. A short read leaves this below `size`, so the
   * next poll's cursor resumes from here instead of silently skipping the
   * unread span forever. */
  consumedTo: number
}

export type SqliteRunner = (database: string, query: string) => Promise<string>
export type RolloutTailReader = (file: string, start?: number) => RolloutRead

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A missing value, or one of the wrong type, is UNKNOWN — never a
 * fabricated `0`. Codex owns this schema privately and can rename or drop a
 * field in any update; a caller must decide separately what "unknown" means
 * for its own field (fail the whole limit closed, render `--`, whatever
 * fits), but this boundary itself never guesses a number out of thin air. */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseLimit(value: unknown): CodexLimit | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const windowMinutes = finite(raw.window_minutes)
  // The window is the one field that gates whether a limit tile can exist at
  // all: with no known window, `limitLabel` has nothing to name and the tile
  // has nothing to be a cap OF. This is the one place a missing field still
  // fails the WHOLE limit closed, rather than reporting partial unknown
  // data — the correct pattern the review found already in place for an
  // absent `rate_limits` block.
  if (windowMinutes === null || windowMinutes <= 0) return null
  const usedPct = finite(raw.used_percent)
  let resetsAt = finite(raw.resets_at)
  if (resetsAt !== null && (resetsAt < 0 || resetsAt > RESET_MAX_SECONDS)) resetsAt = null
  return { usedPct, windowMinutes, resetsAt }
}

/** Parses only status and accounting events. User prompts and assistant text
 * are deliberately ignored, so the deck source never retains task content
 * beyond the short title already present in Codex's thread index. */
export function parseRolloutTail(
  text: string,
  initial: RolloutState = { active: false, usage: null },
): RolloutState {
  let active = initial.active
  let usage: CodexUsage | null = initial.usage

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event: Record<string, any>
    try {
      event = JSON.parse(line) as Record<string, any>
    } catch {
      continue
    }
    if (event.type !== 'event_msg' || !event.payload) continue
    const payload = event.payload as Record<string, any>
    if (payload.type === 'task_started') active = true
    if (payload.type === 'task_complete') active = false
    if (payload.type !== 'token_count') continue

    const rate = payload.rate_limits as Record<string, unknown> | undefined
    const info = payload.info as Record<string, any> | undefined
    const limits = [parseLimit(rate?.primary), parseLimit(rate?.secondary)]
      .filter((limit): limit is CodexLimit => limit !== null)
    const totalTokens = finite(info?.total_token_usage?.total_tokens)
    const timestamp = typeof event.timestamp === 'string'
      ? Math.floor(Date.parse(event.timestamp) / 1000)
      : 0
    usage = {
      limits,
      totalTokens,
      plan: str(rate?.plan_type),
      ts: Number.isFinite(timestamp) ? timestamp : 0,
    }
  }

  return { active, usage }
}

/**
 * Reads from `requestedStart` to the end of `file`. `requestedStart`
 * undefined means "no cursor yet" (a cold start): the read is bounded to
 * `COLD_START_TAIL_BYTES` from the end rather than the whole file. An
 * explicit `requestedStart` — including `0` — is honoured exactly, because a
 * later poll's own remembered offset must never be silently reinterpreted as
 * a fresh cold start.
 */
export function readRolloutTail(file: string, requestedStart?: number): RolloutRead {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const start = requestedStart === undefined
      ? Math.max(0, size - COLD_START_TAIL_BYTES)
      : (requestedStart >= 0 && requestedStart <= size ? requestedStart : 0)
    const buffer = Buffer.alloc(size - start)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start)
    if (bytesRead !== buffer.length) {
      // Suspect, not reproduced: a short read on a local regular file. Cheap
      // to guard regardless — `consumedTo` below stays behind `size`, so the
      // next poll retries the missed span instead of the cursor silently
      // skipping past it forever.
      log.once(
        'codex-rollout-short-read',
        `short read on a Codex rollout file: expected ${buffer.length} bytes, got ${bytesRead}`,
      )
    }
    return { text: buffer.toString('utf8', 0, bytesRead), size, consumedTo: start + bytesRead }
  } finally {
    closeSync(fd)
  }
}

/** Turns a filesystem path into the `file:` URI form sqlite3 needs to accept
 * `mode=ro` (and, on the fallback, `immutable=1`). Only `%`, `#`, and `?` are
 * percent-encoded — sqlite gives those three special meaning inside a URI
 * filename — so an ordinary absolute path passes through unchanged and a
 * leading `/` still reads as an absolute path rather than a relative one. */
function toReadOnlyUri(database: string, extra?: string): string {
  const escaped = database.replace(/[%#?]/g, (char) => encodeURIComponent(char))
  return `file:${escaped}?${extra ? `mode=ro&${extra}` : 'mode=ro'}`
}

/** A short, query-free description of an `execFile` failure, for the log.
 * Prefers sqlite3's own stderr line (e.g. `unable to open database file
 * (14)`), which never contains the query. Deliberately never falls back to
 * `error.message`: Node builds that string as `Command failed: <cmd> <args
 * joined by spaces>`, which — for this command — IS the SQL text (lesson 20
 * requires it never reach a log). `error.code` / `error.signal` are safe,
 * short, enum-like fields with no query content, so those are the only
 * fallback. */
function describeExecFailure(
  error: Error & { killed?: boolean; code?: unknown; signal?: unknown },
  stderr: string,
): string {
  const trimmed = stderr.trim()
  if (trimmed) return trimmed
  if (error.killed) return `sqlite3 timed out after ${SQLITE_TIMEOUT_MS}ms`
  if (error.code !== undefined) return `sqlite3 failed (code ${String(error.code)})`
  if (error.signal !== undefined) return `sqlite3 failed (signal ${String(error.signal)})`
  return 'sqlite3 failed'
}

function execSqlite(uri: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/sqlite3',
      ['-json', uri, query],
      { maxBuffer: 1024 * 1024, timeout: SQLITE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return }
        reject(new Error(describeExecFailure(error, stderr ?? '')))
      },
    )
  })
}

/**
 * Reads the Codex sqlite database without ever opening it read-write.
 *
 * The primary attempt uses the URI form with `mode=ro`, which measurement
 * against the live database showed at least as reliable as the CLI's own
 * `-readonly` flag against a plain path — and `-readonly` against a plain
 * path was seen to fail intermittently with `SQLITE_CANTOPEN` (error 14)
 * against this WAL-mode database. The leading hypothesis is that a
 * read-only connection normally wants the database's `-shm` shared-memory
 * file and cannot create one itself, so the open fails whenever that file
 * is momentarily absent — treat that as a working hypothesis, not a
 * confirmed mechanism; it was not reproduced on demand.
 *
 * If the primary attempt fails, the fallback adds `immutable=1`, which lets
 * sqlite read the file without an `-shm` at all. This is ONLY safe as a
 * fallback: `immutable=1` tells sqlite the file will never change, so a
 * concurrent writer could hand back a stale or torn read. Reaching this
 * fallback means the primary `mode=ro` attempt — which needs an active
 * shared-memory reader — already failed, which itself implies no such
 * writer is live at that instant. It must never be the primary mode.
 *
 * Both attempts open strictly read-only (`mode=ro`); this function never
 * opens the database read-write, and so never creates, checkpoints, or
 * otherwise modifies anything under the user's Codex directory.
 */
export async function runSqlite(database: string, query: string): Promise<string> {
  try {
    return await execSqlite(toReadOnlyUri(database), query)
  } catch (primaryError) {
    const primaryDetail = primaryError instanceof Error ? primaryError.message : String(primaryError)
    try {
      return await execSqlite(toReadOnlyUri(database, 'immutable=1'), query)
    } catch (fallbackError) {
      const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      throw new Error(`mode=ro failed (${primaryDetail}); immutable=1 fallback failed (${fallbackDetail})`)
    }
  }
}

/** Best-effort, read-only view of Codex desktop's local task index and the
 * accounting events in recent rollout files. This is intentionally isolated
 * behind one source: if Codex changes its private on-disk schema, the rest of
 * deckd keeps running and this page simply reports unavailable data. */
export class CodexSource extends EventEmitter {
  private snapshot: CodexSnapshot = { tasks: [], usage: null }
  private available = false
  private lastSuccessAt = 0
  private lastKey = ''
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> | null = null
  private visible = false
  /** Set by `stop()`, so a refresh continuation already in flight cannot arm
   * a new timer after shutdown (lesson 8). Checked first in `schedule()`. */
  private stopped = false
  private cursors = new Map<string, {
    offset: number
    remainder: string
    state: RolloutState
  }>()

  constructor(
    private readonly database = paths.codexStateDb,
    private readonly sqlite: SqliteRunner = runSqlite,
    private readonly readTail: RolloutTailReader = readRolloutTail,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super()
  }

  /** Nothing to do until the Codex page becomes visible — matches
   * `StockSource` and `WeatherSource`. Polling a private local database and
   * scanning rollout files on every tick, for a page the user may never
   * open, is wasted work. */
  async start(): Promise<void> {
    // no-op
  }

  /** Called when the Codex page becomes visible. Refreshes at once and
   * starts the 5 s poll loop; hidden, it costs nothing. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) {
      this.stopped = false
      void this.refresh().then(() => this.schedule())
    } else if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    // A refresh started before `stop()` can still be in flight when it
    // settles. Its continuation must not arm a new timer after shutdown, so
    // this check runs before anything else, ahead of even the `visible`
    // check below.
    if (this.stopped) return
    if (this.timer) clearInterval(this.timer)
    if (!this.visible) return
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async doRefresh(): Promise<void> {
    if (!existsSync(this.database)) {
      this.updateAvailability(false)
      log.once('codex-state-absent', `Codex state database absent: ${this.database}`)
      return
    }

    try {
      const rows = JSON.parse(await this.sqlite(this.database, THREAD_QUERY)) as ThreadRow[]
      const tasks: CodexTask[] = []
      let newestUsage: CodexUsage | null = null
      const seenRollouts = new Set<string>()

      for (const row of Array.isArray(rows) ? rows : []) {
        const rollout = str(row.rollout_path)
        if (!rollout) continue
        seenRollouts.add(rollout)
        let state: RolloutState
        try {
          const cursor = this.cursors.get(rollout)
          const read = this.readTail(rollout, cursor?.offset)
          const reset = !!cursor && read.size < cursor.offset
          const combined = (reset ? '' : (cursor?.remainder ?? '')) + read.text
          const lastNewline = combined.lastIndexOf('\n')
          const complete = lastNewline === -1 ? '' : combined.slice(0, lastNewline + 1)
          const remainder = lastNewline === -1 ? combined : combined.slice(lastNewline + 1)
          state = parseRolloutTail(complete, reset ? undefined : cursor?.state)
          this.cursors.set(rollout, { offset: read.consumedTo, remainder, state })
        } catch {
          continue
        }
        if (state.usage && (!newestUsage || state.usage.ts > newestUsage.ts)) {
          newestUsage = state.usage
        }
        if (!state.active) continue

        // An `active` flag from the rollout is only trustworthy while the
        // thread's own row in the index keeps moving. If Codex died mid-task,
        // no `task_complete` line is ever appended, but `updated_at_ms` also
        // stops advancing at the same moment — so its age is what catches the
        // case the rollout itself cannot report. See
        // `MAX_ACTIVE_TASK_AGE_SECONDS`.
        const updatedAtMs = finite(row.updated_at_ms)
        const updatedAt = updatedAtMs === null ? null : Math.floor(updatedAtMs / 1000)
        if (updatedAt === null || this.now() - updatedAt > MAX_ACTIVE_TASK_AGE_SECONDS) continue

        tasks.push({
          threadId: str(row.id),
          title: str(row.title),
          project: basename(str(row.cwd)) || '—',
          model: str(row.model),
          updatedAt,
          tokensUsed: finite(row.tokens_used),
        })
      }

      for (const rollout of this.cursors.keys()) {
        if (!seenRollouts.has(rollout)) this.cursors.delete(rollout)
      }

      this.available = true
      this.lastSuccessAt = this.now()
      log.clearOnce('codex-state-absent')
      log.clearOnce('codex-state-read')
      this.setSnapshot({ tasks, usage: newestUsage })
    } catch (error) {
      this.updateAvailability(false)
      // Short and query-free: `runSqlite`'s own errors already carry only
      // sqlite3's stderr text or a code/signal, never the SQL body (see
      // `describeExecFailure`), and a plain `Error.message` from anywhere
      // else in this block (e.g. a `JSON.parse` failure) is already short.
      const detail = error instanceof Error ? error.message : String(error)
      log.once('codex-state-read', `cannot read Codex task data at ${this.database}: ${detail}`)
    }
  }

  private setSnapshot(next: CodexSnapshot): void {
    const key = JSON.stringify({ available: this.available, ...next })
    if (key === this.lastKey) return
    this.lastKey = key
    this.snapshot = next
    this.emit('change')
  }

  private updateAvailability(available: boolean): void {
    if (this.available === available) return
    this.available = available
    this.lastKey = ''
    this.emit('change')
  }

  getSnapshot(): CodexSnapshot {
    return {
      tasks: this.snapshot.tasks.map((task) => ({ ...task })),
      usage: this.snapshot.usage
        ? { ...this.snapshot.usage, limits: this.snapshot.usage.limits.map((limit) => ({ ...limit })) }
        : null,
    }
  }

  isAvailable(): boolean {
    return this.available
  }

  /** True when the last successful sqlite READ is too old (or there has
   * never been one). Says nothing about whether the accounting numbers
   * themselves are still true — see `isUsageUnknown()`. */
  isStale(): boolean {
    return !this.lastSuccessAt || this.now() - this.lastSuccessAt > STALE_CODEX_SECONDS
  }

  /** True when the newest known usage SAMPLE no longer describes the
   * CURRENT rate-limit window, or there is no sample at all. Different from
   * `isStale()`, which is about whether the sqlite READ itself is current —
   * this is about whether the NUMBER that read carries is still true.
   *
   * A quota reading is not a live sensor: Codex only emits a fresh
   * `token_count` event when the app itself does work, so "62% of this
   * week's limit" can sit unchanged for hours while the user is away from
   * Codex — and it stays TRUE the entire time. Marking it unknown on age
   * alone would misinform in the opposite direction, telling the user to
   * distrust a number that is still correct. What actually invalidates the
   * figure is the WINDOW ending: once `now` moves past the sample's own
   * `resetsAt`, the sample describes a window that no longer exists, and
   * the true figure for whatever window replaced it is unknowable from an
   * old sample.
   *
   * The check is two-sided, not just `now < resetsAt`: `now` must also sit
   * no more than one window-length behind `resetsAt`. A one-sided check
   * would wrongly call a sample live if `resetsAt` described a window that,
   * from `now`'s perspective, has not even started yet — `now` would still
   * be sitting in the window BEFORE the one the figure is actually about.
   *
   * `resetsAt` is occasionally absent, or already null from `parseLimit`'s
   * own sanity check. `USAGE_UNKNOWN_BACKSTOP_SECONDS` covers only that
   * missing-data case. */
  isUsageUnknown(): boolean {
    const usage = this.snapshot.usage
    if (!usage) return true
    const limit = usage.limits[0]
    const resetsAt = limit?.resetsAt ?? null
    if (resetsAt === null) return this.now() - usage.ts > USAGE_UNKNOWN_BACKSTOP_SECONDS
    const remaining = resetsAt - this.now()
    const windowSeconds = limit!.windowMinutes * 60
    return remaining < 0 || remaining > windowSeconds
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.refreshing
  }
}
