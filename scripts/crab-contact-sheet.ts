/**
 * Renders every extracted crab frame into one contact sheet PNG, so a human
 * can judge legibility before Task 22 builds animation plumbing around it.
 *
 * Each state is one row. Each frame in that row draws on a real 96x96 dark
 * key, with the project's own border colour, using the real `renderKey`
 * function — so the sheet shows exactly how the deck would draw it. Each
 * frame appears twice, at 48 px and at 72 px, since key size is the open
 * question this sheet exists to answer.
 *
 * Run with: `npm run crab:contact-sheet -- [output-path]`. Defaults to
 * `crab-frames.png` in the repository root. That file is a preview, not a
 * deliverable — it is not committed.
 *
 * This script changes nothing under `src/`. It only reads the PNGs that
 * `extract-crab-frames.ts` already wrote and reads `renderKey` read-only.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas'
import { renderKey, KEY_SIZE } from '../src/render/canvas.js'
import { theme, stateColor, type SessionStateName } from '../src/render/theme.js'

/**
 * Walks up from this file to find the repository root. This module runs
 * both as `scripts/crab-contact-sheet.ts` (one level under the root) and,
 * after a build, as `dist/scripts/crab-contact-sheet.js` (two levels under
 * it), so a fixed number of `..` segments is wrong for one of the two. The
 * search stops at the first ancestor directory holding `package.json`.
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
const CRAB_DIR = join(REPO_ROOT, 'assets', 'crab')

const STATES: SessionStateName[] = ['idle', 'thinking', 'tool', 'permission', 'done', 'unknown']
const PREVIEW_SIZES = [48, 72] as const

const MARGIN = 16
const LABEL_W = 150
const ROW_LABEL_H = 16
const CELL_GAP = 10
const FRAME_GAP = 6
const TITLE_H = 28

/** Turns a raw RGBA buffer, as `renderKey` returns, into a drawable canvas. */
function rgbaToCanvas(buf: Buffer, w: number, h: number): Canvas {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(w, h)
  imageData.data.set(buf)
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

interface StateRow {
  state: SessionStateName
  frameCount: number
  delayMs: number
  /** One real, bordered 96x96 key render per frame. */
  keys: Canvas[]
}

async function loadStateRow(state: SessionStateName): Promise<StateRow | null> {
  const dir = join(CRAB_DIR, state)
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) return null

  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { frameCount: number; delayMs: number }
  const keys: Canvas[] = []

  for (let i = 0; i < meta.frameCount; i++) {
    const framePath = join(dir, `${String(i).padStart(2, '0')}.png`)
    if (!existsSync(framePath)) break
    const frame: Image = await loadImage(await readFile(framePath))
    const keyBuf = renderKey({ kind: 'session', image: frame, border: stateColor(state) })
    keys.push(rgbaToCanvas(keyBuf, KEY_SIZE, KEY_SIZE))
  }

  return { state, frameCount: meta.frameCount, delayMs: meta.delayMs, keys }
}

function frameCellWidth(): number {
  return PREVIEW_SIZES[0] + FRAME_GAP + PREVIEW_SIZES[1]
}

function rowHeight(): number {
  return ROW_LABEL_H + Math.max(...PREVIEW_SIZES)
}

async function buildContactSheet(rows: StateRow[]): Promise<Buffer> {
  const maxFrames = Math.max(1, ...rows.map((r) => r.keys.length))
  const cellW = frameCellWidth()
  const width = MARGIN * 2 + LABEL_W + maxFrames * (cellW + CELL_GAP)
  const height = MARGIN * 2 + TITLE_H + rows.length * (rowHeight() + CELL_GAP)

  const canvas = createCanvas(Math.max(width, 400), Math.max(height, 200))
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = 'rgb(18,18,20)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.fillStyle = 'rgb(230,230,230)'
  ctx.font = '16px Menlo'
  ctx.textBaseline = 'top'
  ctx.fillText('Crab frame contact sheet — each frame at 48 px, then 72 px', MARGIN, MARGIN)

  let y = MARGIN + TITLE_H
  for (const row of rows) {
    ctx.fillStyle = 'rgb(200,200,205)'
    ctx.font = '12px Menlo'
    ctx.fillText(`${row.state}  (${row.keys.length} frames, ${row.delayMs} ms)`, MARGIN, y)

    const framesY = y + ROW_LABEL_H
    let x = MARGIN + LABEL_W
    for (const key of row.keys) {
      for (const size of PREVIEW_SIZES) {
        ctx.drawImage(key, x, framesY, size, size)
        x += size + FRAME_GAP
      }
      x += CELL_GAP - FRAME_GAP
    }

    y += rowHeight() + CELL_GAP
  }

  return canvas.toBuffer('image/png')
}

async function main(): Promise<void> {
  const rows: StateRow[] = []
  for (const state of STATES) {
    const row = await loadStateRow(state)
    if (row) {
      rows.push(row)
    } else {
      console.log(`[${state}] no extracted frames found under ${join(CRAB_DIR, state)}`)
    }
  }

  if (rows.length === 0) {
    console.error('No state frames found. Run "npm run extract:crabs" first.')
    process.exitCode = 1
    return
  }

  const outArg = process.argv[2]
  const outPath = outArg ? resolve(process.cwd(), outArg) : join(REPO_ROOT, 'crab-frames.png')

  const png = await buildContactSheet(rows)
  await writeFile(outPath, png)
  console.log(`Wrote contact sheet: ${outPath}`)
  console.log(`Reference: ${theme.bg.join(',')} is the key background colour.`)
}

const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isEntryPoint) {
  main().catch((e: unknown) => {
    console.error(e)
    process.exitCode = 1
  })
}
