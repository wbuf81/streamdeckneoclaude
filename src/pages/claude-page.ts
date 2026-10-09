import type { Image } from '@napi-rs/canvas'
import type {
  DeckFrame, FxSpec, FxVariant, ImageTransform, KeySpec, OneShotSpec, StripSpec, Rgb, TapeSegment,
} from '../render/specs.js'
import { blankKey } from '../render/specs.js'
import { theme, stateColor, stateLabel, barColor, blend } from '../render/theme.js'
import type { SessionStateName } from '../render/theme.js'
import { truncate, formatDuration } from '../render/text.js'
import { getSpriteFrame, getSpriteFrameIndex } from '../render/sprites.js'
import type { Page, PressOutcome } from './types.js'
import type { Session } from '../sources/claude.js'
import type { UsageSnapshot, SessionMeta } from '../sources/usage.js'
import { computePace, elapsedPercent } from '../sources/usage.js'
import { KeyAssigner, SESSION_SLOTS } from './key-assigner.js'
import { tapeOffsetPx } from '../render/canvas.js'
import { breathe, ONE_SHOT_DURATION_MS, ONE_SHOT_QUANTUM_MS } from '../render/motion.js'

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

/**
 * How a session's state moves (task 46).
 *
 * The two working states differ by AXIS, not by speed: vertical drift against
 * horizontal streaks. Two intensities of the same motion are not tellable apart at
 * a glance, which is the whole point of the feature.
 *
 * `permission` has no particle motion. It breathes its whole BACKGROUND amber
 * instead (see `permissionBg`), because it is the one state that means the user
 * is the bottleneck. The glow-up replaced task 46's 1.15 s `pulse` fx with that
 * slow breath: the pulse drew the eye by flashing, and the breath draws it
 * without flashing. Keeping both would put two rhythms on one tile, which reads
 * as noise. `idle` and `done` are genuinely static, and `unknown` stays still
 * because an absent signal is not a state (lesson 18).
 */
const STATE_FX: Partial<Record<SessionStateName, { variant: FxVariant; intensity: number }>> = {
  thinking: { variant: 'drift', intensity: 0.55 },
  tool: { variant: 'wind', intensity: 0.7 },
}

/** One full in-and-out breath of a permission tile's background. Slow on
 * purpose: about 2.8 s, the mockup's `sin(t * 2.2)`. */
export const PERMIT_BREATHE_PERIOD_MS = 2800
/** How much amber the background carries at the bottom and at the top of the
 * breath. Never zero, so the tile always reads as "waiting", and never above a
 * quarter, so the white text on it stays crisp. */
export const PERMIT_BG_MIN = 0.08
export const PERMIT_BG_MAX = 0.24

/**
 * A permission tile's background at `nowMs`: amber, blended over the key
 * background by an amount that breathes between `PERMIT_BG_MIN` and
 * `PERMIT_BG_MAX`.
 *
 * The level comes from `breathe` (render/motion.ts) on pure white, so it is
 * quantised to 100 ms there: the tile changes at most 10 times a second. The
 * page does not keep a second clock of its own.
 */
export function permissionBg(nowMs: number): Rgb {
  // breathe(white, ..., depth 1) runs 255 at the top of the cycle down to 0.
  const level = breathe([255, 255, 255], nowMs, PERMIT_BREATHE_PERIOD_MS, 1)[0] / 255
  return blend(theme.bg, theme.amber, PERMIT_BG_MIN + (PERMIT_BG_MAX - PERMIT_BG_MIN) * level)
}

/** How long a pet's hop lasts, and how high it goes. */
export const PET_HOP_MS = 500
export const PET_HOP_PX = 16
/** How long one spin lasts. */
export const PET_SPIN_MS = 600
/** This many presses inside `PET_SPIN_WINDOW_MS` turn the latest one into a
 * spin rather than a plain hop. */
export const PET_SPIN_PRESSES = 3
export const PET_SPIN_WINDOW_MS = 1200
/** How long strip line 2 says thank you. Also how long a pet's heart floats,
 * so the two end together. */
export const PET_THANKS_MS = ONE_SHOT_DURATION_MS.hearts
export const PET_THANKS_TEXT = '♥ crab: thank you'
/** Upper bound on stamped pets kept at once. A finger cannot press 8 times in
 * 1.5 s and still see each heart, and the bound keeps the hash small. */
const PET_HISTORY = 8

/** One stamped pet: when its first render saw it, and whether it spins. */
export interface Pet {
  atMs: number
  spin: boolean
}

/**
 * The crab's image transform `elapsedMs` after a pet, or null once the motion
 * has ended (or before it has started).
 *
 * The clock is quantised to `ONE_SHOT_QUANTUM_MS` (40 ms) and the offsets are
 * whole pixels and whole degrees, so the key rewrites at most 25 times a
 * second during a hop and never after it. Pure and exported so a test can
 * prove the arc without rasterising anything.
 */
