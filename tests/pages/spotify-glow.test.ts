import { describe, it, expect, beforeAll } from 'vitest'
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import { SpotifyPage, barPulseColor, buttonColors } from '../../src/pages/spotify-page.js'
import type { PlayerState, SpotifyStatus } from '../../src/sources/spotify.js'
import type { DeckFrame, Rgb } from '../../src/render/specs.js'
import { keyHash } from '../../src/render/specs.js'
import { renderKey, KEY_SIZE } from '../../src/render/canvas.js'
import { theme } from '../../src/render/theme.js'

const NOW = 1786549560
const ART_KEYS = [0, 1, 2, 4, 5, 6] as const
/** A dark blue cover, so the warm glow stands clear of it in every probe. */
const COVER: Rgb = [30, 50, 140]

function player(over: Partial<PlayerState> = {}): PlayerState {
  return {
    isPlaying: true, title: 'Everlong', artist: 'Foo Fighters',
    album: 'The Colour and the Shape', positionMs: 125_000, durationMs: 250_000,
    trackId: 'track-1', artUrl: 'https://i/mid.jpg', shuffle: false,
    repeat: 'off', volumePercent: 55, hasDevice: true, ...over,
  }
}

let realArt: Image
beforeAll(async () => {
  const c = createCanvas(64, 64)
  const ctx = c.getContext('2d')
  ctx.fillStyle = `rgb(${COVER.join(',')})`
  ctx.fillRect(0, 0, 64, 64)
  realArt = await loadImage(c.toBuffer('image/png'))
})

interface Reader {
  state: (now: number) => PlayerState | null
  status?: SpotifyStatus
  art?: Image | null
  color?: Rgb | null
  accent?: Rgb | null | 'absent'
}

function page(r: Reader): SpotifyPage {
  const source: Record<string, unknown> = {
    interpolate: (now: number) => r.state(now),
    getStatus: () => r.status ?? 'ok',
    getArt: () => (r.art === undefined ? realArt : r.art),
    getArtColor: () => r.color ?? null,
    play: async () => true,
    pause: async () => true,
    next: async () => true,
    setVisible: () => {},
  }
  if (r.accent !== 'absent') source.getArtAccent = () => r.accent ?? null
  return new SpotifyPage(source as never)
}

type Box = { x0: number; y0: number; x1: number; y1: number }
const TOP: Box = { x0: 0, y0: 0, x1: KEY_SIZE, y1: 4 }
const BOTTOM: Box = { x0: 0, y0: KEY_SIZE - 4, x1: KEY_SIZE, y1: KEY_SIZE }
const LEFT: Box = { x0: 0, y0: 4, x1: 4, y1: KEY_SIZE - 4 }
const RIGHT: Box = { x0: KEY_SIZE - 4, y0: 4, x1: KEY_SIZE, y1: KEY_SIZE - 4 }

/** Warm-glow pixels in a region: red well above the blue cover's red, and red
 * at least as strong as blue. The cover itself never passes. */
function glowIn(buf: Buffer, box: Box, minRed = 180): number {
  let n = 0
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const at = (y * KEY_SIZE + x) * 4
      const r = buf[at]!
      const b = buf[at + 2]!
      if (r >= minRed && r >= b) n++
    }
  }
  return n
}

/** Mean red channel in a region — a brightness measure for the dimmed glow. */
function meanRed(buf: Buffer, box: Box): number {
  let sum = 0
  let n = 0
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      sum += buf[(y * KEY_SIZE + x) * 4]!
      n++
    }
  }
  return sum / n
}

function art(frame: DeckFrame, index: number): Buffer {
  return renderKey(frame.keys[index]!)
}

