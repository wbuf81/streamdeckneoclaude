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
 * Compares usage against elapsed window time. `fast` means usage leads the
 * clock. A missing `resetsAt` gives `even`, because elapsed time is unknown.
 */
export function computePace(
  usedPct: number,
  resetsAt: number,
  windowSeconds: number,
  now: number,
): Pace {
  if (!resetsAt || windowSeconds <= 0) return 'even'
  const remaining = resetsAt - now
  const elapsed = windowSeconds - remaining
  if (elapsed <= 0) return 'even'
  const elapsedPct = (elapsed / windowSeconds) * 100
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
        this.watcher = watch(this.stateDir, () => void this.refresh())
      }
    } catch (e) {
      log.once('usage-watch-failed', `fs.watch failed, polling only: ${String(e)}`)
    }
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  async refresh(): Promise<void> {
    const next = this.readUsage()
    this.readMeta()
    const key = JSON.stringify(next)
    if (key === this.lastKey) return
    this.lastKey = key
    this.usage = next
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

  private readMeta(): void {
    if (!existsSync(this.sessionsDir)) return
    let names: string[]
    try {
      names = readdirSync(this.sessionsDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      try {
        const raw = JSON.parse(readFileSync(join(this.sessionsDir, name), 'utf8'))
        this.meta.set(id, {
          model: typeof raw.model === 'string' ? raw.model : '',
          ctxPct: pct(raw.ctxPct),
          costUsd: pct(raw.costUsd),
          ts: num(raw.ts),
        })
      } catch {
        // Skip a corrupt file. The model line simply does not appear.
      }
    }
  }

  getUsage(): UsageSnapshot | null {
    return this.usage
  }

  /** True when the newest usage value is older than 15 minutes. */
  isStale(): boolean {
    if (!this.usage) return true
    return this.now() - this.usage.ts > STALE_USAGE_SECONDS
  }

  getMeta(sessionId: string): SessionMeta | null {
    return this.meta.get(sessionId) ?? null
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.watcher?.close()
    this.timer = null
    this.watcher = null
  }
}
