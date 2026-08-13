import { describe, it, expect } from 'vitest'
import { SpotifyPage } from '../../src/pages/spotify-page.js'
import type { PlayerState, SpotifyStatus } from '../../src/sources/spotify.js'
import { renderKey } from '../../src/render/canvas.js'
import type { Image } from '@napi-rs/canvas'

const NOW = 1786549560

function player(over: Partial<PlayerState> = {}): PlayerState {
  return {
    isPlaying: true, title: 'Planet Caravan', artist: 'Black Sabbath',
    album: 'Paranoid', positionMs: 134000, durationMs: 272000,
    trackId: 'track-1', artUrl: 'https://i/mid.jpg', shuffle: true,
    repeat: 'context', volumePercent: 55, hasDevice: true, ...over,
  }
}

/**
 * A stand-in for a decoded image. The page only passes it through to the
 * KeySpec, so it never touches the image's contents.
 */
const FAKE_ART = { width: 300, height: 300 } as unknown as Image

function build(state: PlayerState | null, status: SpotifyStatus = 'ok', art: Image | null = null) {
  const calls: string[] = []
  const source = {
    interpolate: () => state,
    getStatus: () => status,
    getArt: () => art,
    play: async () => { calls.push('play'); return true },
    pause: async () => { calls.push('pause'); return true },
    next: async () => { calls.push('next'); return true },
    previous: async () => { calls.push('previous'); return true },
    setVolume: async (p: number) => { calls.push(`volume:${p}`); return true },
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
  }
  return { page: new SpotifyPage(source as never), calls }
}

describe('SpotifyPage layout', () => {
  it('returns 8 keys', () => {
    const { page } = build(player())
    expect(page.render(NOW).keys).toHaveLength(8)
  })

  it('spans the album art across keys 0, 1, 4 and 5 with one shared imageKey', () => {
    const { page } = build(player(), 'ok', FAKE_ART)
    const keys = page.render(NOW).keys
    for (const i of [0, 1, 4, 5]) {
      expect(keys[i]!.kind).toBe('image')
      expect(keys[i]!.image).toBe(FAKE_ART)
      expect(keys[i]!.imageKey).toBe('track-1')
    }
  })

  it('gives keys 0, 1, 4 and 5 the four distinct quadrant crops', () => {
    const { page } = build(player(), 'ok', FAKE_ART)
    const keys = page.render(NOW).keys
    expect(keys[0]!.imageCrop).toEqual({ sx: 0.0, sy: 0.0, sw: 0.5, sh: 0.5 })
    expect(keys[1]!.imageCrop).toEqual({ sx: 0.5, sy: 0.0, sw: 0.5, sh: 0.5 })
    expect(keys[4]!.imageCrop).toEqual({ sx: 0.0, sy: 0.5, sw: 0.5, sh: 0.5 })
    expect(keys[5]!.imageCrop).toEqual({ sx: 0.5, sy: 0.5, sw: 0.5, sh: 0.5 })
    // All four crops must be pairwise distinct, or three quadrants would
    // share a hash with a fourth and never redraw independently.
    const crops = [0, 1, 4, 5].map((i) => JSON.stringify(keys[i]!.imageCrop))
    expect(new Set(crops).size).toBe(4)
  })

  it('shows the album-name fallback on key 0 only when art is absent, and leaves 1, 4, 5 blank', () => {
    const { page } = build(player(), 'ok', null)
    const keys = page.render(NOW).keys
    expect(keys[0]!.kind).not.toBe('image')
    expect(keys[0]!.lines!.join(' ')).toContain('Paranoid'.slice(0, 10))
    for (const i of [1, 4, 5]) {
      expect(keys[i]!.kind).toBe('blank')
      expect(keys[i]!.image).toBeUndefined()
    }
  })

  it('shows SIGN IN on key 0 when unauthorized, and leaves 1, 4, 5 blank with no animation', () => {
    const { page } = build(null, 'unauthorized')
    const keys = page.render(NOW).keys
    expect(keys[0]!.lines!.join(' ')).toContain('SIGN IN')
    expect(keys[0]!.pulse).toBeUndefined()
    for (const i of [1, 4, 5]) {
      expect(keys[i]!.kind).toBe('blank')
      expect(keys[i]!.pulse).toBeUndefined()
    }
  })

  it('shows a pause glyph on key 2 while playing', () => {
    const { page } = build(player({ isPlaying: true }))
    expect(page.render(NOW).keys[2]!.glyph).toBe('❙❙')
  })

  it('shows a play glyph on key 2 while paused', () => {
    const { page } = build(player({ isPlaying: false }))
    expect(page.render(NOW).keys[2]!.glyph).toBe('▶')
  })

  it('shows the previous-track glyph on key 6 and the next-track glyph on key 7', () => {
    const { page } = build(player())
    const keys = page.render(NOW).keys
    expect(keys[6]!.glyph).toBe('◀◀')
    expect(keys[7]!.glyph).toBe('▶▶')
  })

  it('shows VOL + and the current percent on key 3', () => {
    const { page } = build(player({ volumePercent: 55 }))
    const key = page.render(NOW).keys[3]!
    expect(key.lines!.join(' ')).toContain('VOL +')
    expect(key.lines!.join(' ')).toContain('55')
  })

  it('shows a placeholder on key 3 when the volume is unknown', () => {
    const { page } = build(player({ volumePercent: null }))
    const key = page.render(NOW).keys[3]!
    expect(key.lines!.join(' ')).not.toMatch(/\d/)
  })

  it('dims keys 2, 3, 6 and 7 when there is no device', () => {
    const { page } = build(null, 'no-device')
    const keys = page.render(NOW).keys
    expect(keys[2]!.dim).toBe(true)
    expect(keys[3]!.dim).toBe(true)
    expect(keys[6]!.dim).toBe(true)
    expect(keys[7]!.dim).toBe(true)
  })

  it('does not render shuffle or repeat anywhere on the deck', () => {
    const { page } = build(player())
    const keys = page.render(NOW).keys
    const allLines = keys.flatMap((k) => k.lines ?? []).join(' ').toUpperCase()
    expect(allLines).not.toContain('SHUFFLE')
    expect(allLines).not.toContain('REPEAT')
  })
})

