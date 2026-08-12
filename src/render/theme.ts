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
} as const

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
