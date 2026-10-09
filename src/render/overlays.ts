/**
 * The glow-up's foreground primitives: the range gauge, the drawn fog and
 * compass glyphs, the edge-progress line, and the one-shot effects.
 *
 * Every function here draws from an already sanitised AND canonical spec
 * (`renderKey` runs `sanitizeKeySpec`, then `canonicalKeySpec`), so a
 * one-shot's `nowMs` is already its quantised elapsed time and its
 * `startedAtMs` is 0.
 */
import type { SKRSContext2D } from '@napi-rs/canvas'
import type { EdgeProgressSpec, IconSpec, OneShotSpec, RangeSpec, Rgb } from './specs.js'
import { theme } from './theme.js'
import { KEY_SIZE, FONT, css, cssAlpha, clamp01, pseudoRandom } from './paint.js'
import { ONE_SHOT_DURATION_MS } from './motion.js'

/* ---------------------------------------------------------------- range */

export const RANGE_X0 = 10
export const RANGE_X1 = KEY_SIZE - 10
const RANGE_TRACK: Rgb = [42, 46, 56]

/** Where the marker lands, as a fraction of the track. Exported so a test
 * proves the clamp and the degenerate case directly. */
export function rangeFraction(lo: number, hi: number, value: number): number {
  if (!(hi > lo)) return 0.5
  return clamp01((value - lo) / (hi - lo))
}

export function drawRange(ctx: SKRSContext2D, range: RangeSpec, dim: boolean): void {
  const y = range.y ?? 44
  const h = Math.max(2, range.height ?? 8)
  const w = RANGE_X1 - RANGE_X0
  if (range.gradient) {
    const g = ctx.createLinearGradient(RANGE_X0, 0, RANGE_X1, 0)
    g.addColorStop(0, cssAlpha(range.gradient[0], 0.55, dim))
    g.addColorStop(1, cssAlpha(range.gradient[1], 0.55, dim))
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = css(range.track ?? RANGE_TRACK, dim)
  }
  ctx.beginPath()
  ctx.roundRect(RANGE_X0, y, w, h, h / 2)
  ctx.fill()

  const mx = RANGE_X0 + rangeFraction(range.lo, range.hi, range.value) * w
  ctx.fillStyle = css(range.color ?? theme.white, dim)
  if (range.marker === 'tick') {
    ctx.fillRect(mx - 1.5, y - 3, 3, h + 6)
    return
  }
  ctx.beginPath()
  ctx.moveTo(mx, y - 2)
  ctx.lineTo(mx - 5, y - 9)
  ctx.lineTo(mx + 5, y - 9)
  ctx.closePath()
  ctx.fill()
}

/* ---------------------------------------------------------------- icons */

const FOG_COLOR: Rgb = [220, 224, 232]
/** The fog glyph's four bars. Rows sit inside the emoji band (y 17..48). */
export const FOG_BAR_TOP = 23
export const FOG_BAR_STEP = 7
export const FOG_BAR_H = 4

export const COMPASS_CX = KEY_SIZE / 2
export const COMPASS_CY = 38
export const COMPASS_R = 22
/** The N/E/S/W letters' distance from the centre. The S letter's ink ends
 * by y 72, so a bottom line at y 76 clears it. */
export const COMPASS_LETTER_R = 30
const COMPASS_RING: Rgb = [47, 51, 60]
const COMPASS_LETTER: Rgb = [139, 144, 154]