describe('SpotifyPage idle equaliser (nothing playing)', () => {
  it('gives keys 0, 1, 4 and 5 a pulse spec, and no lines, glyph or image', () => {
    const { page } = build(null, 'no-device')
    const keys = page.render(NOW).keys
    for (const i of [0, 1, 4, 5]) {
      expect(keys[i]!.pulse).toBeDefined()
      expect(keys[i]!.lines).toBeUndefined()
      expect(keys[i]!.glyph).toBeUndefined()
      expect(keys[i]!.image).toBeUndefined()
    }
  })

  it('gives the four idle keys four different phases at the same instant', () => {
    const { page } = build(null, 'no-device')
    const keys = page.render(NOW, 5000).keys
    const phases = [0, 1, 4, 5].map((i) => keys[i]!.pulse!.phase)
    expect(new Set(phases).size).toBe(4)
  })

  it('advances the phase as nowMs advances', () => {
    const { page } = build(null, 'no-device')
    const phaseAt = (nowMs: number) => page.render(NOW, nowMs).keys[0]!.pulse!.phase
    expect(phaseAt(0)).not.toBe(phaseAt(2000))
  })

  it('never calls Date.now(): the same nowMs always produces the same phase', () => {
    const { page } = build(null, 'no-device')
    const a = page.render(NOW, 12345).keys[0]!.pulse!.phase
    const b = page.render(NOW, 12345).keys[0]!.pulse!.phase
    expect(a).toBe(b)
  })

  // Lesson 17: measure the actual rendered pixels, not just the spec fields.
  // A render at two different clocks must produce two different key buffers,
  // proving the bars themselves move, not just some inert number in the spec.
  it('renders visibly different pixels for the same key at two different clocks', () => {
    const { page } = build(null, 'no-device')
    const bufA = renderKey(page.render(NOW, 0).keys[0]!)
    const bufB = renderKey(page.render(NOW, 1000).keys[0]!)
    expect(bufA.equals(bufB)).toBe(false)
  })

  // And the four keys, rendered at the SAME clock, must differ from each
  // other too — proving the per-key phase offset actually reaches the pixels,
  // not just the spec.
  it('renders visibly different pixels for all four idle keys at the same clock', () => {
    const { page } = build(null, 'no-device')
    const frame = page.render(NOW, 1500)
    const bufs = [0, 1, 4, 5].map((i) => renderKey(frame.keys[i]!))
    for (let i = 0; i < bufs.length; i++) {
      for (let j = i + 1; j < bufs.length; j++) {
        expect(bufs[i]!.equals(bufs[j]!)).toBe(false)
      }
    }
  })

  it('does not show the idle animation while a track is loaded, even paused', () => {
    const { page } = build(player({ isPlaying: false }), 'ok', null)
    const keys = page.render(NOW).keys
    for (const i of [0, 1, 4, 5]) {
      expect(keys[i]!.pulse).toBeUndefined()
    }
  })
})

