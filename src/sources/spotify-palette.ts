/**
 * The second album colour: an accent that CONTRASTS with the cover's dominant
 * colour, for the right-hand round button.
 *
 * The dominant colour still comes from `dominantColor` in `render/canvas.ts`.
 * This file does not re-grade it. It only answers "which other colour on this
 * cover stands apart from that one?", so the two buttons can never disagree
 * about which colour is dominant.
 *
 * MUST run off the render path, like `dominantColor`. `SpotifySource` calls it
 * once per track, right after the decode, and caches the result beside the
 * image. `contrastAccent` is pure and reads only the pixel array it is given;
 * `sampleCover` is the one function here that touches a canvas.
 */
import { createCanvas, type Image } from '@napi-rs/canvas'
import type { Rgb } from '../render/specs.js'

/** The square the cover is downscaled to. The same size `dominantColor` uses,
 * so both colours come from the same view of the cover. */
export const PALETTE_SAMPLE = 28
/** 5 bits per channel, as `dominantColor` buckets. */
const BUCKET_SHIFT = 3
/** The same brightness band and grey filter as `dominantColor`: a near-black,
 * near-white or grey pixel is never an accent. */
const MIN_LUM = 40
const MAX_LUM = 700
const MIN_CHROMA = 24
/** A candidate must cover at least this share of the counted pixels, so a few
 * stray pixels of a lucky hue cannot become the accent. */
const MIN_SHARE = 0.02
/** How far round the colour wheel a hue must sit from the dominant to count as
 * a contrasting HUE. */
const MIN_HUE_DISTANCE_DEG = 45
/** Failing a hue contrast, how much brighter or darker (channel sum) a colour
 * must be to count as a contrasting SHADE of the same hue. */
const MIN_LUM_DISTANCE = 150

interface Bucket { n: number; r: number; g: number; b: number }

/** Hue in degrees, 0..360. Only called on pixels that passed the chroma
 * filter, so the denominator is never zero. */
function hue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/**
 * The most common colour on the cover that contrasts with `dominant`, or
 * `null` when the cover has none.
 *
 * `rgba` is a raw RGBA pixel array (4 bytes a pixel). Pixels are filtered and
 * bucketed exactly as `dominantColor` does. Among the buckets that cover at
 * least `MIN_SHARE` of the counted pixels, a bucket whose hue sits at least
 * `MIN_HUE_DISTANCE_DEG` from the dominant wins first. Failing that, a much
 * brighter or darker shade wins. A single-colour cover returns `null`: the
 * caller then shows the dominant on both buttons, and never invents a hue.
 */
export function contrastAccent(rgba: ArrayLike<number>, dominant: Rgb): Rgb | null {
  const buckets = new Map<number, Bucket>()
  let counted = 0
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3]!
    if (!(a >= 128)) continue
    const r = rgba[i]!
    const g = rgba[i + 1]!
    const b = rgba[i + 2]!
    const lum = r + g + b
    if (!(lum >= MIN_LUM && lum <= MAX_LUM)) continue
    if (Math.max(r, g, b) - Math.min(r, g, b) < MIN_CHROMA) continue
    counted++
    const key = ((r >> BUCKET_SHIFT) << 10) | ((g >> BUCKET_SHIFT) << 5) | (b >> BUCKET_SHIFT)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.n++
      bucket.r += r
      bucket.g += g
      bucket.b += b
    } else {
      buckets.set(key, { n: 1, r, g, b })
    }
  }
  if (counted === 0) return null

  const domHue = hue(dominant[0], dominant[1], dominant[2])
  const domLum = dominant[0] + dominant[1] + dominant[2]
  const minN = Math.max(1, Math.ceil(counted * MIN_SHARE))
  let byHue: Bucket | null = null
  let byShade: Bucket | null = null
  for (const bucket of buckets.values()) {
    if (bucket.n < minN) continue
    const r = bucket.r / bucket.n
    const g = bucket.g / bucket.n
    const b = bucket.b / bucket.n
    if (hueDistance(hue(r, g, b), domHue) >= MIN_HUE_DISTANCE_DEG) {
      if (!byHue || bucket.n > byHue.n) byHue = bucket
    } else if (Math.abs(r + g + b - domLum) >= MIN_LUM_DISTANCE) {
      if (!byShade || bucket.n > byShade.n) byShade = bucket
    }
  }
  const best = byHue ?? byShade
  if (!best) return null
  return [
    Math.round(best.r / best.n),
    Math.round(best.g / best.n),
    Math.round(best.b / best.n),
  ]
}

/**
 * The cover's pixels, downscaled to `PALETTE_SAMPLE` square, or `null` when
 * the image cannot be drawn. Allocates a canvas: call it once per track, never
 * while rendering.
 */
export function sampleCover(img: Image): Uint8ClampedArray | null {
  const w = Math.max(1, Math.min(PALETTE_SAMPLE, img.width || PALETTE_SAMPLE))
  const h = Math.max(1, Math.min(PALETTE_SAMPLE, img.height || PALETTE_SAMPLE))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  try {
    ctx.drawImage(img, 0, 0, w, h)
  } catch {
    return null
  }
  return ctx.getImageData(0, 0, w, h).data
}
