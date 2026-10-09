import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import { contrastAccent, sampleCover } from '../../src/sources/spotify-palette.js'
import { SpotifySource } from '../../src/sources/spotify.js'
import { dominantColor } from '../../src/render/canvas.js'
import type { Rgb } from '../../src/render/specs.js'

/** A cover drawn as horizontal bands, `[colour, share]`, encoded to PNG and
 * decoded again — so every test reads real decoded pixels, as the source does. */
async function cover(bands: readonly [string, number][]): Promise<{ img: Image; png: Buffer }> {
  const size = 280
  const c = createCanvas(size, size)
  const ctx = c.getContext('2d')
  let y = 0
  for (const [colour, share] of bands) {
    const h = Math.round(size * share)
    ctx.fillStyle = colour
    ctx.fillRect(0, y, size, h)
    y += h
  }
  const png = c.toBuffer('image/png')
  return { img: await loadImage(png), png }
}

async function palette(bands: readonly [string, number][]): Promise<{ dominant: Rgb | null; accent: Rgb | null }> {
  const { img } = await cover(bands)
  const dominant = dominantColor(img)
  const pixels = sampleCover(img)
  return { dominant, accent: dominant && pixels ? contrastAccent(pixels, dominant) : null }
}

const near = (c: Rgb | null, want: Rgb, tol = 12): boolean =>
  c !== null && c.every((v, i) => Math.abs(v - want[i]!) <= tol)

describe('contrastAccent: the second album colour', () => {
  it('picks the other hue on a two-colour cover', async () => {
    const { dominant, accent } = await palette([['rgb(200,50,40)', 0.6], ['rgb(30,170,160)', 0.4]])
    expect(near(dominant, [200, 50, 40])).toBe(true)
    expect(near(accent, [30, 170, 160])).toBe(true)
  })

  it('prefers a contrasting HUE over a more common shade of the dominant', async () => {
    // Dark red, a big lighter red, and a smaller blue: the blue wins, because a
    // second red would read as the same colour on the button.
    const { dominant, accent } = await palette([
      ['rgb(170,30,30)', 0.45], ['rgb(240,120,120)', 0.35], ['rgb(40,80,200)', 0.2],
    ])
    expect(near(dominant, [170, 30, 30])).toBe(true)
    expect(near(accent, [40, 80, 200])).toBe(true)
  })

  it('falls back to a much brighter or darker shade on a one-hue cover', async () => {
    const { accent } = await palette([['rgb(150,20,20)', 0.6], ['rgb(250,140,140)', 0.4]])
    expect(near(accent, [250, 140, 140])).toBe(true)
  })

  it('returns null for a flat cover, never an invented colour', async () => {
    const { dominant, accent } = await palette([['rgb(200,50,40)', 1]])
    expect(dominant).not.toBeNull()
    expect(accent).toBeNull()
  })

  it('ignores black, white and grey, however much of the cover they fill', async () => {
    // A green dominant, so a grey (hue 0) would count as a contrasting hue if
    // the grey filter ever let it in.
    const { dominant, accent } = await palette([
      ['rgb(40,180,60)', 0.3], ['rgb(5,5,5)', 0.3], ['rgb(250,250,250)', 0.2], ['rgb(128,128,128)', 0.2],
    ])
    expect(near(dominant, [40, 180, 60])).toBe(true)
    expect(accent).toBeNull()
  })

  it('ignores a sliver of colour too small to matter', async () => {
    // One percent of the cover is under the two-percent floor.
    const { accent } = await palette([['rgb(200,50,40)', 0.99], ['rgb(30,170,160)', 0.01]])
    expect(accent).toBeNull()
  })

  it('needs at least two percent of the counted pixels before a colour can be the accent', () => {
    // Built as a raw pixel array, because a sliver on a real cover blurs away in
    // the 28 px downscale before the floor is ever consulted.
    const pixels = (accentCount: number): Uint8ClampedArray => {
      const n = 1000
      const out = new Uint8ClampedArray(n * 4)
      for (let i = 0; i < n; i++) {
        out.set(i < accentCount ? [30, 170, 160, 255] : [200, 50, 40, 255], i * 4)
      }
      return out
    }
    expect(contrastAccent(pixels(10), [200, 50, 40])).toBeNull()
    expect(contrastAccent(pixels(20), [200, 50, 40])).toEqual([30, 170, 160])
  })

  it('survives an empty or transparent pixel array', () => {
    expect(contrastAccent(new Uint8ClampedArray(0), [200, 50, 40])).toBeNull()
    expect(contrastAccent(new Uint8ClampedArray(4 * 16), [200, 50, 40])).toBeNull()
  })
})

describe('SpotifySource.getArtAccent', () => {
  let artDir: string | null = null
  afterEach(() => {
    if (artDir) rmSync(artDir, { recursive: true, force: true })
    artDir = null
  })

  it('extracts both colours once, at decode time, from the real cover', async () => {
    const { png } = await cover([['rgb(200,50,40)', 0.6], ['rgb(30,170,160)', 0.4]])
    artDir = mkdtempSync(join(tmpdir(), 'deckd-palette-'))
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, headers: { get: () => null }, json: async () => ({}),
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    }))
    const store = { load: () => null, save: vi.fn(), clear: vi.fn() }
    const src = new SpotifySource('cid', store as never, fetchFn as never, () => 1000, loadImage, artDir)

    expect(src.getArtAccent('track-1')).toBeNull()
    const changed = new Promise<void>((resolve) => src.once('change', resolve))
    src.getArt('track-1', 'https://art/track-1.png')
    await changed
    expect(near(src.getArtColor('track-1'), [200, 50, 40])).toBe(true)
    expect(near(src.getArtAccent('track-1'), [30, 170, 160])).toBe(true)
    expect(src.getArtAccent('')).toBeNull()
  })
})
