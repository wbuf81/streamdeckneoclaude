/**
 * Renders the stocks board (task 43) into contact sheets, so a human can judge
 * the glance value before it reaches the deck. Only the user can see the real
 * device — see the working agreements in `docs/PROJECT-STATE.md`.
 *
 * It renders TWO distributions on purpose, because one hides defects. That
 * lesson came from task 42: a preview with one tile per weather condition looked
 * perfect and approved, and then a real week of nothing but storms exposed four
 * defects at once. So this sheet shows:
 *
 * - a LIVE-like board, from real measured change percentages, and
 * - a FLAT board, every symbol inside ±0.4 percent, which is the case an
 *   absolute heat scale flatters least.
 *
 * Each is drawn at every market state, since the state sets the mood.
 *
 * Run with: `npm run stocks:contact-sheet -- [output-path]`. Defaults to
 * `stocks-board.png` in the repository root. A preview, not a deliverable — it
 * is not committed.
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, type Canvas } from '@napi-rs/canvas'
import { renderKey, renderStrip, KEY_SIZE, STRIP_WIDTH, STRIP_HEIGHT } from '../src/render/canvas.js'
import { theme } from '../src/render/theme.js'
import { StocksPage, type StockReader } from '../src/pages/stocks-page.js'
import { SYMBOLS } from '../src/sources/stocks.js'
import type { MarketState, Quote, YearlyState } from '../src/sources/stocks.js'

/** Walks up to the repository root. This runs both from `scripts/` and from
 * `dist/scripts/`, so a fixed number of `..` segments is wrong for one of them
 * (lesson 2), and `process.cwd()` is wrong under launchd (lesson 3). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('could not find the repository root')
}
const REPO_ROOT = findRepoRoot()

/** Measured live from Yahoo's keyless chart endpoint on 2026-08-18. */
const LIVE: readonly number[] = [-1.10, 0.19, -2.49, 2.33, -1.80, -1.22, -3.47, -0.11]
/** A deliberately dull day: every symbol inside ±0.4 percent. */
const FLAT: readonly number[] = [0.12, -0.08, 0.31, -0.22, 0.04, -0.35, 0.19, -0.14]

const STATES: readonly MarketState[] = ['open', 'pre', 'post', 'closed', 'unknown']

function rgbaToCanvas(buf: Buffer, w: number, h: number): Canvas {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(w, h)
  imageData.data.set(buf)
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

function quoteFor(symbol: string, changePercent: number): Quote {
  const price = 100 + changePercent * 7
  // A gently sloping intraday series, so the sparkline is not flat.
  const spark = Array.from({ length: 24 }, (_, i) => price - changePercent * (1 - i / 23))
  return {
    symbol, name: symbol, price, previousClose: price / (1 + changePercent / 100),
    changePercent, spark, currency: 'USD', asOf: 1786549560,
    dayHigh: price * 1.01, dayLow: price * 0.99,
    week52High: price * 1.4, week52Low: price * 0.7, volume: 1_000_000,
  } as unknown as Quote
}

function pageFor(changes: readonly number[], marketState: MarketState): StocksPage {
  const quotes = new Map<string, Quote>()
  SYMBOLS.forEach((sym, i) => quotes.set(sym, quoteFor(sym, changes[i] ?? 0)))
  const reader = {
    getQuotes: () => quotes,
    getStatus: () => 'ok',
    getMarketState: () => marketState,
    isSymbolStale: () => false,
    getYearlyState: () => ({ status: 'ok', values: [], updatedAt: 0 } as unknown as YearlyState),
    setWatchedSymbol: () => {},
    setVisible: () => {},
  } as unknown as StockReader
  return new StocksPage(reader)
}

const M = 16
const LABEL_W = 96
const TITLE_H = 30
const ROW_LABEL_H = 14
const GAP = 6
const BUTTON_R = 11

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? join(REPO_ROOT, 'stocks-board.png'))

  const boards: readonly { name: string; changes: readonly number[] }[] = [
    { name: 'LIVE (real)', changes: LIVE },
    { name: 'FLAT day', changes: FLAT },
  ]

  const rowH = KEY_SIZE + ROW_LABEL_H + GAP
  const boardH = STATES.length * rowH + STRIP_HEIGHT + 30
  const width = M * 2 + LABEL_W + 8 * (KEY_SIZE + GAP) + BUTTON_R * 3
  const height = TITLE_H + boards.length * (boardH + 24) + M

  const sheet = createCanvas(width, height)
  const ctx = sheet.getContext('2d')
  ctx.fillStyle = 'rgb(24, 24, 28)'
  ctx.fillRect(0, 0, width, height)
  ctx.textBaseline = 'top'

  ctx.fillStyle = `rgb(${theme.text.join(',')})`
  ctx.font = '15px Menlo'
  ctx.fillText('Stocks board — real StocksPage, real renderKey. Two distributions.', M, 10)

  let y = TITLE_H

  for (const board of boards) {
    ctx.fillStyle = `rgb(${theme.amber.join(',')})`
    ctx.font = '13px Menlo'
    const spread = `${Math.min(...board.changes).toFixed(2)}% to +${Math.max(...board.changes).toFixed(2)}%`
    ctx.fillText(`${board.name} — ${spread}`, M, y)
    y += 20

    for (const state of STATES) {
      const page = pageFor(board.changes, state)
      const frame = page.render(1786549560)

      ctx.fillStyle = `rgb(${theme.textDim.join(',')})`
      ctx.font = '10px Menlo'
      ctx.fillText(state, M, y + KEY_SIZE / 2)

      frame.keys.forEach((key, i) => {
        const x = M + LABEL_W + i * (KEY_SIZE + GAP)
        ctx.drawImage(rgbaToCanvas(renderKey(key), KEY_SIZE, KEY_SIZE), x, y)
      })

      // The two round buttons, drawn as the lights they are.
      const bx = M + LABEL_W + 8 * (KEY_SIZE + GAP) + BUTTON_R
      frame.buttons.forEach((rgb, i) => {
        ctx.fillStyle = `rgb(${rgb.join(',')})`
        ctx.beginPath()
        ctx.arc(bx, y + BUTTON_R + i * (BUTTON_R * 2 + 6), BUTTON_R, 0, Math.PI * 2)
        ctx.fill()
      })

      y += rowH
    }

    // One strip, from the open-market board, so the up/down text is visible.
    const openFrame = pageFor(board.changes, 'open').render(1786549560)
    ctx.drawImage(
      rgbaToCanvas(renderStrip(openFrame.strip), STRIP_WIDTH, STRIP_HEIGHT),
      M + LABEL_W, y,
    )
    y += STRIP_HEIGHT + 30
  }

  await writeFile(outPath, sheet.toBuffer('image/png'))
  process.stdout.write(`wrote ${outPath}\n`)
}

await main()
