import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import { paths } from '../paths.js'
import { log } from '../log.js'

const POLL_MS = 5000
export const STALE_CODEX_SECONDS = 60

const THREAD_QUERY = `
SELECT id, rollout_path, updated_at_ms, title, cwd, model, tokens_used
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
  updatedAt: number
  tokensUsed: number
}

export interface CodexLimit {
  usedPct: number
  windowMinutes: number
  resetsAt: number
}

export interface CodexUsage {
  limits: CodexLimit[]
  totalTokens: number
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
  size: number
}

export type SqliteRunner = (database: string, query: string) => Promise<string>
export type RolloutTailReader = (file: string, start: number) => RolloutRead

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseLimit(value: unknown): CodexLimit | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const usedPct = finite(raw.used_percent)
  const windowMinutes = finite(raw.window_minutes)
  const resetsAt = finite(raw.resets_at)
  if (windowMinutes <= 0) return null
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

/** Reads a rollout incrementally. The first pass establishes the true latest
 * lifecycle event even for a very long task; later polls read only bytes
 * appended since the prior pass instead of rescanning the transcript. */
export function readRolloutTail(file: string, requestedStart = 0): RolloutRead {
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const start = requestedStart >= 0 && requestedStart <= size ? requestedStart : 0
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    return { text: buffer.toString('utf8'), size }
  } finally {
    closeSync(fd)
  }
}

export function runSqlite(database: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/sqlite3',
      ['-readonly', '-json', database, query],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout),
    )
  })
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

  async start(): Promise<void> {
    await this.refresh()
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
          const read = this.readTail(rollout, cursor?.offset ?? 0)
          const reset = !!cursor && read.size < cursor.offset
          const combined = (reset ? '' : (cursor?.remainder ?? '')) + read.text
          const lastNewline = combined.lastIndexOf('\n')
          const complete = lastNewline === -1 ? '' : combined.slice(0, lastNewline + 1)
          const remainder = lastNewline === -1 ? combined : combined.slice(lastNewline + 1)
          state = parseRolloutTail(complete, reset ? undefined : cursor?.state)
          this.cursors.set(rollout, { offset: read.size, remainder, state })
        } catch {
          continue
        }
        if (state.usage && (!newestUsage || state.usage.ts > newestUsage.ts)) {
          newestUsage = state.usage
        }
        if (!state.active) continue
        tasks.push({
          threadId: str(row.id),
          title: str(row.title),
          project: basename(str(row.cwd)) || '—',
          model: str(row.model),
          updatedAt: Math.floor(finite(row.updated_at_ms) / 1000),
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
      log.once('codex-state-read', `cannot read Codex task data: ${String(error)}`)
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

  isStale(): boolean {
    return !this.lastSuccessAt || this.now() - this.lastSuccessAt > STALE_CODEX_SECONDS
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.refreshing
  }
}
