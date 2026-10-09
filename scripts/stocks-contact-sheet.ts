/**
 * Renders the stocks page into contact sheets, so a human can judge the glow
 * before it reaches the deck. Only the user can see the real device.
 *
 * Every scene drives the REAL `StocksPage` through the real `renderKey` and
 * `renderStrip`, with a fixed clock — including the moments that need a
 * watched transition (the bells, a +2 % crossing), which it reaches by
 * rendering the frame before and the frame after.
 *
 * Run with: `npm run stocks:contact-sheet -- [output-path]`. Writes the deck
 * sheet there and `-tape.png` beside it. A preview, not a deliverable.
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import { renderKey, renderStrip, KEY_SIZE, STRIP_WIDTH, STRIP_HEIGHT } from '../src/render/canvas.js'
import { theme } from '../src/render/theme.js'
import type { DeckFrame } from '../src/render/specs.js'
import { StocksPage } from '../src/pages/stocks-page.js'
import type { MarketBoundary, MarketState } from '../src/sources/stocks.js'
import { DEFAULT_SYMBOLS } from '../src/config.js'
import { fixtureQuote, fixtureQuotes, fixtureReader, FIXTURE_SYMBOLS } from './stocks-fixture.js'

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

/** 2026-08-12 11:46 AM EDT, a Wednesday mid-session. */
const NOW = 1786549560
const NOW_MS = NOW * 1000
/** 9:30 AM and 4:00 PM EDT on the same day. */
const OPEN_MS = NOW_MS - (2 * 60 + 16) * 60_000
const CLOSE_MS = OPEN_MS + 390 * 60_000

function toCanvas(buf: Buffer, w: number, h: number): Canvas {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(w, h)
  img.data.set(buf)
  ctx.putImageData(img, 0, 0)
  return canvas
}

const GAP = 6
const DECK_W = 4 * KEY_SIZE + 3 * GAP
const DECK_H = 2 * KEY_SIZE + GAP + 10 + STRIP_HEIGHT
const BUTTON_R = 12

/** One deck: 4 x 2 keys, then the two round buttons either side of the
 * strip, as the Neo lays them out. */
function drawDeck(ctx: SKRSContext2D, frame: DeckFrame, x: number, y: number): void {
  frame.keys.slice(0, 8).forEach((key, i) => {
    const kx = x + (i % 4) * (KEY_SIZE + GAP)
    const ky = y + Math.floor(i / 4) * (KEY_SIZE + GAP)
    ctx.drawImage(toCanvas(renderKey(key), KEY_SIZE, KEY_SIZE), kx, ky)
  })
  const sy = y + 2 * KEY_SIZE + GAP + 10
  const sx = x + (DECK_W - STRIP_WIDTH) / 2
  ctx.drawImage(toCanvas(renderStrip(frame.strip), STRIP_WIDTH, STRIP_HEIGHT), sx, sy)
  frame.buttons.forEach((rgb, i) => {
    ctx.fillStyle = `rgb(${rgb.join(',')})`
    ctx.beginPath()
    const bx = i === 0 ? x + 34 : x + DECK_W - 34
    ctx.arc(bx, sy + STRIP_HEIGHT / 2, BUTTON_R, 0, Math.PI * 2)
    ctx.fill()
  })
}

interface Scene { label: string; frame: DeckFrame }

function boundary(kind: MarketBoundary['kind'], atMs: number, next: MarketState): MarketBoundary {
  return { kind, atMs, next }
}

