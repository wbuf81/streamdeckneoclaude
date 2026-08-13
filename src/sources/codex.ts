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
 * CEILING for the backstop that covers a missing `resets_at` (see
 * `RESET_MAX_SECONDS` for the sanity-check case, which nulls `resets_at` the
 * same way). This is NOT the bound actually applied — `isUsageUnknown()`
 * clamps it to the limit's own `windowMinutes` first, because a window
 * shorter than a day cannot possibly still be trustworthy a day later (C2:
 * a 300-minute, 5-hour window with no `resets_at` read as live for a full 24
 * hours, 19 hours past its own window closing). This constant only bounds
 * the OTHER direction: when `windowMinutes` is itself missing or absurd
 * (see `WINDOW_MAX_MINUTES`), a backstop still has to end somewhere, and a
 * full day is that fallback-of-a-fallback ceiling.
 */
export const USAGE_UNKNOWN_BACKSTOP_SECONDS = 24 * 3600
/** A `window_minutes` outside this range cannot be a real rate-limit
 * window — the longest window on record is 10080 minutes (7 days; see
 * `docs/VERIFIED-FACTS.md`), and even a generous monthly window sits nowhere
 * near this bound. A value this large is far more likely to be the SAME
 * figure in a different unit: the review's exact repro, `window_minutes:
 * 604_800_000`, is 7 days in MILLISECONDS. Unbounded, that value both
 * defeats `isUsageUnknown()`'s two-sided check (a month-old sample would
 * read as live) and overruns the key's label line with a value like
 * `420000-DAY CAP` (I4/I6). Treated as unknown, same pattern as
 * `RESET_MAX_SECONDS` for `resets_at` — the whole limit fails closed via
 * `parseLimit`'s existing `windowMinutes === null` branch. */
const WINDOW_MAX_MINUTES = 366 * 24 * 60
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
 * delay shutdown past SIGTERM's grace window. Applies to EACH of
 * `runSqlite`'s sqlite3 child attempts — the primary `mode=ro` open and, on
 * its failure, the `immutable=1` fallback — so a hang on either one is
 * bounded the same way. */
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
  /** Epoch seconds the sample was taken, from the rollout event's own
   * `timestamp`. `null` when that field is absent or not a parseable
   * string — never a fabricated `0` (1969, lesson 18/I1). A `null` ts
   * forces `isUsageUnknown()` true regardless of `resetsAt`: an unparseable
   * clock on the sample is reason enough to distrust the whole reading, not
   * just its displayed time. */
  ts: number | null
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

// `SqliteRunner` (and the `SqliteRead` shape it resolves to) are declared
// next to `runSqlite`, its default implementation, further down this file.
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
  // absent `rate_limits` block. The upper bound (I4/I6) catches the same
  // class of drift `RESET_MAX_SECONDS` catches for `resets_at`: a value that
  // looks like the same figure in a smaller unit.
  if (windowMinutes === null || windowMinutes <= 0 || windowMinutes > WINDOW_MAX_MINUTES) return null
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
    // I1 — a missing or non-string `timestamp`, or one `Date.parse` cannot
    // read, is UNKNOWN, never a fabricated `0` (which rendered as 7:00 PM
    // EST 1969 beside a confident percentage). `CodexUsage.ts`'s own doc
    // comment covers what `null` forces downstream.
    const parsed = typeof event.timestamp === 'string' ? Math.floor(Date.parse(event.timestamp) / 1000) : NaN
    usage = {
      limits,
      totalTokens,
      plan: str(rate?.plan_type),
      ts: Number.isFinite(parsed) ? parsed : null,
    }
  }

  return { active, usage }
}

/** Orders two usage samples for `doRefresh`'s "keep the newest" comparison
 * across rollouts. A `null` ts (I1's unparseable-timestamp case) carries no
 * ordering information of its own — it does not mean "very old", it means
 * "we do not know". Scoring it as the OLDEST possible sample (the previous
 * behaviour, via a fabricated `0`) meant it could never win this comparison,
 * so a genuinely fresher read would silently lose to an actually-older
 * sample from a different rollout just because the fresher one's logged
 * clock failed to parse. Scoring it as the NEWEST possible sample instead
 * means a broken clock inside the payload never costs the page a real,
 * current reading — the sample is still shown as `--` on the strip (see
 * `CodexPage.usageTimeLabel`), because `usage.ts` itself stays `null`; only
 * this internal ordering treats "unknown" differently from "old". */
function usageOrderKey(usage: CodexUsage): number {
  return usage.ts ?? Number.POSITIVE_INFINITY
}

