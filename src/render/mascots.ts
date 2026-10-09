/**
 * Pixel-art mascots: the stocks page's bull and bear, and the small walking
 * crab for the strip. Drawn from character maps, one map cell to one `px`
 * square, so they stay crisp at any size the deck can show.
 *
 * The maps follow the approved mockup (`deck-glowup.src.html`). The bear's
 * eyes are closed lids (`-`) rather than the mockup's open dots, because the
 * bear is asleep and the "z" says so.
 */
import type { SKRSContext2D } from '@napi-rs/canvas'
import type { MascotSpec, Rgb, StripSprite } from './specs.js'
import { theme } from './theme.js'
import { KEY_SIZE, FONT, STRIP_WIDTH, STRIP_HEIGHT, css, cssAlpha } from './paint.js'

export type PixelMap = readonly string[]
export type PixelPalette = Readonly<Record<string, Rgb>>

export const BULL_MAP: PixelMap = [
  'W..........W',
  'WW........WW',
  '.WBBBBBBBBW.',
  '..BBBBBBBB..',
  '..BEBBBBEB..',
  '..BBBBBBBB..',
  '...BNNNNB...',
  '...BNONOB...',
  '....BBBB....',
]
export const BULL_PALETTE: PixelPalette = {
  W: [241, 228, 196],
  B: [168, 97, 45],
  E: [20, 10, 4],
  N: [217, 140, 116],
  O: [90, 42, 28],
}

export const BEAR_MAP: PixelMap = [
  '.BB......BB.',
  '.BIB....BIB.',
  '..BBBBBBBB..',
  '.BBBBBBBBBB.',
  '.B--BBBB--B.',
  '.BBBBNNBBBB.',
  '..BBNOONBB..',
  '...BBBBBB...',
]
export const BEAR_PALETTE: PixelPalette = {
  B: [107, 74, 51],
  I: [201, 154, 122],
  '-': [26, 15, 10],
  N: [201, 165, 127],
  O: [26, 15, 10],
}

export const CRAB_MAPS: readonly [PixelMap, PixelMap] = [
  [
    '..C......C..',
    '.CC......CC.',
    '...CCCCCC...',
    'C.CCECCECC.C',
    'CCCCCCCCCCCC',
    '..CCCCCCCC..',
    '..C.C..C.C..',
  ],
  [
    '..C......C..',
    '.CC......CC.',
    '...CCCCCC...',
    'C.CCECCECC.C',
    'CCCCCCCCCCCC',
    '..CCCCCCCC..',
    '...C.CC.C...',
  ],
]
export const CRAB_PALETTE: PixelPalette = {
  C: [224, 128, 106],
  E: [26, 15, 12],
}

/** Paints `map` with its top-left at (x, y), each cell `px` square. A cell
 * whose character is `.` or not in `palette` is transparent. */
export function drawPixelMap(
  ctx: SKRSContext2D, map: PixelMap, palette: PixelPalette,
  x: number, y: number, px: number, dim: boolean,
): void {
  for (let r = 0; r < map.length; r++) {
    const row = map[r]!
    for (let c = 0; c < row.length; c++) {
      const color = palette[row[c]!]
      if (!color) continue
      ctx.fillStyle = css(color, dim)
      ctx.fillRect(x + c * px, y + r * px, px, px)
    }
  }
}

/** The bull's hop height at `nowMs`, in px, 0 to 8. Exported so a test
 * proves the hop from the predicate. */
export function bullHopPx(nowMs: number): number {
  return Math.abs(Math.sin((nowMs / 1000) * 3.2)) * 8
}

/** The bear's "z" at `nowMs`: its progress through one drift, 0 to 1. */
export function bearZPhase(nowMs: number): number {
  const z = ((nowMs / 1000) * 0.6) % 1
  return z < 0 ? z + 1 : z
}

const MASCOT_PX = 5

/**
 * Draws a mascot centred in the key's upper three quarters: a soft glow,
 * then (for the bull) a ground shadow, then the sprite. The band below
 * y 80 stays free for the page's label.
 */
export function drawMascot(ctx: SKRSContext2D, mascot: MascotSpec, dim: boolean): void {
  const bull = mascot.kind === 'bull'
  const glowHue = bull ? theme.green : theme.red
  const g = ctx.createRadialGradient(KEY_SIZE / 2, KEY_SIZE / 2, 4, KEY_SIZE / 2, KEY_SIZE / 2, 60)
  g.addColorStop(0, cssAlpha(glowHue, bull ? 0.22 : 0.18, dim))
  g.addColorStop(1, cssAlpha(glowHue, 0, dim))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE)

  if (bull) {
    const hop = bullHopPx(mascot.nowMs)
    ctx.fillStyle = cssAlpha([0, 0, 0], 0.35)
    ctx.beginPath()
    ctx.ellipse(KEY_SIZE / 2, 74, Math.max(4, 22 - hop), 4, 0, 0, Math.PI * 2)
    ctx.fill()
    drawPixelMap(ctx, BULL_MAP, BULL_PALETTE, 18, 22 - hop, MASCOT_PX, dim)
    return
  }

  drawPixelMap(ctx, BEAR_MAP, BEAR_PALETTE, 18, 30, MASCOT_PX, dim)
  const z = bearZPhase(mascot.nowMs)
  const size = Math.round(10 + z * 4)
  ctx.font = `bold ${size}px ${FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = cssAlpha(theme.white, 1 - z, dim)
  ctx.fillText('z', 70 + z * 8, 28 - z * 14)
}

/** The strip crab's map cell size: 4 px, so 48 x 28. */
export const STRIP_CRAB_PX = 4
export const STRIP_CRAB_TOP = 26
const STRIP_CRAB_W = 12 * STRIP_CRAB_PX
const SAY_COLOR: Rgb = [255, 177, 153]

/**
 * Draws the walking crab over the strip, clipped to the strip. A dark plate
 * sits behind it, so text beneath cannot show through the crab's gaps.
 */
export function drawStripSprite(ctx: SKRSContext2D, sprite: StripSprite, dim: boolean): void {
  const x = Math.round(sprite.x)
  const top = STRIP_CRAB_TOP + (sprite.dy ?? 0)
  ctx.save()
  try {
    ctx.beginPath()
    ctx.rect(0, 0, STRIP_WIDTH, STRIP_HEIGHT)
    ctx.clip()
    ctx.fillStyle = cssAlpha([6, 6, 8], 0.75)
    ctx.fillRect(x - 6, 20, STRIP_CRAB_W + 12, 36)
    drawPixelMap(ctx, CRAB_MAPS[sprite.frame === 1 ? 1 : 0], CRAB_PALETTE, x, top, STRIP_CRAB_PX, dim)
    if (sprite.say) {
      ctx.font = `bold 12px ${FONT}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = css(sprite.sayColor ?? SAY_COLOR, dim)
      ctx.fillText(sprite.say, x + STRIP_CRAB_W + 4, 24)
    }
  } finally {
    ctx.restore()
  }
}