function scenes(): Scene[] {
  const out: Scene[] = []
  const closeB = boundary('close', CLOSE_MS, 'post')

  // The board, three rotating facts.
  for (const [i, label] of ['open · fact 1 (countdown)', 'open · fact 2 (breadth)', 'open · fact 3 (clock)'].entries()) {
    const page = new StocksPage(fixtureReader({ asOf: NOW, boundary: closeB }))
    const t = Math.floor(NOW_MS / 24_000) * 24_000 + i * 8000 + 200
    out.push({ label, frame: page.render(Math.floor(t / 1000), t) })
  }

  // A peek, and the detail view (two presses).
  {
    const page = new StocksPage(fixtureReader({ asOf: NOW, boundary: closeB }))
    page.render(NOW, NOW_MS)
    page.onKeyPress(2)
    out.push({ label: 'peek on key 3 (first press)', frame: page.render(NOW, NOW_MS + 40) })
    page.onKeyPress(4)
    out.push({ label: 'peek with no volume (key 5)', frame: page.render(NOW, NOW_MS + 80) })
    page.onKeyPress(2)
    out.push({ label: 'detail (second press)', frame: page.render(NOW, NOW_MS + 120) })
    page.onKeyPress(5)
    out.push({ label: 'detail · chart press → 52 WK', frame: page.render(NOW, NOW_MS + 160) })
  }

  // The opening bell, watched across 9:30.
  for (const dt of [150, 450, 1200]) {
    let state: MarketState = 'pre'
    const page = new StocksPage(fixtureReader({
      asOf: NOW, marketState: () => state,
      boundary: () => (state === 'pre' ? boundary('open', OPEN_MS, 'open') : closeB),
    }))
    page.render(0, OPEN_MS - 1000)
    state = 'open'
    page.render(0, OPEN_MS)
    out.push({ label: `opening bell +${dt} ms`, frame: page.render(0, OPEN_MS + dt) })
  }

  // A big move each way: SPY crosses −2 %, AAPL crosses +2 %.
  for (const dt of [250, 600]) {
    const quotes = fixtureQuotes(NOW, [-1.9, 0.42, 1.95, 1.07, -0.38, 0.88])
    const page = new StocksPage(fixtureReader({ asOf: NOW, quotes, boundary: closeB }))
    page.render(NOW, NOW_MS)
    const sym = FIXTURE_SYMBOLS
    quotes.set(sym[0]!, fixtureQuote(sym[0]!, -2.14, 241.18, 0, NOW))
    quotes.set(sym[2]!, fixtureQuote(sym[2]!, 2.07, 188.92, 2, NOW))
    page.render(NOW, NOW_MS + 1000)
    out.push({ label: `big moves +${dt} ms`, frame: page.render(NOW, NOW_MS + 1000 + dt) })
  }

  // The closing bell, then the summary.
  for (const [dt, label] of [[300, 'closing bell +300 ms'], [5 * 60_000, 'closed summary +5 min'], [5 * 60_000 + 4000, 'closed summary +5 min 4 s']] as const) {
    let state: MarketState = 'open'
    const page = new StocksPage(fixtureReader({
      asOf: NOW, marketState: () => state,
      boundary: () => (state === 'open' ? closeB : boundary('post-end', CLOSE_MS + 4 * 3600_000, 'closed')),
    }))
    page.render(0, CLOSE_MS - 1000)
    state = 'post'
    page.render(0, CLOSE_MS)
    // Keep the watch continuous up to the sampled instant.
    for (let t = CLOSE_MS; t < CLOSE_MS + dt; t += 4000) page.render(0, t)
    out.push({ label, frame: page.render(0, CLOSE_MS + dt) })
  }

  // Quiet and edge boards.
  {
    const quotes = fixtureQuotes(NOW, [0.12, -0.08, 0.31, -0.22, 0.04, -0.35])
    out.push({ label: 'flat day (±0.35 %)', frame: new StocksPage(fixtureReader({ asOf: NOW, quotes, boundary: closeB })).render(NOW, NOW_MS) })
  }
  {
    const quotes = fixtureQuotes(NOW, [-1.2, -0.4, -2.6, 0.3, -0.9, -1.1])
    const frame = new StocksPage(fixtureReader({ asOf: NOW, quotes, marketState: 'closed' })).render(NOW, NOW_MS)
    out.push({ label: 'red day, closed (bear)', frame })
  }
  {
    const syms = DEFAULT_SYMBOLS.slice(0, 7)
    const quotes = fixtureQuotes(NOW)
    quotes.set(syms[6]!, fixtureQuote(syms[6]!, 0.6, 180.4, 6, NOW))
    out.push({ label: '7 symbols: mascot only', frame: new StocksPage(fixtureReader({ asOf: NOW, quotes, symbols: syms, boundary: closeB })).render(NOW, NOW_MS) })
  }
  {
    const syms = DEFAULT_SYMBOLS.slice(0, 8)
    const quotes = fixtureQuotes(NOW)
    quotes.set(syms[6]!, fixtureQuote(syms[6]!, 0.6, 180.4, 6, NOW))
    quotes.set(syms[7]!, fixtureQuote(syms[7]!, -12.34, 1234.56, 7, NOW))
    out.push({ label: '8 symbols, −12.34 % hero', frame: new StocksPage(fixtureReader({ asOf: NOW, quotes, symbols: syms, boundary: closeB })).render(NOW, NOW_MS) })
  }
  return out
}

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? join(REPO_ROOT, 'stocks-board.png'))
  const list = scenes()
  const cols = 3
  const cellW = DECK_W + 40
  const cellH = DECK_H + 34
  const rows = Math.ceil(list.length / cols)
  const sheet = createCanvas(cols * cellW + 20, rows * cellH + 20)
  const ctx = sheet.getContext('2d')
  ctx.fillStyle = 'rgb(24, 24, 28)'
  ctx.fillRect(0, 0, sheet.width, sheet.height)
  ctx.textBaseline = 'top'
  list.forEach((scene, i) => {
    const x = 20 + (i % cols) * cellW
    const y = 10 + Math.floor(i / cols) * cellH
    ctx.fillStyle = `rgb(${theme.amber.join(',')})`
    ctx.font = '13px Menlo'
    ctx.fillText(scene.label, x, y)
    drawDeck(ctx, scene.frame, x, y + 20)
  })
  await writeFile(outPath, sheet.toBuffer('image/png'))
  process.stdout.write(`wrote ${outPath}\n`)

  // The tape across two of its live cycles, every 200 ms: the hold should
  // show a whole quote at the left edge, the scroll a short eased glide.
  const page = new StocksPage(fixtureReader({ asOf: NOW, boundary: boundary('close', CLOSE_MS, 'post') }))
  const base = Math.floor(NOW_MS / 15_600) * 15_600
  const samples = Array.from({ length: 27 }, (_, k) => k * 200)
  const tape = createCanvas(STRIP_WIDTH + 140, samples.length * (STRIP_HEIGHT + 6) + 20)
  const tctx = tape.getContext('2d')
  tctx.fillStyle = 'rgb(24, 24, 28)'
  tctx.fillRect(0, 0, tape.width, tape.height)
  tctx.textBaseline = 'top'
  samples.forEach((dt, k) => {
    const frame = page.render(0, base + dt)
    tctx.drawImage(toCanvas(renderStrip(frame.strip), STRIP_WIDTH, STRIP_HEIGHT), 10, 10 + k * (STRIP_HEIGHT + 6))
    tctx.fillStyle = `rgb(${theme.textDim.join(',')})`
    tctx.font = '11px Menlo'
    tctx.fillText(`+${dt} ms  off ${frame.strip.tape?.offsetPx ?? '-'}`, STRIP_WIDTH + 18, 30 + k * (STRIP_HEIGHT + 6))
  })
  const tapePath = outPath.replace(/\.png$/, '-tape.png')
  await writeFile(tapePath, tape.toBuffer('image/png'))
  process.stdout.write(`wrote ${tapePath}\n`)
}

await main()