/**
 * Reads from `requestedStart` to the end of `file`. `requestedStart`
 * undefined means "no cursor yet" (a cold start): the read is bounded to
 * `COLD_START_TAIL_BYTES` from the end rather than the whole file. An
 * explicit `requestedStart` — including `0` — is honoured exactly, because a
 * later poll's own remembered offset must never be silently reinterpreted as
 * a fresh cold start.
 *
 * A `requestedStart` past the CURRENT `size` (M1: the rollout shrank —
 * rotated or compacted out from under a remembered cursor) is treated the
 * SAME as a cold start, bounded by `COLD_START_TAIL_BYTES`, rather than
 * falling back to `0` and reading the whole file unbounded. The live index
 * already references a rollout at 2.7 MB; a shrink-then-reread is exactly
 * the case the cold-start cap exists to bound, and reusing it here needs no
 * new logic.
 */
export function readRolloutTail(file: string, requestedStart?: number): RolloutRead {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const start = requestedStart === undefined || requestedStart > size
      ? Math.max(0, size - COLD_START_TAIL_BYTES)
      : (requestedStart >= 0 ? requestedStart : 0)
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
    } else {
      // M3 — lesson 5's second half: clear on recovery so a LATER short read
      // logs again instead of going silent for the rest of the process.
      log.clearOnce('codex-rollout-short-read')
    }
    return { text: buffer.toString('utf8', 0, bytesRead), size, consumedTo: start + bytesRead }
  } finally {
    closeSync(fd)
  }
}

/** Percent-encodes only `%`, `#`, and `?` — sqlite gives those three special
 * meaning inside a URI filename — so an ordinary absolute path passes
 * through unchanged and a leading `/` still reads as an absolute path
 * rather than a relative one. Escaping `?` specifically means a malformed
 * `database` value (M2: one that itself contains `?mode=rwc` or similar)
 * cannot inject a second query parameter and override the mode either URI
 * form below chose — it becomes a literal, harmless character in the
 * filename instead. Shared by both forms so they can never drift apart on
 * escaping. */
function escapeForSqliteUri(database: string): string {
  return database.replace(/[%#?]/g, (char) => encodeURIComponent(char))
}

/** The primary read URI: `mode=ro`. The only mode that reads the `-wal`
 * file, so a row Codex has written but not yet checkpointed into the main
 * database file is still visible. */
function toReadOnlyUri(database: string): string {
  return `file:${escapeForSqliteUri(database)}?mode=ro`
}

/** The fallback read URI: `mode=ro&immutable=1`. See `runSqlite`'s doc
 * comment for when this is tried and why its result is always tagged
 * degraded rather than trusted outright. */
function toImmutableUri(database: string): string {
  return `file:${escapeForSqliteUri(database)}?mode=ro&immutable=1`
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
      // The `-readonly` CLI flag was measured (docs/VERIFIED-FACTS.md) to
      // compose IDENTICALLY with the URI's own `mode=ro` in every case
      // tried, including the sidecar-absent failure this file exists to
      // handle — it never once changed the result. Dropped as redundant
      // rather than kept "for extra safety" at the cost of a second thing
      // that could drift out of sync with the URI logic below.
      ['-json', uri, query],
      { maxBuffer: 1024 * 1024, timeout: SQLITE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return }
        reject(new Error(describeExecFailure(error, stderr ?? '')))
      },
    )
  })
}

/** The result of one `runSqlite` call. */
export interface SqliteRead {
  text: string
  /** True when `text` came from the `immutable=1` fallback rather than the
   * primary `mode=ro` open. `CodexSource` treats a degraded read as
   * real data worth showing — dimmed — rather than an empty page, but never
   * as good as a primary read: it must never satisfy a freshness check. See
   * `CodexSource.isStale` and `CodexSource.isDegraded`. */
  degraded: boolean
}

export type SqliteRunner = (database: string, query: string) => Promise<SqliteRead>

