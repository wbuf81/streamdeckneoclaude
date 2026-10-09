/**
 * Renders every glow-up render primitive into one contact sheet PNG, so a
 * human can judge the look against the approved mockup before any page uses
 * them. Every cell is a REAL `renderKey` or `renderStrip` buffer.
 *
 * Run with: `npm run build && node dist/scripts/glowup-contact-sheet.js
 * [output-path]`. Defaults to `glowup.png` in the repository root. That file
 * is a preview, not a deliverable — it is not committed.
 *
 * This script changes nothing under `src/` and never opens the device.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas'
import { renderKey, renderStrip, KEY_SIZE, STRIP_WIDTH, STRIP_HEIGHT } from '../src/render/canvas.js'
import { theme } from '../src/render/theme.js'
import { blockPerimeterProgress, breathe } from '../src/render/motion.js'
import type { KeySpec, Rgb, StripSpec } from '../src/render/specs.js'

/** Walks up to the repository root (lesson 2: never a fixed `..` depth). */
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
const SCALE = 2
const GAP = 10
const MARGIN = 16
const LABEL_W = 150

function rgbaToCanvas(buf: Buffer, w: number, h: number): Canvas {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const data = ctx.createImageData(w, h)
  data.data.set(buf)
  ctx.putImageData(data, 0, 0)
  return canvas
}

const key = (spec: KeySpec): Canvas => rgbaToCanvas(renderKey(spec), KEY_SIZE, KEY_SIZE)
const strip = (spec: StripSpec): Canvas => rgbaToCanvas(renderStrip(spec), STRIP_WIDTH, STRIP_HEIGHT)

/** A deterministic intraday series ending at `pct`, like the mockup's. */
function series(pct: number, seed: number, n = 40): number[] {
  const out: number[] = []
  for (let k = 0; k < n; k++) {
    const target = pct * (k / (n - 1))
    const wiggle = (Math.sin(seed * 50 + k * 1.7) * 0.5) * Math.max(0.35, Math.abs(pct) * 0.35) * Math.sin(k / 6 + seed)
    out.push(k === n - 1 ? pct : target + wiggle)
  }
  return out
}

function stockTile(sym: string, price: string, pct: number, seed: number, extra: Partial<KeySpec> = {}): KeySpec {
  const c = pct >= 0 ? theme.green : theme.red
  const text = `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`
  return {
    kind: 'gauge',
    lines: [sym, price, text],
    lineSizes: [11, 11, [19, 17, 15]],
    lineY: [6, 6, 22],
    lineAligns: ['left', 'right', 'center'],
    lineWeights: ['bold', undefined, 'bold'],
    lineColors: [theme.textDim, theme.textDim, c],
    spark: { values: series(pct, seed), color: c, style: 'line', baseline: 0, minHalfRange: 1 },
    ...extra,
  }
}