describe('SpotifyPage tickMs', () => {
  it('is undefined (the 1000 ms default) while a track is loaded', () => {
    const { page } = build(player())
    expect(page.tickMs).toBeUndefined()
  })

  it('is defined and faster than 1000 ms while nothing is playing', () => {
    const { page } = build(null, 'no-device')
    expect(page.tickMs).toBeDefined()
    expect(page.tickMs!).toBeLessThan(1000)
  })

  it('is undefined while unauthorized, since key 0 shows the sign-in text, not the animation', () => {
    const { page } = build(null, 'unauthorized')
    expect(page.tickMs).toBeUndefined()
  })
})

describe('SpotifyPage strip', () => {
  it('shows the title on line 1 and the artist on line 2', () => {
    const { page } = build(player())
    expect(page.render(NOW).strip.lines[0]).toContain('Planet Caravan')
    expect(page.render(NOW).strip.lines[1]).toContain('Black Sabbath')
  })

  it('keeps the full title visible for a track with several artists', () => {
    const { page } = build(player({
      artist: 'Helynt, GameChops, mellow mode',
      title: 'Chrono Trigger Blues',
    }))
    const line0 = page.render(NOW).strip.lines[0]!
    expect(line0).toContain('Chrono Trigger Blues')
    expect(line0).not.toBe('…')
  })

  it('truncates an over-long title at 30 characters, not 34', () => {
    const { page } = build(player({ title: 'A'.repeat(50) }))
    const line0 = page.render(NOW).strip.lines[0]!
    expect(line0.length).toBe(30)
    expect(line0.length).toBeLessThan(34)
  })

  it('shows the position and the duration as a clock', () => {
    const { page } = build(player())
    expect(page.render(NOW).strip.right).toBe('2:14 / 4:32')
  })

  it('fills the progress bar to the position fraction', () => {
    const { page } = build(player())
    expect(page.render(NOW).strip.bar!.value).toBeCloseTo(134000 / 272000, 3)
  })

  it('shows nothing playing when there is no state', () => {
    const { page } = build(null, 'no-device')
    expect(page.render(NOW).strip.lines.join(' ')).toContain('nothing playing')
  })

  it('shows a wall clock beside the idle message', () => {
    const { page } = build(null, 'no-device')
    const strip = page.render(NOW, 1786549560000).strip
    expect(strip.right).toMatch(/^\d{1,2}:\d{2}$/)
  })

  it('tells the user how to authorize when unauthorized', () => {
    const { page } = build(null, 'unauthorized')
    expect(page.render(NOW).strip.lines.join(' ')).toContain('deckd auth spotify')
  })

  it('handles a zero duration without dividing by zero', () => {
    const { page } = build(player({ durationMs: 0, positionMs: 0 }))
    expect(page.render(NOW).strip.bar!.value).toBe(0)
  })
})

describe('SpotifyPage presses', () => {
  it('pauses when playing', async () => {
    const { page, calls } = build(player({ isPlaying: true }))
    await page.onKeyPress(2)
    expect(calls).toContain('pause')
  })

  it('plays when paused', async () => {
    const { page, calls } = build(player({ isPlaying: false }))
    await page.onKeyPress(2)
    expect(calls).toContain('play')
  })

  it('raises the volume by 10 points on key 3', async () => {
    const { page, calls } = build(player({ volumePercent: 55 }))
    await page.onKeyPress(3)
    expect(calls).toContain('volume:65')
  })

  it('assumes 50 percent when the volume is unknown, before raising it', async () => {
    const { page, calls } = build(player({ volumePercent: null }))
    await page.onKeyPress(3)
    expect(calls).toContain('volume:60')
  })

  it('goes to the previous track on key 6', async () => {
    const { page, calls } = build(player())
    await page.onKeyPress(6)
    expect(calls).toContain('previous')
  })

  it('advances to the next track on key 7', async () => {
    const { page, calls } = build(player())
    await page.onKeyPress(7)
    expect(calls).toContain('next')
  })

  it('does nothing on any of the four album-art keys', async () => {
    const { page, calls } = build(player())
    await page.onKeyPress(0)
    await page.onKeyPress(1)
    await page.onKeyPress(4)
    await page.onKeyPress(5)
    expect(calls).toEqual([])
  })

  it('tells the source when it becomes visible', () => {
    const { page, calls } = build(player())
    page.onEnter!()
    page.onLeave!()
    expect(calls).toEqual(['visible:true', 'visible:false'])
  })
})
