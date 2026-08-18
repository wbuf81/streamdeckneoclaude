import type { Rgb } from './specs.js'

export const theme = {
  bg: [10, 10, 12] as Rgb,
  text: [235, 235, 235] as Rgb,
  textDim: [120, 120, 128] as Rgb,
  white: [255, 255, 255] as Rgb,
  red: [230, 60, 60] as Rgb,
  green: [70, 200, 110] as Rgb,
  amber: [255, 176, 0] as Rgb,
  blue: [90, 150, 255] as Rgb,
  cyan: [80, 210, 220] as Rgb,
  gray: [80, 80, 88] as Rgb,
  barTrack: [40, 40, 46] as Rgb,
  /**
   * Press-feedback ring colours (task 36). Task 32's full-key fill used
   * plain `white` and `red` at full strength, and the user reported it as
   * "too bright" on real hardware. These are dimmer versions for the same
   * two outcomes, meant only for the thin perimeter ring — never a fill —
   * so full-strength `white`/`red` stay free for anything that still wants
   * a bright, saturated colour. Both stay clearly apart from every other
   * colour above: `flashWhite` sits below `text` (235) and above `textDim`
   * (120) and `gray` (80); `flashRed` keeps `red`'s hue but at about 70% of
   * its brightness, so it reads as the same "nothing happened" signal
   * without the glare, and never reads as `amber`.
   */
  flashWhite: [185, 185, 190] as Rgb,
  flashRed: [165, 55, 55] as Rgb,
  /**
   * Task 39's cyberpunk idle animation (Spotify page, `IdleSpec` in
   * `render/specs.ts`), replacing the old green equaliser. `neonMagenta` is
   * the one new hue this task adds — every other idle colour reuses `cyan`
   * (already in this palette) and `bg`/`text`, so the animation stays inside
   * a small, deliberate set rather than inventing a wide new range. Named
   * `neonMagenta` rather than plain `magenta` so it reads, at the call site,
   * as a deliberate design choice for this animation rather than a generic
   * colour any page might reach for.
   */
  neonMagenta: [255, 45, 175] as Rgb,
} as const

/**
 * Mixes `from` toward `to` by `fraction`, clamped to 0 to 1.
 *
 * ONE implementation, shared by every page that tints a key from data — the
 * stocks heat wash and the football record wash both call it. A second copy is
 * exactly the family drift this project calls its dominant defect pattern
 * (docs/LESSONS.md #21's sibling sweep), and colour arithmetic duplicated across
 * pages would eventually disagree about what "half way to green" means.
 */
export function blend(from: Rgb, to: Rgb, fraction: number): Rgb {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  return [
    Math.round(from[0] + (to[0] - from[0]) * f),
    Math.round(from[1] + (to[1] - from[1]) * f),
    Math.round(from[2] + (to[2] - from[2]) * f),
  ]
}

/** Every value the `state` field can hold, plus the fallback. */
export type SessionStateName =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'permission'
  | 'done'
  | 'unknown'

const LABELS: Record<SessionStateName, string> = {
  idle: 'IDLE',
  thinking: 'THINKING',
  tool: 'TOOL',
  permission: 'PERMIT?',
  done: 'DONE',
  unknown: 'BUSY',
}

const COLORS: Record<SessionStateName, Rgb> = {
  idle: theme.gray,
  thinking: theme.blue,
  tool: theme.cyan,
  permission: theme.amber,
  done: theme.green,
  unknown: theme.gray,
}

export function stateLabel(state: SessionStateName): string {
  return LABELS[state]
}

export function stateColor(state: SessionStateName): Rgb {
  return COLORS[state]
}

/** Green below 0.6. Amber from 0.6 to 0.85. Red above 0.85. */
export function barColor(fraction: number): Rgb {
  if (fraction > 0.85) return theme.red
  if (fraction >= 0.6) return theme.amber
  return theme.green
}
