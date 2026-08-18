/**
 * Renders the rebuilt Spotify page (task 44) into a contact sheet, so a human can
 * judge the crop, the extracted album colour, and the paused state before any of
 * it reaches the deck. Only the user can see the real device.
 *
 * It renders FOUR synthetic covers on purpose, because one input hides defects —
 * the lesson task 42 paid for:
 *
 * - a colourful cover, for the ordinary case;
 * - a dark cover with one small accent, which an averaging extractor destroys;
 * - a greyscale cover, which must yield no colour at all rather than a fake hue;
 * - a cover with text hard against the top and bottom edges, which is exactly
 *   what the central 3:2 crop sacrifices.
 *
 * Run with: `npm run spotify:contact-sheet -- [output-path]`. Defaults to
 * `spotify-page.png` in the repository root. A preview, not a deliverable.
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas'
import {
  renderKey, renderStrip, dominantColor, KEY_SIZE, STRIP_WIDTH, STRIP_HEIGHT,
} from '../src/render/canvas.js'
import { theme } from '../src/render/theme.js'
import { SpotifyPage, type PlayerReader } from '../src/pages/spotify-page.js'
import type { PlayerState } from '../src/sources/spotify.js'

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

const COVER = 320

type Painter = (ctx: ReturnType<Canvas['getContext']>) => void

const COVERS: readonly { name: string; paint: Painter }[] = [
  {
    name: 'colourful',
    paint: (ctx) => {
      const g = ctx.createLinearGradient(0, 0, COVER, COVER)
      g.addColorStop(0, 'rgb(40, 90, 220)')
      g.addColorStop(1, 'rgb(200, 40, 140)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, COVER, COVER)
      ctx.fillStyle = 'rgb(250, 210, 40)'
      ctx.beginPath()
      ctx.arc(COVER * 0.5, COVER * 0.5, COVER * 0.22, 0, Math.PI * 2)
      ctx.fill()
    },
  },
  {
    name: 'dark + accent',
    paint: (ctx) => {
      ctx.fillStyle = 'rgb(8, 8, 10)'
      ctx.fillRect(0, 0, COVER, COVER)
      ctx.fillStyle = 'rgb(230, 60, 30)'
      ctx.fillRect(0, COVER * 0.46, COVER, COVER * 0.08)
    },
  },
  {
    name: 'greyscale',
    paint: (ctx) => {
      for (let i = 0; i < 10; i++) {
        const v = 25 + i * 22
        ctx.fillStyle = `rgb(${v}, ${v}, ${v})`
        ctx.fillRect(0, (i * COVER) / 10, COVER, COVER / 10)
      }
    },
  },
  {
    name: 'text at edges',
    paint: (ctx) => {
      ctx.fillStyle = 'rgb(20, 120, 100)'
      ctx.fillRect(0, 0, COVER, COVER)
      ctx.fillStyle = 'rgb(255, 255, 255)'
      ctx.font = 'bold 30px Menlo'
      ctx.textBaseline = 'top'
      ctx.fillText('TOP EDGE', 12, 6)
      ctx.textBaseline = 'bottom'
      ctx.fillText('BOTTOM EDGE', 12, COVER - 6)
    },
  },
]

function rgbaToCanvas(buf: Buffer, w: number, h: number): Canvas {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const data = ctx.createImageData(w, h)
  data.data.set(buf)
  ctx.putImageData(data, 0, 0)
  return canvas
}

function playerState(over: Partial<PlayerState> = {}): PlayerState {
  return {
    isPlaying: true, title: 'Everlong', artist: 'Foo Fighters', album: 'The Colour and the Shape',
    positionMs: 96_000, durationMs: 250_000, trackId: 'track-1', artUrl: null,
    shuffle: false, repeat: 'off', volumePercent: 65, hasDevice: true,
    ...over,
  }
}

function pageFor(art: Image | null, colour: readonly number[] | null, state: PlayerState | null): SpotifyPage {
  const reader = {
    interpolate: () => state,
    getStatus: () => 'ok',
    getArt: () => art,
    getArtColor: () => colour,
    play: async () => true,
    pause: async () => true,
    next: async () => true,
    setVisible: () => {},
  } as unknown as PlayerReader
  return new SpotifyPage(reader)
}

const M = 16
const LABEL_W = 122
const GAP = 6
const TITLE_H = 28

async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? join(REPO_ROOT, 'spotify-page.png'))

  const rows: { label: string; page: SpotifyPage; nowMs: number; swatch: readonly number[] | null }[] = []

  for (const cover of COVERS) {
    const canvas = createCanvas(COVER, COVER)
    cover.paint(canvas.getContext('2d'))
    const art = await loadImage(canvas.toBuffer('image/png'))
    const colour = dominantColor(art)
    rows.push({
      label: `${cover.name} · playing`,
      page: pageFor(art, colour, playerState()),
      nowMs: 1_000,
      swatch: colour,
    })
    if (cover.name === 'colourful') {
      rows.push({
        label: `${cover.name} · PAUSED`,
        page: pageFor(art, colour, playerState({ isPlaying: false })),
        nowMs: 1_000,
        swatch: colour,
      })
    }
  }
  // Nothing playing: the matrix rain, now across six keys.
  rows.push({ label: 'idle · matrix rain', page: pageFor(null, null, null), nowMs: 1_000, swatch: null })
  rows.push({ label: 'idle · +400ms', page: pageFor(null, null, null), nowMs: 1_400, swatch: null })

  const rowH = KEY_SIZE + STRIP_HEIGHT + 18
  const width = M * 2 + LABEL_W + 4 * (KEY_SIZE + GAP) + 40
  const height = TITLE_H + rows.length * (rowH + 10) + M

  const sheet = createCanvas(width, height)
  const ctx = sheet.getContext('2d')
  ctx.fillStyle = 'rgb(24, 24, 28)'
  ctx.fillRect(0, 0, width, height)
  ctx.textBaseline = 'top'
  ctx.fillStyle = `rgb(${theme.text.join(',')})`
  ctx.font = '14px Menlo'
  ctx.fillText('Spotify page — real SpotifyPage, real renderKey. 6 keys of art.', M, 8)

  let y = TITLE_H
  for (const row of rows) {
    ctx.fillStyle = `rgb(${theme.textDim.join(',')})`
    ctx.font = '10px Menlo'
    ctx.fillText(row.label, M, y + 4)
    // The extracted colour, as a swatch beside the label.
    if (row.swatch) {
      ctx.fillStyle = `rgb(${row.swatch.join(',')})`
      ctx.fillRect(M, y + 20, 28, 12)
    } else {
      ctx.fillStyle = `rgb(${theme.textDim.join(',')})`
      ctx.font = '9px Menlo'
      ctx.fillText('no colour', M, y + 20)
    }

    const frame = row.page.render(Math.floor(row.nowMs / 1000), row.nowMs)
    // Two rows of four keys.
    for (let i = 0; i < 8; i++) {
      const col = i % 4
      const rrow = Math.floor(i / 4)
      ctx.drawImage(
        rgbaToCanvas(renderKey(frame.keys[i]!), KEY_SIZE, KEY_SIZE),
        M + LABEL_W + col * (KEY_SIZE + GAP),
        y + rrow * (KEY_SIZE + GAP),
      )
    }
    // The round buttons, as the lights they are.
    frame.buttons.forEach((rgb, i) => {
      ctx.fillStyle = `rgb(${rgb.join(',')})`
      ctx.beginPath()
      ctx.arc(M + LABEL_W + 4 * (KEY_SIZE + GAP) + 14, y + 12 + i * 30, 10, 0, Math.PI * 2)
      ctx.fill()
    })
    // And the strip beneath.
    ctx.drawImage(
      rgbaToCanvas(renderStrip(frame.strip), STRIP_WIDTH, STRIP_HEIGHT),
      M + LABEL_W,
      y + 2 * (KEY_SIZE + GAP) + 4,
    )

    y += 2 * (KEY_SIZE + GAP) + STRIP_HEIGHT + 22
  }

  await writeFile(outPath, sheet.toBuffer('image/png'))
  process.stdout.write(`wrote ${outPath}\n`)
}

await main()
