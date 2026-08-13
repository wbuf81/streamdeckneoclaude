import { createCanvas, type SKRSContext2D, type Image } from '@napi-rs/canvas'
import type { KeySpec, StripSpec, Rgb, BarSpec, SparkSpec, ImageCrop, PulseSpec } from './specs.js'
import { theme } from './theme.js'

export const KEY_SIZE = 96
export const STRIP_WIDTH = 248
export const STRIP_HEIGHT = 58

/** Exported so `text.ts` can measure with the exact same font the renderer
 * uses. Two different font names would make a measurement meaningless. */
export const FONT = 'Menlo'
const PAD = 6
const BORDER = 3
const BAR_Y = 66
const BAR_H = 8
const SPARK_Y = 48
const SPARK_H = 40
/** A chart-only key (no text lines) can use the whole tile instead of the
 * default lower band. Leaves the same top and bottom margin the default
 * band keeps, just stretched over the full height. */
const SPARK_FULL_Y = 6
const SPARK_FULL_H = 84
/** The idle equaliser uses the same full-height band as a chart-only spark:
 * a pulse key carries no text, so it may as well use nearly the whole tile
 * instead of the smaller lower band a key with labels would leave for it. */
const PULSE_Y = 6
const PULSE_H = 84
/**
 * Usable text width of one key: 96 − 3 border − 6 padding each side.
 * Matches docs/VERIFIED-FACTS.md's measured text budget table. Used to
 * resolve a `lineSizes` candidate-array entry to a concrete size that
 * actually fits, at draw time — see `resolveLineSpecs`.
 */
const TEXT_MAX_WIDTH = KEY_SIZE - BORDER - PAD * 2
/** Baseline of the strip's second text line. */
const STRIP_LINE_2_Y = 21
/** Dims a colour, or a colour emoji's `globalAlpha`, to this fraction. One
 * constant so text, border and emoji all dim by the same amount. */
const DIM_FACTOR = 0.45
/**
 * Size and vertical centre of the emoji glyph.
 *
 * Measured with `ctx.getImageData` over every weather emoji this app draws
 * (see the brief's band table for the nominal geometry): a colour emoji's
 * real ink does not sit centred on its nominal font-size box the way plain
 * text does. At `34px` centred on `y 34` — the brief's own suggested
 * numbers — several glyphs (for example the rain and snow icons) painted
 * ink as high as `y 12`, one row below where the day label's own ink ends,
 * leaving no background gap at all between band 1 and band 2.
 *
 * `32px` centred on `y 38` was the smallest, lowest combination that kept
 * every weather emoji's ink between `y 17` and `y 48` — clear of the label
 * (ends by `y 12`) above and the temperature line (starts at `y 55`) below.
 */
const EMOJI_SIZE = 32
const EMOJI_Y = 38

