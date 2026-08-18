import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { SpotifyPage, controlWash, controlGlyphColor, breathePhase } from '../../src/pages/spotify-page.js'
import type { PlayerState, SpotifyStatus } from '../../src/sources/spotify.js'
import type { Rgb } from '../../src/render/specs.js'
import { renderKey, renderStrip, probe, FONT, STRIP_WIDTH, STRIP_HEIGHT } from '../../src/render/canvas.js'
import { keyHash } from '../../src/render/specs.js'
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

function build(
  state: PlayerState | null,
  status: SpotifyStatus = 'ok',
  art: Image | null = null,
  artColor: Rgb | null = null,
) {
  const calls: string[] = []
  const source = {
    interpolate: () => state,
    getStatus: () => status,
    getArt: () => art,
    getArtColor: (trackId: string) => { calls.push(`artColor:${trackId}`); return artColor },
    play: async () => { calls.push('play'); return true },
    pause: async () => { calls.push('pause'); return true },
    next: async () => { calls.push('next'); return true },
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

  it('tiles the central 3:2 slice of the cover across all six art keys, with square cells', () => {
    // The cover is SQUARE and the block is 3:2, so naive 1/3 x 1/2 crops would
    // squash every tile — `drawCroppedImage` fills the whole key whatever shape
    // the source rect is, so the distortion would be silent. This proves the
    // arithmetic the page actually emits: six cells, each square, tiling the
    // central slice exactly with no gap and no overlap.
    const { page } = build(player(), 'ok', FAKE_ART)
    const keys = page.render(NOW).keys
    const crops = [0, 1, 2, 4, 5, 6].map((i) => keys[i]!.imageCrop!)
    for (const crop of crops) {
      expect(crop).toBeDefined()
      // Square source rect: no distortion when drawn into a square key.
      expect(crop.sw).toBeCloseTo(crop.sh, 10)
    }
    // All six cells distinct.
    const cells = new Set(crops.map((c) => `${c.sx.toFixed(4)}:${c.sy.toFixed(4)}`))
    expect(cells.size).toBe(6)
    const xs = [...new Set(crops.map((c) => Number(c.sx.toFixed(6))))].sort((a, b) => a - b)
    const ys = [...new Set(crops.map((c) => Number(c.sy.toFixed(6))))].sort((a, b) => a - b)
    expect(xs).toHaveLength(3)
    expect(ys).toHaveLength(2)
    // Full width, and a vertically CENTRED slice.
    expect(xs[0]).toBeCloseTo(0, 6)
    expect(xs[2]! + crops[0]!.sw).toBeCloseTo(1, 6)
    const sliceTop = ys[0]!
    const sliceBottom = ys[1]! + crops[0]!.sh
    expect(sliceTop).toBeCloseTo(1 - sliceBottom, 6)
    // And the slice really is 3:2 — full width against two thirds of the height.
    expect(sliceBottom - sliceTop).toBeCloseTo(2 / 3, 6)
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
    expect(keys[0]!.idle).toBeUndefined()
    for (const i of [1, 4, 5]) {
      expect(keys[i]!.kind).toBe('blank')
      expect(keys[i]!.idle).toBeUndefined()
    }
  })

  // Task 38: every control glyph moved to the colour-emoji font, the user's
  // pick over task 37's plain-text Geometric Shapes set.
  it('shows a real Menlo pause glyph on key 3 while playing, tinted by the album', () => {
    // TEXT mode, not emoji. Apple's glossy media emoji read as plastic stickers
    // against the art, and being bitmap glyphs they ignore `fillStyle`, so they
    // could never take the album's colour (lesson 15).
    const { page } = build(player({ isPlaying: true }), 'ok', FAKE_ART, [250, 210, 40])
    const key = page.render(NOW).keys[3]!
    expect(key.glyph).toBe('❚❚')
    expect(key.glyphFont).not.toBe('emoji')
    expect(key.glyphColor).toBeDefined()
    expect(key.bg).toBeDefined()
  })

  it('avoids the media-control characters Menlo does not have', () => {
    // MEASURED: `⏵`, `⏸`, `⏭` and `‖` all render as the SAME missing-glyph box in
    // Menlo, byte-identical at 202 ink pixels. Shipping one in text mode would put
    // a tofu box on the deck, and nothing would report it.
    const TOFU = ['⏵', '⏸', '⏭', '⏮', '‖', '⏯']
    for (const playing of [true, false]) {
      const { page } = build(player({ isPlaying: playing }), 'ok', FAKE_ART)
      const glyphs = page.render(NOW).keys.map((k) => k.glyph).filter(Boolean)
      for (const g of glyphs) {
        expect(TOFU, `glyph ${g} has no Menlo form`).not.toContain(g)
      }
    }
  })

  it('shows a real Menlo play glyph on key 3 while paused', () => {
    const { page } = build(player({ isPlaying: false }), 'ok', FAKE_ART)
    const key = page.render(NOW).keys[3]!
    expect(key.glyph).toBe('▶')
    expect(key.glyphFont).not.toBe('emoji')
  })

  it('shows the next glyph on key 7, and no previous or volume button anywhere', () => {
    // Previous and volume were dropped when the art grew to six keys. Asserted
    // GONE rather than merely moved, so a later edit cannot quietly reintroduce a
    // control this layout has no room for.
    const { page } = build(player(), 'ok', FAKE_ART)
    const keys = page.render(NOW).keys
    expect(keys[7]!.glyph).toBe('▶▶')
    const glyphs = keys.map((k) => k.glyph).filter(Boolean)
    expect(glyphs).not.toContain('⏮️')
    expect(glyphs).not.toContain('🔊')
  })

  // Task 37: the volume key moved off the `lines`/`align` text path onto the
  // same `glyph`/`glyphCaption` path as its three neighbours, so all four
  // control keys share one render path and one optical centring instead of
  // the volume key alone reading as a two-line text tile.



  // Task 38: only the volume key's speaker "thumps," and only while a
  // track is actually PLAYING — a thumping speaker beside a paused track
  // would be decoration with no meaning.


  it('gives key 3 no glyphPulse when there is no device', () => {
    const { page } = build(null, 'no-device')
    expect(page.render(NOW).keys[3]!.glyphPulse).toBeUndefined()
  })




  // Lesson 17: measure the actual rendered pixels, not just the spec field.

  // The coordinator's specific concern: a tick that only advances the
  // animation must touch exactly ONE key's hash (the volume key), so the
  // daemon's dirty-key check (src/daemon.ts, `keyHash`) writes exactly one
  // key to the device instead of redrawing all eight for a change that only
  // affects one. `now` (the playback position clock) is held FIXED between
  // the two renders — only `nowMs` (the animation clock) advances — so this
  // isolates the thump from anything position-driven.
  it('changes ONLY the play/pause key when nowMs advances during playback', () => {
    // The one thing that moves during playback is the play/pause glyph's breath,
    // so exactly one key is rewritten per frame — about ten key-writes a second
    // against a measured ceiling of 362. The six art cells and the next key must
    // stay byte-stable, or a still cover would be redrawn 10 times a second for
    // nothing.
    const { page } = build(player({ isPlaying: true }), 'ok', FAKE_ART)
    const a = page.render(NOW, 1_000).keys.map(keyHash)
    const b = page.render(NOW, 1_300).keys.map(keyHash)
    expect(b[3]).not.toBe(a[3])
    for (const i of [0, 1, 2, 4, 5, 6, 7]) {
      expect(b[i], `key ${i} should be stable while playing`).toBe(a[i])
    }
  })

  it('does not breathe while paused, or behind a dead device', () => {
    const paused = build(player({ isPlaying: false }), 'ok', FAKE_ART)
    expect(paused.page.render(NOW, 1_000).keys[3]!.glyphPulse).toBeUndefined()
    const dead = build(player({ isPlaying: true }), 'no-device', FAKE_ART)
    expect(dead.page.render(NOW, 1_000).keys[3]!.glyphPulse).toBeUndefined()
  })

  it('changes every art key hash when only nowMs advances while PAUSED', () => {
    // Paused is the animated state now: the cover dims and a layer drifts
    // beneath it, so the six art cells do change frame to frame.
    const { page } = build(player({ isPlaying: false }), 'ok', FAKE_ART)
    const a = page.render(NOW, 1_000).keys.map(keyHash)
    const b = page.render(NOW, 1_500).keys.map(keyHash)
    for (const i of [0, 1, 2, 4, 5, 6]) expect(b[i], `art key ${i}`).not.toBe(a[i])
    // The control keys carry no layer, so they are untouched.
    expect(b[3]).toBe(a[3])
    expect(b[7]).toBe(a[7])
  })

  it('dims both control keys when there is no device', () => {
    const { page } = build(player(), 'no-device', FAKE_ART)
    const keys = page.render(NOW).keys
    for (const i of [3, 7]) expect(keys[i]!.dim, `key ${i}`).toBe(true)
  })

  it('does not render shuffle or repeat anywhere on the deck', () => {
    const { page } = build(player())
    const keys = page.render(NOW).keys
    const allLines = keys.flatMap((k) => k.lines ?? []).join(' ').toUpperCase()
    expect(allLines).not.toContain('SHUFFLE')
    expect(allLines).not.toContain('REPEAT')
  })
})