export function drawIcon(ctx: SKRSContext2D, icon: IconSpec, dim: boolean): void {
  const t = (icon.nowMs ?? 0) / 1000
  const moving = icon.nowMs !== undefined
  if (icon.kind === 'fog') {
    const color = icon.color ?? FOG_COLOR
    for (let k = 0; k < 4; k++) {
      const w = 44 - (k % 2) * 12
      const dx = moving ? Math.sin(t * 0.6 + k) * 5 : 0
      const x = KEY_SIZE / 2 - w / 2 + (k % 2 ? 4 : -2) + dx
      ctx.fillStyle = cssAlpha(color, 0.62 - k * 0.08, dim)
      ctx.beginPath()
      ctx.roundRect(x, FOG_BAR_TOP + k * FOG_BAR_STEP, w, FOG_BAR_H, FOG_BAR_H / 2)
      ctx.fill()
    }
    return
  }

  ctx.strokeStyle = css(COMPASS_RING, dim)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(COMPASS_CX, COMPASS_CY, COMPASS_R, 0, Math.PI * 2)
  ctx.stroke()

  ctx.font = `bold 8px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = css(COMPASS_LETTER, dim)
  ;['N', 'E', 'S', 'W'].forEach((letter, k) => {
    const a = (k * Math.PI) / 2 - Math.PI / 2
    ctx.fillText(letter, COMPASS_CX + Math.cos(a) * COMPASS_LETTER_R, COMPASS_CY + Math.sin(a) * COMPASS_LETTER_R)
  })

  const wobble = moving ? Math.sin(t * 0.9) * 0.08 : 0
  const a = (icon.bearingDeg * Math.PI) / 180 + wobble
  ctx.save()
  try {
    ctx.translate(COMPASS_CX, COMPASS_CY)
    ctx.rotate(a)
    ctx.fillStyle = css(icon.color ?? theme.cyan, dim)
    ctx.beginPath()
    ctx.moveTo(0, -19)
    ctx.lineTo(5.5, 6)
    ctx.lineTo(0, 1)
    ctx.lineTo(-5.5, 6)
    ctx.closePath()
    ctx.fill()
  } finally {
    ctx.restore()
  }
}

/* -------------------------------------------------------- edge progress */

const EDGE_COLOR: Rgb = [255, 217, 196]
/** The core line's width and its centre's distance from the key edge. */
export const EDGE_LINE_W = 3
const EDGE_INSET = EDGE_LINE_W / 2
const EDGE_GLOW_W = 8

/** The two ends of one key edge, in clockwise order. */
function edgeEnds(edge: 'top' | 'right' | 'bottom' | 'left'): [number, number, number, number] {
  const near = EDGE_INSET
  const far = KEY_SIZE - EDGE_INSET
  switch (edge) {
    case 'top': return [0, near, KEY_SIZE, near]
    case 'right': return [far, 0, far, KEY_SIZE]
    case 'bottom': return [KEY_SIZE, far, 0, far]
    case 'left': return [near, KEY_SIZE, near, 0]
  }
}

export function drawEdgeProgress(ctx: SKRSContext2D, spec: EdgeProgressSpec, dim: boolean): void {
  const color = spec.color ?? EDGE_COLOR
  ctx.save()
  try {
    ctx.lineCap = 'butt'
    for (const pass of [0, 1] as const) {
      ctx.lineWidth = pass === 0 ? EDGE_GLOW_W : EDGE_LINE_W
      ctx.strokeStyle = pass === 0 ? cssAlpha(color, 0.22, dim) : css(color, dim)
      for (const run of spec.runs) {
        const [ax, ay, bx, by] = edgeEnds(run.edge)
        ctx.beginPath()
        ctx.moveTo(ax + (bx - ax) * run.from, ay + (by - ay) * run.from)
        ctx.lineTo(ax + (bx - ax) * run.to, ay + (by - ay) * run.to)
        ctx.stroke()
      }
    }
  } finally {
    ctx.restore()
  }
}

/* ------------------------------------------------------------ one-shots */

const BURST_COLORS: readonly Rgb[] = [
  theme.green, theme.amber, theme.white, theme.cyan, [255, 122, 182],
]
const HEART_COLORS: readonly Rgb[] = [[255, 107, 138], [255, 179, 196]]
const SWEEP_COLOR: Rgb = [125, 255, 176]
const BRICK_FACE: Rgb = [156, 74, 58]
const BRICK_EDGE: Rgb = [94, 43, 33]

/** The brick's fall time, after which it rests and the content shakes. */
export const BRICK_FALL_MS = 350

/**
 * How far a `brick` shakes the key content at `elapsedMs`, in px. Zero while
 * the brick falls and after the effect ends; a damped 3 px rattle between.
 */
export function brickShakePx(elapsedMs: number): number {
  if (!(elapsedMs > BRICK_FALL_MS) || elapsedMs >= ONE_SHOT_DURATION_MS.brick) return 0
  const d = elapsedMs / 1000
  return Math.sin(d * 60) * 3 * Math.exp(-(d - BRICK_FALL_MS / 1000) * 5)
}

/** The summed shake of every running brick on a key. */
export function effectsShakePx(effects: readonly OneShotSpec[] | undefined): number {
  if (!effects) return 0
  let dx = 0
  for (const fx of effects) {
    if (fx.variant === 'brick') dx += brickShakePx(fx.nowMs - fx.startedAtMs)
  }
  return dx
}

/** The heart outline from the mockup: top centre at (x, y), `s` wide and
 * tall. */
function heartPath(ctx: SKRSContext2D, x: number, y: number, s: number): void {
  ctx.beginPath()
  ctx.moveTo(x, y + s * 0.3)
  ctx.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.3)
  ctx.bezierCurveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.8, x, y + s)
  ctx.bezierCurveTo(x, y + s * 0.8, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.3)
  ctx.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.3)
}

function drawBurst(ctx: SKRSContext2D, fx: OneShotSpec, e: number, dim: boolean): void {
  const colors = fx.colors && fx.colors.length > 0 ? fx.colors : BURST_COLORS
  const n = Math.max(1, Math.min(80, Math.round(fx.count ?? 34)))
  const ox = fx.x ?? KEY_SIZE / 2
  const oy = fx.y ?? 40
  const seed = (fx.seed ?? 0) * 97 + 11
  const dt = e / 1000
  const fade = clamp01((1.5 - dt) / 0.6)
  for (let k = 0; k < n; k++) {
    const a = -Math.PI / 2 + (pseudoRandom(seed + k) - 0.5) * 2.6
    const v = 45 + pseudoRandom(seed + k * 3 + 1) * 70
    const x = ox + Math.cos(a) * v * dt
    const y = oy + Math.sin(a) * v * dt + 120 * dt * dt
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(dt * 8 * (pseudoRandom(seed + k * 7 + 2) - 0.5) * 2)
    ctx.fillStyle = cssAlpha(colors[k % colors.length]!, fade, dim)
    ctx.fillRect(-2.5, -1.5, 5, 3)
    ctx.restore()
  }
}

function drawHearts(ctx: SKRSContext2D, fx: OneShotSpec, e: number, dim: boolean): void {
  const colors = fx.colors && fx.colors.length > 0 ? fx.colors : HEART_COLORS
  const n = Math.max(1, Math.min(8, Math.round(fx.count ?? 1)))
  const ox = fx.x ?? KEY_SIZE / 2
  const oy = fx.y ?? 34
  const dt = e / 1000
  const alpha = clamp01((1.5 - dt) / 0.7)
  const grow = Math.min(1, dt / 0.15)
  const size = (n > 1 ? 10 : 13) * grow
  for (let k = 0; k < n; k++) {
    const spread = n > 1 ? (k - (n - 1) / 2) * 11 : 0
    const x = ox + spread + Math.sin(dt * 5 + k) * (n > 1 ? 6 : 10)
    const y = oy - size / 2 - dt * (n > 1 ? 44 + k * 10 : 28)
    ctx.fillStyle = cssAlpha(colors[k % colors.length]!, alpha, dim)
    heartPath(ctx, x, y, size)
    ctx.fill()
  }
}

function drawBrick(ctx: SKRSContext2D, e: number, shake: number, dim: boolean): void {
  const fall = clamp01(e / BRICK_FALL_MS)
  // Ease-in: the brick accelerates as it drops, like a thing falling.
  const by = -30 + fall * fall * 58
  const x = 28 + shake
  // Fades over the last quarter, so it leaves rather than vanishes.
  ctx.globalAlpha = clamp01((ONE_SHOT_DURATION_MS.brick - e) / 250)
  ctx.fillStyle = css(BRICK_FACE, dim)
  ctx.fillRect(x, by, 40, 18)
  ctx.strokeStyle = css(BRICK_EDGE, dim)
  ctx.lineWidth = 1.5
  ctx.strokeRect(x, by, 40, 18)
  ctx.beginPath()
  ctx.moveTo(x + 20, by)
  ctx.lineTo(x + 20, by + 9)
  ctx.moveTo(x, by + 9)
  ctx.lineTo(x + 40, by + 9)
  ctx.moveTo(x + 10, by + 9)
  ctx.lineTo(x + 10, by + 18)
  ctx.moveTo(x + 30, by + 9)
  ctx.lineTo(x + 30, by + 18)
  ctx.stroke()
}

/** Draws every running one-shot over the content, in spec order. */
export function drawEffects(
  ctx: SKRSContext2D, effects: readonly OneShotSpec[], shake: number, dim: boolean,
): void {
  for (const fx of effects) {
    const e = fx.nowMs - fx.startedAtMs
    const duration = ONE_SHOT_DURATION_MS[fx.variant]
    if (!(e >= 0) || duration === undefined || e >= duration) continue
    ctx.save()
    try {
      switch (fx.variant) {
        case 'sweep':
          ctx.fillStyle = cssAlpha(fx.color ?? SWEEP_COLOR, 0.5 * (1 - e / duration), dim)
          ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE)
          break
        case 'burst':
          drawBurst(ctx, fx, e, dim)
          break
        case 'hearts':
          drawHearts(ctx, fx, e, dim)
          break
        case 'brick':
          drawBrick(ctx, e, shake, dim)
          break
      }
    } finally {
      ctx.restore()
    }
  }
}
