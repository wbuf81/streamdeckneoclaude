import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync, existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../paths.js'
import { log } from '../log.js'

export const STALE_USAGE_SECONDS = 900
const POLL_MS = 10000
const PACE_BAND = 5

export type Pace = 'fast' | 'slow' | 'even'

export interface UsageSnapshot {
  fiveHourPct: number | null
  fiveHourResetsAt: number
  sevenDayPct: number | null
  sevenDayResetsAt: number
  ts: number
}

export interface SessionMeta {
  model: string
  ctxPct: number | null
  costUsd: number | null
  ts: number
}

/**
 * The percent of `windowSeconds` that has elapsed toward `resetsAt`, as of
 * `now`. Null when `resetsAt` is unknown, the window length is not
 * positive, or the window has not started yet — the same conditions under
 * which `computePace` falls back to `even`, because there is nothing yet to
 * compare a usage percentage against.
 */
export function elapsedPercent(
  resetsAt: number,
  windowSeconds: number,
  now: number,
): number | null {
  if (!resetsAt || windowSeconds <= 0) return null
  const remaining = resetsAt - now
  const elapsed = windowSeconds - remaining
  if (elapsed <= 0) return null
  // M6, same family as I1's future-timestamp guard: when `resetsAt` is
  // already in the past, `remaining` goes negative and `elapsed` overruns
  // `windowSeconds`, so the raw ratio exceeds 100. An elapsed percentage
  // past 100 is not a real reading of anything — the window has already
  // ended — and left unclamped it made `computePace` report `slow`
  // permanently, since `usedPct` (0 to 100) can never catch up to a
  // three-digit `elapsedPct`. Clamp at the boundary the window itself
  // defines.
  return Math.min(100, (elapsed / windowSeconds) * 100)
}

/**
 * Compares usage against elapsed window time. `fast` means usage leads the
 * clock. A missing `resetsAt` gives `even`, because elapsed time is unknown.
 */
export function computePace(
  usedPct: number,
  resetsAt: number,
  windowSeconds: number,
  now: number,
): Pace {
  const elapsedPct = elapsedPercent(resetsAt, windowSeconds, now)
  if (elapsedPct === null) return 'even'
  const delta = usedPct - elapsedPct
  if (delta > PACE_BAND) return 'fast'
  if (delta < -PACE_BAND) return 'slow'
  return 'even'
}

export function parseUsage(json: string): UsageSnapshot | null {
  let raw: Record<string, any>
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const rl = raw.rate_limits ?? {}
  return {
    fiveHourPct: pct(rl.five_hour?.used_percentage),
    fiveHourResetsAt: num(rl.five_hour?.resets_at),
    sevenDayPct: pct(rl.seven_day?.used_percentage),
    sevenDayResetsAt: num(rl.seven_day?.resets_at),
    ts: num(raw.ts),
  }
}

function pct(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Reads the cache that the statusline wrapper writes. The daemon cannot read
 * rate limits directly, because Claude Code sends them to the statusline
 * command on stdin.
 */
export class UsageSource extends EventEmitter {
  private usage: UsageSnapshot | null = null
  private meta = new Map<string, SessionMeta>()
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private lastKey = ''
  private debounce: NodeJS.Timeout | null = null

  constructor(
    private readonly stateDir: string = paths.stateDir,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super()
  }

  private get usageFile(): string {
    return join(this.stateDir, 'usage.json')
  }

  private get sessionsDir(): string {
    return join(this.stateDir, 'sessions')
  }

  async start(): Promise<void> {
    await this.refresh()
    try {
      if (existsSync(this.stateDir)) {
        this.watcher = watch(this.stateDir, () => this.scheduleRefresh())
      }
    } catch (e) {
      log.once('usage-watch-failed', `fs.watch failed, polling only: ${String(e)}`)
    }
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  /** M2: coalesces a burst of watch events — same rationale as
   * `ClaudeSource.scheduleRefresh`, watching the same kind of directory with
   * the same rename-based writer: a rename fires more than once, and the
   * statusline wrapper rewrites `usage.json` on every Claude Code render, so
   * this fires often. Each event without this ran a full `readdirSync` of
   * `sessions/` plus a `readFileSync` and `JSON.parse` per session file. */
  private scheduleRefresh(): void {
    if (this.debounce) return
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.refresh()
    }, 60)
  }

  async refresh(): Promise<void> {
    const nextUsage = this.readUsage()
    const nextMeta = this.readMeta()
    // The key folds in BOTH the usage snapshot and the freshly-read metadata.
    // ClaudeSource had the same bug once: a key built from only some fields
    // let the model/context/cost line go stale, because usage.json can stay
    // put across renders while the per-session file changes underneath it.
    // Map order is not guaranteed to match write order, so entries are
    // sorted before stringifying, or two functionally-identical maps could
    // produce different keys and fire a spurious `change`.
    const key = JSON.stringify({
      usage: nextUsage,
      meta: Array.from(nextMeta.entries()).sort(([a], [b]) => a.localeCompare(b)),
    })
    if (key === this.lastKey) return
    this.lastKey = key
    this.usage = nextUsage
    this.meta = nextMeta
    this.emit('change')
  }

  private readUsage(): UsageSnapshot | null {
    if (!existsSync(this.usageFile)) return null
    try {
      return parseUsage(readFileSync(this.usageFile, 'utf8'))
    } catch {
      return null
    }
  }

  /** Reads every per-session file fresh. Returns the map rather than only
   * mutating `this.meta`, so `refresh()` can fold it into the change key. */
  private readMeta(): Map<string, SessionMeta> {
    const out = new Map<string, SessionMeta>()
    if (!existsSync(this.sessionsDir)) return out
    let names: string[]
    try {
      names = readdirSync(this.sessionsDir)
    } catch {
      return out
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      try {
        const raw = JSON.parse(readFileSync(join(this.sessionsDir, name), 'utf8'))
        out.set(id, {
          model: typeof raw.model === 'string' ? raw.model : '',
          ctxPct: pct(raw.ctxPct),
          costUsd: pct(raw.costUsd),
          ts: num(raw.ts),
        })
      } catch {
        // Skip a corrupt file. The model line simply does not appear.
      }
    }
    return out
  }

  /** I2: `UsageSnapshot` is flat, so a shallow copy is deep enough — this
   * used to return the live object itself, letting a caller mutate the
   * source's own cached usage snapshot. */
  getUsage(): UsageSnapshot | null {
    return this.usage ? { ...this.usage } : null
  }

  /** True when the newest usage value is older than 15 minutes. */
  isStale(): boolean {
    if (!this.usage) return true
    return this.now() - this.usage.ts > STALE_USAGE_SECONDS
  }

  /** I2: `SessionMeta` is flat, so a shallow copy is deep enough — this used
   * to return the live map entry itself. */
  getMeta(sessionId: string): SessionMeta | null {
    const m = this.meta.get(sessionId)
    return m ? { ...m } : null
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.watcher?.close()
    this.timer = null
    this.debounce = null
    this.watcher = null
  }
}
