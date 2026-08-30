/**
 * Extracts animated crab frames from clawd-on-desk's GIFs into PNG sequences.
 *
 * This is a one-time, offline step. It reads GIFs from a sibling project, decodes
 * them with `omggif`, composes each frame onto a persistent canvas (GIF frames
 * are often partial patches, not whole images), finds one shared content box per
 * state, and writes cropped, scaled 96x96 PNGs plus a `meta.json` per state.
 *
 * Run with: `npm run extract:crabs`.
 *
 * This script changes nothing under `src/`. It adds no runtime behaviour: the
 * daemon only ever loads the PNGs this script writes.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { GifReader } from 'omggif'

/** A rectangle in pixel coordinates. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Finds the smallest rectangle that contains every pixel whose alpha is at or
 * above `alphaMin`. `rgba` holds one image, `w` by `h`, four bytes per pixel.
 *
 * A fully transparent buffer has no such pixel. Returning a negative-size box
 * in that case would break every caller, so this returns the full image
 * instead — a safe box, not a meaningful one.
 */
export function contentBounds(rgba: Uint8Array, w: number, h: number, alphaMin = 16): Box {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = rgba[(y * w + x) * 4 + 3]
      if (a === undefined || a < alphaMin) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) return { x: 0, y: 0, w, h }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * Expands `box` to a square, centred on the box's centre, with a margin added
 * around the content, then clamps it so it never crosses the `w` by `h` image
 * edge. The clamp can shift the box off-centre near an edge or corner; it
 * never shrinks it.
 */
export function squareBox(box: Box, w: number, h: number, marginFraction = 0.12): Box {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const bare = Math.max(box.w, box.h)
  const withMargin = bare * (1 + marginFraction * 2)
  const side = Math.min(withMargin, w, h)

  let x = cx - side / 2
  let y = cy - side / 2
  x = Math.max(0, Math.min(x, w - side))
  y = Math.max(0, Math.min(y, h - side))

  return { x: Math.round(x), y: Math.round(y), w: Math.round(side), h: Math.round(side) }
}

/**
 * Picks up to `max` frame indices out of `total`, spread evenly, ascending,
 * unique, and always starting at 0. When `total` is already at or below `max`
 * it returns every index, so nothing is lost unless sampling is necessary.
 */
export function pickFrameIndices(total: number, max: number): number[] {
  if (total <= 0) return []
  if (total <= max || max <= 1) {
    return Array.from({ length: Math.min(total, Math.max(max, 1)) }, (_, i) => i)
  }

  const result: number[] = []
  for (let i = 0; i < max; i++) {
    result.push(Math.round((i * (total - 1)) / (max - 1)))
  }
  return [...new Set(result)]
}

// --- GIF decoding and composition -----------------------------------------

/** One state's mapping to a source GIF filename. */
const STATE_GIFS: Record<string, string> = {
  idle: 'clawd-idle.gif',
  thinking: 'clawd-thinking.gif',
  tool: 'clawd-typing.gif',
  permission: 'clawd-notification.gif',
  done: 'clawd-happy.gif',
  unknown: 'clawd-idle.gif',
}

/**
 * Where the source GIFs live. This is a one-off authoring tool, not part of
 * the daemon: it re-extracts `assets/crab/` from a checkout of
 * clawd-on-desk, which is NOT vendored here — only the extracted PNGs are.
 *
 * Pass the directory as the first argument, or set `CLAWD_GIF_DIR`. The
 * default points at a sibling checkout, so the common case needs neither:
 *
 *   git clone https://github.com/rullerzhou-afk/clawd-on-desk ../clawd-on-desk
 *   npm run extract:crabs
 */
function gifDir(): string {
  const fromArg = process.argv[2]
  if (fromArg) return resolve(fromArg)
  const fromEnv = process.env['CLAWD_GIF_DIR']
  if (fromEnv) return resolve(fromEnv)
  return join(findRepoRoot(), '..', 'clawd-on-desk', 'assets', 'gif')
}

/**
 * Walks up from this file to find the repository root. This module runs
 * both as `scripts/extract-crab-frames.ts` (one level under the root) and,
 * after a build, as `dist/scripts/extract-crab-frames.js` (two levels
 * under it), so a fixed number of `..` segments is wrong for one of the two.
 * The search stops at the first ancestor directory holding `package.json`.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('could not find the repository root above ' + dirname(fileURLToPath(import.meta.url)))
}

const REPO_ROOT = findRepoRoot()
const OUT_DIR = join(REPO_ROOT, 'assets', 'crab')

const OUTPUT_SIZE = 96
const MAX_FRAMES = 24
const MIN_DELAY_MS = 40

/** Disposal method 2: restore the frame's rectangle to background (transparent). */
const DISPOSE_TO_BACKGROUND = 2
/** Disposal method 3: restore the frame's rectangle to what preceded it. */
const DISPOSE_TO_PREVIOUS = 3

function clearRect(canvas: Uint8Array, width: number, r: Box): void {
  for (let row = 0; row < r.h; row++) {
    const start = ((r.y + row) * width + r.x) * 4
    canvas.fill(0, start, start + r.w * 4)
  }
}

function copyRect(canvas: Uint8Array, width: number, r: Box): Uint8Array {
  const out = new Uint8Array(r.w * r.h * 4)
  for (let row = 0; row < r.h; row++) {
    const start = ((r.y + row) * width + r.x) * 4
    out.set(canvas.subarray(start, start + r.w * 4), row * r.w * 4)
  }
  return out
}

function restoreRect(canvas: Uint8Array, width: number, r: Box, data: Uint8Array): void {
  for (let row = 0; row < r.h; row++) {
    const start = ((r.y + row) * width + r.x) * 4
    canvas.set(data.subarray(row * r.w * 4, (row + 1) * r.w * 4), start)
  }
}

