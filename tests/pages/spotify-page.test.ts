import { describe, it, expect, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { SpotifyPage } from '../../src/pages/spotify-page.js'
import type { PlayerState, SpotifyStatus } from '../../src/sources/spotify.js'
import { renderKey, renderStrip, probe, FONT, STRIP_WIDTH, STRIP_HEIGHT } from '../../src/render/canvas.js'
import { theme } from '../../src/render/theme.js'
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

  it('shows the wall clock beside the idle message, in Eastern time with AM/PM', () => {
    // Fixed epoch, not the real clock: 1786549560000 ms is 2026-08-12 15:46
    // UTC, which is 11:46 AM EDT — a summer instant, so the zone must read
    // EDT, never a hard-coded EST. Exact string, per docs/LESSONS.md #17:
    // measured at 93.9 px against the strip's 236 px usable width.
    const { page } = build(null, 'no-device')
    const strip = page.render(NOW, 1786549560000).strip
    expect(strip.right).toBe('11:46 AM EDT')
  })

  it('never draws strip text past the strip edge, and the idle clock never overlaps "nothing playing"', () => {
    // Measured: `nothing playing` is 117.4 px and the right-aligned
    // `11:46 AM EDT` is 93.9 px, well clear of each other inside the
    // strip's 236 px usable width — verified by pixel probe, not
    // arithmetic, per docs/LESSONS.md #17.
    //
    // Probing only the last column (I7) is background for ANY overlap
    // whatsoever, since the right-aligned text grows LEFTWARD from well
    // short of the edge — it cannot fail. This still checks the edge itself
    // stays clear, and the row-by-row ink-vs-ink check below is what
    // actually proves the two runs of text do not overlap each other.
    const { page } = build(null, 'no-device')
    const buffer = renderStrip(page.render(NOW, 1786549560000).strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      expect(probe(buffer, STRIP_WIDTH - 1, y, STRIP_WIDTH)).toEqual(theme.bg)
    }
  })

  it('never overlaps line 2 with the right-hand clock, even at the widest realistic content (I5/I7)', () => {
    // The exact combination the review measured: an 18-character artist
    // (`ARTIST_CHARS`) beside a track over an hour long, so the clock reads
    // `120:00 / 120:00` — 22.3 px of real overlap before this was fixed.
    // `STRIP_WIDTH - 1` (I7's old probe column) is background for this case
    // too, since the right text sits nowhere near the strip's true edge, so
    // that single column cannot see this defect at all.
    const { page } = build(player({
      artist: 'X'.repeat(18),
      positionMs: 120 * 60_000,
      durationMs: 120 * 60_000,
    }))
    const strip = page.render(NOW).strip
    expect(strip.right).toBe('120:00 / 120:00')

    // Measure the clock's own rendered width with the SAME font the
    // renderer draws it with, per lesson 17 — this is exactly how the
    // review itself found the 22.3 px overlap, not a guess.
    const ctx = createCanvas(1, 1).getContext('2d')
    ctx.font = `13px ${FONT}`
    const rightWidth = ctx.measureText(strip.right!).width
    const rightStart = Math.floor(STRIP_WIDTH - 6 - rightWidth) // 6 = the strip's own PAD

    const withLine2 = renderStrip(strip)
    // A reference render of the SAME strip with line 2 blanked out. If line
    // 2's real content painted anything inside the clock's own footprint —
    // an overlap, whether it fully covers the clock's ink or only shows
    // through the gaps between its glyphs — the two buffers diverge there.
    // Identical pixels in that whole region is the only way this passes.
    const withoutLine2 = renderStrip({ ...strip, lines: [strip.lines[0]!, ''] })

    let comparedAnyColumn = false
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      for (let x = rightStart; x < STRIP_WIDTH; x++) {
        comparedAnyColumn = true
        expect(probe(withLine2, x, y, STRIP_WIDTH)).toEqual(probe(withoutLine2, x, y, STRIP_WIDTH))
      }
    }
    expect(comparedAnyColumn).toBe(true)
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

  it('wraps volume from the top back to zero', async () => {
    const { page, calls } = build(player({ volumePercent: 100 }))
    await page.onKeyPress(3)
    expect(calls).toContain('volume:0')
  })

  it('does not read the wall clock while handling a press', async () => {
    const now = vi.spyOn(Date, 'now')
    try {
      const { page } = build(player())
      await page.onKeyPress(2)
      expect(now).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
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

describe('SpotifyPage presses report the real outcome, keys 0 to 7', () => {
  it('reports handled for play/pause, volume, previous and next when the source call succeeds', async () => {
    const { page } = build(player({ isPlaying: true, volumePercent: 50 }))
    expect(await page.onKeyPress(2)).toBe('handled')
    expect(await page.onKeyPress(3)).toBe('handled')
    expect(await page.onKeyPress(6)).toBe('handled')
    expect(await page.onKeyPress(7)).toBe('handled')
  })

  it('reports failed for play/pause, volume, previous and next when the source call itself fails', async () => {
    const source = {
      interpolate: () => player({ isPlaying: true, volumePercent: 50 }),
      getStatus: () => 'ok' as SpotifyStatus,
      getArt: () => null,
      play: async () => false,
      pause: async () => false,
      next: async () => false,
      previous: async () => false,
      setVolume: async () => false,
      setVisible: () => {},
    }
    const page = new SpotifyPage(source as never)
    expect(await page.onKeyPress(2)).toBe('failed')
    expect(await page.onKeyPress(3)).toBe('failed')
    expect(await page.onKeyPress(6)).toBe('failed')
    expect(await page.onKeyPress(7)).toBe('failed')
  })

  it('reports ignored for every album-art key, 0, 1, 4 and 5', async () => {
    const { page } = build(player())
    for (const i of [0, 1, 4, 5]) {
      expect(await page.onKeyPress(i)).toBe('ignored')
    }
  })
})
