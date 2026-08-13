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

/** Plain, unmeasured size for the session tile's state label (`IDLE`,
 * `THINKING`, ...). Every value comes from `theme.ts`'s own small, known-safe
 * enum — the widest, `THINKING`, measures 53.0 px against the key's 81 px
 * usable width — so it never needs measuring or an ellipsis, unlike the
 * model line below. */
const STATE_LABEL_SIZE = 11
/** One-candidate array for the project line (I1's sweep for other unmeasured
 * lines on this tile): `truncate(s.project, PROJECT_CHARS)` already bounds
 * it to 10 characters, measured safe at 11 px (66.2 px against the 81 px
 * usable width) — but a character count is not a pixel measurement, per
 * docs/LESSONS.md #17. Wrapping it in a one-candidate array, the same trick
 * `weather-page.ts`'s WIND line uses, routes it through the real
 * measure-and-`shrinkToFit` path, so a future font change degrades to an
 * ellipsis instead of clipping silently. */
const PROJECT_SIZE = [11]
/**
 * Candidate sizes for the session tile's model line (I1). `meta.model` is
 * Claude Code's own `display_name`, an external string straight off stdin
 * with no length bound (docs/VERIFIED-FACTS.md) — the review's exact repro:
 * `Claude Sonnet 4.5` (17 characters) measured 112.6 px at a bare,
 * unmeasured 11 px, running to column 94 with 22 px of ink past the key's
 * 90-95 padding margin. Even the smallest candidate here (92.1 px at 9 px)
 * still does not fully fit 81 px, so this relies on `shrinkToFit`'s own
 * ellipsis the same way codex-page.ts's `MODEL_SIZES` does for the identical
 * shape — a short name like `Sonnet 4.5` (66.2 px at 11 px) still renders in
 * full, since `resolveLineSpecs` always tries the largest candidate first.
 */
const MODEL_SIZES = [11, 10, 9]
/**
 * Candidate sizes for the reset countdown value line (C1). `ELAPSED`
 * (7 characters) measures 101.1 px at 24 px and 67.4 px at 16 px, against
 * the 81 px usable width — so 24 alone, the old bare size, would have
 * clipped it. Mirrors codex-page.ts's own `RESET_SIZES` for the identical
 * shape. Exported so the test file can assert against the same array
 * instead of a hard-coded literal size that no longer applies.
 */
export const RESET_SIZES = [24, 20, 16, 11]
/**
 * Candidate sizes for the burn-rate evidence line (M1). Unlike the cap-key
 * percentage (clamped nowhere on this page, and measured safe up to a real
 * schema-drift `1234%`), the evidence line combines TWO unclamped
 * percentages: a schema-drift `usedPct` alongside `elapsedPercent`, and
 * `100% of 1000%` measures 86.1 px at the old bare 11 px, past the 81 px
 * usable width — latent today only because `elapsedPercent` itself stays
 * under about 105% while the usage cache is fresh enough to reach this
 * branch at all. Exported so the test file can assert against the same
 * array instead of a hard-coded literal size that no longer applies.
 */
export const EVIDENCE_SIZES = [11, 10, 9]

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

/**
 * True when `resetsAt` names a real window that has already ended, as of
 * `now` (C1). `resetsAt` of `0` means "never known" and is left to each
 * caller's own null/zero handling — this only answers the SEPARATE question
 * of a window that WAS known but has since closed. A closed window's true
 * usage is not knowable from a snapshot taken before it ended: `usage.json`
 * can sit unchanged, and so pass `isStale()`'s own 15-minute check, for the
 * entire time between the window ending and the statusline's next write —
 * verified by rendering, up to 15 minutes of a fully bright `87%` bar for a
 * cap that has already reset, then `RESETS IN 0m` frozen forever once
 * staleness finally catches up. Mirrors codex-page.ts's `isUsageUnknown` for
 * the identical harm; `UsageSnapshot` already carries everything this needs
 * (`fiveHourResetsAt`, `sevenDayResetsAt`), so no source change is required.
 */
export function isWindowEnded(resetsAt: number, now: number): boolean {
  return resetsAt > 0 && resetsAt <= now
}

/**
 * The reset countdown's value line (C1). Mirrors codex-page.ts's own
 * `formatResetIn` for the identical harm: a `resetsAt` at or before `now`
 * renders `ELAPSED`, never `formatDuration`'s `0m`, which would otherwise
 * repeat forever for a window this page never advances past its own
 * deadline. `resetsAt` of `0` (never known) renders `--`.
 */