interface ComposedGif {
  width: number
  height: number
  /** One full-canvas RGBA snapshot per displayed frame. */
  frames: Uint8Array[]
  /** Each frame's own delay, in GIF time units of 1/100 s. */
  delaysCs: number[]
}

/**
 * Decodes every frame of a GIF and composes it onto a persistent canvas.
 *
 * A GIF frame often patches only a sub-rectangle of the previous frame. The
 * disposal method says what happens to that sub-rectangle once its delay
 * elapses, before the next frame is drawn:
 *  - 0 or 1: leave it. The next frame draws on top.
 *  - 2: clear it to background (here, transparent).
 *  - 3: restore whatever was there before this frame was drawn.
 *
 * Treating frames as independent images, instead of composing them, leaves
 * holes wherever a later frame does not repaint the full canvas.
 */
function composeFrames(reader: GifReader): ComposedGif {
  const width = reader.width
  const height = reader.height
  const canvas = new Uint8Array(width * height * 4)
  const frames: Uint8Array[] = []
  const delaysCs: number[] = []

  let prevRect: Box | null = null
  let prevDisposal = 0
  let saved: { rect: Box; data: Uint8Array } | null = null

  for (let i = 0; i < reader.numFrames(); i++) {
    if (prevRect) {
      if (prevDisposal === DISPOSE_TO_BACKGROUND) {
        clearRect(canvas, width, prevRect)
      } else if (prevDisposal === DISPOSE_TO_PREVIOUS && saved) {
        restoreRect(canvas, width, saved.rect, saved.data)
      }
    }

    const info = reader.frameInfo(i)
    const rect: Box = { x: info.x, y: info.y, w: info.width, h: info.height }

    saved = info.disposal === DISPOSE_TO_PREVIOUS ? { rect, data: copyRect(canvas, width, rect) } : null

    reader.decodeAndBlitFrameRGBA(i, canvas)

    frames.push(canvas.slice())
    delaysCs.push(info.delay)

    prevRect = rect
    prevDisposal = info.disposal
  }

  return { width, height, frames, delaysCs }
}

/** Marks a pixel's alpha with the highest alpha seen there across all frames. */
function unionAlpha(frames: Uint8Array[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (const frame of frames) {
    for (let p = 0; p < w * h; p++) {
      const a = frame[p * 4 + 3] ?? 0
      const idx = p * 4 + 3
      if (a > (out[idx] ?? 0)) out[idx] = a
    }
  }
  return out
}

/** Crops `rgba` to `box` and scales it to a 96x96 PNG buffer. */
function renderFramePng(rgba: Uint8Array, width: number, height: number, box: Box): Buffer {
  const source = createCanvas(width, height)
  const sctx = source.getContext('2d')
  const imageData = sctx.createImageData(width, height)
  imageData.data.set(rgba)
  sctx.putImageData(imageData, 0, 0)

  const dest = createCanvas(OUTPUT_SIZE, OUTPUT_SIZE)
  const dctx = dest.getContext('2d')
  dctx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
  return dest.toBuffer('image/png')
}

async function extractState(state: string, gifName: string, dir: string): Promise<void> {
  const gifPath = join(dir, gifName)
  if (!existsSync(gifPath)) {
    console.log(`[${state}] MISSING source GIF: ${gifPath}`)
    return
  }

  const buf = await readFile(gifPath)
  const reader = new GifReader(buf)
  const { width, height, frames, delaysCs } = composeFrames(reader)

  const totalFrames = frames.length
  const indices = pickFrameIndices(totalFrames, MAX_FRAMES)
  const sampled = indices.length < totalFrames

  // One shared box for every frame of this state. A per-frame box would let
  // the crab jitter and change size as it moves.
  const rawBox = contentBounds(unionAlpha(frames, width, height), width, height)
  const box = squareBox(rawBox, width, height)

  const firstDelayCs = delaysCs[0] ?? 10
  const delayMs = Math.max(MIN_DELAY_MS, firstDelayCs * 10)

  const outDir = join(OUT_DIR, state)
  await mkdir(outDir, { recursive: true })

  for (let outIdx = 0; outIdx < indices.length; outIdx++) {
    const frameIdx = indices[outIdx]
    if (frameIdx === undefined) continue
    const rgba = frames[frameIdx]
    if (!rgba) continue
    const png = renderFramePng(rgba, width, height, box)
    await writeFile(join(outDir, `${String(outIdx).padStart(2, '0')}.png`), png)
  }

  await writeFile(
    join(outDir, 'meta.json'),
    JSON.stringify({ frameCount: indices.length, delayMs }, null, 2) + '\n',
  )

  const sampleNote = sampled ? ` sampled ${totalFrames} down to ${indices.length}` : ''
  console.log(
    `[${state}] source=${width}x${height} frames=${totalFrames}${sampleNote} ` +
      `contentBox=(${rawBox.x},${rawBox.y} ${rawBox.w}x${rawBox.h}) delayMs=${delayMs}`,
  )
}

async function main(): Promise<void> {
  const dir = gifDir()
  if (!existsSync(dir)) {
    console.error(
      `No GIF directory at ${dir}.\n` +
        `Clone clawd-on-desk next to this repository, or pass the directory:\n` +
        `  npm run extract:crabs -- /path/to/clawd-on-desk/assets/gif`,
    )
    process.exitCode = 1
    return
  }
  console.log(`source GIFs: ${dir}`)
  for (const [state, gifName] of Object.entries(STATE_GIFS)) {
    await extractState(state, gifName, dir)
  }
}

const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isEntryPoint) {
  main().catch((e: unknown) => {
    console.error(e)
    process.exitCode = 1
  })
}