describe('SpotifyPage idle animation (nothing playing) — task 39, replacing the old green equaliser', () => {
  it('gives keys 0, 1, 4 and 5 an idle spec, and no lines, glyph or image', () => {
    const { page } = build(null, 'no-device')
    const keys = page.render(NOW).keys
    for (const i of [0, 1, 4, 5]) {
      expect(keys[i]!.idle).toBeDefined()
      expect(keys[i]!.lines).toBeUndefined()
      expect(keys[i]!.glyph).toBeUndefined()
      expect(keys[i]!.image).toBeUndefined()
    }
  })

  // Key 0 is top-left (col 0, row 0), key 1 is top-right (col 1, row 0),
  // key 4 is bottom-left (col 0, row 1), key 5 is bottom-right (col 1,
  // row 1) — matching the same 2x2 layout the album-art crops already use.
  // Without each key naming its own distinct corner, three of the four
  // quadrants of a scene-based animation would draw the identical corner,
  // the same class of defect lesson 11 describes for `imageCrop`.
  it('gives each of the four idle keys its own distinct col/row position', () => {
    const { page } = build(null, 'no-device')
    const keys = page.render(NOW).keys
    expect(keys[0]!.idle).toMatchObject({ col: 0, row: 0 })
    expect(keys[1]!.idle).toMatchObject({ col: 1, row: 0 })
    expect(keys[4]!.idle).toMatchObject({ col: 0, row: 1 })
    expect(keys[5]!.idle).toMatchObject({ col: 1, row: 1 })
  })

  it('gives all four idle keys the same variant and the same nowMs at one instant', () => {
    const { page } = build(null, 'no-device')
    const keys = page.render(NOW, 5000).keys
    for (const i of [0, 1, 4, 5]) {
      expect(keys[i]!.idle!.variant).toBe(keys[0]!.idle!.variant)
      expect(keys[i]!.idle!.nowMs).toBe(5000)
    }
  })

  it('advances idle.nowMs as nowMs advances', () => {
    const { page } = build(null, 'no-device')
    const nowMsAt = (nowMs: number) => page.render(NOW, nowMs).keys[0]!.idle!.nowMs
    expect(nowMsAt(0)).not.toBe(nowMsAt(2000))
  })

  it('never calls Date.now(): the same nowMs always produces the same idle spec', () => {
    const { page } = build(null, 'no-device')
    const a = page.render(NOW, 12345).keys[0]!.idle
    const b = page.render(NOW, 12345).keys[0]!.idle
    expect(a).toEqual(b)
  })

  // Lesson 17: measure the actual rendered pixels, not just the spec fields.
  // A render at two different clocks must produce two different key buffers,
  // proving the animation itself moves, not just some inert number in the spec.
  it('renders visibly different pixels for the same key at two different clocks', () => {
    const { page } = build(null, 'no-device')
    const bufA = renderKey(page.render(NOW, 0).keys[0]!)
    const bufB = renderKey(page.render(NOW, 1000).keys[0]!)
    expect(bufA.equals(bufB)).toBe(false)
  })

  // And the four keys, rendered at the SAME clock, must differ from each
  // other too — proving the per-key col/row actually reaches the pixels, not
  // just the spec.
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
      expect(keys[i]!.idle).toBeUndefined()
    }
  })

  // The coordinator's specific concern for this task: a tick that only
  // advances the idle animation must touch exactly the FOUR art keys' hashes
  // (0, 1, 4 and 5) — never all eight, and never a different set of four —
  // so the daemon's dirty-key check (src/daemon.ts, `keyHash`) writes only
  // those four keys to the device. `now` (the playback position clock) plays
  // no role here since nothing is loaded; only `nowMs` (the animation clock)
  // advances.
  it('changes all SIX art key hashes when only nowMs advances while idle', () => {
    const { page } = build(null, 'no-device')
    const a = page.render(NOW, 1_000).keys.map(keyHash)
    const b = page.render(NOW, 1_100).keys.map(keyHash)
    for (const i of [0, 1, 2, 4, 5, 6]) {
      expect(b[i], `art key ${i} froze`).not.toBe(a[i])
    }
    expect(b[3]).toBe(a[3])
    expect(b[7]).toBe(a[7])
  })

  it('gives every one of the six idle cells its own position, so no two rain alike', () => {
    // The user's very first request in this project was this animation. Six keys
    // needs six distinct (col, row) pairs — on a 2-wide grid two would collide and
    // two tiles would fall identically.
    const { page } = build(null, 'no-device')
    const keys = page.render(NOW, 1_000).keys
    const cells = new Set<string>()
    for (const i of [0, 1, 2, 4, 5, 6]) {
      const idle = keys[i]!.idle
      expect(idle, `key ${i} has no idle spec`).toBeDefined()
      cells.add(`${idle!.col}:${idle!.row}`)
    }
    expect(cells.size).toBe(6)
  })
})

