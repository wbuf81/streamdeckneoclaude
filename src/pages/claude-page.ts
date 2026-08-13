import type { Image } from '@napi-rs/canvas'
import type { DeckFrame, KeySpec, StripSpec, Rgb } from '../render/specs.js'
import { blankKey } from '../render/specs.js'
import { theme, stateColor, stateLabel, barColor } from '../render/theme.js'
import type { SessionStateName } from '../render/theme.js'
import { truncate, formatDuration } from '../render/text.js'
import { getSpriteFrame, getSpriteFrameIndex } from '../render/sprites.js'
import type { Page, PressOutcome } from './types.js'
import type { Session } from '../sources/claude.js'
import type { UsageSnapshot, SessionMeta } from '../sources/usage.js'
import { computePace, elapsedPercent } from '../sources/usage.js'
import { KeyAssigner, SESSION_SLOTS } from './key-assigner.js'

export const PROJECT_CHARS = 10
const FIVE_HOURS = 5 * 3600

/** Key 3: the permanent crab mascot tile, between the session slots and the
 * gauges. Never a session slot, never blank. */
const CRAB_KEY_INDEX = SESSION_SLOTS

/** Total keys the page draws: up to 3 session slots, the crab tile, plus 4
 * gauges. Matches `DeckFrame.keys`'s fixed length of 8. */
const KEY_COUNT = SESSION_SLOTS + 1 + 4

/**
 * Ranks each session state by how urgently it needs attention, most urgent
 * first. Drives which state the permanent crab tile (key 3) animates when
 * several sessions disagree — the tile is one mascot for the whole page, so
 * it shows whichever session most needs the user's eye. Any state NOT in
 * this list — `unknown`, or a future value `daisy-statusbar` has not
 * documented, see docs/VERIFIED-FACTS.md — is treated as calm as `idle`,
 * the last (least urgent) entry here, since there is nothing more specific
 * to show.
 */
export const CRAB_STATE_PRIORITY: readonly SessionStateName[] = [
  'permission',
  'tool',
  'thinking',
  'done',
  'idle',
]

/** The most urgent state across `sessions`, per `CRAB_STATE_PRIORITY`. No
 * sessions at all is `idle` — the mascot has nothing to report, not nothing
 * to show. */
export function mostUrgentCrabState(sessions: Session[]): SessionStateName {
  if (sessions.length === 0) return 'idle'
  const idleRank = CRAB_STATE_PRIORITY.length - 1
  let best = idleRank
  for (const s of sessions) {
    const rank = CRAB_STATE_PRIORITY.indexOf(s.state)
    const effective = rank === -1 ? idleRank : rank
    if (effective < best) best = effective
  }
  return CRAB_STATE_PRIORITY[best]!
}

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

export type FocusFn = (
  pid: number,
  termProgram: string,
  cwd: string,
  project: string,
) => Promise<boolean>

export class ClaudePage implements Page {
  readonly name = 'claude'
  /**
   * Roughly 10 fps. The crab's source material plays at 70 ms per frame
   * (about 14 fps); a 100 ms tick samples it closely enough to read as
   * motion rather than a slideshow, without asking the daemon for a rate it
   * cannot use.
   */
  readonly tickMs = 100

  private assigner = new KeyAssigner()
  /** Session id per key 0 to `SESSION_SLOTS - 1`, from the last render. A
   * press reads it. */
  private slots: (string | null)[] = new Array(SESSION_SLOTS).fill(null)

  constructor(
    private readonly sessions: SessionReader,
    private readonly usage: UsageReader,
    private readonly focus: FocusFn,
  ) {}

  render(now: number, nowMs: number = now * 1000): DeckFrame {
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

    keys.push(this.crabKey(live, nowMs))

    const gauges = this.gaugeKeys(now)
    for (const gauge of gauges) keys.push(gauge)

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
    }

    // A pending permission pulses once per second, so the eye finds it.
    if (s.state === 'permission') key.pulseOn = now % 2 === 0

