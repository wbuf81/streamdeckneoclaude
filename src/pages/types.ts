import type { DeckFrame } from '../render/specs.js'

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
  /** Handles a press on key 0 to 7. */
  onKeyPress(index: number): void | Promise<void>
  /** Called when the page becomes visible. */
  onEnter?(): void
  /** Called when the page stops being visible. */
  onLeave?(): void
}
