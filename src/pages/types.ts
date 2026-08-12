import type { DeckFrame } from '../render/specs.js'

export interface Page {
  /** Shown on the strip when no better text exists. */
  readonly name: string
  /** Describes the whole deck. `now` is unix seconds. */
  render(now: number): DeckFrame
  /** Handles a press on key 0 to 7. */
  onKeyPress(index: number): void | Promise<void>
  /** Called when the page becomes visible. */
  onEnter?(): void
  /** Called when the page stops being visible. */
  onLeave?(): void
}