describe('Spotify: no border on the art, a faint pulse on the strip bar', () => {
  it('draws no progress line on any art key, playing or paused', () => {
    for (const isPlaying of [true, false]) {
      const frame = page({ state: () => player({ isPlaying }) }).render(NOW, NOW * 1000)
      for (const k of ART_KEYS) expect(frame.keys[k]!.edgeProgress).toBeUndefined()
    }
  })

  it('breathes the bar colour while playing, never brighter than the accent', () => {
    const RED: Rgb = [200, 50, 40]
    const p = page({ state: () => player(), color: RED })
    const seen = new Set<string>()
    for (let ms = 0; ms < 2400; ms += 200) {
      const c = p.render(NOW, NOW * 1000 + ms).strip.bar!.color!
      seen.add(c.join(','))
      for (let i = 0; i < 3; i++) expect(c[i]!).toBeLessThanOrEqual(RED[i]!)
      expect(c[0]!).toBeGreaterThanOrEqual(Math.floor(RED[0] * 0.6))
    }
    expect(seen.size).toBeGreaterThan(3)
  })

  it('holds the bar still when paused, stale, or with a bad clock', () => {
    const RED: Rgb = [200, 50, 40]
    const paused = page({ state: () => player({ isPlaying: false }), color: RED })
    expect(paused.render(NOW, NOW * 1000 + 600).strip.bar!.color).toEqual(RED)
    expect(barPulseColor(RED, Number.NaN, true)).toEqual(RED)
    expect(barPulseColor(RED, 1234, false)).toEqual(RED)
  })

  it('changes the bar at most five times a second', () => {
    const p = page({ state: () => player() , color: [200, 50, 40] })
    let changes = 0
    let last = ''
    for (let ms = 0; ms < 10_000; ms += 20) {
      const c = p.render(NOW, NOW * 1000 + ms).strip.bar!.color!.join(',')
      if (last && c !== last) changes++
      last = c
    }
    expect(changes / 10).toBeLessThanOrEqual(5)
  })
})

describe('Spotify round buttons: two album colours', () => {
  const RED: Rgb = [200, 50, 40]
  const TEAL: Rgb = [30, 170, 160]

  it('shows the dominant colour left and the contrasting accent right, steady while paused', () => {
    const p = page({ state: () => player({ isPlaying: false }), color: RED, accent: TEAL })
    expect(p.render(NOW, 1_000).buttons).toEqual([RED, TEAL])
    expect(p.render(NOW, 3_700).buttons).toEqual([RED, TEAL])
  })

  it('falls back to the old colours: dominant twice without an accent, the theme without art colour', () => {
    const paused = (): PlayerState => player({ isPlaying: false })
    expect(page({ state: paused, color: RED, accent: null }).render(NOW, 0).buttons).toEqual([RED, RED])
    expect(page({ state: paused, color: RED, accent: 'absent' }).render(NOW, 0).buttons).toEqual([RED, RED])
    expect(page({ state: paused, color: null, accent: TEAL }).render(NOW, 0).buttons).toEqual([theme.gray, theme.gray])
    expect(page({ state: () => null }).render(NOW, 0).buttons).toEqual([theme.gray, theme.gray])
    // An accent alone, with no dominant, is not a palette: both stay on the theme.
    expect(buttonColors(null, TEAL, false, 0)).toEqual([theme.gray, theme.gray])
    expect(buttonColors(null, TEAL, true, 1_234)).toEqual(buttonColors(null, null, true, 1_234))
  })

  it('breathes gently while playing: never below 75 percent, and the pair out of step', () => {
    const p = page({ state: () => player(), color: RED, accent: TEAL })
    const seen = new Set<string>()
    for (let ms = 0; ms < 5_000; ms += 100) {
      const [l, r] = p.render(NOW, ms).buttons
      for (let c = 0; c < 3; c++) {
        expect(l[c]!).toBeLessThanOrEqual(RED[c]!)
        expect(l[c]!).toBeGreaterThanOrEqual(Math.floor(RED[c]! * 0.75))
        expect(r[c]!).toBeGreaterThanOrEqual(Math.floor(TEAL[c]! * 0.75))
      }
      seen.add(l.join(','))
    }
    expect(seen.size).toBeGreaterThan(5)
    // Half a cycle apart: when the left is at full strength, the right is at its dimmest.
    const [l0, r0] = p.render(NOW, 0).buttons
    expect(l0).toEqual(RED)
    expect(r0[1]!).toBeLessThan(TEAL[1]! * 0.8)
  })

  it('changes each button at most five times a second, so the backlights stay cheap', () => {
    let writes = 0
    let last: string | null = null
    for (let ms = 0; ms < 10_000; ms += 40) {
      const pair = buttonColors([200, 50, 40], [30, 170, 160], true, ms).map((c) => c.join(',')).join('|')
      if (last !== null && pair !== last) writes++
      last = pair
    }
    // 10 s at a 200 ms quantum: at most 50 changes of the pair.
    expect(writes).toBeLessThanOrEqual(50)
    expect(writes).toBeGreaterThan(20)
  })

  it('holds steady behind stale data, like every other moving part of the page', () => {
    const p = page({ state: () => player(), status: 'no-device', color: RED, accent: TEAL })
    expect(p.render(NOW, 1_000).buttons).toEqual([RED, TEAL])
    expect(p.render(NOW, 3_300).buttons).toEqual([RED, TEAL])
  })
})
