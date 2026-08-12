import { describe, it, expect, vi } from 'vitest'
import { SpotifyPage } from '../../src/pages/spotify-page.js'
import type { PlayerState, SpotifyStatus } from '../../src/sources/spotify.js'

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
const FAKE_ART = { width: 96, height: 96 } as unknown as Image

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
    toggleShuffle: async () => { calls.push('shuffle'); return true },
    cycleRepeat: async () => { calls.push('repeat'); return true },
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
  }
  return { page: new SpotifyPage(source as never), calls }
}

describe('SpotifyPage layout', () => {
  it('returns 8 keys', () => {
    const { page } = build(player())
    expect(page.render(NOW).keys).toHaveLength(8)
  })

  it('puts album art on key 0 when it is cached', () => {
    const { page } = build(player(), 'ok', FAKE_ART)
    const key = page.render(NOW).keys[0]!
    expect(key.kind).toBe('image')
    expect(key.image).toBe(FAKE_ART)
    expect(key.imageKey).toBe('track-1')
  })

  it('falls back to text on key 0 when art is absent', () => {
    const { page } = build(player(), 'ok', null)
    expect(page.render(NOW).keys[0]!.kind).not.toBe('image')
  })

  it('shows SIGN IN on key 0 when unauthorized', () => {
    const { page } = build(null, 'unauthorized')
    expect(page.render(NOW).keys[0]!.lines!.join(' ')).toContain('SIGN IN')
  })

  it('shows a pause glyph while playing', () => {
    const { page } = build(player({ isPlaying: true }))
    expect(page.render(NOW).keys[2]!.glyph).toBe('❙❙')
  })

  it('shows a play glyph while paused', () => {
    const { page } = build(player({ isPlaying: false }))
    expect(page.render(NOW).keys[2]!.glyph).toBe('▶')
  })

  it('shows the skip glyphs on keys 1 and 3', () => {
    const { page } = build(player())
    const keys = page.render(NOW).keys
    expect(keys[1]!.glyph).toBe('◀◀')
    expect(keys[3]!.glyph).toBe('▶▶')
  })

  it('shows the shuffle and repeat state', () => {
    const { page } = build(player({ shuffle: true, repeat: 'track' }))
    const keys = page.render(NOW).keys
    expect(keys[6]!.lines!.join(' ')).toContain('on')
    expect(keys[7]!.lines!.join(' ')).toContain('track')
  })

  it('dims the transport keys when there is no device', () => {
    const { page } = build(null, 'no-device')
    expect(page.render(NOW).keys[2]!.dim).toBe(true)
  })
})

describe('SpotifyPage strip', () => {
  it('shows the artist and the title', () => {
    const { page } = build(player())
    expect(page.render(NOW).strip.lines[0]).toContain('Black Sabbath')
    expect(page.render(NOW).strip.lines[0]).toContain('Planet Caravan')
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

  it('maps the skip keys', async () => {
    const { page, calls } = build(player())
    await page.onKeyPress(1)
    await page.onKeyPress(3)
    expect(calls).toContain('previous')
    expect(calls).toContain('next')
  })

  it('steps the volume by 10 points', async () => {
    const { page, calls } = build(player({ volumePercent: 55 }))
    await page.onKeyPress(4)
    await page.onKeyPress(5)
    expect(calls).toContain('volume:45')
    expect(calls).toContain('volume:65')
  })

  it('assumes 50 percent when the volume is unknown', async () => {
    const { page, calls } = build(player({ volumePercent: null }))
    await page.onKeyPress(5)
    expect(calls).toContain('volume:60')
  })

  it('maps the shuffle and repeat keys', async () => {
    const { page, calls } = build(player())
    await page.onKeyPress(6)
    await page.onKeyPress(7)
    expect(calls).toContain('shuffle')
    expect(calls).toContain('repeat')
  })

  it('does nothing on the album art key', async () => {
    const { page, calls } = build(player())
    await page.onKeyPress(0)
    expect(calls).toEqual([])
  })

  it('tells the source when it becomes visible', () => {
    const { page, calls } = build(player())
    page.onEnter!()
    page.onLeave!()
    expect(calls).toEqual(['visible:true', 'visible:false'])
  })
})
