import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync, existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../paths.js'
import { log } from '../log.js'
import type { SessionStateName } from '../render/theme.js'

export const STALE_SECONDS = 600
const POLL_MS = 5000

const KNOWN: SessionStateName[] = ['idle', 'thinking', 'tool', 'permission', 'done']

export interface Session {
  sessionId: string
  state: SessionStateName
  label: string
  tool: string
  project: string
  cwd: string
  termProgram: string
  pid: number
  startedAt: number
  ts: number
}

/**
 * Parses one state file. Returns null for a stale session, a corrupt file, or a
 * file with no session id.
 */
export function parseSessionFile(json: string, now: number): Session | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  const sessionId = str(raw.sessionId)
  if (!sessionId) return null
  const ts = num(raw.ts)
  if (now - ts > STALE_SECONDS) return null

  const stateRaw = str(raw.state)
  const state = (KNOWN as string[]).includes(stateRaw)
    ? (stateRaw as SessionStateName)
    : 'unknown'

  return {
    sessionId,
    state,
    label: str(raw.label),
    tool: str(raw.tool),
    project: str(raw.project) || '—',
    cwd: str(raw.cwd),
    termProgram: str(raw.term_program),
    pid: num(raw.pid),
    startedAt: num(raw.startedAt),
    ts,
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Watches the daisy-statusbar state directory. It reads only, and it writes
 * nothing. `fs.watch` drops events on some file systems, so a 5 second poll
 * acts as a backstop.
 */
export class ClaudeSource extends EventEmitter {
  private sessions: Session[] = []
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private lastKey = ''
  private debounce: NodeJS.Timeout | null = null

  constructor(
    private readonly dir: string = paths.claudeStateDir,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super()
  }

  directoryExists(): boolean {
    return existsSync(this.dir)
  }

  async start(): Promise<void> {
    if (!this.directoryExists()) {
      log.once(
        'no-state-dir',
        `session state directory absent: ${this.dir}. The Claude page shows no sessions.`,
      )
    }
    await this.refresh()
    this.attachWatcher()
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  private attachWatcher(): void {
    if (!this.directoryExists()) return
    try {
      this.watcher = watch(this.dir, () => this.scheduleRefresh())
    } catch (e) {
      log.once('watch-failed', `fs.watch failed, polling only: ${String(e)}`)
    }
  }

  /** Coalesces a burst of events, because a rename fires more than once. */
  private scheduleRefresh(): void {
    if (this.debounce) return
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.refresh()
    }, 60)
  }

  /** Re-reads the directory. Emits `change` only when the result differs. */
  async refresh(): Promise<void> {
    const next = this.read()
    // Compare the whole session list, not a few chosen fields. An earlier
    // version keyed on sessionId, state, ts and tool. `ts` holds whole seconds,
    // so two writes inside one second with a new `label` gave the same key. The
    // deck then kept the old text, because it redraws only on `change`.
    const key = JSON.stringify(next)
    if (key === this.lastKey) return
    this.lastKey = key
    this.sessions = next
    this.emit('change')
  }

  private read(): Session[] {
    if (!this.directoryExists()) return []
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch (e) {
      log.once('readdir', `cannot read ${this.dir}: ${String(e)}`)
      return []
    }
    const now = this.now()
    const out: Session[] = []
    for (const name of names) {
      // update.js writes `<id>.json.<pid>.tmp` and renames it. Skip the temps.
      if (!name.endsWith('.json')) continue
      let text: string
      try {
        text = readFileSync(join(this.dir, name), 'utf8')
      } catch {
        continue
      }
      const s = parseSessionFile(text, now)
      if (s) out.push(s)
    }
    return out.sort((a, b) => b.ts - a.ts)
  }

  getSessions(): Session[] {
    return this.sessions
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