/*
 * RETIRED, deliberately: golden sha256 hashes of keys 2, 3, 6 and 7, captured
 * from the pre-task-39 build to prove that task 39's idle-animation rewrite had
 * left the playing state byte-identical.
 *
 * Task 39 landed. AGENTS.md's rule is that "a point-in-time proof (a golden
 * hash pinning another page's bytes) retires when its change lands. Do not
 * leave it to fire on the next legitimate change." It was left, and it fired on
 * task 44 — which moves play/pause to key 3, drops volume and previous
 * entirely, and grows the art to six keys, all by the user's explicit request.
 *
 * Re-baselining would preserve a proof of a claim nobody makes any more. The
 * playing state's real properties are covered by the layout and press blocks
 * above.
 *
 * It did earn its keep on the way out, though: it was the failure that exposed
 * `tickMs` still following `isPlaying` from the deleted volume "thump", which
 * would have burned the fast tick on a static playing page and starved the new
 * paused animation to one frame a second.
 */

describe('SpotifyPage tickMs', () => {
  /*
   * INVERTED by task 44, and the inversion is the point.
   *
   * Task 38 tied the fast tick to `isPlaying`, because the volume key's "thump"
   * animated during playback. Task 44 deleted that key, so a PLAYING page is
   * static between polls — and a PAUSED one animates, because the cover dims and
   * a layer drifts beneath it. The rate follows what actually moves.
   */
  it('is defined and faster than 1000 ms while a track is loaded but PAUSED', () => {
    const { page } = build(player({ isPlaying: false }))
    expect(page.tickMs).toBeDefined()
    expect(page.tickMs!).toBeLessThan(1000)
  })

  it('is defined and faster than 1000 ms while playing, for the glyph breath', () => {
    // Inverted TWICE now, and each time for the same reason: the rate follows what
    // actually moves. Task 38 raised it for the volume "thump"; task 44 dropped
    // that key and lowered it again; then the user asked for the controls to feel
    // alive, so the play/pause glyph breathes and it is raised once more. Only ONE
    // key changes per frame while playing, which is what makes that affordable.
    const { page } = build(player({ isPlaying: true }))
    expect(page.tickMs).toBeDefined()
    expect(page.tickMs!).toBeLessThan(1000)
  })

  it('is defined while nothing is loaded, for the idle animation', () => {
    const { page } = build(null, 'no-device')
    expect(page.tickMs).toBeDefined()
    expect(page.tickMs!).toBeLessThan(1000)
  })

  it('is undefined while unauthorized, since key 0 shows text rather than an animation', () => {
    const { page } = build(null, 'unauthorized')
    expect(page.tickMs).toBeUndefined()
  })

  it('is undefined for a stale "was playing" snapshot behind a dead device (M5)', () => {
    // A failed transport command leaves `isPlaying` true while `status` reports
    // `no-device`. Nothing should animate for a device that is gone — and with the
    // rate now inverted, the naive reading would have made this case FAST.
    const { page } = build(player({ isPlaying: true }), 'no-device')
    expect(page.tickMs).toBeUndefined()
  })

  it('is undefined for a stale PAUSED snapshot behind a dead device too', () => {
    const { page } = build(player({ isPlaying: false }), 'no-device')
    expect(page.tickMs).toBeUndefined()
  })
})