/**
 * Reads the Codex sqlite database without ever opening it read-write.
 *
 * Primary attempt: the URI form with `mode=ro`. This is the only mode that
 * reads the `-wal` file, so a row Codex has written but not yet checkpointed
 * into the main database file is still visible.
 *
 * On failure, ONE fallback attempt: `mode=ro&immutable=1`. This restores a
 * fallback an earlier version of this file removed entirely — that removal
 * was itself a mistake, and this comment records why, so it is not repeated.
 *
 * The fallback exists because of a measured fact (docs/VERIFIED-FACTS.md):
 * with the `-wal`/`-shm` sidecars ABSENT — which is Codex's database's
 * normal resting state whenever Codex itself is not actively holding it
 * open, i.e. most of the time — `mode=ro` fails outright with
 * `SQLITE_CANTOPEN (14)`, because a read-only connection to a WAL database
 * needs the `-shm` and cannot create one. `immutable=1` succeeds in that
 * exact case and creates no sidecar file at all. Without this fallback the
 * Codex page shows nothing whenever Codex is not this instant writing to its
 * database — honest, but useless, since that is most of the time. (An
 * earlier version of this file claimed `mode=ro` creates the missing `-shm`
 * itself and so never needs a fallback; that claim was false — it only
 * looked true because the sidecars already existed at the moment it was
 * checked. Retesting with the sidecars actually absent produced the failure
 * above. See docs/VERIFIED-FACTS.md for the full correction.)
 *
 * The fallback is not free of risk, and the risk is exactly why every
 * caller must treat a `degraded: true` result as second-class, never as
 * good as a primary read:
 *
 * - `immutable=1` does not read the WAL at all. Against a database with one
 *   row checkpointed into the main file and a second left only in `-wal`,
 *   `mode=ro` returns both rows; `mode=ro&immutable=1` returns only the
 *   checkpointed one, exit code 0, no warning on stderr. It can silently
 *   hand back a stale snapshot and call it done.
 * - A live writer holding the database under `PRAGMA locking_mode=exclusive`
 *   makes the primary `mode=ro` attempt fail with `database is locked (5)` —
 *   and makes this SAME fallback succeed, handing back pre-checkpoint rows
 *   as if they were current. The exact condition that makes the fallback
 *   unsafe is also the condition that triggers it.
 *
 * So a degraded result is always tagged as such, and `CodexSource` is
 * responsible for making sure it never satisfies a freshness check and
 * always renders dimmed (see its `doRefresh`, `isStale`, `isDegraded`) — the
 * fallback exists to avoid an empty page, not to quietly pass off
 * possibly-stale data as current.
 *
 * If BOTH attempts fail, the PRIMARY attempt's own error is what reaches the
 * caller: the fallback existing at all is an implementation detail, not
 * something a "why is Codex unavailable" message should dwell on.
 */