export function petMotion(elapsedMs: number, spin: boolean): ImageTransform | null {
  const end = spin ? Math.max(PET_HOP_MS, PET_SPIN_MS) : PET_HOP_MS
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= end) return null
  const e = Math.floor(elapsedMs / ONE_SHOT_QUANTUM_MS) * ONE_SHOT_QUANTUM_MS
  const out: ImageTransform = {}
  if (e < PET_HOP_MS) {
    const dy = -Math.round(Math.sin((e / PET_HOP_MS) * Math.PI) * PET_HOP_PX)
    if (dy !== 0) out.dy = dy
  }
  if (spin && e < PET_SPIN_MS) {
    const deg = Math.round((e / PET_SPIN_MS) * 360)
    if (deg !== 0) out.rotateDeg = deg
  }
  return out
}

/** How strongly a cap tile's background carries its own percentage. Kept low for
 * the reason every wash on this deck is: the tile's own big number has to stay
 * crisp on top of it. */
const CAP_WASH_MAX_BLEND = 0.28

/** How many sessions the strip's tape lists. Bounded so the loop stays watchable. */
const TAPE_SESSION_COUNT = 4
/** Matches the other pages' tapes, tuned against a rendered preview. */
const TAPE_PX_PER_SEC = 60

/**
 * The ambient motion for one session tile, or undefined when the session is not
 * doing anything.
 *
 * The colour is `stateColor(state)` — the SAME hue the tile's border already
 * carries, so the motion and the border can never disagree about what state this
 * is.
 */
export function sessionFx(
  state: SessionStateName, nowMs: number, seed: number,
): FxSpec | undefined {
  const spec = STATE_FX[state]
  if (!spec) return undefined
  return {
    variant: spec.variant,
    nowMs,
    intensity: spec.intensity,
    seed,
    color: stateColor(state),
    direction: 'up',
  }
}

/**
 * A cap tile's background wash, or undefined when there is nothing to show.
 *
 * The hue comes from `barColor` — the SAME function the tile's own bar uses — so
 * the bar and the wash can never disagree about whether 87 percent is amber or
 * red. The strength scales with the percentage, so a nearly-full budget is both
 * redder and stronger.
 */
export function capWash(pct: number | null, stale: boolean): Rgb | undefined {
  if (pct === null || !Number.isFinite(pct)) return undefined
  // A stale sample keeps its own STALE treatment and no wash: a coloured budget
  // that might be fifteen minutes old is worse than a plain one.
  if (stale) return undefined
  const fraction = Math.max(0, Math.min(1, pct / 100))
  return blend(theme.bg, barColor(fraction), fraction * CAP_WASH_MAX_BLEND)
}

/**
 * One tape segment per live session: its project, what it is doing, and how long
 * it has been going, coloured by its own state.
 *
 * Bounded by `TAPE_SESSION_COUNT` so the loop stays watchable. Pure and exported
 * so a test can prove the content without rasterising anything.
 */
export function tapeSegments(live: Session[], now: number): TapeSegment[] {
  return live.slice(0, TAPE_SESSION_COUNT).map((s) => {
    const elapsed = s.startedAt ? formatDuration(now - s.startedAt) : ''
    const what = s.tool || s.label || stateLabel(s.state)
    const parts = [s.project, what, elapsed].filter(Boolean)
    return { text: parts.join(' · '), color: stateColor(s.state) }
  })
}

export class ClaudePage implements Page {
  readonly name = 'claude'
  /**
   * Roughly 10 fps. The crab's source material plays at 70 ms per frame
   * (about 14 fps); a 100 ms tick samples it closely enough to read as
   * motion rather than a slideshow, without asking the daemon for a rate it
   * cannot use.
   *
   * Stays FIXED, unlike the conditional getters on Spotify, stocks, weather and
   * football. Task 46's design claimed this was "wrong in both directions" and
   * should become a getter; that was wrong. The crab is a permanent mascot on key
   * 3 — it animates whether or not any session is running — so something on this
   * page always moves, and the rate has no condition to follow. The rule is still
   * "the rate follows what actually moves"; here the answer is simply always.
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

  /**
   * Crab presses not yet stamped with a time. `onKeyPress` has no clock and a
   * page must never read the wall clock, so a press is only counted here; the
   * next `render(nowMs)` stamps it with that frame's own time. The hop
   * therefore starts on the first frame after the press, which is the
   * earliest frame that could show it anyway.
   */
  private pendingPets = 0
  /** Stamped pets, oldest first, still inside `PET_THANKS_MS`. */
  private pets: Pet[] = []

