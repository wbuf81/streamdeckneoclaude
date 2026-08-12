import { createCanvas, ImageData, type SKRSContext2D } from '@napi-rs/canvas'
import { inflateSync } from 'node:zlib'
import type { KeySpec, StripSpec, Rgb, BarSpec } from './specs.js'
import { theme } from './theme.js'

export const KEY_SIZE = 96
export const STRIP_WIDTH = 248
export const STRIP_HEIGHT = 58

const FONT = 'Menlo'
const PAD = 6
const BORDER = 3
const BAR_Y = 66
const BAR_H = 8

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

/** Renders one 96 by 96 key. The result is a PNG buffer. */
export function renderKey(spec: KeySpec): Buffer {
  const canvas = createCanvas(KEY_SIZE, KEY_SIZE)
  const ctx = canvas.getContext('2d')
  const dim = spec.dim === true

  ctx.fillStyle = css(spec.bg ?? theme.bg)
  ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE)

  if (spec.image) {
    // The caller supplies a decoded, pre-scaled image. Draw it edge to edge.
    const decoded = decodePngSafe(spec.image)
    if (decoded) {
      const src = createCanvas(decoded.width, decoded.height)
      src.getContext('2d').putImageData(new ImageData(decoded.data, decoded.width, decoded.height), 0, 0)
      ctx.drawImage(src, 0, 0, KEY_SIZE, KEY_SIZE)
    }
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
    ctx.fillStyle = css(theme.text, dim)
    ctx.font = `11px ${FONT}`
    ctx.textAlign = centered ? 'center' : 'left'
    ctx.textBaseline = 'top'
    const x = centered ? KEY_SIZE / 2 : BORDER + PAD
    let y = PAD
    for (const line of spec.lines) {
      ctx.fillText(line, x, y)
      y += 14
    }
  }

  if (spec.bar) {
    drawBar(ctx, spec.bar, BORDER + PAD, BAR_Y, KEY_SIZE - BORDER - PAD * 2, BAR_H, dim)
  }

  return canvas.toBuffer('image/png')
}

/** Renders the 248 by 58 info strip as one image. */
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
    ctx.textAlign = 'right'
    ctx.fillStyle = css(theme.textDim, dim)
    ctx.fillText(spec.right, STRIP_WIDTH - PAD, 4)
    ctx.textAlign = 'left'
  }

  if (spec.bar) {
    drawBar(ctx, spec.bar, PAD, 46, STRIP_WIDTH - PAD * 2, 6, dim)
  }

  return canvas.toBuffer('image/png')
}

/**
 * Reads one pixel from a PNG buffer. Tests use it for pixel probes.
 * It decodes the image every call, so it suits tests and not the render loop.
 */
export function probe(png: Buffer, x: number, y: number): Rgb {
  const decoded = decodePngSync(png)
  const i = (y * decoded.width + x) * 4
  const r = decoded.data[i]
  const g = decoded.data[i + 1]
  const b = decoded.data[i + 2]
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error(`probe coordinate (${x}, ${y}) is out of bounds`)
  }
  return [r, g, b]
}

/**
 * A decoded raster image: raw RGBA bytes, top to bottom, left to right.
 */
interface DecodedPng {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** Like `decodePngSync`, but returns `null` on failure instead of throwing. */
function decodePngSafe(buf: Buffer): DecodedPng | null {
  try {
    return decodePngSync(buf)
  } catch {
    return null
  }
}

/**
 * Decodes an 8-bit, non-interlaced PNG buffer into raw RGBA pixels. It runs
 * synchronously.
 *
 * The `Image` class in `@napi-rs/canvas` mirrors the browser `HTMLImageElement`.
 * There, image loading is always asynchronous. Assigning `.src` schedules a
 * background decode. The decode does not finish before the next event-loop
 * tick, even for a buffer already in memory. A render loop that returns a
 * `Buffer` synchronously cannot wait for that tick, so `Image` cannot serve it.
 *
 * This module only decodes PNGs that it produced itself, through
 * `Canvas#toBuffer('image/png')`. `@napi-rs/canvas` always encodes those as
 * 8-bit and non-interlaced, with the standard per-scanline PNG filters. This
 * decoder handles exactly that shape. It inflates the IDAT stream with Node's
 * synchronous zlib, then reverses the PNG filters by hand. It is not a general
 * PNG decoder.
 */
function decodePngSync(buf: Buffer): DecodedPng {
  const PNG_SIGNATURE_LENGTH = 8
  let offset = PNG_SIGNATURE_LENGTH
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idatParts: Buffer[] = []

  while (offset < buf.length) {
    const chunkLength = buf.readUInt32BE(offset)
    const chunkType = buf.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const data = buf.subarray(dataStart, dataStart + chunkLength)

    if (chunkType === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? 0
      interlace = data[12] ?? 0
    } else if (chunkType === 'IDAT') {
      idatParts.push(data)
    } else if (chunkType === 'IEND') {
      break
    }

    offset = dataStart + chunkLength + 4 // skip the trailing CRC
  }

  if (bitDepth !== 8) throw new Error(`decodePngSync: only 8-bit PNGs are supported, got ${bitDepth}`)
  if (interlace !== 0) throw new Error('decodePngSync: interlaced PNGs are not supported')

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`decodePngSync: unsupported PNG color type ${colorType}`)

  const inflated = inflateSync(Buffer.concat(idatParts))
  const rowBytes = width * channels
  const planes = new Uint8Array(height * rowBytes)
  let readPos = 0

  for (let row = 0; row < height; row++) {
    const filterType = inflated[readPos]
    readPos += 1
    const rowStart = row * rowBytes
    const prevRowStart = (row - 1) * rowBytes

    for (let col = 0; col < rowBytes; col++) {
      const rawByte = inflated[readPos + col] ?? 0
      const a = col >= channels ? planes[rowStart + col - channels]! : 0
      const b = row > 0 ? planes[prevRowStart + col]! : 0
      const c = row > 0 && col >= channels ? planes[prevRowStart + col - channels]! : 0

      let recon: number
      switch (filterType) {
        case 0:
          recon = rawByte
          break
        case 1:
          recon = rawByte + a
          break
        case 2:
          recon = rawByte + b
          break
        case 3:
          recon = rawByte + Math.floor((a + b) / 2)
          break
        case 4:
          recon = rawByte + paethPredictor(a, b, c)
          break
        default:
          throw new Error(`decodePngSync: unsupported filter type ${filterType}`)
      }
      planes[rowStart + col] = recon & 0xff
    }
    readPos += rowBytes
  }

  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0, out = 0; pixel < width * height; pixel++, out += 4) {
    const s = pixel * channels
    if (channels === 4) {
      rgba[out] = planes[s]!
      rgba[out + 1] = planes[s + 1]!
      rgba[out + 2] = planes[s + 2]!
      rgba[out + 3] = planes[s + 3]!
    } else if (channels === 3) {
      rgba[out] = planes[s]!
      rgba[out + 1] = planes[s + 1]!
      rgba[out + 2] = planes[s + 2]!
      rgba[out + 3] = 255
    } else if (channels === 2) {
      rgba[out] = planes[s]!
      rgba[out + 1] = planes[s]!
      rgba[out + 2] = planes[s]!
      rgba[out + 3] = planes[s + 1]!
    } else {
      rgba[out] = planes[s]!
      rgba[out + 1] = planes[s]!
      rgba[out + 2] = planes[s]!
      rgba[out + 3] = 255
    }
  }

  return { width, height, data: rgba }
}

/** The PNG Paeth filter predictor. See the PNG specification, section 9.4. */
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}
