import { describe, it, expect, beforeAll } from 'vitest'
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import { SpotifyPage, glowFraction, buttonColors } from '../../src/pages/spotify-page.js'
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

describe('Spotify progress glow: placement', () => {
  it('lights the top row and the right column at half way, and nothing else', () => {
    // 10 key edges; half way = the three tops plus both right edges.
    const frame = page({ state: () => player() }).render(NOW, NOW * 1000)
    for (const i of [0, 1, 2]) expect(glowIn(art(frame, i), TOP)).toBeGreaterThanOrEqual(280)
    expect(glowIn(art(frame, 2), RIGHT)).toBeGreaterThan(250)
    expect(glowIn(art(frame, 6), RIGHT)).toBeGreaterThan(250)
    // The bottom row and the left column are still dark. (The bottom box stops
    // short of the right column, where key 6's lit right edge ends.)
    for (const i of [4, 5, 6]) expect(glowIn(art(frame, i), { ...BOTTOM, x1: KEY_SIZE - 4 })).toBe(0)
    for (const i of [0, 4]) expect(glowIn(art(frame, i), LEFT)).toBe(0)
  })

  it('runs clockwise from the top-left: a quarter of the first key edge lights its LEFT end only', () => {
    // 2.5 percent of the perimeter = a quarter of key 0's top edge.
    const frame = page({ state: () => player({ positionMs: 6_250, durationMs: 250_000 }) })
      .render(NOW, NOW * 1000)
    const k0 = art(frame, 0)
    expect(glowIn(k0, { x0: 0, y0: 0, x1: 20, y1: 4 })).toBeGreaterThan(40)
    expect(glowIn(k0, { x0: 30, y0: 0, x1: KEY_SIZE, y1: 4 })).toBe(0)
    for (const i of [1, 2, 4, 5, 6]) expect(glowIn(art(frame, i), { x0: 0, y0: 0, x1: KEY_SIZE, y1: KEY_SIZE })).toBe(0)
  })

  it('traces only the OUTER edge of the block at the very end — never the seams between art keys', () => {
    const frame = page({ state: () => player({ positionMs: 250_000, durationMs: 250_000 }) })
      .render(NOW, NOW * 1000)
    // Every outside edge is lit...
    for (const i of [0, 1, 2]) expect(glowIn(art(frame, i), TOP)).toBeGreaterThanOrEqual(280)
    for (const i of [4, 5, 6]) expect(glowIn(art(frame, i), BOTTOM)).toBeGreaterThanOrEqual(280)
    for (const i of [0, 4]) expect(glowIn(art(frame, i), LEFT)).toBeGreaterThan(250)
    for (const i of [2, 6]) expect(glowIn(art(frame, i), RIGHT)).toBeGreaterThan(250)
    // ...and the inner seams are not: key 1's bottom, key 5's top, key 0's right.
    expect(glowIn(art(frame, 1), BOTTOM)).toBe(0)
    expect(glowIn(art(frame, 5), TOP)).toBe(0)
    expect(glowIn(art(frame, 0), RIGHT)).toBe(0)
    expect(glowIn(art(frame, 5), LEFT)).toBe(0)
  })

  it('draws no glow without real art, while idle, or while unauthorized', () => {
    const cases = [
      page({ state: () => player(), art: null }),
      page({ state: () => null }),
      page({ state: () => null, status: 'unauthorized' }),
    ]
    for (const p of cases) {
      const frame = p.render(NOW, NOW * 1000)
      for (const i of ART_KEYS) expect(frame.keys[i]!.edgeProgress).toBeUndefined()
    }
  })

  it('keeps a paused glow where it stopped, dimmed with the cover, and does not move it', () => {
    const playing = page({ state: () => player() }).render(NOW, NOW * 1000)
    const p = page({ state: () => player({ isPlaying: false }) })
    const a = p.render(NOW, NOW * 1000)
    const b = p.render(NOW + 30, (NOW + 30) * 1000)
    for (const i of ART_KEYS) expect(a.keys[i]!.edgeProgress).toEqual(b.keys[i]!.edgeProgress)
    // Still visible against the dimmed cover, but quieter than while playing.
    const pausedTop = meanRed(art(a, 1), { x0: 0, y0: 0, x1: KEY_SIZE, y1: 3 })
    const pausedBody = meanRed(art(a, 1), { x0: 20, y0: 30, x1: 76, y1: 70 })
    const playingTop = meanRed(art(playing, 1), { x0: 0, y0: 0, x1: KEY_SIZE, y1: 3 })
    expect(pausedTop).toBeGreaterThan(pausedBody + 40)
    expect(pausedTop).toBeLessThan(playingTop - 60)
  })
})

