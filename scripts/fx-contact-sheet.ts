/**
 * Renders the weather page's ambient condition effects (task 42) into one
 * contact sheet PNG, so a human can judge the look before it reaches the deck.
 * Only the user can see the real device, so a visual judgement is theirs — see
 * the working agreements in `docs/PROJECT-STATE.md`.
 *
 * One row per forecast condition. One column per instant, so a still image
 * still shows how each effect moves. Every cell is a REAL `WeatherPage` day
 * tile rasterised through the REAL `renderKey`, so the sheet shows exactly what
 * the deck would draw — not a mock-up of it.
 *
 * The right-hand columns repeat the heaviest and lightest rain chance, and the
 * stale (frozen, dimmed) state, since those are the three cases the design
 * makes decisions about.
 *
 * Run with: `npm run fx:contact-sheet -- [output-path]`. Defaults to
 * `weather-fx.png` in the repository root. That file is a preview, not a
 * deliverable — it is not committed.
 *
 * This script changes nothing under `src/`. It reads the page and the renderer
 * read-only, and it never opens the device.
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, type Canvas } from '@napi-rs/canvas'
import { renderKey, KEY_SIZE } from '../src/render/canvas.js'
import { theme } from '../src/render/theme.js'
import { WeatherPage, type WeatherReader } from '../src/pages/weather-page.js'
import type { DayForecast } from '../src/sources/weather.js'

/**
 * Walks up from this file to find the repository root. This module runs both as
 * `scripts/fx-contact-sheet.ts` (one level under the root) and, after a build,
 * as `dist/scripts/fx-contact-sheet.js` (two levels under it), so a fixed
 * number of `..` segments is wrong for one of the two — lesson 2 in
 * docs/LESSONS.md, which cost three silent failures before the habit stuck.
 * Never resolve from `process.cwd()` (lesson 3).
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

/** Every condition the forecast classifier can produce, with a real
 * `shortForecast` string beside it so the sheet is labelled the way the source
 * would label it. */
const CONDITIONS: readonly { emoji: string; label: string }[] = [
  { emoji: '⛈', label: 'thunder' },
  { emoji: '🌨', label: 'snow / ice' },
  { emoji: '🌧', label: 'rain' },
  { emoji: '🌫', label: 'fog / haze' },
  { emoji: '💨', label: 'wind' },
  { emoji: '☁️', label: 'overcast' },
  { emoji: '⛅', label: 'partly cloudy' },
  { emoji: '☀️', label: 'sunny / clear' },
]

/** Instants sampled across each effect's motion, in milliseconds. */
const INSTANTS = [0, 300, 700, 1400, 2800, 5600] as const

const MARGIN = 16
const LABEL_W = 132
const TITLE_H = 30
const HEADER_H = 18
const CELL_GAP = 8
const ROW_GAP = 10
const SCALE = 1

/** Turns a raw RGBA buffer, as `renderKey` returns, into a drawable canvas. */
function rgbaToCanvas(buf: Buffer, w: number, h: number): Canvas {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(w, h)
  imageData.data.set(buf)
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

function day(emoji: string, precipPercent: number | null): DayForecast {
  return {
    label: 'NOW',
    id: 'NOW',
    emoji,
    high: 95,
    low: 77,
    precipPercent,
    shortForecast: 'preview',
    day: null,
    night: null,
  }
}

/** A minimal reader, the same shape the page's own tests use. It reaches no
 * network and no device. */
function reader(days: DayForecast[], stale: boolean): WeatherReader {
  return {
    getZip: () => '10001',
    getDays: () => days,
    getConditions: () => null,
    getStatus: () => 'ok',
    getLastUpdatedAt: () => 0,
    getPlace: () => 'Brooklyn NY',
    isStale: () => stale,
    setVisible: () => {},
  } as unknown as WeatherReader
}

/** Renders the real key 0 of a real `WeatherPage` for one condition, one rain
 * chance, one clock, and one staleness state. */
function tile(emoji: string, precip: number | null, nowMs: number, stale: boolean): Canvas {
  const page = new WeatherPage(reader([day(emoji, precip)], stale))
  const key = page.render(Math.floor(nowMs / 1000), nowMs).keys[0]!
  return rgbaToCanvas(renderKey(key), KEY_SIZE, KEY_SIZE)
}

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? join(REPO_ROOT, 'weather-fx.png'))

  // Columns: the motion samples, then 100% rain, then 0% rain, then stale.
  const extraColumns = 3
  const cols = INSTANTS.length + extraColumns
  const cellW = KEY_SIZE * SCALE
  const width = MARGIN * 2 + LABEL_W + cols * cellW + (cols - 1) * CELL_GAP
  const rowH = cellW + ROW_GAP
  const height = MARGIN * 2 + TITLE_H + HEADER_H + CONDITIONS.length * rowH

  const sheet = createCanvas(width, height)
  const ctx = sheet.getContext('2d')
  ctx.fillStyle = 'rgb(24, 24, 28)'
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = `rgb(${theme.text.join(',')})`
  ctx.font = '16px Menlo'
  ctx.textBaseline = 'top'
  ctx.fillText('Weather ambient effects — real WeatherPage tiles, real renderKey', MARGIN, MARGIN)

  // Column headers.
  ctx.font = '11px Menlo'
  ctx.fillStyle = `rgb(${theme.textDim.join(',')})`
  const headerY = MARGIN + TITLE_H
  INSTANTS.forEach((ms, i) => {
    const x = MARGIN + LABEL_W + i * (cellW + CELL_GAP)
    ctx.fillText(`${ms} ms`, x, headerY)
  })
  const extraLabels = ['100% rain', '0% rain', 'STALE']
  extraLabels.forEach((label, i) => {
    const x = MARGIN + LABEL_W + (INSTANTS.length + i) * (cellW + CELL_GAP)
    ctx.fillText(label, x, headerY)
  })

  CONDITIONS.forEach((condition, row) => {
    const y = MARGIN + TITLE_H + HEADER_H + row * rowH

    ctx.font = '13px Menlo'
    ctx.fillStyle = `rgb(${theme.text.join(',')})`
    ctx.fillText(`${condition.emoji} ${condition.label}`, MARGIN, y + cellW / 2 - 8)

    const cells: Canvas[] = [
      ...INSTANTS.map((ms) => tile(condition.emoji, 60, ms, false)),
      tile(condition.emoji, 100, 1400, false),
      tile(condition.emoji, 0, 1400, false),
      tile(condition.emoji, 60, 1400, true),
    ]

    cells.forEach((cell, col) => {
      const x = MARGIN + LABEL_W + col * (cellW + CELL_GAP)
      ctx.drawImage(cell, x, y, cellW, cellW)
    })
  })

  await writeFile(outPath, sheet.toBuffer('image/png'))
  process.stdout.write(`wrote ${outPath}\n`)
  process.stdout.write(`${CONDITIONS.length} conditions x ${cols} columns\n`)
}

await main()
