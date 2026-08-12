import type { Image } from '@napi-rs/canvas'
import type { DeckFrame, KeySpec, StripSpec, Rgb } from '../render/specs.js'
import { blankKey } from '../render/specs.js'
import { theme, stateColor, stateLabel, barColor } from '../render/theme.js'
import { truncate, formatDuration } from '../render/text.js'
import { getSpriteFrame, getSpriteFrameIndex } from '../render/sprites.js'
import type { Page } from './types.js'
import type { Session } from '../sources/claude.js'
import type { UsageSnapshot, SessionMeta } from '../sources/usage.js'
import { computePace, elapsedPercent } from '../sources/usage.js'
import { KeyAssigner, SESSION_SLOTS } from './key-assigner.js'

export const PROJECT_CHARS = 10
const FIVE_HOURS = 5 * 3600

/** Total keys the page draws: 4 session slots plus 4 gauges. Matches
 * `DeckFrame.keys`'s fixed length of 8. */
const KEY_COUNT = SESSION_SLOTS + 4

/**
 * How long a press's white/red border flash stays visible before reverting
 * to the key's own colour. 200 ms is the project spec's figure. At this
 * page's 100 ms tick (`tickMs` above) that is two to three render frames —
 * enough to read as a flash on real hardware rather than nothing at all,
 * without lingering long enough to look like a state colour.
 */
const FLASH_MS = 200

/** A transient press-feedback border on one key: white for success, red for
 * failure, until `expiresAtMs`. */
interface Flash {
  ok: boolean
  expiresAtMs: number
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
  /** Session id per key 0 to 3, from the last render. A press reads it. */
  private slots: (string | null)[] = new Array(SESSION_SLOTS).fill(null)
  /** One transient flash per key, indices 0 to 7. `null` means no flash. */
  private flashes: (Flash | null)[] = new Array(KEY_COUNT).fill(null)
  /**
   * The millisecond clock from the most recent `render()` call. `onKeyPress`
   * has no clock of its own — the daemon calls it with only the key index,
   * and a page must never call `Date.now()` itself — so a new flash anchors
   * its expiry to the last time this page actually saw the clock. The
   * daemon always renders again immediately after handling a press, so this
   * is at most one tick stale.
   */
  private lastNowMs = 0

  constructor(
    private readonly sessions: SessionReader,
    private readonly usage: UsageReader,
    private readonly focus: FocusFn,
  ) {}

  render(now: number, nowMs: number = now * 1000): DeckFrame {
    this.lastNowMs = nowMs

    const live = this.sessions.getSessions()
    const { slots, overflow } = this.assigner.assign(live)
    this.slots = slots

    const byId = new Map(live.map((s) => [s.sessionId, s]))
    const keys: KeySpec[] = []

    for (let i = 0; i < SESSION_SLOTS; i++) {
      const id = slots[i]
      const session = id ? byId.get(id) : undefined
      const key = session ? this.sessionKey(session, now, nowMs) : blankKey()
      keys.push(this.withFlash(i, key, nowMs))
    }

    const gauges = this.gaugeKeys(now)
    for (let i = 0; i < gauges.length; i++) {
      keys.push(this.withFlash(SESSION_SLOTS + i, gauges[i]!, nowMs))
    }

    return {
      keys,
      strip: this.strip(live, overflow, now),
      buttons: [theme.gray, theme.gray],
    }
  }

  /**
   * Overlays the press-feedback flash for `index`, if one is still active.
   * The flash wins over the key's own border and pulse — white or red is a
   * direct answer to a human action a moment ago, and must not compete with
   * the permission pulse for the eye.
   *
   * Once `nowMs` reaches the expiry, the stored flash is discarded and this
   * function returns `key` untouched, so the key's hash goes back to
   * exactly what it would have been with no flash ever recorded. That is
   * what lets the daemon's dirty-key check stop redrawing it again.
   */
  private withFlash(index: number, key: KeySpec, nowMs: number): KeySpec {
    const flash = this.flashes[index]
    if (!flash) return key
    if (nowMs >= flash.expiresAtMs) {
      this.flashes[index] = null
      return key
    }
    return { ...key, border: flash.ok ? theme.white : theme.red, pulseOn: undefined }
  }

  /** Records a flash for `index`, timed off the clock `render()` last saw. */
  private setFlash(index: number, ok: boolean): void {
    this.flashes[index] = { ok, expiresAtMs: this.lastNowMs + FLASH_MS }
  }

  private sessionKey(s: Session, now: number, nowMs: number): KeySpec {
    const lines = [stateLabel(s.state), truncate(s.project, PROJECT_CHARS)]
    const meta = this.usage.getMeta(s.sessionId)
    if (meta?.model) lines.push(meta.model)

    const key: KeySpec = {
      kind: 'session',
      lines,
      border: stateColor(s.state),
    }

    // A pending permission pulses once per second, so the eye finds it. This
    // stays driven by `now` (whole seconds), never `nowMs` — at a 100 ms tick,
    // keying it to the millisecond clock would make it flicker instead.
    if (s.state === 'permission') key.pulseOn = now % 2 === 0

    const crab = crabFrame(s.state, nowMs)
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

  async onKeyPress(index: number): Promise<void> {
    if (index < 0 || index >= KEY_COUNT) return

    // Keys 4 to 7 are gauges. They do nothing, but a press there still gets
    // an answer — a brief red flash is honest feedback, rather than being
    // indistinguishable from a press that did not register at all.
    if (index >= SESSION_SLOTS) {
      this.setFlash(index, false)
      return
    }

    const id = this.slots[index]
    if (!id) {
      this.setFlash(index, false)
      return
    }
    const session = this.sessions.getSessions().find((s) => s.sessionId === id)
    if (!session) {
      this.setFlash(index, false)
      return
    }
    const ok = await this.focus(session.pid, session.termProgram, session.cwd, session.project)
    this.setFlash(index, ok)
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