describe('Spotify progress glow: quantisation and write rate', () => {
  it('snaps to at least half a second of track time, and never to less than a pixel', () => {
    // 60 s track: 120 steps. 30 min track: capped at 960 steps (one pixel each).
    expect(glowFraction(30_400, 60_000)).toBe(60 / 120)
    expect(glowFraction(30_499, 60_000)).toBe(glowFraction(30_000, 60_000))
    expect(glowFraction(30_500, 60_000)).toBeGreaterThan(glowFraction(30_499, 60_000))
    const long = 30 * 60_000
    const step = 1 / 960
    expect(glowFraction(long / 2 + 1, long)).toBeCloseTo(0.5, 10)
    expect(glowFraction(long / 2 + long * step - 1, long)).toBe(0.5)
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(glowFraction(1000, bad)).toBe(0)
      expect(glowFraction(bad, 60_000)).toBe(0)
    }
    expect(glowFraction(90_000, 60_000)).toBe(1)
  })

  /**
   * Plays a whole track through the page at the daemon's 100 ms tick and counts
   * how often any ART key's hash changes — each change is one USB key-write.
   *
   * `subSecond` feeds `interpolate` a fractional clock. Today the daemon hands
   * the page whole seconds, which alone caps the glow near one write a second;
   * the fractional case is the worst case, and the one the page's own
   * quantisation must hold by itself.
   */
  function writesOverTrack(durationMs: number, subSecond: boolean): { total: number; worstSecond: number } {
    const startMs = NOW * 1000
    const p = page({
      state: (now) => player({ positionMs: Math.min(durationMs, now * 1000 - startMs), durationMs }),
    })
    const last: (string | null)[] = ART_KEYS.map(() => null)
    const perSecond = new Map<number, number>()
    let total = 0
    for (let t = 0; t <= durationMs; t += 100) {
      const ms = startMs + t
      const frame = p.render(subSecond ? ms / 1000 : Math.floor(ms / 1000), ms)
      ART_KEYS.forEach((k, j) => {
        const h = keyHash(frame.keys[k]!)
        if (last[j] !== null && h !== last[j]) {
          total++
          const s = Math.floor(t / 1000)
          perSecond.set(s, (perSecond.get(s) ?? 0) + 1)
        }
        last[j] = h
      })
    }
    return { total, worstSecond: Math.max(0, ...perSecond.values()) }
  }

  it('costs at most a few art-key writes a second on a short track, even with a sub-second clock', () => {
    // A 60 s track is the hard case: unquantised, its glow moves 1920 half-pixel
    // steps in 60 s and would rewrite a key on every tick.
    const { total, worstSecond } = writesOverTrack(60_000, true)
    expect(worstSecond).toBeLessThanOrEqual(4)
    expect(total / 60).toBeLessThanOrEqual(2.5)
    // And it really does move: one step per half second, every one written.
    expect(total).toBeGreaterThanOrEqual(115)
  })

  it('costs about one art-key write a second at the daemon\'s whole-second clock', () => {
    const { total, worstSecond } = writesOverTrack(240_000, false)
    expect(worstSecond).toBeLessThanOrEqual(2)
    expect(total / 240).toBeLessThanOrEqual(1.1)
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
