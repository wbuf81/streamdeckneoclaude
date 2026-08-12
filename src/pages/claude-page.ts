import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
import { blankKey } from '../render/specs.js'
import { theme, stateColor, stateLabel, barColor } from '../render/theme.js'
import { truncate, formatDuration } from '../render/text.js'
import type { Page } from './types.js'
import type { Session } from '../sources/claude.js'
import type { UsageSnapshot, SessionMeta } from '../sources/usage.js'
import { computePace } from '../sources/usage.js'
import { KeyAssigner, SESSION_SLOTS } from './key-assigner.js'

export const PROJECT_CHARS = 10
const FIVE_HOURS = 5 * 3600

/** The part of `ClaudeSource` this page needs. */
export interface SessionReader {
  getSessions(): Session[]
  directoryExists(): boolean
}

/** The part of `UsageSource` this page needs. */
export interface UsageReader {
  getUsage(): UsageSnapshot | null
  isStale(): boolean
  getMeta(sessionId: string): SessionMeta | null
}

export type FocusFn = (pid: number, termProgram: string) => Promise<boolean>

export class ClaudePage implements Page {
  readonly name = 'claude'

  private assigner = new KeyAssigner()
  /** Session id per key 0 to 3, from the last render. A press reads it. */
  private slots: (string | null)[] = new Array(SESSION_SLOTS).fill(null)

  constructor(
    private readonly sessions: SessionReader,
    private readonly usage: UsageReader,
    private readonly focus: FocusFn,
  ) {}

  render(now: number): DeckFrame {
    const live = this.sessions.getSessions()
    const { slots, overflow } = this.assigner.assign(live)
    this.slots = slots

    const byId = new Map(live.map((s) => [s.sessionId, s]))
    const keys: KeySpec[] = []

    for (let i = 0; i < SESSION_SLOTS; i++) {
      const id = slots[i]
      const session = id ? byId.get(id) : undefined
      keys.push(session ? this.sessionKey(session, now) : blankKey())
    }

    keys.push(...this.gaugeKeys(now))

    return {
      keys,
      strip: this.strip(live, overflow, now),
      buttons: [theme.gray, theme.gray],
    }
  }

  private sessionKey(s: Session, now: number): KeySpec {
    const lines = [stateLabel(s.state), truncate(s.project, PROJECT_CHARS)]
    const meta = this.usage.getMeta(s.sessionId)
    if (meta?.model) lines.push(meta.model)

    const key: KeySpec = {
      kind: 'session',
      lines,
      border: stateColor(s.state),
      sprite: 'crab',
    }

    // A pending permission pulses once per second, so the eye finds it.
    if (s.state === 'permission') key.pulseOn = now % 2 === 0

    return key
  }

  private gaugeKeys(now: number): KeySpec[] {
    const u = this.usage.getUsage()
    const stale = this.usage.isStale()

    if (!u) {
      return [
        { kind: 'gauge', lines: ['5h', '--'], dim: true },
        { kind: 'gauge', lines: ['7d', '--'], dim: true },
        { kind: 'gauge', lines: ['PACE', '--'], dim: true },
        { kind: 'gauge', lines: ['RESET', '--'], dim: true },
      ]
    }

    const suffix = stale ? 'STALE' : ''
    const five = u.fiveHourPct
    const seven = u.sevenDayPct

    const gauge = (label: string, pct: number | null): KeySpec => {
      const spec: KeySpec = {
        kind: 'gauge',
        lines: [label, pct === null ? '--' : `${Math.floor(pct)}%`, suffix].filter(Boolean),
      }
      if (stale) spec.dim = true
      if (pct !== null) {
        spec.bar = { value: pct / 100, color: barColor(pct / 100) }
      }
      return spec
    }

    const pace =
      five === null
        ? 'even'
        : computePace(five, u.fiveHourResetsAt, FIVE_HOURS, now)
    const paceArrow = pace === 'fast' ? '⇡' : pace === 'slow' ? '⇣' : '·'

    const paceKey: KeySpec = {
      kind: 'gauge',
      lines: [`PACE ${paceArrow}`, pace, suffix].filter(Boolean),
    }
    const resetSeconds = u.fiveHourResetsAt ? u.fiveHourResetsAt - now : 0
    const resetKey: KeySpec = {
      kind: 'gauge',
      lines: ['RESET', u.fiveHourResetsAt ? formatDuration(resetSeconds) : '--', suffix].filter(Boolean),
    }
    if (stale) {
      paceKey.dim = true
      resetKey.dim = true
    }

    return [gauge('5h', five), gauge('7d', seven), paceKey, resetKey]
  }

  private strip(live: Session[], overflow: number, now: number): StripSpec {
    if (!this.sessions.directoryExists()) {
      return { lines: ['claude', 'no session data'], dim: true }
    }
    if (live.length === 0) {
      return { lines: ['claude', 'no active sessions'], dim: true }
    }

    const newest = live[0]!
    const elapsed = newest.startedAt ? formatDuration(now - newest.startedAt) : ''
    const parts = [newest.project, newest.tool || newest.label, elapsed].filter(Boolean)
    const second = overflow > 0 ? `+${overflow} more` : `${live.length} active`

    return { lines: [parts.join(' · '), second] }
  }

  async onKeyPress(index: number): Promise<void> {
    // Keys 4 to 7 are gauges. They do nothing in v1.
    if (index < 0 || index >= SESSION_SLOTS) return
    const id = this.slots[index]
    if (!id) return
    const session = this.sessions.getSessions().find((s) => s.sessionId === id)
    if (!session) return
    await this.focus(session.pid, session.termProgram)
  }
}
