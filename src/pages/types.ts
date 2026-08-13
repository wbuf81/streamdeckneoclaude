import type { DeckFrame } from '../render/specs.js'

/**
 * What a page did with a press on one key. The daemon uses this to decide
 * the on-device feedback, per AGENTS.md's "Press feedback" convention:
 *
 * - `handled` — the page took an action. The daemon flashes the key white.
 * - `ignored` — nothing is bound to that key. The daemon flashes it red.
 * - `failed` — the page tried and could not (for example, a focus call that
 *   returned false). The daemon flashes it red too, on purpose: the user's
 *   mental model is already "red means nothing happened", so `ignored` and
 *   `failed` share one signal rather than adding a third colour.
 *
 * A page must report its REAL outcome. Claiming `handled` for a key it did
 * nothing with would make a press indistinguishable from a genuine action —
 * exactly the silence this whole mechanism exists to remove.
 */
export type PressOutcome = 'handled' | 'ignored' | 'failed'

export interface Page {
  /** Shown on the strip when no better text exists. */
  readonly name: string
  /**
   * How often the daemon should render this page, in milliseconds. Absent or
   * undefined defaults to 1000. A page with no reason to animate should leave
   * this unset — raising the rate costs nothing on unchanged content (the
   * dirty-key hash skips the write), but it is still pointless CPU.
   */
  readonly tickMs?: number
  /**
   * Describes the whole deck. `now` is unix seconds, and every existing page
   * and test built before animation keeps using it unchanged. `nowMs` is unix
   * milliseconds, for pages that animate faster than once a second; it
   * defaults to `now * 1000` when the caller omits it. A page must never call
   * `Date.now()` itself — the daemon supplies both clocks, so a test can pass
   * `nowMs` explicitly and get a deterministic frame.
   */
  render(now: number, nowMs?: number): DeckFrame
  /**
   * Handles a press on key 0 to 7 and reports what happened, so the daemon
   * can draw the right on-device feedback — see `PressOutcome`. The daemon
   * awaits this before drawing anything, so an async page's real outcome
   * (for example, a focus call that has to run a shell command first) is
   * never guessed at ahead of time.
   */
  onKeyPress(index: number): PressOutcome | Promise<PressOutcome>
  /** Called when the page becomes visible. */
  onEnter?(): void
  /** Called when the page stops being visible. */
  onLeave?(): void
}