type Row = { label: string; cells: { canvas: Canvas; caption?: string }[] }

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? join(REPO_ROOT, 'glowup.png'))
  const crabFile = join(REPO_ROOT, 'assets', 'crab', 'idle', '00.png')
  const crab: Image | null = existsSync(crabFile) ? await loadImage(await readFile(crabFile)) : null
  const T = 1_786_549_560_000

  const rows: Row[] = []

  rows.push({
    label: 'stock tiles',
    cells: [
      { canvas: key(stockTile('TSLA', '241.18', -2.14, 0)), caption: 'line, -2.14' },
      { canvas: key(stockTile('NVDA', '188.92', 3.41, 2)), caption: 'line, +3.41' },
      { canvas: key(stockTile('MSFT', '512.40', 0.12, 1)), caption: '0.12, minHalf 1' },
      { canvas: key(stockTile('MSFT', '512.40', 0.12, 1, { spark: { values: series(0.12, 1), color: theme.green, style: 'line', baseline: 0 } })), caption: 'no minHalf' },
      { canvas: key({ kind: 'gauge', lines: ['BARS'], spark: { values: [3, 1, 4, 1, 5, 9, 2, 6], color: theme.green } }), caption: 'bar, min drawn' },
      { canvas: key({ kind: 'gauge', lines: ['5-HR CAP', '62%'], lineSizes: [11, 28], align: 'center', lineWeights: [undefined, 'bold'], bar: { value: 0.62, color: theme.amber } }), caption: 'hero 28 bold' },
    ],
  })

  const gauge = (label: string, lo: number, hi: number, v: number, extra: Partial<KeySpec['range']> = {}): KeySpec => ({
    kind: 'gauge',
    lines: [label, lo.toFixed(1), hi.toFixed(1), `${Math.round(((v - lo) / (hi - lo)) * 100)}% of range`],
    lineSizes: [10, 10, 10, 10],
    lineY: [12, 60, 60, 80],
    lineAligns: ['center', 'left', 'right', 'center'],
    lineColors: [theme.textDim, theme.textDim, theme.textDim, theme.text],
    range: { lo, hi, value: v, gradient: [theme.red, theme.green], ...extra },
  })
  rows.push({
    label: 'range gauge',
    cells: [
      { canvas: key(gauge('DAY RANGE', 238.9, 249.6, 241.18)), caption: 'arrow + gradient' },
      { canvas: key(gauge('52 WEEKS', 138.8, 488.5, 241.18)), caption: '52 wk' },
      { canvas: key(gauge('DAY RANGE', 238.9, 249.6, 241.18, { gradient: undefined, marker: 'tick', color: theme.red, y: 40, height: 5 })), caption: 'tick, plain' },
      { canvas: key(gauge('CLAMP', 10, 20, 99)), caption: 'value > hi' },
      { canvas: key(gauge('FLAT', 10, 10, 10)), caption: 'lo == hi' },
    ],
  })

  const at = (ms: number[], f: (e: number) => KeySpec, unit = 'ms'): Row['cells'] =>
    ms.map((e) => ({ canvas: key(f(e)), caption: `${e} ${unit}` }))
  const tsla = stockTile('TSLA', '241.18', -2.14, 0)
  const nvda = stockTile('NVDA', '188.92', 3.41, 2)
  rows.push({
    label: 'burst',
    cells: at([0, 120, 360, 700, 1100, 1400, 1600], (e) => ({ ...nvda, effects: [{ variant: 'burst', startedAtMs: T, nowMs: T + e }] })),
  })
  rows.push({
    label: 'pop (hero)',
    cells: at([0, 80, 160, 280, 480, 800, 1000], (e) => ({ ...nvda, linePop: { line: 2, startedAtMs: T, nowMs: T + e } })),
  })
  rows.push({
    label: 'brick',
    cells: at([0, 160, 320, 400, 480, 700, 900, 1000], (e) => ({ ...tsla, effects: [{ variant: 'brick', startedAtMs: T, nowMs: T + e }] })),
  })
  const pre: KeySpec = { kind: 'gauge', lines: ['NVDA'], lineWeights: ['bold'], lineColors: [theme.textDim] }
  rows.push({
    label: 'sweep',
    cells: at([0, 100, 200, 300, 400, 500], (e) => ({ ...nvda, effects: [{ variant: 'sweep', startedAtMs: T, nowMs: T + e }] }))
      .concat([{ canvas: key(pre), caption: 'before' }]),
  })

  const crabKey = (extra: Partial<KeySpec>): KeySpec => (crab ? { kind: 'image', image: crab, imageKey: 'crab', ...extra } : { kind: 'blank', ...extra })
  rows.push({
    label: 'crab hop / spin',
    cells: [
      { canvas: key(crabKey({})), caption: 'rest' },
      { canvas: key(crabKey({ imageTransform: { dy: -8 } })), caption: 'dy -8' },
      { canvas: key(crabKey({ imageTransform: { dy: -16 } })), caption: 'dy -16' },
      { canvas: key(crabKey({ imageTransform: { rotateDeg: 90 } })), caption: 'rot 90' },
      { canvas: key(crabKey({ imageTransform: { rotateDeg: 200, dy: -6 } })), caption: 'rot 200' },
      ...at([0, 300, 700, 1100, 1400], (e) => crabKey({ effects: [{ variant: 'hearts', startedAtMs: T, nowMs: T + e }] })),
    ],
  })
  rows.push({
    label: 'hearts x6',
    cells: at([0, 200, 500, 800, 1200], (e) => ({
      kind: 'control', glyph: '♥', glyphColor: [255, 79, 122], bg: [42, 15, 24],
      effects: [{ variant: 'hearts', startedAtMs: T, nowMs: T + e, count: 6, y: 50 }],
    })),
  })

  const label = (text: string, color: Rgb): Partial<KeySpec> => ({
    lines: [text], lineSizes: [9], lineY: [84], align: 'center', lineWeights: ['bold'], lineColors: [color],
  })
  rows.push({
    label: 'bull',
    cells: at([0, 100, 200, 300, 400, 500, 600], (e) => ({ kind: 'gauge', mascot: { kind: 'bull', nowMs: e }, ...label('BULLISH', theme.green) })),
  })
  rows.push({
    label: 'bear',
    cells: at([0, 300, 600, 900, 1200, 1500], (e) => ({ kind: 'gauge', mascot: { kind: 'bear', nowMs: e }, ...label('BEARISH', theme.red) })),
  })

  const wx = (extra: Partial<KeySpec>, bg: Rgb): KeySpec => ({
    kind: 'gauge', bg,
    lines: ['WED', '63°', '20%'],
    lineSizes: [11, 17, 13],
    lineY: [4, 55, 76],
    align: 'center',
    lineWeights: ['bold', 'bold', undefined],
    ...extra,
  })
  rows.push({
    label: 'cloud fx',
    cells: [0, 3000, 6000, 9000, 12000].map((ms) => ({
      canvas: key(wx({ emoji: '☁️', fx: { variant: 'cloud', nowMs: ms, intensity: 0.75, seed: 4 } }, [22, 24, 28])),
      caption: `${ms} ms`,
    })).concat([
      { canvas: key(wx({ emoji: '⛅', fx: { variant: 'cloud', nowMs: 4000, intensity: 0.4, seed: 0 } }, [28, 26, 24])), caption: 'partly 0.4' },
      { canvas: key(wx({ fx: { variant: 'cloud', nowMs: 4000, intensity: 1, seed: 2 } }, [22, 24, 28])), caption: 'layer only' },
    ]),
  })
  rows.push({
    label: 'fog / compass',
    cells: [
      { canvas: key(wx({ emoji: '🌫' }, [28, 28, 30])), caption: 'old emoji' },
      { canvas: key(wx({ icon: { kind: 'fog', nowMs: 0 } }, [28, 28, 30])), caption: 'fog glyph' },
      { canvas: key(wx({ icon: { kind: 'fog', nowMs: 2600 }, fx: { variant: 'fog', nowMs: 2600, intensity: 0.7, seed: 6 } }, [28, 28, 30])), caption: 'fog + fx' },
      ...[0, 45, 135, 225, 300].map((b) => ({
        canvas: key({ kind: 'gauge', icon: { kind: 'compass', bearingDeg: b }, lines: ['12 mph'], lineSizes: [15], lineY: [76], align: 'center', lineWeights: ['bold'] }),
        caption: `${b}°`,
      })),
    ],
  })

  rows.push({
    label: 'breathe',
    cells: [0, 250, 500, 750, 1000, 1250, 1500].map((ms) => {
      const c = breathe([31, 122, 64], ms, 2000, 0.5)
      return { canvas: key({ kind: 'gauge', bg: c, lines: [c.join(',')], lineSizes: [10], align: 'center' }), caption: `${ms} ms` }
    }),
  })

  // The edge-progress line around a 3x2 album block, assembled with real gaps.
  const blocks: Canvas[] = []
  for (const f of [0.1, 0.42, 0.85]) {
    const cells = blockPerimeterProgress(3, 2, f)
    const gapPx = 14
    const c = createCanvas(3 * KEY_SIZE + 2 * gapPx, 2 * KEY_SIZE + gapPx)
    const g = c.getContext('2d')
    g.fillStyle = 'rgb(27,28,32)'
    g.fillRect(0, 0, c.width, c.height)
    for (let r = 0; r < 2; r++) {
      for (let col = 0; col < 3; col++) {
        const tint: Rgb = [140 - r * 50 - col * 20, 40 + col * 6, 70 + r * 20]
        const spec: KeySpec = { kind: 'image', bg: tint }
        const edge = cells[r]![col]
        if (edge) spec.edgeProgress = edge
        g.drawImage(key(spec), col * (KEY_SIZE + gapPx), r * (KEY_SIZE + gapPx))
      }
    }
    blocks.push(c)
  }

  const strips: { canvas: Canvas; caption: string }[] = [
    { canvas: strip({ lines: [], banner: { text: 'WEATHER' } }), caption: 'banner' },
    { canvas: strip({ lines: [], banner: { text: '🔔 OPENING BELL', color: theme.green, size: 16, sub: '9:30 AM EDT · have a good one' } }), caption: 'banner + sub' },
    { canvas: strip({ lines: [], banner: { text: '🔔 OPENING BELL', color: theme.green, size: 16, sub: '9:30 AM EDT', pop: { startedAtMs: T, nowMs: T + 120 } } }), caption: 'banner pop 120 ms' },
    { canvas: strip({ lines: ['CLOSES IN 2h 14m', 'NVDA 188.92 +3.41%'], sprite: { kind: 'crab', x: 40, frame: 0 } }), caption: 'crab frame 0' },
    { canvas: strip({ lines: ['CLOSES IN 2h 14m', 'NVDA 188.92 +3.41%'], sprite: { kind: 'crab', x: 120, frame: 1, dy: -2, say: 'hi!' } }), caption: 'crab frame 1 + say' },
    { canvas: strip({ lines: ['CLOSES IN 2h 14m', 'NVDA 188.92 +3.41%'], sprite: { kind: 'crab', x: 225, frame: 0 } }), caption: 'crab at the edge' },
  ]

  const maxCells = Math.max(...rows.map((r) => r.cells.length))
  const cellW = KEY_SIZE * SCALE
  const rowH = cellW + 22
  const blockW = blocks[0]!.width * SCALE
  const blockH = blocks[0]!.height * SCALE
  const stripW = STRIP_WIDTH * SCALE
  const stripH = STRIP_HEIGHT * SCALE + 22
  const width = Math.max(MARGIN * 2 + LABEL_W + maxCells * (cellW + GAP), MARGIN * 2 + 3 * (blockW + 4 * GAP), MARGIN * 2 + 3 * (stripW + GAP))
  const height = MARGIN * 2 + rows.length * rowH + blockH + 30 + 2 * stripH

  const sheet = createCanvas(width, height)
  const ctx = sheet.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = 'rgb(27,28,32)'
  ctx.fillRect(0, 0, width, height)
  ctx.textBaseline = 'top'

  let y = MARGIN
  for (const row of rows) {
    ctx.fillStyle = 'rgb(235,235,235)'
    ctx.font = '14px Menlo'
    ctx.fillText(row.label, MARGIN, y + cellW / 2 - 8)
    row.cells.forEach((cell, i) => {
      const x = MARGIN + LABEL_W + i * (cellW + GAP)
      ctx.drawImage(cell.canvas, x, y, cellW, cellW)
      if (cell.caption) {
        ctx.fillStyle = 'rgb(140,140,150)'
        ctx.font = '11px Menlo'
        ctx.fillText(cell.caption, x, y + cellW + 4)
      }
    })
    y += rowH
  }
  blocks.forEach((b, i) => ctx.drawImage(b, MARGIN + i * (blockW + 4 * GAP), y, blockW, blockH))
  y += blockH + 30
  strips.forEach((s, i) => {
    const x = MARGIN + (i % 3) * (stripW + GAP)
    const yy = y + Math.floor(i / 3) * stripH
    ctx.drawImage(s.canvas, x, yy, stripW, STRIP_HEIGHT * SCALE)
    ctx.fillStyle = 'rgb(140,140,150)'
    ctx.font = '11px Menlo'
    ctx.fillText(s.caption, x, yy + STRIP_HEIGHT * SCALE + 4)
  })

  await writeFile(outPath, sheet.toBuffer('image/png'))
  process.stdout.write(`wrote ${outPath}\n`)
}

await main()