function css(c: Rgb, dim = false): string {
  const f = dim ? DIM_FACTOR : 1
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
 *
 * With `slice`, the series lays out across `slice.count` key widths instead
 * of one, and this call draws only the portion belonging to `slice.index`.
 * The min and max still come from the WHOLE series (never just the visible
 * slice), so the three keys of one chart share one scale and a bar's height
 * means the same thing on every one of them. A bar that straddles a slice
 * boundary is clipped to this key's own margin rather than bleeding into the
 * border — the physical gap between two real keys already loses that sliver,
 * this only keeps the maths from painting over the padding.
 *
 * Absent `slice`, `sliceStart` is 0 and `virtualWidth` equals the plain
 * single-key `width`, so every computed position matches the pre-`slice`
 * code exactly — the grid's single-key sparkline depends on that being
 * byte-identical.
 */
function drawSpark(ctx: SKRSContext2D, spark: SparkSpec, dim: boolean): void {
  const { values, color, slice, fullHeight } = spark
  if (values.length < 2) return

  const x0 = BORDER + PAD
  const x1 = KEY_SIZE - PAD
  const width = x1 - x0
  const bandY = fullHeight ? SPARK_FULL_Y : SPARK_Y
  const bandH = fullHeight ? SPARK_FULL_H : SPARK_H

  const count = slice && slice.count > 0 ? slice.count : 1
  const index = slice?.index ?? 0
  const virtualWidth = width * count
  const barW = virtualWidth / values.length
  const sliceStart = index * width
  const sliceEnd = sliceStart + width

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min

  ctx.fillStyle = css(color, dim)
  for (let i = 0; i < values.length; i++) {
    const virtualX = i * barW
    // Entirely outside this slice's span: nothing of this bar lands here.
    if (virtualX + barW <= sliceStart || virtualX >= sliceEnd) continue

    const v = values[i]!
    const frac = range === 0 ? 0.5 : (v - min) / range
    const h = frac * bandH
    if (h <= 0) continue

    let x = x0 + (virtualX - sliceStart)
    let w = Math.max(1, barW - 1)
    if (x < x0) {
      w -= x0 - x
      x = x0
    }
    if (w <= 0) continue
    if (x >= x1) continue
    // Clip a bar that runs past this key's own margin — but never below the
    // 1 px floor above. Above 81 values `barW < 1`, so a strict clip would
    // shrink the last bar to a sub-pixel sliver that renders as nothing,
    // where the pre-slice code always drew at least 1 px. A few values run
    // slightly into the padding instead: a visible bar beats an invisible
    // one, and the padding itself has nothing else drawn in it.
    if (x + w > x1) {
      const clipped = x1 - x
      if (clipped >= 1) w = clipped
    }

    const y = bandY + (bandH - h)
    ctx.fillRect(x, y, w, h)
  }
}

/**
 * Draws a slow-breathing equaliser: `bars` vertical bars, each one's height
 * a sine wave of `phase`, offset from its neighbours so the bars do not all
 * move in lockstep. Bars are bottom-anchored, spanning the same `x0`-to-`x1`
 * margin `drawSpark` uses, over the `PULSE_Y`/`PULSE_H` band. `bars <= 0`
 * draws nothing, so a bad spec cannot throw inside the render loop.
 */
function drawPulse(ctx: SKRSContext2D, pulse: PulseSpec, dim: boolean): void {
  const { phase, bars, color } = pulse
  if (bars <= 0) return

  const x0 = BORDER + PAD
  const x1 = KEY_SIZE - PAD
  const width = x1 - x0
  const barW = width / bars
  const bottom = PULSE_Y + PULSE_H
  // Never fully flat: even the quietest bar keeps a sliver, so the key reads
  // as an equaliser "at rest" rather than something that occasionally turns
  // off entirely.
  const minH = PULSE_H * 0.1
  const maxH = PULSE_H

  ctx.fillStyle = css(color, dim)
  for (let i = 0; i < bars; i++) {
    // Each bar samples the same wave a fraction further along, so within one
    // key the bars ripple rather than all breathing together.
    const t = phase + i * ((2 * Math.PI) / bars)
    const frac = 0.5 + 0.5 * Math.sin(t)
    const h = minH + frac * (maxH - minH)
    const x = x0 + i * barW
    const w = Math.max(1, barW - 2)
    const y = bottom - h
    ctx.fillRect(x, y, w, h)
  }
}

/**
 * Draws `img` onto the whole key. With no `crop`, this scales the entire
 * image edge to edge, exactly as before `imageCrop` existed. With a `crop`,
 * it draws only that source rectangle — fractions of `img`'s own size, so
 * the caller never needs to know the natural pixel dimensions.
 *
 * Fractions clamp into 0 to 1 first. A crop whose clamped width or height is
 * zero or negative draws nothing, so a bad crop cannot throw inside the
 * render loop.
 */
function drawCroppedImage(ctx: SKRSContext2D, img: Image, crop?: ImageCrop): void {
  if (!crop) {
    ctx.drawImage(img, 0, 0, KEY_SIZE, KEY_SIZE)
    return
  }
  const sx = clamp01(crop.sx)
  const sy = clamp01(crop.sy)
  const sw = clamp01(crop.sw)
  const sh = clamp01(crop.sh)
  if (sw <= 0 || sh <= 0) return
  ctx.drawImage(
    img,
    sx * img.width,
    sy * img.height,
    sw * img.width,
    sh * img.height,
    0,
    0,
    KEY_SIZE,
    KEY_SIZE,
  )
}

/** Shrinks `text` one character at a time, replacing the tail with an
 * ellipsis, until it measures at or under `maxWidth` at the context's
 * CURRENT font. Used only as the last resort, when even the smallest
 * `lineSizes` candidate does not fit — truncating is a smaller defect than
 * drawing past the key's edge. */
function shrinkToFit(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  for (let n = text.length - 1; n > 0; n--) {
    const candidate = text.slice(0, n) + '…'
    if (ctx.measureText(candidate).width <= maxWidth) return candidate
  }
  return '…'
}

function sameSizeCandidates(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Resolves each line's `lineSizes` entry to a concrete size and the exact
 * text to draw. A plain `number` is used as given, unmeasured — the legacy
 * path, and the path for any page that already knows its text fits. An
 * `array` is a set of candidates: this measures with the SAME context and
 * font `renderKey` draws with, and picks the largest one that fits
 * `maxWidth`. Consecutive lines that pass the identical candidate array (by
 * value) are resolved as ONE group, sized to whichever member of the group
 * needs the smallest size to fit — so a range's high and low, which always
 * pass the same candidate list, end up the same size instead of the low
 * rendering bigger than the high above it.
 *
 * `lineSizes` entirely absent returns every line at the fixed legacy size,
 * 11, with no measuring at all — byte-identical to before this function
 * existed, for the pages that have never set it.
 */
function resolveLineSpecs(
  ctx: SKRSContext2D,
  lines: string[],
  lineSizes: (number | number[])[] | undefined,
  maxWidth: number,
): { size: number; text: string }[] {
  if (!lineSizes) return lines.map((text) => ({ size: 11, text }))

  const out: { size: number; text: string }[] = []
  let i = 0
  while (i < lines.length) {
    const spec = lineSizes[i]
    if (Array.isArray(spec)) {
      let j = i + 1
      while (j < lines.length) {
        const next = lineSizes[j]
        if (!Array.isArray(next) || !sameSizeCandidates(next, spec)) break
        j++
      }
      const groupTexts = lines.slice(i, j)
      const sorted = [...spec].sort((a, b) => b - a)
      let chosen: number | null = null
      for (const size of sorted) {
        ctx.font = `${size}px ${FONT}`
        if (groupTexts.every((t) => ctx.measureText(t).width <= maxWidth)) {
          chosen = size
          break
        }
      }
      const size = chosen ?? sorted[sorted.length - 1] ?? 11
      ctx.font = `${size}px ${FONT}`
      for (let k = i; k < j; k++) {
        out.push({ size, text: shrinkToFit(ctx, lines[k]!, maxWidth) })
      }
      i = j
    } else {
      out.push({ size: typeof spec === 'number' ? spec : 11, text: lines[i]! })
      i++
    }
  }
  return out
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
    // The producer already decoded this. With no crop, it scales to the key,
    // edge to edge, exactly as before `imageCrop` existed.
    drawCroppedImage(ctx, spec.image, spec.imageCrop)
  }

  if (spec.border) {
    const on = spec.pulseOn !== false
    ctx.fillStyle = on ? css(spec.border, dim) : css(spec.border, true)
    ctx.fillRect(0, 0, BORDER, KEY_SIZE)
  }

  if (spec.glyph) {
    ctx.fillStyle = css(spec.glyphColor ?? theme.text, dim)
    ctx.font = `28px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(spec.glyph, KEY_SIZE / 2, KEY_SIZE / 2)
  }

  if (spec.emoji) {
    // Colour emoji are bitmap glyphs and ignore `fillStyle`, so dimming
    // needs `globalAlpha` instead. Restored in `finally`, so a throw here
    // (or anywhere else in this function later) cannot leave every
    // subsequent draw call on this context dimmed. A missing emoji font
    // simply draws nothing, which is acceptable degradation — there is no
    // fallback glyph.
    const prevAlpha = ctx.globalAlpha
    try {
      if (dim) ctx.globalAlpha = DIM_FACTOR
      ctx.font = `${EMOJI_SIZE}px "Apple Color Emoji"`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(spec.emoji, KEY_SIZE / 2, EMOJI_Y)
    } finally {
      ctx.globalAlpha = prevAlpha
    }
  }

  if (spec.lines?.length) {
    const centered = spec.align === 'center'
    ctx.textAlign = centered ? 'center' : 'left'
    ctx.textBaseline = 'top'
    const x = centered ? KEY_SIZE / 2 : BORDER + PAD
    // Resolved once, up front: a candidate-array entry may need to look at
    // OTHER lines in its group (see `resolveLineSpecs`), which the
    // line-by-line draw loop below cannot do after it has already moved on.
    const resolved = resolveLineSpecs(ctx, spec.lines, spec.lineSizes, TEXT_MAX_WIDTH)
    let y = PAD
    for (let i = 0; i < resolved.length; i++) {
      const { size, text } = resolved[i]!
      // `lineSizes` is opt-in per key. Its absence takes the exact legacy
      // path: 11 px text on a fixed 14 px advance, so every page that has
      // never set it (Spotify, stocks, weather) renders pixel-for-pixel as
      // it did before this field existed. A present array switches to
      // size-driven spacing, because a 28 px line needs more room below it
      // than an 11 px one — a fixed advance would let two lines overlap.
      const advance = spec.lineSizes ? size + 4 : 14
      ctx.font = `${size}px ${FONT}`
      const color = spec.lineColors?.[i] ?? theme.text
      ctx.fillStyle = css(color, dim)
      // `lineY` is opt-in per line, same pattern as `lineSizes`. Its absence
      // (the case for every page except the new weather layout) keeps the
      // running automatic position, so nothing else changes.
      const drawY = spec.lineY?.[i] ?? y
      ctx.fillText(text, x, drawY)
      y = drawY + advance
    }
  }

  if (spec.spark) {
    drawSpark(ctx, spec.spark, dim)
  }

  if (spec.pulse) {
    drawPulse(ctx, spec.pulse, dim)
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
