import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import type { KeySpec, StripSpec, Rgb, BarSpec, SparkSpec } from './specs.js'
import { theme } from './theme.js'
import { getSprite } from './sprites.js'

export const KEY_SIZE = 96
export const STRIP_WIDTH = 248
export const STRIP_HEIGHT = 58

const FONT = 'Menlo'
const PAD = 6
const BORDER = 3
const BAR_Y = 66
const BAR_H = 8
const SPARK_Y = 48
const SPARK_H = 40
/** Baseline of the strip's second text line. */
const STRIP_LINE_2_Y = 21

function css(c: Rgb, dim = false): string {
  const f = dim ? 0.45 : 1
  return `rgb(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)})`
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function drawBar(
  ctx: SKRSContext2D,
  bar: BarSpec,
  x: number,
  y: number,
  w: number,
  h: number,
  dim: boolean,
): void {
  ctx.fillStyle = css(bar.bg ?? theme.barTrack, dim)
  ctx.fillRect(x, y, w, h)
  const fill = Math.round(w * clamp01(bar.value))
  if (fill > 0) {
    ctx.fillStyle = css(bar.color, dim)
    ctx.fillRect(x, y, fill, h)
  }
}

/**
 * Draws one series as vertical bars, one per value, filling the width from
 * `BORDER + PAD` to `KEY_SIZE - PAD`. Normalises between the series minimum
 * and maximum. A flat series (`range === 0`) draws every bar at half height,
 * which reads as a centred horizontal line, rather than dividing by zero.
 * Fewer than 2 values draws nothing at all.
 */
function drawSpark(ctx: SKRSContext2D, spark: SparkSpec, dim: boolean): void {
  const { values, color } = spark
  if (values.length < 2) return

  const x0 = BORDER + PAD
  const x1 = KEY_SIZE - PAD
  const width = x1 - x0
  const barW = width / values.length

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min

  ctx.fillStyle = css(color, dim)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    const frac = range === 0 ? 0.5 : (v - min) / range
    const h = frac * SPARK_H
    const x = x0 + i * barW
    const y = SPARK_Y + (SPARK_H - h)
    if (h > 0) ctx.fillRect(x, y, Math.max(1, barW - 1), h)
  }
}

/**
 * Copies the canvas out as raw RGBA. The device takes raw pixel buffers and
 * has no PNG support, so the renderer never encodes an image format.
 */
function toRgba(ctx: SKRSContext2D, w: number, h: number): Buffer {
  return Buffer.from(ctx.getImageData(0, 0, w, h).data.buffer)
}

/** Renders one 96 by 96 key. The result is a raw RGBA buffer. */
export function renderKey(spec: KeySpec): Buffer {
  const canvas = createCanvas(KEY_SIZE, KEY_SIZE)
  const ctx = canvas.getContext('2d')
  const dim = spec.dim === true

  ctx.fillStyle = css(spec.bg ?? theme.bg)
  ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE)

  if (spec.image) {
    // The producer already decoded this. Scale it to the key, edge to edge.
    ctx.drawImage(spec.image, 0, 0, KEY_SIZE, KEY_SIZE)
  }

  if (spec.border) {
    const on = spec.pulseOn !== false
    ctx.fillStyle = on ? css(spec.border, dim) : css(spec.border, true)
    ctx.fillRect(0, 0, BORDER, KEY_SIZE)
  }

  if (spec.glyph) {
    ctx.fillStyle = css(theme.text, dim)
    ctx.font = `28px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(spec.glyph, KEY_SIZE / 2, KEY_SIZE / 2)
  }

  if (spec.lines?.length) {
    const centered = spec.align === 'center'
    ctx.font = `11px ${FONT}`
    ctx.textAlign = centered ? 'center' : 'left'
    ctx.textBaseline = 'top'
    const x = centered ? KEY_SIZE / 2 : BORDER + PAD
    let y = PAD
    for (let i = 0; i < spec.lines.length; i++) {
      const color = spec.lineColors?.[i] ?? theme.text
      ctx.fillStyle = css(color, dim)
      ctx.fillText(spec.lines[i]!, x, y)
      y += 14
    }
  }

  if (spec.sprite) {
    const img = getSprite(spec.sprite)
    // 48 x 48 at a 48 pixel source keeps one source pixel per key pixel.
    if (img) ctx.drawImage(img, KEY_SIZE / 2 - 24, 40, 48, 48)
  }

  if (spec.spark) {
    drawSpark(ctx, spec.spark, dim)
  }

  if (spec.bar) {
    drawBar(ctx, spec.bar, BORDER + PAD, BAR_Y, KEY_SIZE - BORDER - PAD * 2, BAR_H, dim)
  }

  return toRgba(ctx, KEY_SIZE, KEY_SIZE)
}

/** Renders the 248 by 58 info strip as one image. The result is a raw RGBA buffer. */
export function renderStrip(spec: StripSpec): Buffer {
  const canvas = createCanvas(STRIP_WIDTH, STRIP_HEIGHT)
  const ctx = canvas.getContext('2d')
  const dim = spec.dim === true

  ctx.fillStyle = css(theme.bg)
  ctx.fillRect(0, 0, STRIP_WIDTH, STRIP_HEIGHT)

  ctx.fillStyle = css(theme.text, dim)
  ctx.font = `13px ${FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  let y = 4
  for (const line of spec.lines.slice(0, 2)) {
    ctx.fillText(line, PAD, y)
    y += 17
  }

  if (spec.right) {
    // Right-aligned on the SECOND line, beside line 2's text. Line 1 is reserved
    // for the title, which needs the full width. Measured: a line holds 30
    // characters at 13 px Menlo, and this clock takes 11 of them.
    ctx.textAlign = 'right'
    ctx.fillStyle = css(theme.textDim, dim)
    ctx.fillText(spec.right, STRIP_WIDTH - PAD, STRIP_LINE_2_Y)
    ctx.textAlign = 'left'
  }

  if (spec.bar) {
    drawBar(ctx, spec.bar, PAD, 46, STRIP_WIDTH - PAD * 2, 6, dim)
  }

  return toRgba(ctx, STRIP_WIDTH, STRIP_HEIGHT)
}

/**
 * Reads one pixel from a raw RGBA buffer. Tests use it for pixel probes. It
 * needs no decode step, because the buffer already holds raw pixels.
 * Pass `width` as `STRIP_WIDTH` when you probe a strip buffer.
 */
export function probe(rgba: Buffer, x: number, y: number, width = KEY_SIZE): Rgb {
  const at = (y * width + x) * 4
  if (at < 0 || at + 3 > rgba.length) {
    throw new Error(`probe coordinate ${x},${y} is outside the buffer`)
  }
  return [rgba[at]!, rgba[at + 1]!, rgba[at + 2]!]
}