export async function runSqlite(database: string, query: string): Promise<SqliteRead> {
  try {
    const text = await execSqlite(toReadOnlyUri(database), query)
    return { text, degraded: false }
  } catch (primaryError) {
    try {
      const text = await execSqlite(toImmutableUri(database), query)
      return { text, degraded: true }
    } catch {
      throw primaryError
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
  /** True when the MOST RECENT successful read used the `immutable=1`
   * fallback (see `runSqlite`) rather than the primary `mode=ro` open. Set
   * back to `false` the instant a primary read next succeeds, or a read
   * fails outright — there is no data left to call degraded once the source
   * is unavailable. See `isDegraded()` and `isStale()`. */
  private degraded = false
  private lastKey = ''
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> | null = null
  private visible = false
  /** Set by `stop()`, so a refresh continuation already in flight cannot arm
   * a new timer after shutdown (lesson 8). Checked first in `schedule()`.
   * One-way (M6): nothing ever sets this back to `false`. A page cycling
   * `setVisible` on and off while the source is alive never touches this
   * flag at all, so that path is unaffected; only a source that has already
   * been `stop()`ped is meant to stay dead rather than being resurrected by
   * a later `setVisible(true)`. */
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
   * starts the 5 s poll loop; hidden, it costs nothing. A source that has
   * already been `stop()`ped stays stopped (M6): this never clears
   * `stopped`, so a stray `setVisible(true)` after shutdown cannot restart
   * polling. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (this.stopped) return
    if (visible) {
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
      this.degraded = false
      log.once('codex-state-absent', `Codex state database absent: ${this.database}`)
      return
    }

    try {
      const read = await this.sqlite(this.database, THREAD_QUERY)
      const rows = JSON.parse(read.text) as ThreadRow[]
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
        if (state.usage && (!newestUsage || usageOrderKey(state.usage) > usageOrderKey(newestUsage))) {
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
      if (read.degraded) {
        // A fallback read: real data, worth showing dimmed rather than an
        // empty page, but never provably as current as a primary read (see
        // `runSqlite`'s doc comment for the exact trap this guards against).
        // `lastSuccessAt` is deliberately left untouched — a degraded read
        // must never be able to satisfy `isStale()`, and `isStale()` also
        // checks `degraded` directly so this holds even if an earlier
        // primary success is still within the staleness window.
        this.degraded = true
        log.once(
          'codex-state-degraded',
          `Codex task data is DEGRADED (immutable fallback) at ${this.database}`,
        )
      } else {
        this.degraded = false
        this.lastSuccessAt = this.now()
        log.clearOnce('codex-state-degraded')
      }
      log.clearOnce('codex-state-absent')
      log.clearOnce('codex-state-read')
      this.setSnapshot({ tasks, usage: newestUsage })
    } catch (error) {
      this.updateAvailability(false)
      this.degraded = false
      // Short and query-free: `runSqlite`'s own errors already carry only
      // sqlite3's stderr text or a code/signal, never the SQL body (see
      // `describeExecFailure`), and a plain `Error.message` from anywhere
      // else in this block (e.g. a `JSON.parse` failure) is already short.
      const detail = error instanceof Error ? error.message : String(error)
      log.once('codex-state-read', `cannot read Codex task data at ${this.database}: ${detail}`)
    }
  }

  private setSnapshot(next: CodexSnapshot): void {
    // `degraded` is included even though it is not part of `next`: a poll
    // that reads byte-for-identical task/usage data but flips degraded (a
    // recovery, or a fresh fallback) must still emit `change`, or the page
    // never redraws to add or remove the dimming that flip requires.
    const key = JSON.stringify({ available: this.available, degraded: this.degraded, ...next })
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

  /** True when the last successful, PRIMARY sqlite READ is too old, there
   * has never been one, or the MOST RECENT read used the `immutable=1`
   * fallback instead of a primary `mode=ro` open (`this.degraded` — see
   * `isDegraded()`). That last clause is what keeps a fallback read from
   * ever masquerading as current: without it, a degraded read arriving
   * shortly after an earlier, unrelated primary success would read as
   * fresh purely because `lastSuccessAt` from that EARLIER success was
   * still within `STALE_CODEX_SECONDS` — even though the CURRENT data on
   * screen is the fallback's, not that earlier success's. Says nothing
   * about whether the accounting numbers themselves are still true — see
   * `isUsageUnknown()`. */
  isStale(): boolean {
    return this.degraded || !this.lastSuccessAt || this.now() - this.lastSuccessAt > STALE_CODEX_SECONDS
  }

  /** True when the MOST RECENT successful read came from the `immutable=1`
   * fallback (see `runSqlite`) rather than the primary `mode=ro` open.
   * Exposed for tests and logging; every caller that only needs to know
   * whether the current snapshot is trustworthy enough to render undimmed
   * can use `isStale()` alone, since it already folds this in. */
  isDegraded(): boolean {
    return this.degraded
  }

  /** True when `usage.limits[limitIndex]` (default the primary window, index
   * 0) no longer describes the CURRENT rate-limit window, or there is no
   * sample at all. Different from `isStale()`, which is about whether the
   * sqlite READ itself is current — this is about whether the NUMBER that
   * read carries is still true.
   *
   * Evaluated PER LIMIT (I3/I5), never once for the whole snapshot: the
   * primary and secondary windows carry independent `resetsAt` values, and a
   * five-hour primary window ending soon says nothing about a seven-day
   * secondary window that may have reset an hour ago. Reusing one boolean
   * for both tiles let an ended secondary window render a confident,
   * undimmed percentage under the wrong assumption that the primary
   * window's freshness applied to it too.
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
   * old sample. */
  isUsageUnknown(limitIndex = 0): boolean {
    const usage = this.snapshot.usage
    if (!usage) return true
    const limit = usage.limits[limitIndex]
    if (!limit) return true
    // I1 — an unparseable sample timestamp is reason enough to distrust the
    // whole reading, not just its displayed clock. This also means a `null`
    // ts forces EVERY limit unknown, independent of that limit's own
    // `resetsAt`, since `ts` describes the sample as a whole.
    if (usage.ts === null) return true
    const resetsAt = limit.resetsAt
    if (resetsAt === null) {
      // C2 — the backstop for a missing `resetsAt` must never outlive the
      // window it stands in for: a 5-hour (300-minute) window's sample
      // cannot possibly still describe "now" 20 hours later just because a
      // flat 24-hour backstop said so. Clamping to the window's own length
      // is what the window field is FOR. `USAGE_UNKNOWN_BACKSTOP_SECONDS`
      // still bounds the other direction, for when `windowMinutes` itself is
      // missing or absurd (see `WINDOW_MAX_MINUTES`, which already fails
      // that whole limit closed before reaching here — so in practice this
      // Math.min is almost always the window term).
      const backstop = Math.min(USAGE_UNKNOWN_BACKSTOP_SECONDS, limit.windowMinutes * 60)
      return this.now() - usage.ts > backstop
    }
    const remaining = resetsAt - this.now()
    const windowSeconds = limit.windowMinutes * 60
    // The check is two-sided, not just `now < resetsAt`: `now` must also sit
    // no more than one window-length behind `resetsAt`. A one-sided check
    // would wrongly call a sample live if `resetsAt` described a window
    // that, from `now`'s perspective, has not even started yet — `now`
    // would still be sitting in the window BEFORE the one the figure is
    // actually about.
    //
    // M5 — `remaining <= 0`, not `< 0`: at `resetsAt === now` the window has
    // just ended. `formatResetIn` already reports `ELAPSED` at that exact
    // instant (its own boundary is `remaining <= 0`), so this must agree,
    // or the reset tile and the percentage tile disagree by one second on
    // the same frame.
    return remaining <= 0 || remaining > windowSeconds
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.refreshing
  }
}