    // No crab here, on purpose: task 22 drew the crab full-key, underneath
    // all three text lines, and measured 41% ink coverage in the text band
    // — lesson 14. The crab now lives only on its own tile, key 3.
    return key
  }

  /**
   * Key 3: the permanent Claude mascot tile. Always shows the crab, never
   * text, whether or not any session is running — it is a mascot, not a
   * status slot. Animates whichever state is most urgent across all live
   * sessions, per `CRAB_STATE_PRIORITY`, so the ONE tile stays informative
   * even with several sessions in different states.
   */
  private crabKey(live: Session[], nowMs: number): KeySpec {
    const state = mostUrgentCrabState(live)
    const key: KeySpec = { kind: 'image' }
    const crab = crabFrame(state, nowMs)
    if (crab) {
      key.image = crab.image
      key.imageKey = crab.imageKey
    }
    return key
  }

  private gaugeKeys(now: number): KeySpec[] {
    const u = this.usage.getUsage()
    const stale = this.usage.isStale()

    if (!u) {
      return [
        { kind: 'gauge', lines: ['5-HR CAP', '--'], lineSizes: [11, 28], align: 'center', dim: true },
        { kind: 'gauge', lines: ['WEEK CAP', '--'], lineSizes: [11, 28], align: 'center', dim: true },
        { kind: 'gauge', lines: ['BURN RATE', '--'], lineSizes: [11, 16], align: 'center', dim: true },
        { kind: 'gauge', lines: ['RESETS IN', '--'], lineSizes: [11, 24], align: 'center', dim: true },
      ]
    }

    const five = u.fiveHourPct
    const seven = u.sevenDayPct

    return [
      this.capKey('5-HR CAP', five, stale),
      this.capKey('WEEK CAP', seven, stale),
      this.burnRateKey(five, u.fiveHourResetsAt, now, stale),
      this.resetKey(u.fiveHourResetsAt, now, stale),
    ]
  }

  /** Keys 4 and 5: label, whole-percent value, and a bar — unless the cache
   * is stale, when the bar gives way to a `STALE` third line instead, so a
   * dimmed bar can never be mistaken for a current one. */
  private capKey(label: string, pct: number | null, stale: boolean): KeySpec {
    const value = pct === null ? '--' : `${Math.floor(pct)}%`

    if (stale) {
      return {
        kind: 'gauge',
        lines: [label, value, 'STALE'],
        lineSizes: [11, 28, 11],
        align: 'center',
        dim: true,
      }
    }

    const spec: KeySpec = {
      kind: 'gauge',
      lines: [label, value],
      lineSizes: [11, 28],
      align: 'center',
    }
    if (pct !== null) {
      spec.bar = { value: pct / 100, color: barColor(pct / 100) }
    }
    return spec
  }

  /**
   * Key 6: a one-word verdict on whether usage is ahead of or behind the
   * clock, plus the evidence beneath it. Reuses `computePace` for the
   * verdict and `elapsedPercent` for the evidence line, so the word and the
   * numbers under it are always computed from the same comparison and can
   * never disagree with each other.
   */
  private burnRateKey(
    usedPct: number | null,
    resetsAt: number,
    now: number,
    stale: boolean,
  ): KeySpec {
    const label = 'BURN RATE'

    if (usedPct === null) {
      const lines = stale ? [label, '--', 'STALE'] : [label, '--']
      const lineSizes = stale ? [11, 16, 11] : [11, 16]
      const spec: KeySpec = { kind: 'gauge', lines, lineSizes, align: 'center' }
      if (stale) spec.dim = true
      return spec
    }

    const pace = computePace(usedPct, resetsAt, FIVE_HOURS, now)
    const word = pace === 'slow' ? 'UNDER' : pace === 'fast' ? 'OVER' : 'ON PACE'
    const wordColor: Rgb = pace === 'slow' ? theme.green : pace === 'fast' ? theme.red : theme.amber

    if (stale) {
      return {
        kind: 'gauge',
        lines: [label, word, 'STALE'],
        lineSizes: [11, 16, 11],
        lineColors: [undefined, wordColor],
        align: 'center',
        dim: true,
      }
    }

    const elapsedPct = elapsedPercent(resetsAt, FIVE_HOURS, now)
    const lines = [label, word]
    const lineSizes = [11, 16]
    if (elapsedPct !== null) {
      lines.push(`${Math.round(usedPct)}% of ${Math.round(elapsedPct)}%`)
      lineSizes.push(11)
    }

    return {
      kind: 'gauge',
      lines,
      lineSizes,
      lineColors: [undefined, wordColor],
      align: 'center',
    }
  }

  /** Key 7: the countdown to the five-hour reset, with a third line naming
   * which window it is — the countdown alone does not say. */
  private resetKey(resetsAt: number, now: number, stale: boolean): KeySpec {
    const value = resetsAt ? formatDuration(resetsAt - now) : '--'
    const spec: KeySpec = {
      kind: 'gauge',
      lines: ['RESETS IN', value, stale ? 'STALE' : '5-hr'],
      lineSizes: [11, 24, 11],
      align: 'center',
    }
    if (stale) spec.dim = true
    return spec
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

  /**
   * Key 0 to 2 focus the session in that slot, when one is bound and focus
   * succeeds. Key 3 (the crab mascot tile) and keys 4 to 7 (the gauges) are
   * always `ignored` — nothing is bound to them. The daemon, not this page,
   * draws the on-device feedback for every outcome; see `PressOutcome`.
   */
  async onKeyPress(index: number): Promise<PressOutcome> {
    if (index < 0 || index >= KEY_COUNT) return 'ignored'
    if (index >= SESSION_SLOTS) return 'ignored'

    const id = this.slots[index]
    if (!id) return 'ignored'
    const session = this.sessions.getSessions().find((s) => s.sessionId === id)
    if (!session) return 'ignored'
    const ok = await this.focus(session.pid, session.termProgram, session.cwd, session.project)
    return ok ? 'handled' : 'failed'
  }
}

/**
 * Picks the decoded crab frame for `state` at `nowMs`. Tries `state` itself
 * first, then falls back to `idle` — the extraction is expected to cover
 * every `SessionStateName`, but a partial or failed extraction must still
 * degrade gracefully rather than draw a stale or wrong animation. Returns
 * null (draw no crab) when neither has any cached frames.
 *
 * `imageKey` carries the resolved state and frame index, because `keyHash`
 * ignores `image` itself (a decoded `Image` is not JSON-serialisable data,
 * and comparing it every tick would be wasted work) — without a distinct
 * `imageKey` per frame, the daemon would never see the crab's hash change
 * and would never write the animated key.
 *
 * Exported so a test can prove the fallback and the frame-identity behaviour
 * directly, against a fixture that loads only some states.
 */
export function crabFrame(
  state: string,
  nowMs: number,
): { image: Image; imageKey: string } | null {
  for (const candidate of [state, 'idle']) {
    const idx = getSpriteFrameIndex(candidate, nowMs)
    if (idx === null) continue
    const image = getSpriteFrame(candidate, nowMs)
    if (!image) continue
    return { image, imageKey: `crab:${candidate}:${idx}` }
  }
  return null
}