  constructor(
    private readonly sessions: SessionReader,
    private readonly usage: UsageReader,
    private readonly focus: FocusFn,
  ) {}

  render(now: number, nowMs: number = now * 1000): DeckFrame {
    this.stampPets(nowMs)
    const live = this.sessions.getSessions()
    const { slots, overflow } = this.assigner.assign(live)

    const byId = new Map(live.map((s) => [s.sessionId, s]))
    const keys: KeySpec[] = []

    for (let i = 0; i < SESSION_SLOTS; i++) {
      const id = slots[i]
      const session = id ? byId.get(id) : undefined
      // `i` seeds the motion, so four sessions in the same state do not move in
      // lockstep and read as one block.
      keys.push(session ? this.sessionKey(session, now, nowMs, i) : blankKey())
    }

    keys.push(this.crabKey(live, nowMs))

    const gauges = this.gaugeKeys(now, nowMs)
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
      strip: this.strip(live, key0Session, overflow, now, nowMs),
      buttons: [theme.gray, theme.gray],
    }
  }

  /**
   * Gives every pending crab press this frame's time, and forgets pets whose
   * heart and thank-you have both ended.
   *
   * A press is a spin when it is at least the `PET_SPIN_PRESSES`th inside
   * `PET_SPIN_WINDOW_MS`, counting itself. A non-finite clock stamps nothing
   * and leaves the presses pending for a frame with a real time.
   */
  private stampPets(nowMs: number): void {
    if (!Number.isFinite(nowMs)) return
    // A clock that went backwards past a pet makes its elapsed time negative;
    // that pet would never finish, so drop it with the expired ones.
    this.pets = this.pets.filter((p) => nowMs - p.atMs >= 0 && nowMs - p.atMs < PET_THANKS_MS)
    for (; this.pendingPets > 0; this.pendingPets--) {
      const recent = this.pets.filter((p) => nowMs - p.atMs < PET_SPIN_WINDOW_MS).length
      this.pets.push({ atMs: nowMs, spin: recent + 1 >= PET_SPIN_PRESSES })
    }
    if (this.pets.length > PET_HISTORY) this.pets = this.pets.slice(-PET_HISTORY)
  }

  /** True while strip line 2 should thank the user for a pet. */
  private thanking(nowMs: number): boolean {
    return this.pets.some((p) => nowMs - p.atMs >= 0 && nowMs - p.atMs < PET_THANKS_MS)
  }

  private sessionKey(s: Session, now: number, nowMs: number, seed: number): KeySpec {
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

    // The state's own ambient motion, in the state's own colour (task 46).
    //
    // This REPLACES the old `pulseOn = now % 2 === 0` border blink for a pending
    // permission. That blink toggled the border on whole-second boundaries; the
    // pulse brightens the entire tile smoothly, which is strictly more visible for
    // the one state that means the user is the bottleneck. Keeping both would have
    // put a 1 Hz border blink against a 0.9 Hz tile pulse — two rhythms at once
    // read as noise rather than as urgency.
    const fx = sessionFx(s.state, nowMs, seed)
    if (fx) key.fx = fx
    // The one state that waits on the user breathes its background amber. No
    // seed offset: two waiting sessions breathe together, as one request.
    if (s.state === 'permission') key.bg = permissionBg(nowMs)

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
    // A pet: the newest one drives the hop or spin. The crab keeps drawing
    // the most urgent state's own frames while it moves, so a pet can never
    // hide a real `permission` alert: the "!" hops with it. (Swapping to the
    // calm `idle` frames was tried and rejected on the preview: the idle
    // extraction is drawn about twice the size of every other state, so the
    // crab visibly jumped in size at the start and end of each hop.)
    const latest = this.pets[this.pets.length - 1]
    const motion = latest ? petMotion(nowMs - latest.atMs, latest.spin) : null
    const state = mostUrgentCrabState(live)
    const key: KeySpec = { kind: 'image' }
    const crab = crabFrame(state, nowMs)
    if (crab) {
      key.image = crab.image
      key.imageKey = crab.imageKey
    }
    if (motion && (motion.dy !== undefined || motion.rotateDeg !== undefined)) {
      key.imageTransform = motion
    }
    // One heart per pet, three for a spin. Finished hearts drop out of
    // `keyHash` on their own, but expired pets are pruned anyway.
    const hearts: OneShotSpec[] = this.pets.map((p, i) => ({
      variant: 'hearts',
      startedAtMs: p.atMs,
      nowMs,
      count: p.spin ? 3 : 1,
      seed: i,
    }))
    if (hearts.length > 0) key.effects = hearts
    return key
  }

  private gaugeKeys(now: number, nowMs: number): KeySpec[] {
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
      this.burnRateKey(five, u.fiveHourResetsAt, now, nowMs, stale, fiveEnded),
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

    const key: KeySpec = {
      kind: 'gauge',
      lines: [label, value],
      lineSizes: [11, 28],
      align: 'center',
      bar: { value: pct / 100, color: barColor(pct / 100) },
    }
    // The budget you can feel. Same `barColor` the bar above uses, so the two can
    // never disagree about whether 87 percent is amber or red. Only reached on the
    // fresh, known branch — the `--` and STALE branches above return before here,
    // so an unknowable or lagging figure never gets a colour.
    const wash = capWash(pct, false)
    if (wash) key.bg = wash
    return key
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
    nowMs: number,
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

    const key: KeySpec = {
      kind: 'gauge',
      lines,
      lineSizes,
      lineColors: [undefined, wordColor],
      align: 'center',
    }
    // A FAST pace drifts upward, in the verdict's own colour: the direction
    // carries the RATE and the colour carries the valence. `slow` and `even` stay
    // still, because a budget you are inside of is not something to draw attention
    // to. Only reached on the fresh, known branch — the `--` and STALE branches
    // above return before here.
    if (pace === 'fast') {
      key.fx = {
        variant: 'drift',
        nowMs,
        intensity: 0.6,
        seed: 5,
        color: wordColor,
        direction: 'up',
      }
    }
    return key
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

  private strip(
    live: Session[],
    key0: Session | null,
    overflow: number,
    now: number,
    nowMs: number,
  ): StripSpec {
    const base = this.baseStrip(live, key0, overflow, now, nowMs)
    if (!this.thanking(nowMs)) return base
    // A pet takes line 2 for `PET_THANKS_MS`. The tape stands down so the
    // thanks is readable, and the dim treatment lifts so it reads as a reply.
    const { tape: _tape, dim: _dim, ...rest } = base
    return { ...rest, lines: [base.lines[0] ?? 'claude', PET_THANKS_TEXT] }
  }

  private baseStrip(
    live: Session[],
    key0: Session | null,
    overflow: number,
    now: number,
    nowMs: number,
  ): StripSpec {
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

    // One session: line 1 and the tape would say the same thing twice. Line 1
    // keeps what it is doing, and line 2 says how long it has run, on which
    // model, and how full its context is. No tape: there is nothing else to
    // scroll to.
    if (live.length === 1) {
      const doing = [described.project, described.tool || described.label].filter(Boolean)
      const facts = singleSessionFacts(elapsed, this.usage.getMeta(described.sessionId))
      return { lines: [doing.join(' · '), facts || '1 active'] }
    }
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
    const spec: StripSpec = { lines: [parts.join(' · '), second] }

    // Every live session's own description, crawling across line 2's band, so a
    // long project and tool pair gets read in full instead of being truncated onto
    // a 96 px key. Line 1 still names whatever key 0 shows, so the most important
    // single fact needs no waiting.
    const segments = tapeSegments(live, now)
    if (segments.length > 0) {
      spec.tape = { segments, offsetPx: tapeOffsetPx(nowMs, TAPE_PX_PER_SEC) }
    }
    return spec
  }

  /**
   * Key 0 to 2 focus the session in that slot, when one is bound and focus
   * succeeds. Key 3 pets the crab and is always `handled`: the crab hops, a
   * heart floats up, and the strip says thank you. Keys 4 to 7 (the gauges)
   * are always `ignored` — nothing is bound to them. The daemon, not this page,
   * draws the on-device feedback for every outcome; see `PressOutcome`.
   */
  async onKeyPress(index: number): Promise<PressOutcome> {
    if (index < 0 || index >= KEY_COUNT) return 'ignored'
    if (index === CRAB_KEY_INDEX) {
      // Pet the crab. Stamped on the next render; see `pendingPets`.
      this.pendingPets = Math.min(this.pendingPets + 1, PET_HISTORY)
      return 'handled'
    }
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

  /** A pet still pending when the page leaves would hop on re-entry, long
   * after the press. Forget it, and any pet in flight. */
  onLeave(): void {
    this.pendingPets = 0
    this.pets = []
  }
}

/**
 * Strip line 2 for a single session: `running 21m · opus · ctx 41%`. Each
 * part appears only when its source knows it; an empty string means nothing
 * is known, and the caller falls back.
 */
export function singleSessionFacts(elapsed: string, meta: SessionMeta | null): string {
  const parts: string[] = []
  if (elapsed) parts.push(`running ${elapsed}`)
  if (meta?.model) parts.push(meta.model)
  const ctx = meta?.ctxPct
  if (typeof ctx === 'number' && Number.isFinite(ctx)) parts.push(`ctx ${Math.round(ctx)}%`)
  return parts.join(' · ')
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