describe('SpotifyPage staleness (I3): one predicate for the whole page, including the album-art keys', () => {
  // Before this fix, `dead` (the transport keys' dim check) omitted
  // `'offline'`, the strip used a SEPARATE `status === 'offline'` check of
  // its own, and the four album-art keys never dimmed at all, in any state
  // — the exact disagreement I3 reports.
  it('dims the four album-art keys, not just the transport controls, when the device is gone with a stale but present state', () => {
    const { page } = build(player({ isPlaying: true }), 'no-device', FAKE_ART)
    const keys = page.render(NOW).keys
    for (const i of [0, 1, 4, 5]) {
      expect(keys[i]!.kind).toBe('image')
      expect(keys[i]!.dim).toBe(true)
    }
    for (const i of [2, 3, 6, 7]) {
      expect(keys[i]!.dim).toBe(true)
    }
  })

  it('dims the strip AND the four album-art keys when offline — the strip alone used to be the only thing that dimmed', () => {
    const { page } = build(player({ isPlaying: true }), 'offline', FAKE_ART)
    const frame = page.render(NOW)
    for (const i of [0, 1, 4, 5]) {
      expect(frame.keys[i]!.dim).toBe(true)
    }
    for (const i of [2, 3, 6, 7]) {
      expect(frame.keys[i]!.dim).toBe(true)
    }
    expect(frame.strip.dim).toBe(true)
  })

  it('does not dim the idle-animation art keys just because nothing is loaded — an idle scene is not stale data', () => {
    const { page } = build(null, 'ok')
    const keys = page.render(NOW).keys
    for (const i of [0, 1, 4, 5]) {
      expect(keys[i]!.dim).toBeFalsy()
    }
  })


  it('freezes the interpolated position while offline, instead of tracking the wall clock forward for up to 5 minutes behind dim art', () => {
    const calls: number[] = []
    const source = {
      interpolate: (now: number) => {
        calls.push(now)
        return player({ isPlaying: true })
      },
      getStatus: () => 'offline' as SpotifyStatus,
      getArt: () => FAKE_ART,
      getArtColor: () => null,
      play: async () => true,
      pause: async () => true,
      next: async () => true,
      previous: async () => true,
      setVolume: async () => true,
      setVisible: () => {},
    }
    const page = new SpotifyPage(source as never)
    page.render(1000)
    page.render(1010)
    page.render(1020)
    // Every render while offline reuses the FIRST `now` this page observed
    // the drop at (1000) — it does not keep handing `interpolate` the
    // advancing wall clock.
    expect(calls).toEqual([1000, 1000, 1000])
  })

  it('re-anchors the freeze the next time the device goes offline, rather than reusing a stale anchor from a previous drop', () => {
    const calls: number[] = []
    let status: SpotifyStatus = 'offline'
    const source = {
      interpolate: (now: number) => {
        calls.push(now)
        return player({ isPlaying: true })
      },
      getStatus: () => status,
      getArt: () => FAKE_ART,
      getArtColor: () => null,
      play: async () => true,
      pause: async () => true,
      next: async () => true,
      previous: async () => true,
      setVolume: async () => true,
      setVisible: () => {},
    }
    const page = new SpotifyPage(source as never)
    page.render(1000) // offline: anchors at 1000
    status = 'ok'
    page.render(2000) // recovered: uses the real clock again
    status = 'offline'
    page.render(3000) // offline again: re-anchors at 3000, not the old 1000
    page.render(3010)
    expect(calls).toEqual([1000, 2000, 3000, 3000])
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


  it('advances to the next track on key 7', async () => {
    const { page, calls } = build(player())
    await page.onKeyPress(7)
    expect(calls).toContain('next')
  })

  it('toggles playback on every art key, so the control is always under a finger', async () => {
    // The inverse of the old behaviour, by the user's request: they wanted to play
    // and pause and see the cover, so seven of the eight keys now do it.
    for (const i of [0, 1, 2, 4, 5, 6]) {
      const { page, calls } = build(player({ isPlaying: true }), 'ok', FAKE_ART)
      expect(await page.onKeyPress(i)).toBe('handled')
      expect(calls, `key ${i}`).toContain('pause')
    }
    for (const i of [0, 1, 2, 4, 5, 6]) {
      const { page, calls } = build(player({ isPlaying: false }), 'ok', FAKE_ART)
      expect(await page.onKeyPress(i)).toBe('handled')
      expect(calls, `key ${i}`).toContain('play')
    }
  })

  it('toggles playback on the labelled key 3 too', async () => {
    const { page, calls } = build(player({ isPlaying: true }), 'ok', FAKE_ART)
    expect(await page.onKeyPress(3)).toBe('handled')
    expect(calls).toContain('pause')
  })

  it('ignores a press when nothing is loaded, rather than guessing', async () => {
    const { page, calls } = build(null, 'no-device')
    for (const i of [0, 3, 6]) expect(await page.onKeyPress(i)).toBe('ignored')
    expect(calls).not.toContain('play')
    expect(calls).not.toContain('pause')
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
      getArtColor: () => null,
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

  it('reports handled for every key when a track is loaded', async () => {
    for (let i = 0; i <= 7; i++) {
      const { page } = build(player({ isPlaying: true }), 'ok', FAKE_ART)
      expect(await page.onKeyPress(i), `key ${i}`).toBe('handled')
    }
  })
})

describe('SpotifyPage paused state (task 44)', () => {
  it('dims the cover AND puts a layer beneath it while paused', () => {
    const { page } = build(player({ isPlaying: false }), 'ok', FAKE_ART)
    const keys = page.render(NOW, 1_000).keys
    for (const i of [0, 1, 2, 4, 5, 6]) {
      expect(keys[i]!.dim, `key ${i}`).toBe(true)
      expect(keys[i]!.fx, `key ${i}`).toBeDefined()
    }
  })

  it('shows the cover clean and undimmed while playing', () => {
    const { page } = build(player({ isPlaying: true }), 'ok', FAKE_ART)
    const keys = page.render(NOW, 1_000).keys
    for (const i of [0, 1, 2, 4, 5, 6]) {
      expect(keys[i]!.dim, `key ${i}`).not.toBe(true)
      expect(keys[i]!.fx, `key ${i}`).toBeUndefined()
    }
  })

  it('gives the six paused cells distinct seeds, so they do not drift as one sheet', () => {
    const { page } = build(player({ isPlaying: false }), 'ok', FAKE_ART)
    const keys = page.render(NOW, 1_000).keys
    const seeds = [0, 1, 2, 4, 5, 6].map((i) => keys[i]!.fx!.seed)
    expect(new Set(seeds).size).toBe(6)
  })

  it('does not add a paused layer when the data is merely stale', () => {
    // A dead device already dims everything through `stale`. Adding drifting haze
    // on top would claim the track is paused when we do not know that.
    const { page } = build(player({ isPlaying: false }), 'no-device', FAKE_ART)
    const keys = page.render(NOW, 1_000).keys
    for (const i of [0, 1, 2, 4, 5, 6]) {
      expect(keys[i]!.dim, `key ${i}`).toBe(true)
      expect(keys[i]!.fx, `key ${i}`).toBeUndefined()
    }
  })

  it('actually reveals the layer through the dimmed cover, on the glass', async () => {
    // The whole mechanism rests on draw order plus `dim`: background, then the
    // layer, then the image at DIM_FACTOR opacity, so a 45-percent-opaque cover
    // lets the layer through.
    //
    // Needs a REAL decoded image, not this file's `FAKE_ART` stand-in. FAKE_ART is
    // a bare `{ width, height }` object, which is fine for the spec-level tests
    // but draws nothing — so a pixel-level claim made with it compares two
    // coverless renders and proves nothing about the cover at all.
    const cover = createCanvas(64, 64)
    const cctx = cover.getContext('2d')
    cctx.fillStyle = 'rgb(200, 60, 40)'
    cctx.fillRect(0, 0, 64, 64)
    const realArt = await loadImage(cover.toBuffer('image/png'))

    const { page } = build(player({ isPlaying: false }), 'ok', realArt)
    const key = page.render(NOW, 1_000).keys[0]!
    expect(key.fx).toBeDefined()

    const withLayer = renderKey(key)
    const withoutLayer = renderKey({ ...key, fx: undefined })
    expect(withLayer.equals(withoutLayer)).toBe(false)

    // And the cover is genuinely visible through the dimming, not blacked out:
    // the red channel still leads.
    const px = probe(withLayer, 48, 48)
    expect(px[0]).toBeGreaterThan(px[1]! + 10)
  })
})

describe('SpotifyPage album-colour theming (task 44)', () => {
  const BLUE: Rgb = [40, 120, 220]

  it('borders both control keys, fills the progress bar and lights both round buttons', () => {
    const { page } = build(player(), 'ok', FAKE_ART, BLUE)
    const frame = page.render(NOW, 1_000)
    expect(frame.keys[3]!.border).toEqual(BLUE)
    expect(frame.keys[7]!.border).toEqual(BLUE)
    expect(frame.strip.bar!.color).toEqual(BLUE)
    expect(frame.buttons[0]).toEqual(BLUE)
    expect(frame.buttons[1]).toEqual(BLUE)
  })

  it('falls back to the theme when the cover has no usable colour, never a fabricated hue', () => {
    const { page } = build(player(), 'ok', FAKE_ART, null)
    const frame = page.render(NOW, 1_000)
    expect(frame.keys[3]!.border).toEqual(theme.gray)
    expect(frame.strip.bar!.color).toEqual(theme.gray)
  })

  it('asks the source for the colour rather than computing one, so no pixels are read on the render path', () => {
    // The hard invariant: nothing decodes or measures pixels while rendering. The
    // page may only ASK, and the source computes once per track at decode time.
    const { page, calls } = build(player(), 'ok', FAKE_ART, BLUE)
    for (let i = 0; i < 5; i++) page.render(NOW, 1_000 + i)
    const asks = calls.filter((c) => c.startsWith('artColor:'))
    expect(asks.length).toBe(5)
    expect(asks[0]).toBe(`artColor:${player().trackId}`)
  })

  it('does not ask for a colour when nothing is loaded', () => {
    const { page, calls } = build(null, 'no-device')
    page.render(NOW, 1_000)
    expect(calls.some((c) => c.startsWith('artColor:'))).toBe(false)
  })
})

describe('SpotifyPage control-key styling (task 44 follow-up)', () => {
  /** Real accents spanning the range an album can produce: bright, mid, very
   * dark, saturated-dark, and near-white. */
  const ACCENTS: readonly Rgb[] = [
    [250, 210, 40],   // bright gold
    [40, 120, 220],   // mid blue
    [90, 20, 20],     // dark red — the case that breaks a naive tint
    [26, 0, 60],      // near-black violet
    [240, 240, 250],  // near-white
    [70, 200, 110],   // green
  ]
  const lum = (c: readonly number[]) => c[0]! + c[1]! + c[2]!

  it('keeps every glyph clearly brighter than its own wash, for any album', () => {
    // The whole point of lifting the glyph. Without it a dark-red cover puts a
    // dark red glyph on a near-black wash and the controls disappear.
    for (const accent of ACCENTS) {
      const wash = controlWash(accent)
      const glyph = controlGlyphColor(accent)
      expect(lum(glyph), `accent ${accent}`).toBeGreaterThan(lum(wash) * 2.5)
    }
  })

  it('keeps every wash dark enough to sit beside album art without glowing', () => {
    for (const accent of ACCENTS) {
      expect(lum(controlWash(accent)), `accent ${accent}`).toBeLessThan(200)
    }
  })

  it('leaves an already-bright accent alone, and lifts only a dark one', () => {
    const bright: Rgb = [250, 210, 40]
    expect(controlGlyphColor(bright)).toEqual(bright)
    const dark: Rgb = [26, 0, 60]
    const lifted = controlGlyphColor(dark)
    expect(lum(lifted)).toBeGreaterThan(lum(dark))
    // The hue survives the lift: violet stays blue-dominant rather than washing
    // out to pure white.
    expect(lifted[2]).toBeGreaterThan(lifted[1]!)
  })

  it('renders the glyph visibly against the wash on the real key', () => {
    // The colours could satisfy the arithmetic and still fail on the glass, so
    // this probes the rendered pixels for the hardest accent.
    const { page } = build(player({ isPlaying: false }), 'ok', FAKE_ART, [90, 20, 20])
    const key = page.render(NOW, 1_000).keys[3]!
    const buf = renderKey(key)
    let brightest = 0
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) brightest = Math.max(brightest, lum(probe(buf, x, y)))
    }
    expect(brightest).toBeGreaterThan(lum(key.bg!) * 2.5)
  })

  it('breathes from the injected clock only, and advances between frames', () => {
    expect(breathePhase(0)).toBe(0)
    expect(breathePhase(600)).toBeGreaterThan(breathePhase(0))
    // Identical clocks give identical phases, so two renders at one instant match.
    expect(breathePhase(1_234)).toBe(breathePhase(1_234))
    // And a hostile clock degrades rather than reaching a font string as NaN.
    expect(breathePhase(Number.NaN)).toBe(0)
    expect(breathePhase(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('falls back to the theme wash when the album has no colour', () => {
    const { page } = build(player(), 'ok', FAKE_ART, null)
    const key = page.render(NOW, 1_000).keys[3]!
    expect(key.bg).toEqual(controlWash(theme.gray))
    expect(key.glyphColor).toEqual(controlGlyphColor(theme.gray))
  })
})