export function formatResetIn(resetsAt: number, now: number): string {
  if (!resetsAt) return '--'
  const remaining = resetsAt - now
  return remaining <= 0 ? 'ELAPSED' : formatDuration(remaining)
}

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

  // M9 — the assigner itself is deliberately stateful (a live session must
  // keep its own slot across calls, never reshuffle while the user reads
  // it), but the PAGE used to cache its result in a `this.slots` field, set
  // only inside `render()`, purely so `onKeyPress` could read it later. That
  // made a press target a side effect of rendering: a page with live
  // sessions that had never rendered a single frame reported `ignored` on
  // every session key, since the cache had never been populated. Removed —
  // `onKeyPress` now calls `this.assigner.assign` itself, the same call
  // `render` makes, which is safe because `assign` is idempotent for an
  // unchanged live-session list (it only ever fills currently-free slots
  // from newly-waiting sessions; a session already holding a slot is left
  // exactly where it is). This matches the stocks and weather pages' own
  // `activeQuote`/`activeDay`, computed fresh rather than cached on `this`.
  private assigner = new KeyAssigner()

  constructor(
    private readonly sessions: SessionReader,
    private readonly usage: UsageReader,
    private readonly focus: FocusFn,
  ) {}

  render(now: number, nowMs: number = now * 1000): DeckFrame {
    const live = this.sessions.getSessions()
    const { slots, overflow } = this.assigner.assign(live)

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

    // M3 — the key 0 session, by stable identity, rather than `live[0]`
    // (the newest session by `ts`). Those two used to differ silently once
    // a session ended and a new one claimed a freed slot: `live` re-sorts
    // by `ts` on every render, but the assigner holds a session in its slot
    // until it ends, so the frame's OWN key 0 and "the newest session" can
    // name two different sessions with nothing on the frame to say so.
    const key0Id = slots[0]
    const key0Session = key0Id ? byId.get(key0Id) ?? null : null

    return {
      keys,
      strip: this.strip(live, key0Session, overflow, now),
      buttons: [theme.gray, theme.gray],
    }
  }

  private sessionKey(s: Session, now: number): KeySpec {
    const lines = [stateLabel(s.state), truncate(s.project, PROJECT_CHARS)]
    // I1 — this array used to be handed to `KeySpec` with NO `lineSizes` at
    // all, which sends every line through `resolveLineSpecs`'s legacy
    // branch: a bare, unmeasured 11 px, never shrunk, never ellipsised. The
    // model line is the one that actually overflows in practice (see
    // `MODEL_SIZES`'s own comment), but the other two get the same
    // measure-and-shrink protection here too, per the review's "sweep every
    // line" instruction.
    const lineSizes: (number | number[])[] = [STATE_LABEL_SIZE, PROJECT_SIZE]
    const meta = this.usage.getMeta(s.sessionId)
    if (meta?.model) {
      lines.push(meta.model)
      lineSizes.push(MODEL_SIZES)
    }

    const key: KeySpec = {
      kind: 'session',
      lines,
      lineSizes,
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
    // C1 — a fresh `usage.json` (so `isStale()` reports false) can still
    // describe a five-hour or seven-day window that has already ended:
    // `isStale()` only measures the AGE of the read, never whether the
    // window IT DESCRIBES is still current. Checked independently per
    // window, since the two end at different times and either can close
    // while the other stays live.
    const fiveEnded = isWindowEnded(u.fiveHourResetsAt, now)
    const sevenEnded = isWindowEnded(u.sevenDayResetsAt, now)

    return [
      this.capKey('5-HR CAP', five, stale, fiveEnded),
      this.capKey('WEEK CAP', seven, stale, sevenEnded),
      this.burnRateKey(five, u.fiveHourResetsAt, now, stale, fiveEnded),
      this.resetKey(u.fiveHourResetsAt, now, stale, fiveEnded),
    ]
  }

  /** Keys 4 and 5: label, whole-percent value, and a bar — unless the cache
   * is stale, when the bar gives way to a `STALE` third line instead, so a
   * dimmed bar can never be mistaken for a current one. */
  private capKey(label: string, pct: number | null, stale: boolean, windowEnded: boolean): KeySpec {
    // C1 — an ended window's own figure is not merely old, it is unknowable:
    // the snapshot may have been taken before the window closed, so any
    // percentage it carries could describe a cap that has already reset.
    // This wins over `stale` (a fresh `usage.json` can still describe an
    // ended window for up to `STALE_USAGE_SECONDS`) and renders the same
    // plain `--` codex-page.ts's own `isUsageUnknown` branch uses — never a
    // real number dimmed under a STALE label that implies the read is
    // merely lagging behind otherwise-true data.
    if (pct === null || windowEnded) {
      return {
        kind: 'gauge',
        lines: [label, '--'],
        lineSizes: [11, 28],
        align: 'center',
        dim: true,
      }
    }

    const value = `${Math.floor(pct)}%`

    if (stale) {
      return {
        kind: 'gauge',
        lines: [label, value, 'STALE'],
        lineSizes: [11, 28, 11],
        align: 'center',
        dim: true,
      }
    }

    return {
      kind: 'gauge',
      lines: [label, value],
      lineSizes: [11, 28],
      align: 'center',
      bar: { value: pct / 100, color: barColor(pct / 100) },
    }
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
    windowEnded: boolean,
  ): KeySpec {
    const label = 'BURN RATE'

    // C1 — same rule as `capKey`: a pace verdict compares usage against
    // elapsed window time, and once the window has ended neither side of
    // that comparison is trustworthy any more. Renders the same plain `--`
    // as an unknown percentage, dimmed even when the read itself is not
    // otherwise stale.
    if (usedPct === null || windowEnded) {
      const lines = stale ? [label, '--', 'STALE'] : [label, '--']
      const lineSizes = stale ? [11, 16, 11] : [11, 16]
      const spec: KeySpec = { kind: 'gauge', lines, lineSizes, align: 'center' }
      if (stale || windowEnded) spec.dim = true
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
    const lineSizes: (number | number[])[] = [11, 16]
    if (elapsedPct !== null) {
      lines.push(`${Math.round(usedPct)}% of ${Math.round(elapsedPct)}%`)
      lineSizes.push(EVIDENCE_SIZES)
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
  private resetKey(resetsAt: number, now: number, stale: boolean, windowEnded: boolean): KeySpec {
    // C1 — `formatResetIn` renders `ELAPSED` rather than `formatDuration`'s
    // `0m`, which would otherwise repeat forever for a window this page
    // never advances past its own deadline; a `resetsAt` of `0` (never
    // known) renders `--`. Dims whenever the value is not a real,
    // trustworthy countdown — `stale`, `windowEnded`, or a bare `--` — the
    // same three-way rule codex-page.ts's own `resetKey` (M4) uses.
    const value = formatResetIn(resetsAt, now)
    const spec: KeySpec = {
      kind: 'gauge',
      lines: ['RESETS IN', value, stale ? 'STALE' : '5-hr'],
      lineSizes: [11, RESET_SIZES, 11],
      align: 'center',
    }
    if (stale || windowEnded || value === '--') spec.dim = true
    return spec
  }

  private strip(live: Session[], key0: Session | null, overflow: number, now: number): StripSpec {
    if (!this.sessions.directoryExists()) {
      return { lines: ['claude', 'no session data'], dim: true }
    }
    if (live.length === 0) {
      return { lines: ['claude', 'no active sessions'], dim: true }
    }

    // M3 — describes whatever session key 0 itself shows, not simply the
    // newest live session by `ts` (see `render`'s own comment on `key0Id`).
    // Falls back to the newest live session only when key 0's own slot is
    // empty — reachable whenever an earlier session held there ends before
    // any new session arrives to claim the freed slot, since the assigner
    // never shifts an already-held session down into a lower slot.
    const described = key0 ?? live[0]!
    const elapsed = described.startedAt ? formatDuration(now - described.startedAt) : ''
    const parts = [described.project, described.tool || described.label, elapsed].filter(Boolean)
    const second = overflow > 0 ? `+${overflow} more` : `${live.length} active`

    // I6's review note flagged this page as the only one of the four whose
    // strip does not bound its own lines with `truncate` before handing
    // them to `renderStrip` — explicitly NOT itself a defect (`renderStrip`
    // measures and shrink-fits regardless, so the RENDERED pixels are
    // identical either way), just a missing test-visible budget. Left
    // un-truncated here on purpose: adding one changes what `strip.lines`
    // itself reports without changing a single rendered pixel, which would
    // silently cut real, still-fitting content (measured: `project · tool ·
    // elapsed` can legitimately run past a 30-character count while still
    // fitting the strip's real 236 px width, since a character count is not
    // a pixel measurement — lesson 17). I6's own fix here is the geometry
    // TEST below, proven against a genuinely oversized (500-character)
    // input rather than this page's normal output.
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

    // M9 — computed fresh, the same call `render` makes, rather than read
    // from a page-level cache that only `render` used to populate. See the
    // `assigner` field's own doc comment for why this is safe.
    const live = this.sessions.getSessions()
    const { slots } = this.assigner.assign(live)
    const id = slots[index]
    if (!id) return 'ignored'
    const session = live.find((s) => s.sessionId === id)
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
