import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as esbuild from 'esbuild'
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import {
  renderKey,
  renderStrip,
  probe,
  rainColumnSpan,
  fxRainDropSpan,
  fxSnowFlakeY,
  fxStormStrike,
  fxStormStrikePeriodMs,
  FX_STORM_STRIKE_DURATION_MS,
  fxWindStreakSpan,
  FX_MAX_ALPHA,
  FX_INTENSITY_MIN,
  FX_SNOW_R,
  KEY_SIZE,
  STRIP_WIDTH,
  STRIP_HEIGHT,
  FLASH_RING_INSET,
  FLASH_RING_THICKNESS,
} from '../../src/render/canvas.js'
import { theme } from '../../src/render/theme.js'
import type { FxVariant, KeySpec, Rgb } from '../../src/render/specs.js'

/** Allows a small difference, because canvas anti-aliases edges. */
function near(actual: readonly number[], expected: readonly number[], tol = 12) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(tol)
  }
}

/** Same tolerance as `near`, but returns a boolean instead of asserting, so
 * a probe loop can ask "is this pixel background?" without throwing. */
function near3(actual: readonly number[], expected: readonly number[], tol = 12): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(actual[i]! - expected[i]!) > tol) return false
  }
  return true
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

describe('renderKey', () => {
  it('returns a 96 by 96 image', () => {
    const buf = renderKey({ kind: 'blank' })
    expect(buf.length).toBeGreaterThan(0)
    expect(probe(buf, 0, 0)).toHaveLength(3)
    expect(KEY_SIZE).toBe(96)
  })

  it('fills a blank key with the background colour', () => {
    const buf = renderKey({ kind: 'blank' })
    near(probe(buf, 48, 48), theme.bg)
  })

  it('draws the border colour on the left edge', () => {
    const buf = renderKey({ kind: 'session', border: theme.amber, pulseOn: true })
    near(probe(buf, 1, 48), theme.amber)
  })

  it('draws a dark border when pulseOn is false', () => {
    const buf = renderKey({ kind: 'session', border: theme.amber, pulseOn: false })
    const px = probe(buf, 1, 48)
    expect(px[0]).toBeLessThan(theme.amber[0])
  })

  it('draws a solid border when pulseOn is absent', () => {
    const buf = renderKey({ kind: 'session', border: theme.cyan })
    near(probe(buf, 1, 48), theme.cyan)
  })

  it('draws a bar filled to the given fraction', () => {
    const buf = renderKey({
      kind: 'gauge',
      bar: { value: 1.0, color: theme.green },
    })
    // The bar spans the key width at y = 70. A full bar paints the right end.
    near(probe(buf, 80, 70), theme.green)
  })

  it('leaves the bar track unpainted past the fill', () => {
    const buf = renderKey({
      kind: 'gauge',
      bar: { value: 0.1, color: theme.green },
    })
    near(probe(buf, 80, 70), theme.barTrack)
  })

  it('clamps a bar value above 1', () => {
    const buf = renderKey({ kind: 'gauge', bar: { value: 5, color: theme.green } })
    near(probe(buf, 88, 70), theme.green)
  })

  it('clamps a bar value below 0', () => {
    const buf = renderKey({ kind: 'gauge', bar: { value: -5, color: theme.green } })
    near(probe(buf, 12, 70), theme.barTrack)
  })

  it('paints text pixels somewhere on the key', () => {
    const blank = renderKey({ kind: 'gauge' })
    const withText = renderKey({ kind: 'gauge', lines: ['HELLO'] })
    expect(withText.equals(blank)).toBe(false)
  })

  it('renders an image key from an already-decoded image', async () => {
    const solid = await solidImage(255, 0, 0)
    const buf = renderKey({ kind: 'image', image: solid, imageKey: 'x' })
    near(probe(buf, 48, 48), [255, 0, 0], 20)
  })

  it('dims an image key, so album art darkens with the text beside it', async () => {
    // The image path was the ONE drawing path that ignored `dim`: a decoded
    // bitmap ignores `fillStyle` exactly like a colour emoji does (lesson
    // 15), so it needs `globalAlpha`. Spotify's album art therefore stayed
    // at full brightness while its own key's text and border dimmed, for as
    // long as that page has shipped. Found by a reviewer working on an
    // unrelated page. Break the fix (drop the `globalAlpha` lines) and the
    // two probes below come back equal.
    const solid = await solidImage(200, 200, 200)
    const bright = renderKey({ kind: 'image', image: solid, imageKey: 'x' })
    const dimmed = renderKey({ kind: 'image', image: solid, imageKey: 'x', dim: true })

    const [br, bg, bb] = probe(bright, 48, 48)
    const [dr, dg, db] = probe(dimmed, 48, 48)
    expect(br + bg + bb).toBeGreaterThan(dr + dg + db)
    // And it must dim by the same fraction the text does, not some other
    // amount — a mismatch would read as two unrelated brightnesses on one key.
    expect(dr).toBeLessThan(br)
    expect(dr).toBeGreaterThan(0)
  })

  it('draws the glyph in its default colour when no glyphColor is set', () => {
    const buf = renderKey({ kind: 'control', glyph: '♡' })
    // Just proving it renders without throwing and paints something.
    expect(buf.length).toBeGreaterThan(0)
  })

  it('tints the glyph red when glyphColor is set', () => {
    const buf = renderKey({ kind: 'control', glyph: '♥', glyphColor: theme.red })
    // Task 37 moved the glyph's ink-centre target off the key's arithmetic
    // middle (48, 48) to (48, 36) — see canvas.ts's GLYPH_Y — to leave room
    // for the caption band beneath it, so the probe point moves with it.
    near(probe(buf, 48, 36), theme.red, 40)
  })
})

describe('renderKey glyph optical centring (task 37)', () => {
  // Lesson 17: measure the actual rendered pixels, not the arithmetic
  // advance box. `drawCenteredGlyph` corrects each glyph's OWN measured ink
  // bounds onto the same target point, so every glyph this page uses —
  // despite different shapes and advance widths — must land its ink at the
  // same place.
  function inkCentroid(buf: Buffer): { cx: number; cy: number } {
    let minX = KEY_SIZE, maxX = -1, minY = KEY_SIZE, maxY = -1
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
  }

  it('centres the ink of every one of the four Spotify transport glyphs at the same y, within 1px', () => {
    const glyphs = ['▶', '▮▮', '◀◀', '▶▶', '▲']
    const centres = glyphs.map((glyph) => inkCentroid(renderKey({ kind: 'control', glyph })))
    const ys = centres.map((c) => c.cy)
    for (const y of ys) {
      expect(Math.abs(y - ys[0]!)).toBeLessThanOrEqual(1)
    }
  })

  it('centres the ink horizontally within 1px of the key centre for every transport glyph', () => {
    const glyphs = ['▶', '▮▮', '◀◀', '▶▶', '▲']
    for (const glyph of glyphs) {
      const { cx } = inkCentroid(renderKey({ kind: 'control', glyph }))
      expect(Math.abs(cx - KEY_SIZE / 2)).toBeLessThanOrEqual(1)
    }
  })

  it('leaves a background gap between the glyph and the caption band, then paints the caption', () => {
    const withCaption = renderKey({ kind: 'control', glyph: '▲', glyphCaption: '55%' })
    // A row that must sit below the glyph's own ink and above the caption's
    // ink — background either way. Measured: the glyph's ink bottom sits
    // around y 47 (GLYPH_Y 36 plus its own ~11px half-height) and the
    // caption starts at GLYPH_CAPTION_Y (60).
    for (let x = 0; x < KEY_SIZE; x++) {
      expect(near3(probe(withCaption, x, 52), theme.bg)).toBe(true)
    }
    let inkInCaptionBand = false
    for (let y = 60; y < 74 && !inkInCaptionBand; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        if (!near3(probe(withCaption, x, y), theme.bg)) {
          inkInCaptionBand = true
          break
        }
      }
    }
    expect(inkInCaptionBand).toBe(true)
  })

  it('leaves the caption band blank when glyphCaption is absent, even though the band is reserved', () => {
    const buf = renderKey({ kind: 'control', glyph: '▲' })
    for (let y = 60; y < 74; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        expect(near3(probe(buf, x, y), theme.bg)).toBe(true)
      }
    }
  })

  it('changes the rendered pixels when glyphCaption changes, so a volume change actually redraws', () => {
    const at55 = renderKey({ kind: 'control', glyph: '▲', glyphCaption: '55%' })
    const at65 = renderKey({ kind: 'control', glyph: '▲', glyphCaption: '65%' })
    expect(at55.equals(at65)).toBe(false)
  })

  it('dims the caption like every other text element', () => {
    const bright = renderKey({ kind: 'control', glyph: '▲', glyphCaption: '55%' })
    const dimmed = renderKey({ kind: 'control', glyph: '▲', glyphCaption: '55%', dim: true })
    expect(bright.equals(dimmed)).toBe(false)
  })

  it('draws nothing for glyphCaption with no glyph, matching specs.ts\'s documented contract (r3 M3 review)', () => {
    // `specs.ts` documents glyphCaption as "Ignored unless `glyph` is also
    // set," but the guard used to check `spec.glyphCaption` alone, so this
    // painted 103 ink pixels with no glyph present at all — harmless only
    // because no page today builds a key this way, not because the code
    // agreed with its own doc comment.
    const blank = renderKey({ kind: 'control' })
    const buf = renderKey({ kind: 'control', glyphCaption: '55%' })
    expect(buf.equals(blank)).toBe(true)
  })
})

/**
 * Task 38: `glyphFont: 'emoji'` and `glyphPulse` on the SAME `glyph` field
 * — the emoji transport row and the volume key's "thump," the user's pick
 * over task 37's plain-text variant (still available via `glyphFont:
 * 'text'`/absent, covered by the "glyph optical centring (task 37)" suite
 * above, which is now a regression guard for the non-default path).
 */
describe('renderKey glyph emoji mode and pulse (task 38)', () => {
  function inkCentroid(buf: Buffer): { cx: number; cy: number } {
    let minX = KEY_SIZE, maxX = -1, minY = KEY_SIZE, maxY = -1
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
  }

  function chromaticCount(buf: Buffer): number {
    let n = 0
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        const [r, g, b] = probe(buf, x, y)
        if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) > 20) n++
      }
    }
    return n
  }

  it('centres the ink of every emoji-mode transport glyph near the intended target y, not merely relative to each other (r3 C review)', () => {
    // The r3 review's finding: the four media-control emoji (⏮️ ▶️ ⏸️ ⏭️) draw
    // as full-bleed rounded squares with BYTE-IDENTICAL ink boxes by
    // construction — same target draw point, same shape — so comparing them
    // only to EACH OTHER (the old form of this test) can never fail, even for
    // a bug that shifted every one of them off-target by the SAME amount.
    // Pinning to the measured absolute value (ink centre y 29.5 for the four
    // squares, 30 for 🔊 — both against the renderer's own target,
    // `EMOJI_GLYPH_Y` = 30) gives this real teeth: a target shifted by even a
    // few pixels now fails it.
    const glyphs = ['⏮️', '▶️', '⏸️', '⏭️', '🔊']
    for (const glyph of glyphs) {
      const { cy } = inkCentroid(renderKey({ kind: 'control', glyph, glyphFont: 'emoji' }))
      expect(cy).toBeGreaterThanOrEqual(28)
      expect(cy).toBeLessThanOrEqual(31)
    }
  })

  it('draws real colour, proving the emoji font (not the text fallback) actually rendered', () => {
    const buf = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji' })
    expect(chromaticCount(buf)).toBeGreaterThan(50)
  })

  it('draws visibly different pixels than the same codepoint drawn as a text glyph', () => {
    // The task 37 measurement error this corrects: under the plain-text
    // font, this codepoint has no coverage and falls back to `.notdef` —
    // never chromatic, and a different shape than the real emoji.
    const asEmoji = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji' })
    const asText = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'text' })
    expect(asEmoji.equals(asText)).toBe(false)
    expect(chromaticCount(asText)).toBe(0)
  })

  it('dims the emoji glyph via globalAlpha, proven by a drop in chromatic pixels, not just any pixel difference', () => {
    // Lesson 15: colour emoji ignore `fillStyle`. A test that only checked
    // "the buffers differ" could pass even if dimming quietly did nothing
    // to the emoji's own colour — this checks the SPECIFIC signal
    // `globalAlpha` blending toward the near-black background produces:
    // measurably fewer pixels read as chromatic once dimmed.
    const bright = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji' })
    const dimmed = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji', dim: true })
    const brightChroma = chromaticCount(bright)
    const dimChroma = chromaticCount(dimmed)
    expect(brightChroma).toBeGreaterThan(50)
    expect(dimChroma).toBeLessThan(brightChroma * 0.6)
  })

  it('leaves the caption band clear of the emoji glyph at rest, same row as the text variant', () => {
    const buf = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji', glyphCaption: '55%' })
    // Row 52: background for the text-glyph variant (task 37's own gap
    // test) — also background here, proving the taller emoji still clears
    // the SAME reserved gap rather than needing a lower caption row.
    for (let x = 0; x < KEY_SIZE; x++) {
      expect(near3(probe(buf, x, 52), theme.bg)).toBe(true)
    }
    let inkInCaptionBand = false
    for (let y = 60; y < 74 && !inkInCaptionBand; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) {
          inkInCaptionBand = true
          break
        }
      }
    }
    expect(inkInCaptionBand).toBe(true)
  })

  it('leaves the caption band clear even at the thump animation\'s LARGEST frame, not just at rest', () => {
    // phase = π/2 is glyphPulse's maximum (sin = 1), the biggest the glyph
    // ever gets — the case that could crowd the caption if it were going
    // to at all.
    const buf = renderKey({
      kind: 'control', glyph: '🔊', glyphFont: 'emoji',
      glyphPulse: { phase: Math.PI / 2 }, glyphCaption: '55%',
    })
    for (let x = 0; x < KEY_SIZE; x++) {
      expect(near3(probe(buf, x, 55), theme.bg)).toBe(true)
    }
  })

  it('keeps the widest realistic caption\'s ink within a tight, measured margin at the pulse\'s LARGEST frame, not just at rest (r3 M2 review)', () => {
    // The r3 review's finding: probing one fixed column (90) 30px past the
    // caption's own measured ink edge meant this assertion only started to
    // fail at FOURTEEN characters — the real caption ('100%', from
    // `volumeLabel`) never comes remotely close, so the old form of this
    // test proved nothing beyond "100% measures under 81px", which the
    // "measured text width" describe block below already covers on its own.
    // Tying the probe to the caption's OWN measured ink edge (lesson 17:
    // measure, do not guess a pixel count), with a small fixed margin
    // instead of a 30px one, gives this real teeth: a bug that grew the
    // caption's font or shifted its centring by even a few pixels now fails
    // it, and the pulse's largest frame (phase π/2) is still the frame under
    // test, in case the growing glyph ever pushed the caption's own position.
    const caption = '100%'
    const buf = renderKey({
      kind: 'control', glyph: '🔊', glyphFont: 'emoji',
      glyphPulse: { phase: Math.PI / 2 }, glyphCaption: caption,
    })
    const measure = createCanvas(KEY_SIZE, KEY_SIZE).getContext('2d')
    measure.font = '11px Menlo'
    measure.textAlign = 'center'
    const m = measure.measureText(caption)
    const rightEdge = Math.ceil(KEY_SIZE / 2 + m.actualBoundingBoxRight)
    // 6px of margin, not 30: comfortably clear of anti-aliasing, tight
    // enough to catch a real regression.
    for (let y = 60; y < 74; y++) {
      expect(near3(probe(buf, rightEdge + 6, y), theme.bg)).toBe(true)
    }
    // Proves the probe point is meaningful, not merely far from wherever the
    // caption happened to paint: ink actually appears just inside the
    // measured edge.
    let inkNearEdge = false
    for (let y = 60; y < 74 && !inkNearEdge; y++) {
      if (!near3(probe(buf, rightEdge - 2, y), theme.bg)) inkNearEdge = true
    }
    expect(inkNearEdge).toBe(true)
  })

  it('renders a visibly different frame at two different pulse phases', () => {
    const a = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji', glyphPulse: { phase: 0 } })
    const b = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji', glyphPulse: { phase: Math.PI / 2 } })
    expect(a.equals(b)).toBe(false)
  })

  it('grows the glyph\'s ink footprint at the pulse peak versus its resting size', () => {
    function inkCount(buf: Buffer): number {
      let n = 0
      for (let y = 0; y < KEY_SIZE; y++) {
        for (let x = 0; x < KEY_SIZE; x++) {
          if (!near3(probe(buf, x, y), theme.bg)) n++
        }
      }
      return n
    }
    const rest = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji', glyphPulse: { phase: 0 } })
    const peak = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji', glyphPulse: { phase: Math.PI / 2 } })
    expect(inkCount(peak)).toBeGreaterThan(inkCount(rest))
  })

  it('keeps the pulsing glyph\'s ink centred at every phase sampled across one cycle, within 1.5px', () => {
    const phases = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]
    const centres = phases.map((phase) =>
      inkCentroid(renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji', glyphPulse: { phase } })),
    )
    for (const c of centres) {
      expect(Math.abs(c.cx - KEY_SIZE / 2)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(c.cy - centres[0]!.cy)).toBeLessThanOrEqual(1.5)
    }
  })

  it('draws byte-identically to the un-pulsed glyph when glyphPulse is absent (scale defaults to 1)', () => {
    const withoutField = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji' })
    const explicitRest = renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji', glyphPulse: { phase: 0 } })
    // phase 0 -> sin(0) = 0 -> scale 1, so this should match the no-pulse
    // path exactly, proving `glyphPulse` at rest changes nothing.
    expect(withoutField.equals(explicitRest)).toBe(true)
  })

  it('leaves the plain-text glyph path byte-identical when glyphFont and glyphPulse are both absent (regression guard)', () => {
    // The plain-text path (task 37, still available via `glyphFont: 'text'`
    // or absent) must render exactly as it did before task 38's fields
    // existed. This is the same guarantee lineSizes/lineY/labelBand each
    // got when they were added.
    const buf = renderKey({ kind: 'control', glyph: '♥', glyphColor: theme.red })
    expect(sha256(buf)).toBe(
      '5a1f8affe73ef43caa860fa0c2b26c24f24a091e29f999284373c9d851cb071f',
    )
  })
})

/**
 * Builds a 300 by 300 decoded image with a distinct solid colour in each
 * quadrant: red top-left, green top-right, blue bottom-left, yellow
 * bottom-right. This stands in for real album art (which arrives as JPEG),
 * and lets a test prove a crop draws the RIGHT quarter, not just any quarter.
 */
async function quadrantImage(): Promise<Image> {
  const size = 300
  const half = size / 2
  const c = createCanvas(size, size)
  const ctx = c.getContext('2d')
  ctx.fillStyle = 'rgb(255,0,0)' // top-left: red
  ctx.fillRect(0, 0, half, half)
  ctx.fillStyle = 'rgb(0,255,0)' // top-right: green
  ctx.fillRect(half, 0, half, half)
  ctx.fillStyle = 'rgb(0,0,255)' // bottom-left: blue
  ctx.fillRect(0, half, half, half)
  ctx.fillStyle = 'rgb(255,255,0)' // bottom-right: yellow
  ctx.fillRect(half, half, half, half)
  return loadImage(c.toBuffer('image/jpeg'))
}

describe('renderKey imageCrop', () => {
  it('draws the whole image edge to edge when imageCrop is absent, exactly as before', async () => {
    const solid = await solidImage(10, 20, 30)
    const buf = renderKey({ kind: 'image', image: solid, imageKey: 'x' })
    near(probe(buf, 0, 0), [10, 20, 30], 20)
    near(probe(buf, 95, 95), [10, 20, 30], 20)
  })

  it('draws only the top-left quadrant when cropped to it', async () => {
    const img = await quadrantImage()
    const buf = renderKey({
      kind: 'image', image: img, imageKey: 'track-1',
      imageCrop: { sx: 0.0, sy: 0.0, sw: 0.5, sh: 0.5 },
    })
    near(probe(buf, 48, 48), [255, 0, 0], 30)
  })

  it('draws only the top-right quadrant when cropped to it', async () => {
    const img = await quadrantImage()
    const buf = renderKey({
      kind: 'image', image: img, imageKey: 'track-1',
      imageCrop: { sx: 0.5, sy: 0.0, sw: 0.5, sh: 0.5 },
    })
    near(probe(buf, 48, 48), [0, 255, 0], 30)
  })

  it('draws only the bottom-left quadrant when cropped to it', async () => {
    const img = await quadrantImage()
    const buf = renderKey({
      kind: 'image', image: img, imageKey: 'track-1',
      imageCrop: { sx: 0.0, sy: 0.5, sw: 0.5, sh: 0.5 },
    })
    near(probe(buf, 48, 48), [0, 0, 255], 30)
  })

  it('draws only the bottom-right quadrant when cropped to it', async () => {
    const img = await quadrantImage()
    const buf = renderKey({
      kind: 'image', image: img, imageKey: 'track-1',
      imageCrop: { sx: 0.5, sy: 0.5, sw: 0.5, sh: 0.5 },
    })
    near(probe(buf, 48, 48), [255, 255, 0], 30)
  })

  it('produces four different key buffers for the four quadrant crops of the same image', async () => {
    const img = await quadrantImage()
    const crops = [
      { sx: 0.0, sy: 0.0, sw: 0.5, sh: 0.5 },
      { sx: 0.5, sy: 0.0, sw: 0.5, sh: 0.5 },
      { sx: 0.0, sy: 0.5, sw: 0.5, sh: 0.5 },
      { sx: 0.5, sy: 0.5, sw: 0.5, sh: 0.5 },
    ]
    const buffers = crops.map((imageCrop) =>
      renderKey({ kind: 'image', image: img, imageKey: 'track-1', imageCrop }),
    )
    for (let i = 0; i < buffers.length; i++) {
      for (let j = i + 1; j < buffers.length; j++) {
        expect(buffers[i]!.equals(buffers[j]!)).toBe(false)
      }
    }
  })

  it('draws nothing extra for a zero-width crop, and does not throw', async () => {
    const img = await quadrantImage()
    const blank = renderKey({ kind: 'image', imageKey: 'x' })
    expect(() =>
      renderKey({
        kind: 'image', image: img, imageKey: 'track-1',
        imageCrop: { sx: 0.2, sy: 0.2, sw: 0, sh: 0.5 },
      }),
    ).not.toThrow()
    const buf = renderKey({
      kind: 'image', image: img, imageKey: 'track-1',
      imageCrop: { sx: 0.2, sy: 0.2, sw: 0, sh: 0.5 },
    })
    expect(buf.equals(blank)).toBe(true)
  })

  it('draws nothing extra for a negative-height crop, and does not throw', async () => {
    const img = await quadrantImage()
    const blank = renderKey({ kind: 'image', imageKey: 'x' })
    expect(() =>
      renderKey({
        kind: 'image', image: img, imageKey: 'track-1',
        imageCrop: { sx: 0.2, sy: 0.2, sw: 0.5, sh: -0.3 },
      }),
    ).not.toThrow()
    const buf = renderKey({
      kind: 'image', image: img, imageKey: 'track-1',
      imageCrop: { sx: 0.2, sy: 0.2, sw: 0.5, sh: -0.3 },
    })
    expect(buf.equals(blank)).toBe(true)
  })

  it('clamps crop fractions outside 0 to 1, rather than throwing or wrapping', async () => {
    const img = await quadrantImage()
    // sx negative and sw past 1: clamps to something inside the image, and
    // must not throw despite the out-of-range fractions.
    expect(() =>
      renderKey({
        kind: 'image', image: img, imageKey: 'track-1',
        imageCrop: { sx: -0.5, sy: -0.5, sw: 2, sh: 2 },
      }),
    ).not.toThrow()
  })
})

describe('renderStrip', () => {
  it('returns a 248 by 58 image', () => {
    expect(STRIP_WIDTH).toBe(248)
    expect(STRIP_HEIGHT).toBe(58)
    const buf = renderStrip({ lines: ['hello'] })
    near(probe(buf, 240, 4, STRIP_WIDTH), theme.bg)
  })

  it('draws a progress bar filled to the fraction', () => {
    const buf = renderStrip({
      lines: ['a', 'b'],
      bar: { value: 1.0, color: theme.green },
    })
    near(probe(buf, 200, 50, STRIP_WIDTH), theme.green)
  })
})

/**
 * I3 from the r3 review: `renderStrip`'s own measurement (52d3ddb) was
 * covered only indirectly, from two page test files
 * (`tests/pages/spotify-page.test.ts`, `tests/pages/claude-page.test.ts`),
 * each pinning one page's own content. Direct coverage here, at the
 * renderer's own level, with the widest realistic content the review asked
 * for: a long artist beside `120:00 / 120:00`, and this repository's own
 * name on the Claude strip.
 */
describe('renderStrip measurement (I3): direct coverage at the renderer level', () => {
  const STRIP_RIGHT_PAD = 6 // matches canvas.ts's PAD

  function hasInk(buf: Buffer, x: number, y: number): boolean {
    return !near3(probe(buf, x, y, STRIP_WIDTH), theme.bg)
  }

  it('keeps a long artist beside the widest realistic clock (120:00 / 120:00) inside the strip, with no overlap', () => {
    const buf = renderStrip({
      lines: ['Everlong (Acoustic Version — Live at Wembley Arena)', 'Foo Fighters and the Colour and the Shape Band'],
      right: '120:00 / 120:00',
    })
    // Nothing paints past the usable band's own right edge.
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      expect(hasInk(buf, STRIP_WIDTH - STRIP_RIGHT_PAD + 2, y)).toBe(false)
    }
    // Line 2's own text and the right-aligned clock share one row band
    // (around STRIP_LINE_2_Y, 21) — find each side's own ink and prove they
    // do not overlap, the exact defect I5 found by measurement on an
    // 18-character artist.
    let line2RightmostInk = -1
    let rightLeftmostInk = STRIP_WIDTH
    for (let y = 18; y < 34; y++) {
      for (let x = 0; x < STRIP_WIDTH; x++) {
        if (!hasInk(buf, x, y)) continue
        if (x < STRIP_WIDTH / 2 && x > line2RightmostInk) line2RightmostInk = x
        if (x > STRIP_WIDTH / 2 && x < rightLeftmostInk) rightLeftmostInk = x
      }
    }
    expect(line2RightmostInk).toBeGreaterThan(0)
    expect(rightLeftmostInk).toBeLessThan(STRIP_WIDTH)
    expect(rightLeftmostInk).toBeGreaterThan(line2RightmostInk)
  })

  it('fits this repository\'s own name on the Claude strip\'s line 1, with no right-hand clock', () => {
    const buf = renderStrip({ lines: ['streamdeckneoclaude · Bash · 2h11m'] })
    // Line 1 occupies roughly rows 4 to 17 (13px Menlo, baseline top y = 4).
    for (let y = 0; y < 17; y++) {
      expect(hasInk(buf, STRIP_WIDTH - STRIP_RIGHT_PAD + 2, y)).toBe(false)
    }
    let anyInk = false
    for (let y = 0; y < 17 && !anyInk; y++) {
      for (let x = 0; x < STRIP_WIDTH; x++) {
        if (hasInk(buf, x, y)) { anyInk = true; break }
      }
    }
    expect(anyInk).toBe(true)
  })

  it('never lets line 2 spill past the left padding, even when right is unrealistically wide (M4)', () => {
    // M4 from the review: `shrinkToFit`'s old last-resort return (`'…'`,
    // unconditional) could itself measure past `maxWidth` when `maxWidth`
    // was driven to (near) zero by an oversized `right` — no real page
    // produces this (the widest real value, `120:00 / 120:00`, measures
    // 117.4px), but the fix makes the function itself safe regardless of
    // what a future caller passes.
    const buf = renderStrip({ lines: ['title', 'B'.repeat(60)], right: 'X'.repeat(40) })
    for (let y = 18; y < 34; y++) {
      for (let x = 0; x < STRIP_RIGHT_PAD; x++) {
        expect(hasInk(buf, x, y)).toBe(false)
      }
    }
  })
})

describe('renderKey spark', () => {
  it('changes the rendered pixels when a spark is present', () => {
    const without = renderKey({ kind: 'gauge' })
    const withSpark = renderKey({
      kind: 'gauge',
      spark: { values: [1, 5, 2, 8, 3, 6], color: theme.green },
    })
    expect(withSpark.equals(without)).toBe(false)
  })

  it('draws a centred line for a flat series without dividing by zero', () => {
    expect(() =>
      renderKey({ kind: 'gauge', spark: { values: [4, 4, 4, 4], color: theme.green } }),
    ).not.toThrow()
    const flat = renderKey({ kind: 'gauge', spark: { values: [4, 4, 4, 4], color: theme.green } })
    const blank = renderKey({ kind: 'gauge' })
    expect(flat.equals(blank)).toBe(false)
  })

  it('draws nothing for an empty series', () => {
    const blank = renderKey({ kind: 'gauge' })
    const withSpark = renderKey({ kind: 'gauge', spark: { values: [], color: theme.green } })
    expect(withSpark.equals(blank)).toBe(true)
  })

  it('draws nothing for a single value', () => {
    const blank = renderKey({ kind: 'gauge' })
    const withSpark = renderKey({ kind: 'gauge', spark: { values: [7], color: theme.green } })
    expect(withSpark.equals(blank)).toBe(true)
  })

  describe('slice (the stock detail chart spanning 3 keys)', () => {
    const values = Array.from({ length: 24 }, (_, i) => Math.sin(i / 2) * 10 + i)

    it('draws different pixels for each of the three slice indices of the same series', () => {
      const bufs = [0, 1, 2].map((index) =>
        renderKey({
          kind: 'gauge',
          spark: { values, color: theme.green, slice: { index, count: 3 } },
        }),
      )
      expect(bufs[0]!.equals(bufs[1]!)).toBe(false)
      expect(bufs[1]!.equals(bufs[2]!)).toBe(false)
      expect(bufs[0]!.equals(bufs[2]!)).toBe(false)
    })

    it('draws something (not blank) for every slice index', () => {
      const blank = renderKey({ kind: 'gauge' })
      for (const index of [0, 1, 2]) {
        const buf = renderKey({
          kind: 'gauge',
          spark: { values, color: theme.green, slice: { index, count: 3 } },
        })
        expect(buf.equals(blank)).toBe(false)
      }
    })

    it('draws nothing for a slice with fewer than 2 values, same as the non-sliced path', () => {
      const blank = renderKey({ kind: 'gauge' })
      const buf = renderKey({
        kind: 'gauge',
        spark: { values: [7], color: theme.green, slice: { index: 0, count: 3 } },
      })
      expect(buf.equals(blank)).toBe(true)
    })

    it('normalises min and max over the WHOLE series, not just the visible slice', () => {
      // A monotonically increasing series: slice 0 sees only its own low
      // values. If it normalised against just its own slice, its tallest bar
      // would reach the top. Against the whole series, it must not.
      const rising = Array.from({ length: 30 }, (_, i) => i)
      const wholeKey = renderKey({ kind: 'gauge', spark: { values: rising, color: theme.green } })
      const sliceZero = renderKey({
        kind: 'gauge',
        spark: { values: rising, color: theme.green, slice: { index: 0, count: 3 } },
      })
      // Different geometry (only a third of the bars, over a third of the
      // width), so the buffers differ, but slice 0 alone must not paint a
      // full-height bar the way the whole, self-normalised key does at its
      // OWN tallest point — proven indirectly: slice 0's tallest bar sits
      // lower than SPARK_Y (48), because its own local max (index 9 of 0..29)
      // is far below the series max (29).
      expect(sliceZero.equals(wholeKey)).toBe(false)
      let topInkRow = -1
      for (let y = 0; y < KEY_SIZE && topInkRow < 0; y++) {
        for (let x = 0; x < KEY_SIZE; x++) {
          if (!near3(probe(sliceZero, x, y), theme.bg)) {
            topInkRow = y
            break
          }
        }
      }
      // SPARK_Y is 48; a bar normalised to the whole series' max (29) from a
      // local max of only 9 cannot reach anywhere near the top of the spark
      // band. If it wrongly self-normalised to fill the band, ink would start
      // at 48 - 40 = 8. Requiring it start no earlier than row 40 proves the
      // full series' max, not the slice's own max, set the scale.
      expect(topInkRow).toBeGreaterThanOrEqual(40)
    })
  })

  // The regression guard the task brief demands: the grid's single-key
  // sparkline (no `slice`) must render byte-identically to the hash captured
  // BEFORE `slice` support was added to `drawSpark`, the same way Task 23
  // proved `lineSizes` did not disturb the pages that never set it.
  it('renders a single-key spark byte-identically to the pre-slice snapshot (8 points)', () => {
    const buf = renderKey({
      kind: 'gauge',
      spark: { values: [1, 5, 2, 8, 3, 6, 9, 4], color: theme.green },
    })
    expect(sha256(buf)).toBe(
      'c1790257f8b27077f656deff392c0c31afb6a864ebc7ed884109f0b73a2cc748',
    )
  })

  it('renders a single-key spark byte-identically to the pre-slice snapshot (12 points)', () => {
    const buf = renderKey({
      kind: 'gauge',
      spark: { values: [1, 5, 2, 8, 3, 6, 9, 4, 7, 2, 5, 1], color: theme.red },
    })
    expect(sha256(buf)).toBe(
      'e412e112d97f631eb7217b7300a232dcdb9d0edefc41d5624fee776f58515605',
    )
  })

  it('dims the spark like every other element', () => {
    const bright = renderKey({
      kind: 'gauge',
      spark: { values: [1, 5, 2, 8], color: theme.green },
    })
    const dimmed = renderKey({
      kind: 'gauge',
      spark: { values: [1, 5, 2, 8], color: theme.green },
      dim: true,
    })
    expect(bright.equals(dimmed)).toBe(false)
  })
})

describe('renderKey emoji', () => {
  it('changes the rendered pixels when an emoji is present', () => {
    const without = renderKey({ kind: 'gauge' })
    const withEmoji = renderKey({ kind: 'gauge', emoji: '☀️' })
    expect(withEmoji.equals(without)).toBe(false)
  })

  it('draws real colour, not just gray text, proving the colour emoji font rendered', () => {
    const buf = renderKey({ kind: 'gauge', emoji: '⛈' })
    let colourful = false
    for (let y = 10; y < KEY_SIZE - 10 && !colourful; y++) {
      for (let x = 10; x < KEY_SIZE - 10; x++) {
        const [r, g, b] = probe(buf, x, y)
        if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) > 20) {
          colourful = true
          break
        }
      }
    }
    expect(colourful).toBe(true)
  })

  it('draws a line as well as the emoji, in the same key', () => {
    const emojiOnly = renderKey({ kind: 'gauge', emoji: '☀️' })
    const withLine = renderKey({ kind: 'gauge', emoji: '☀️', lines: ['NOW'] })
    expect(withLine.equals(emojiOnly)).toBe(false)
  })

  it('dims the emoji like every other element, proving globalAlpha is honoured', () => {
    // Colour emoji are bitmap glyphs and ignore `fillStyle`; only
    // `globalAlpha` can dim them. This is the regression the task brief
    // calls out: without it, a stale key's emoji stays full brightness while
    // its text and border correctly dim.
    const bright = renderKey({ kind: 'gauge', emoji: '☀️' })
    const dimmed = renderKey({ kind: 'gauge', emoji: '☀️', dim: true })
    expect(bright.equals(dimmed)).toBe(false)
  })

  it('keeps the emoji inside band 2 (y 17 to 51), clear of the temperature band below', () => {
    const buf = renderKey({ kind: 'gauge', emoji: '☀️' })
    const inkOnRow = (y: number) => {
      for (let x = 20; x < KEY_SIZE - 20; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) return true
      }
      return false
    }
    // Near the emoji's own centre, y 34: ink is present.
    expect(inkOnRow(34)).toBe(true)
    // Down at y 60, well past band 2's y 51 floor: no emoji ink reaches here.
    expect(inkOnRow(60)).toBe(false)
  })
})

describe('renderKey lineColors', () => {
  it('changes the rendered pixels when a line colour is set', () => {
    const uncoloured = renderKey({ kind: 'gauge', lines: ['TSLA', '327.51', '▼ 1.59%'] })
    const coloured = renderKey({
      kind: 'gauge',
      lines: ['TSLA', '327.51', '▼ 1.59%'],
      lineColors: [undefined, undefined, theme.red],
    })
    expect(coloured.equals(uncoloured)).toBe(false)
  })
})

describe('renderKey lineSizes', () => {
  it('renders a line at 28 px differently than the same line at 11 px', () => {
    const small = renderKey({ kind: 'gauge', lines: ['20%'], lineSizes: [11] })
    const big = renderKey({ kind: 'gauge', lines: ['20%'], lineSizes: [28] })
    expect(small.equals(big)).toBe(false)
  })

  it('falls back to the default size for a missing lineSizes entry', () => {
    // lineSizes has no entry for the second line, so it should fall back to
    // 11, exactly as if 11 had been written explicitly.
    const implicit = renderKey({ kind: 'gauge', lines: ['5-HR CAP', '20%'], lineSizes: [11] })
    const explicit = renderKey({ kind: 'gauge', lines: ['5-HR CAP', '20%'], lineSizes: [11, 11] })
    expect(implicit.equals(explicit)).toBe(true)
  })

  it('advances by size plus 4, matching the measured y positions for an 11/28 pair', () => {
    // Per the brief: an 11 px line at y 6 is followed by a 28 px line at
    // y 21, an advance of 15 (11 + 4). Probe just above and at the second
    // line's start row to confirm the label has finished and the value has
    // not started early.
    const buf = renderKey({ kind: 'gauge', lines: ['5-HR CAP', '20%'], lineSizes: [11, 28] })
    let firstInkRow = -1
    for (let y = 0; y < 30 && firstInkRow < 0; y++) {
      for (let x = 9; x < 90; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) {
          firstInkRow = y
          break
        }
      }
    }
    expect(firstInkRow).toBeGreaterThanOrEqual(6)
    expect(firstInkRow).toBeLessThan(21)

    // T2 from the review: the check above only ever finds LINE 0's ink,
    // because it scans from y=0 upward and line 0 always paints first. A
    // bug that used the wrong running `y` for line 1 (for example
    // `y = y + advance` instead of `y = drawY + advance`) would still pass
    // it. Scanning strictly AFTER line 0's own ink has ended isolates line
    // 1 and pins its start to the correct automatic position, 21.
    const inkAt = (y: number) => {
      for (let x = 9; x < 90; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) return true
      }
      return false
    }
    expect(inkAt(17)).toBe(false) // line 0 (11 px, starts y 6) has finished
    let line1Start = -1
    for (let y = 18; y < 30 && line1Start < 0; y++) {
      if (inkAt(y)) line1Start = y
    }
    // Measured: line 1 (28 px) starts painting ink at row 23.
    expect(line1Start).toBeGreaterThanOrEqual(21)
    expect(line1Start).toBeLessThan(26)
  })

  it('does not overlap three lines at 11, 24 and 11 px: gaps stay background, lines carry ink', () => {
    const buf = renderKey({
      kind: 'gauge',
      lines: ['AAAA', 'BBBB', 'CCCC'],
      lineSizes: [11, 24, 11],
    })
    const inkSomewhere = (y: number) => {
      for (let x = 9; x < 90; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) return true
      }
      return false
    }
    // Ink within each line (measured, see tests/render/_probe scan used to
    // derive these rows: line 0 paints 7-14, line 1 paints 22-39, line 2
    // paints 50-57).
    expect(inkSomewhere(10)).toBe(true)
    expect(inkSomewhere(30)).toBe(true)
    expect(inkSomewhere(53)).toBe(true)
    // Background in the gaps between them.
    expect(inkSomewhere(18)).toBe(false)
    expect(inkSomewhere(44)).toBe(false)
  })

  // The regression guard: Spotify and stocks never set lineSizes, so they
  // must render byte-identically to how they did before this field existed.
  // These hashes were captured from renderKey BEFORE lineSizes was added to
  // canvas.ts, against the exact KeySpecs those pages build. Weather used to
  // have a snapshot here too, but task 24 deliberately changed its emoji
  // size, position and dimming and gave it its own banded layout — its
  // regression coverage is now the geometric band/gap probes below, plus
  // `tests/pages/weather-page.test.ts`, rather than a frozen hash of the old,
  // overlapping rendering.
  it('renders a stocks-like key byte-identically to the pre-lineSizes snapshot', () => {
    const buf = renderKey({
      kind: 'gauge',
      lines: ['TSLA', '327.51', '▼ 1.59%'],
      lineColors: [undefined, undefined, theme.red],
    })
    expect(sha256(buf)).toBe(
      'e07d0e4ed7e055e58d977fe94abd2d3f8e687a36ac5a06cdbc367bfbd8462181',
    )
  })

  // This snapshot intentionally changed under task 37: the Spotify glyph
  // path moved from arithmetic centring at (48, 48) with a fixed 28px size
  // to ink-centred drawing at (48, 36) with GLYPH_SIZE (34px), fixing the
  // "not all centred" defect a real user reported on the four transport
  // keys. Frozen again at its new value, the same pattern the weather page's
  // retired snapshot used after its own deliberate task 24 layout change.
  it('renders a spotify-like key byte-identically to the post-task-37 glyph layout', () => {
    const buf = renderKey({ kind: 'control', glyph: '♥', glyphColor: theme.red })
    expect(sha256(buf)).toBe(
      '5a1f8affe73ef43caa860fa0c2b26c24f24a091e29f999284373c9d851cb071f',
    )
  })

  it('renders a claude-gauge-like key byte-identically across this change', () => {
    // Claude's gauge tiles (task 23) use lineSizes and align but never
    // emoji, sprite or lineY — nothing this task touches. This hash was
    // captured against the current code, before task 24's edits, from the
    // exact shape `ClaudePage.capKey` builds.
    const buf = renderKey({
      kind: 'gauge',
      lines: ['5-HR CAP', '62%'],
      lineSizes: [11, 28],
      align: 'center',
      bar: { value: 0.62, color: theme.amber },
    })
    expect(sha256(buf)).toBe(
      'dccb9afefb4a01d1908fd106e0000bd776e9fe695961d9ff1803fd17af08a7bc',
    )
  })
})

describe('renderKey lineY', () => {
  it('places a line at an explicit y instead of the automatic position', () => {
    const auto = renderKey({ kind: 'gauge', lines: ['HI'] })
    const explicit = renderKey({ kind: 'gauge', lines: ['HI'], lineY: [50] })
    expect(auto.equals(explicit)).toBe(false)
  })

  it('keeps the running automatic advance for a line with no lineY entry', () => {
    // Only line 0 gets an explicit y (3). Line 1 has no lineY entry, so it
    // must continue from wherever line 0's explicit position plus its
    // advance landed — 3 + 14 = 17 — not from the original default start of
    // 6, and not by resetting to some other fixed value.
    const buf = renderKey({ kind: 'gauge', lines: ['A', 'B'], lineY: [3] })
    const inkAt = (y: number) => {
      for (let x = 9; x < 90; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) return true
      }
      return false
    }
    let firstInkRow = -1
    for (let y = 0; y < 30 && firstInkRow < 0; y++) {
      if (inkAt(y)) firstInkRow = y
    }
    expect(firstInkRow).toBeGreaterThanOrEqual(3)
    expect(firstInkRow).toBeLessThan(17)

    // T2 from the review: the check above only ever finds LINE 0's ink
    // (drawn at explicit y 3), so a bug that used the wrong running `y` for
    // line 1 — for example `y = y + advance` (landing on the ORIGINAL
    // default start, 6 + 14 = 20) instead of `y = drawY + advance` (the
    // correct 3 + 14 = 17) — would still pass it. Scanning strictly after
    // line 0's own ink has ended isolates line 1 and pins its start to the
    // correct value, not the buggy one.
    expect(inkAt(12)).toBe(false) // line 0 (starts y 3) has finished by here
    let line1Start = -1
    for (let y = 13; y < 25 && line1Start < 0; y++) {
      if (inkAt(y)) line1Start = y
    }
    // Measured: the correct automatic advance paints line 1's first ink at
    // row 18. The buggy alternative above would land several rows later.
    expect(line1Start).toBeGreaterThanOrEqual(17)
    expect(line1Start).toBeLessThan(20)
  })

  it('does not affect rendering when lineY is absent, matching the automatic advance exactly', () => {
    // T1 from the review: comparing a spec to itself twice is vacuous — it
    // passes for any implementation, including one that ignores lineY
    // entirely. Comparing lineY-ABSENT against an EXPLICIT lineY that
    // matches the known automatic positions (PAD=6 for line 0, then
    // 6 + (11+4) = 21 for line 1) proves the two paths truly agree, not
    // just that rendering is deterministic.
    const spec = { kind: 'gauge' as const, lines: ['5-HR CAP', '20%'], lineSizes: [11, 28] }
    const withoutLineY = renderKey(spec)
    const withMatchingLineY = renderKey({ ...spec, lineY: [6, 21] })
    expect(withoutLineY.equals(withMatchingLineY)).toBe(true)
  })
})

// T3 from the review: a "no overlap" proof used to live here, hand-writing
// the weather page's own lineSizes/lineY/bg constants rather than rendering
// its real output — decoupled, so it could not have caught finding A4 (the
// empty-tile placeholder that skipped the banded layout entirely). That
// geometric proof now renders `WeatherPage`'s actual `dayKey` output,
// across all eight condition tints (T4), in
// `tests/pages/weather-page.test.ts`, under "day tile: rendered band
// geometry has no overlap, for every condition".

describe('renderKey spark labelBand and label (the stocks 52-week chart caption)', () => {
  // Monotonically increasing, so the tallest bar (the last value) reaches
  // the full band height — the worst case for an accidental overlap between
  // the bars and the reserved caption band above them.
  const rising = Array.from({ length: 30 }, (_, i) => i)

  function topInkRow(buf: Buffer): number {
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) return y
      }
    }
    return KEY_SIZE
  }

  it('reserves a band at the top so no bar paints into it, even at its tallest', () => {
    const withLabel = renderKey({
      kind: 'gauge',
      spark: { values: rising, color: theme.green, fullHeight: true, labelBand: true },
    })
    // Lesson 14: assert the gap is background, not just that the bars moved.
    // Row 10 sits inside the reserved band (rows 6 to 23) regardless of the
    // series' own values, because the reservation is a fixed geometry
    // change, not something the data can push into.
    for (let x = 0; x < KEY_SIZE; x++) {
      expect(near3(probe(withLabel, x, 10), theme.bg)).toBe(true)
    }
    // The tallest bar still paints somewhere, just lower down than without
    // the reservation.
    const withoutLabel = renderKey({
      kind: 'gauge',
      spark: { values: rising, color: theme.green, fullHeight: true },
    })
    expect(topInkRow(withLabel)).toBeGreaterThan(topInkRow(withoutLabel))
  })

  it('draws the caption inside the reserved band when label is set', () => {
    const buf = renderKey({
      kind: 'gauge',
      spark: { values: rising, color: theme.green, fullHeight: true, labelBand: true, label: '52 WK' },
    })
    let inkInBand = false
    for (let y = 6; y < 24 && !inkInBand; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) {
          inkInBand = true
          break
        }
      }
    }
    expect(inkInBand).toBe(true)
  })

  it('draws nothing extra for labelBand with no label — reserves the space but leaves it blank', () => {
    const buf = renderKey({
      kind: 'gauge',
      spark: { values: rising, color: theme.green, fullHeight: true, labelBand: true },
    })
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        expect(near3(probe(buf, x, y), theme.bg)).toBe(true)
      }
    }
  })

  it('affects the hash, matching keyHash — a caption change must redraw', () => {
    const a = renderKey({
      kind: 'gauge',
      spark: { values: [1, 5, 2], color: theme.green, fullHeight: true, labelBand: true, label: '1D' },
    })
    const b = renderKey({
      kind: 'gauge',
      spark: { values: [1, 5, 2], color: theme.green, fullHeight: true, labelBand: true, label: '52 WK' },
    })
    expect(a.equals(b)).toBe(false)
  })

  it('leaves fullHeight rendering completely unchanged when labelBand is absent', () => {
    // Regression guard: a page that never sets labelBand (none did, before
    // this task) must render byte-identically to before these fields
    // existed. Same pattern as the lineSizes/lineY absent-field guards
    // elsewhere in this file.
    const a = renderKey({ kind: 'gauge', spark: { values: rising, color: theme.green, fullHeight: true } })
    const b = renderKey({
      kind: 'gauge',
      spark: { values: rising, color: theme.green, fullHeight: true, labelBand: false },
    })
    expect(a.equals(b)).toBe(true)
  })
})

// Task 33's real measurement (docs/VERIFIED-FACTS.md): TSLA's `range=1y&interval=1d`
// gave 251 points, no null holes. A prior review (M1, see the "81 points"
// describe block above) found the slice clip logic broke above 81 values on
// a single key; this proves the SAME code path at the real 52-week point
// count, sliced across 3 keys the way the stocks detail chart actually does
// it, not just at the smaller counts the earlier tests used.
describe('renderKey spark at the real 52-week point count (251, measured live)', () => {
  const values = Array.from({ length: 251 }, (_, i) => i)

  it('does not throw for any of the three slice indices', () => {
    for (const index of [0, 1, 2]) {
      expect(() =>
        renderKey({
          kind: 'gauge',
          spark: { values, color: theme.green, slice: { index, count: 3 }, fullHeight: true, labelBand: true, label: index === 0 ? '52 WK' : undefined },
        }),
      ).not.toThrow()
    }
  })

  it('draws visibly different pixels for each of the three slices', () => {
    const bufs = [0, 1, 2].map((index) =>
      renderKey({
        kind: 'gauge',
        spark: { values, color: theme.green, slice: { index, count: 3 }, fullHeight: true, labelBand: true, label: index === 0 ? '52 WK' : undefined },
      }),
    )
    expect(bufs[0]!.equals(bufs[1]!)).toBe(false)
    expect(bufs[1]!.equals(bufs[2]!)).toBe(false)
    expect(bufs[0]!.equals(bufs[2]!)).toBe(false)
  })

  it('still draws a visible last bar near the right edge of the final slice (the M1 guarantee, at the real count)', () => {
    const buf = renderKey({
      kind: 'gauge',
      spark: { values, color: theme.green, slice: { index: 2, count: 3 }, fullHeight: true, labelBand: true },
    })
    let inkNearRightEdge = false
    for (let x = 85; x < 90 && !inkNearRightEdge; x++) {
      for (let y = 0; y < KEY_SIZE; y++) {
        if (!near3(probe(buf, x, y), theme.bg)) {
          inkNearRightEdge = true
          break
        }
      }
    }
    expect(inkNearRightEdge).toBe(true)
  })

  it('keeps the caption clear of the bars at the real point count too', () => {
    // The caption itself (white-ish `theme.text`) DOES paint ink in the
    // reserved band — that is the point of it. What must never happen is a
    // BAR (`theme.green`) reaching up into that band. Colour, not mere
    // "not background", is what tells the two apart here.
    const buf = renderKey({
      kind: 'gauge',
      spark: { values, color: theme.green, slice: { index: 0, count: 3 }, fullHeight: true, labelBand: true, label: '52 WK' },
    })
    let barInk = false
    for (let y = 0; y < 24 && !barInk; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        if (near3(probe(buf, x, y), theme.green)) {
          barInk = true
          break
        }
      }
    }
    expect(barInk).toBe(false)
  })
})

describe('renderKey spark fullHeight', () => {
  it('uses more of the key height than the default band, for a chart-only key', () => {
    const values = Array.from({ length: 20 }, (_, i) => i)
    const short = renderKey({ kind: 'gauge', spark: { values, color: theme.green } })
    const full = renderKey({ kind: 'gauge', spark: { values, color: theme.green, fullHeight: true } })
    // The default band's tallest possible bar starts no earlier than
    // SPARK_Y (48). A full-height chart must paint ink above that.
    let shortTop = -1
    let fullTop = -1
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        if (shortTop < 0 && !near3(probe(short, x, y), theme.bg)) shortTop = y
        if (fullTop < 0 && !near3(probe(full, x, y), theme.bg)) fullTop = y
      }
      if (shortTop >= 0 && fullTop >= 0) break
    }
    expect(shortTop).toBeGreaterThanOrEqual(8)
    expect(fullTop).toBeLessThan(shortTop)
  })

  it('affects the hash, so a page toggling it redraws', () => {
    const a = { kind: 'gauge' as const, spark: { values: [1, 5, 2], color: theme.green } }
    const b = { kind: 'gauge' as const, spark: { values: [1, 5, 2], color: theme.green, fullHeight: true } }
    expect(sha256(renderKey(a))).not.toBe(sha256(renderKey(b)))
  })
})

describe('renderKey spark: M1, a visible last bar above 81 points', () => {
  it('draws a visible last bar even where barW < 1, restoring the pre-slice guarantee of at least 1 px', () => {
    // Above 81 values on the 81 px-wide band, barW < 1. The clamp added for
    // slice-boundary clipping used to shrink the last bar to a sub-pixel
    // sliver that vanished — verified by the review against the
    // pre-55b7713 renderKey, which always drew at least 1 px.
    const values = Array.from({ length: 100 }, (_, i) => i)
    const buf = renderKey({ kind: 'gauge', spark: { values, color: theme.green } })
    let inkNearRightEdge = false
    for (let x = 85; x < 90 && !inkNearRightEdge; x++) {
      for (let y = 0; y < KEY_SIZE; y++) {
        if (!near3(probe(buf, x, y), theme.bg)) {
          inkNearRightEdge = true
          break
        }
      }
    }
    expect(inkNearRightEdge).toBe(true)
  })

  it('still clips a bar that runs well past the slice margin, when there is room to shrink it', () => {
    // The clamp still does its original job: a bar whose UNCLIPPED width
    // would land far past x1 is cut down, not just left alone.
    const values = Array.from({ length: 3 }, (_, i) => i)
    const buf = renderKey({
      kind: 'gauge',
      spark: { values, color: theme.green, slice: { index: 2, count: 3 } },
    })
    // Slice index 2 of 3 for a 3-value series: this key's own slice sits
    // entirely past its own span for most bars, so it draws little to
    // nothing — proving no throw and no bleed past the key's own width.
    expect(() => renderKey({ kind: 'gauge', spark: { values, color: theme.green, slice: { index: 2, count: 3 } } })).not.toThrow()
    expect(buf.length).toBeGreaterThan(0)
  })
})

describe('renderKey lineSizes as an array of candidates (A3: the renderer resolves, measured at draw time)', () => {
  it('picks the largest candidate that fits, just like a plain number would have', () => {
    const asNumber = renderKey({ kind: 'gauge', lines: ['9.99'], lineSizes: [24] })
    const asArray = renderKey({ kind: 'gauge', lines: ['9.99'], lineSizes: [[24, 20, 16]] })
    expect(asNumber.equals(asArray)).toBe(true)
  })

  it('drops to a smaller candidate rather than clipping, for a wide value', () => {
    // The review's exact repro: `▲ 150.00%` measures 86.7 px at 16 px,
    // clipping past the 81 px usable width. A candidate array must let the
    // renderer shrink further than the smallest fixed size a page used to
    // be limited to.
    const wide = renderKey({ kind: 'gauge', lines: ['▲ 150.00%'], lineSizes: [[16]] })
    const withSmaller = renderKey({ kind: 'gauge', lines: ['▲ 150.00%'], lineSizes: [[16, 13, 11]] })
    expect(wide.equals(withSmaller)).toBe(false)
    // No ink at or past the right margin (x = 90) for the version with room
    // to shrink.
    let clipped = false
    for (let y = 0; y < KEY_SIZE; y++) {
      if (!near3(probe(withSmaller, 90, y), theme.bg)) clipped = true
    }
    expect(clipped).toBe(false)
  })

  it('truncates rather than overflows, when even the smallest candidate does not fit', () => {
    const buf = renderKey({
      kind: 'gauge',
      lines: ['a very long line of text indeed'],
      lineSizes: [[24, 20, 16]],
    })
    let clipped = false
    for (let y = 0; y < KEY_SIZE; y++) {
      if (!near3(probe(buf, 90, y), theme.bg)) clipped = true
    }
    expect(clipped).toBe(false)
  })

  it('sizes a group of consecutive lines that pass the SAME candidate array as one unit (M3)', () => {
    // A range's high (short) and low (long) must not end up two different
    // sizes — shaped like the review's 52-week example: '498.83' alone
    // would fit the largest candidate (24), but paired with '1234.56' (which
    // needs 16 to fit), the GROUP must share the smaller size.
    const grouped = renderKey({
      kind: 'gauge',
      lines: ['498.83', '1234.56'],
      lineSizes: [[24, 20, 16], [24, 20, 16]],
    })
    const standaloneAt16 = renderKey({ kind: 'gauge', lines: ['498.83'], lineSizes: [16] })
    const standaloneAt24 = renderKey({ kind: 'gauge', lines: ['498.83'], lineSizes: [24] })

    // Compare only the rows line 0 occupies (well before line 1 starts), so
    // line 1's own text does not affect the comparison.
    const rowsEqual = (a: Buffer, b: Buffer, yFrom: number, yTo: number): boolean => {
      for (let y = yFrom; y < yTo; y++) {
        for (let x = 0; x < KEY_SIZE; x++) {
          if (!probe(a, x, y).every((v, i) => v === probe(b, x, y)[i])) return false
        }
      }
      return true
    }
    expect(rowsEqual(grouped, standaloneAt16, 0, 18)).toBe(true)
    expect(rowsEqual(grouped, standaloneAt24, 0, 18)).toBe(false)
  })
})

/**
 * Task 39: three cyberpunk idle animations replaced the old green equaliser
 * on the Spotify page's four album-art keys. Each variant gets its own
 * "draws something, dims, animates, and the four quadrants tell each other
 * apart" battery, plus one shape-specific probe of real pixels (lesson 17:
 * measure, do not reason) rather than trusting the spec fields alone.
 *
 * A shared helper counts non-background pixels in a whole RECTANGLE, never a
 * single row or column (lesson 22 — a one-column probe is background for
 * almost any real overflow or, here, almost any real animation frame).
 */
function inkCountInRegion(
  buf: Buffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bg: readonly number[] = theme.bg,
): number {
  let count = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!near3(probe(buf, x, y), bg)) count++
    }
  }
  return count
}

const IDLE_QUADRANTS: { col: 0 | 1; row: 0 | 1 }[] = [
  { col: 0, row: 0 },
  { col: 1, row: 0 },
  { col: 0, row: 1 },
  { col: 1, row: 1 },
]

describe('renderKey idle animations (the Spotify cyberpunk idle screens, task 39)', () => {
  describe.each([
    { variant: 'grid' as const, label: 'neon grid horizon' },
    { variant: 'rain' as const, label: 'glyph rain' },
    { variant: 'glitch' as const, label: 'glitch scanline' },
  ])('$label ($variant)', ({ variant }) => {
    it('draws something (not blank) for every quadrant', () => {
      const blank = renderKey({ kind: 'control' })
      for (const { col, row } of IDLE_QUADRANTS) {
        const buf = renderKey({ kind: 'control', idle: { variant, nowMs: 1234, col, row } })
        expect(buf.equals(blank)).toBe(false)
      }
    })

    it('never calls Date.now(): the same nowMs always renders byte-identical pixels', () => {
      const a = renderKey({ kind: 'control', idle: { variant, nowMs: 42_000, col: 0, row: 0 } })
      const b = renderKey({ kind: 'control', idle: { variant, nowMs: 42_000, col: 0, row: 0 } })
      expect(a.equals(b)).toBe(true)
    })

    it('dims like every other element', () => {
      const bright = renderKey({ kind: 'control', idle: { variant, nowMs: 500, col: 0, row: 0 } })
      const dimmed = renderKey({
        kind: 'control', idle: { variant, nowMs: 500, col: 0, row: 0 }, dim: true,
      })
      expect(bright.equals(dimmed)).toBe(false)
    })

    it('renders visibly different pixels for the same quadrant at two different clocks', () => {
      for (const { col, row } of IDLE_QUADRANTS) {
        const a = renderKey({ kind: 'control', idle: { variant, nowMs: 0, col, row } })
        const b = renderKey({ kind: 'control', idle: { variant, nowMs: 3000, col, row } })
        expect(a.equals(b)).toBe(false)
      }
    })

    // I1: the old glitch scanline phase came from a weak sine-based hash
    // whose nearby integer seeds could (and, for two of the four keys, did)
    // return nearly identical outputs — the four quadrants were
    // byte-identical at 46 of 60 sampled clocks, and a test that only
    // checked one hard-coded clock (1500) could not see it, since 1500
    // happened to be one of the 14 lucky ones (lesson 22). Sweeping many
    // clocks here is what would have caught it, and is what proves the fix.
    it('renders visibly different pixels for all four quadrants across many clocks', () => {
      const clocks = Array.from({ length: 60 }, (_, i) => i * 100)
      for (const nowMs of clocks) {
        const bufs = IDLE_QUADRANTS.map(({ col, row }) =>
          renderKey({ kind: 'control', idle: { variant, nowMs, col, row } }),
        )
        for (let i = 0; i < bufs.length; i++) {
          for (let j = i + 1; j < bufs.length; j++) {
            expect(bufs[i]!.equals(bufs[j]!)).toBe(false)
          }
        }
      }
    })
  })

  describe('neon grid horizon shape', () => {
    it('draws the sun in magenta, reaching well into both top-row keys', () => {
      // The sun is centred on the seam between columns, so both the left
      // (col 0) and right (col 1) key of the top row should carry visible
      // magenta ink near their own inner edge.
      const left = renderKey({ kind: 'control', idle: { variant: 'grid', nowMs: 0, col: 0, row: 0 } })
      const right = renderKey({ kind: 'control', idle: { variant: 'grid', nowMs: 0, col: 1, row: 0 } })
      const isMagenta = (buf: Buffer, x: number, y: number) => near3(probe(buf, x, y), theme.neonMagenta, 30)
      expect(isMagenta(left, 90, 74)).toBe(true)
      expect(isMagenta(right, 5, 74)).toBe(true)
    })

    it('draws perspective floor lines only below the horizon, on the bottom-row keys', () => {
      const buf = renderKey({ kind: 'control', idle: { variant: 'grid', nowMs: 800, col: 0, row: 1 } })
      // The floor lines are cyan on a near-black background; a bottom-row
      // key must carry SOME cyan ink somewhere in its lower two-thirds.
      expect(inkCountInRegion(buf, 0, 32, KEY_SIZE, KEY_SIZE)).toBeGreaterThan(0)
    })
  })

  describe('glyph rain shape', () => {
    it('draws text-shaped ink spread across the key, not concentrated in one corner', () => {
      // Sample several nowMs values (columns fall continuously) and require
      // that at least one produces visible ink in the left half AND the
      // right half of the key — proving the columns really do spread across
      // the width rather than piling into a single spot.
      const nowValues = [0, 700, 1400, 2100, 2800]
      const anyLeft = nowValues.some((nowMs) => {
        const buf = renderKey({ kind: 'control', idle: { variant: 'rain', nowMs, col: 0, row: 0 } })
        return inkCountInRegion(buf, 3, 0, KEY_SIZE / 2, KEY_SIZE) > 0
      })
      const anyRight = nowValues.some((nowMs) => {
        const buf = renderKey({ kind: 'control', idle: { variant: 'rain', nowMs, col: 0, row: 0 } })
        return inkCountInRegion(buf, KEY_SIZE / 2, 0, KEY_SIZE - 3, KEY_SIZE) > 0
      })
      expect(anyLeft).toBe(true)
      expect(anyRight).toBe(true)
    })

    it('every strand slides fully off the bottom before it loops — the wrap is never visible', () => {
      // The user's report from the glass: "as soon as one strand touches the
      // bottom ... the whole strand vanishes". The first shipped travel
      // stopped the head AT the bottom edge, wrapping while five of six
      // trail glyphs were still mid-key. The property that forbids it: at
      // any instant where a column's head position jumps backwards (a
      // wrap), the strand's TAIL at the previous instant must already be
      // below the key. Scanned at 20 ms — under 1 px of motion per step at
      // the slowest period — across every key and column for a full worst-
      // case cycle. Break the fix (travel back to KEY_SIZE + one trail
      // length) and this fails on every column.
      const STEP_MS = 20
      const SCAN_MS = 12_000 // longest period is < 9.3 s; cover one full loop
      for (let keyIndex = 0; keyIndex < 4; keyIndex++) {
        for (let col = 0; col < 6; col++) {
          let prev = rainColumnSpan(keyIndex, col, 0)
          let sawWrap = false
          for (let nowMs = STEP_MS; nowMs <= SCAN_MS; nowMs += STEP_MS) {
            const cur = rainColumnSpan(keyIndex, col, nowMs)
            if (cur.head < prev.head) {
              sawWrap = true
              // At the moment before the wrap, the whole strand — tail
              // included — must sit below the key's bottom edge.
              expect(prev.tail).toBeGreaterThan(KEY_SIZE)
            }
            prev = cur
          }
          // The scan must actually witness a wrap, or the assertion above
          // proved nothing for this column (lesson 22).
          expect(sawWrap).toBe(true)
        }
      }
    })
  })

  describe('glitch scanline shape', () => {
    it('draws the flickering OFFLINE text only on the top-left quadrant (col 0, row 0)', () => {
      // nowMs = 800 lands well outside this key's own glitch-band dropout
      // window (seed 0 puts the first band at nowMs 0-220), so the text is
      // near its brightest here — a real, generous rectangle probe (lesson
      // 22), not a single column.
      const withText = renderKey({ kind: 'control', idle: { variant: 'glitch', nowMs: 800, col: 0, row: 0 } })
      const centerInk = inkCountInRegion(withText, 20, 40, 76, 56)
      expect(centerInk).toBeGreaterThan(20)

      // The other three quadrants never draw this text at all, at the same
      // clock — their own centre band should show far less ink.
      for (const { col, row } of [{ col: 1 as const, row: 0 as const }, { col: 0 as const, row: 1 as const }, { col: 1 as const, row: 1 as const }]) {
        const other = renderKey({ kind: 'control', idle: { variant: 'glitch', nowMs: 800, col, row } })
        expect(inkCountInRegion(other, 20, 40, 76, 56)).toBeLessThan(centerInk)
      }
    })

    it('breathes slowly rather than flickering: brightness cannot swing across most of its range on more than a handful of small time steps', () => {
      // A strobe is a FAST, REPEATED swing, not one big one — the text is
      // meant to breathe all the way from dim to bright, just slowly, with
      // one brief (90 ms), INTENTIONAL sharp dropout timed to its own
      // glitch band each cycle (documented at `GLITCH_TEXT_DROPOUT_MS`). So
      // this measures brightness (total channel deviation from the
      // background, over the whole text region — not a pixel count, which
      // cannot tell a dim frame from a bright one once any ink is present at
      // all) at 150 ms steps across FOUR full band periods (not a
      // hand-picked window chosen to dodge the one dropout at whatever
      // clock it happens to land on for THIS key — lesson 22 — since M7's
      // fix moved that clock off a fixed epoch boundary) and requires that
      // no more than a handful of adjacent-sample steps swing by 40% of the
      // full range: at most one or two per band period, from the dropout's
      // own brief in/out edges. A period as slow as the real BREATHING one
      // produces a handful of such steps across the whole sweep; cutting
      // the breathing period down to something that would actually read as
      // flicker produces one on nearly EVERY step instead.
      const totalDeviation = (buf: Buffer): number => {
        let sum = 0
        for (let y = 40; y < 56; y++) {
          for (let x = 20; x < 76; x++) {
            const p = probe(buf, x, y)
            sum += Math.abs(p[0]! - theme.bg[0]) + Math.abs(p[1]! - theme.bg[1]) + Math.abs(p[2]! - theme.bg[2])
          }
        }
        return sum
      }
      const stepMs = 150
      const glitchBandPeriodMs = 5200 // matches canvas.ts's GLITCH_BAND_PERIOD_MS, not exported
      const bandPeriods = 4
      const samples: number[] = []
      for (let nowMs = 0; nowMs < glitchBandPeriodMs * bandPeriods; nowMs += stepMs) {
        samples.push(totalDeviation(renderKey({ kind: 'control', idle: { variant: 'glitch', nowMs, col: 0, row: 0 } })))
      }
      const range = Math.max(...samples) - Math.min(...samples)
      expect(range).toBeGreaterThan(0) // the property only means something if brightness moves at all
      let bigSteps = 0
      for (let i = 1; i < samples.length; i++) {
        const step = Math.abs(samples[i]! - samples[i - 1]!)
        if (step / range >= 0.4) bigSteps++
      }
      // Measured (post-fix): 3 big steps across 4 band periods (~139
      // samples) — the dropout's own edges. A generous multiple of that,
      // still far short of "nearly every step," which is what an actual
      // fast-flicker regression would produce.
      expect(bigSteps).toBeLessThanOrEqual(8)
    })
  })

  // I2: at the Spotify page's real idle tick (100 ms), keys 1, 4 and 5 held
  // byte-identical pixels for up to 8 consecutive frames — 800 ms — because
  // the scanline position only advanced past a rounding boundary once every
  // ~860 ms, even though `idle.nowMs` (correctly) changed `keyHash` on every
  // tick. That is wasted key-writes for content that had not visibly
  // changed. Key 0 (the OFFLINE-text quadrant) already escaped this via its
  // own continuous breathing, so it is excluded here — its own "breathes
  // slowly" behaviour is covered above instead.
  describe('glitch scanline animation cost (I2)', () => {
    it('does not hold identical pixels for more than a couple of consecutive 100ms ticks, on any of the three non-text quadrants', () => {
      const tickMs = 100
      const durationMs = 12_000
      for (const { col, row } of [
        { col: 1 as const, row: 0 as const },
        { col: 0 as const, row: 1 as const },
        { col: 1 as const, row: 1 as const },
      ]) {
        let prev: Buffer | null = null
        let run = 0
        let maxRun = 0
        for (let nowMs = 0; nowMs < durationMs; nowMs += tickMs) {
          const buf = renderKey({ kind: 'control', idle: { variant: 'glitch', nowMs, col, row } })
          if (prev && buf.equals(prev)) {
            run++
            maxRun = Math.max(maxRun, run)
          } else {
            run = 0
          }
          prev = buf
        }
        // Measured pre-fix: up to 8. Post-fix, sub-pixel scanline motion
        // changes something on every tick, so this should never run long.
        expect(maxRun).toBeLessThanOrEqual(1)
      }
    })
  })
})

/**
 * C1: `drawIdleGrid`'s sun, drawn with `ctx.arc`, is the only `arc`/`ellipse`
 * call anywhere in `src/` (`grep -rn '\.arc(\|arcTo\|ellipse(' src/`).
 * `@napi-rs/canvas`'s `ctx.arc` PANICS in Rust — an uncatchable `SIGABRT`,
 * not a `throw` — when handed a non-finite argument, which a non-finite
 * `idle.nowMs` produces (`sunY` becomes `NaN`). A `try`/`catch` around the
 * render loop cannot see a Rust panic, so a genuinely aborting test would
 * kill the vitest worker outright, not just fail one assertion — the exact
 * hazard this suite exists to catch. So this proves the fix from the
 * OUTSIDE, in an isolated child process, checking the exit code rather than
 * calling `renderKey` with a hostile spec in-process.
 *
 * Pre-fix, this same probe (run manually during development, not committed
 * here — a test that captures the crash would itself abort the suite)
 * measured `status: null, signal: 'SIGABRT'` for `nowMs: NaN`, and a clean
 * exit for a finite clock — matching the review's own measurement exactly.
 * `sanitizeKeySpec` (the boundary guard) plus the belt-and-braces
 * `Number.isFinite` check at the `arc` call itself are what make the
 * post-fix assertion below true.
 */
describe('C1: no spec aborts the process on a non-finite number — the fatal cases, in a child process', () => {
  /**
   * Bundles `src/render/canvas.ts` (and its two local dependencies) into one
   * self-contained ESM file with `esbuild` — a real dependency of `vitest`
   * itself, so this needs no prior `npm run build` and no `dist/` output to
   * exist. `@napi-rs/canvas` stays external (a real, already-installed
   * node_module) rather than bundled. The temp files live under a directory
   * INSIDE the project root (not the system tmpdir) so plain Node's ESM
   * resolver walks up and finds `node_modules` normally.
   */
  /**
   * The bundle and its directory, built ONCE for every case in this block.
   *
   * Each case used to run its own `esbuild.buildSync`, create its own temp
   * directory, and remove it again. That was fine at two cases; task 42 added
   * six more for the effect layer, and paying for eight bundles multiplied both
   * the runtime and the amount of filesystem and subprocess churn inside the
   * project root for no gain. The bundle does not vary by case — only the spec
   * literal does.
   */
  let probeDir: string | null = null
  let bundleFile: string | null = null

  beforeAll(() => {
    const result = esbuild.buildSync({
      entryPoints: [join(process.cwd(), 'src/render/canvas.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      external: ['@napi-rs/canvas'],
    })
    probeDir = mkdtempSync(join(process.cwd(), '.c1-probe-'))
    bundleFile = join(probeDir, 'canvas.bundle.mjs')
    writeFileSync(bundleFile, result.outputFiles[0]!.text)
  })

  afterAll(() => {
    if (probeDir) rmSync(probeDir, { recursive: true, force: true })
    probeDir = null
    bundleFile = null
  })

  /**
   * Renders every spec in `specLiterals` inside ONE child process, and reports
   * how that process exited. A Rust panic kills the process, so a clean exit is
   * the proof that no spec in the list reached a fatal drawing primitive.
   */
  function renderHostileSpecsInChildProcess(specLiterals: readonly string[]): {
    status: number | null
    signal: NodeJS.Signals | null
  } {
    if (!probeDir || !bundleFile) throw new Error('probe bundle was not built')
    // One probe file per case, named from a counter, so two cases can never
    // race on the same path.
    const probeFile = join(probeDir, `probe-${probeCounter++}.mjs`)
    writeFileSync(
      probeFile,
      [
        `import { renderKey } from ${JSON.stringify(bundleFile)}`,
        ...specLiterals.map((spec) => [
          `{`,
          `  const buf = renderKey(${spec})`,
          `  if (buf.length !== 96 * 96 * 4) throw new Error('unexpected buffer length: ' + buf.length)`,
          `}`,
        ].join('\n')),
      ].join('\n'),
    )
    const r = spawnSync(process.execPath, [probeFile], { encoding: 'utf8' })
    return { status: r.status, signal: r.signal }
  }

  /** The single-spec form, for the callers that only need one. */
  function renderHostileSpecInChildProcess(specLiteral: string): {
    status: number | null
    signal: NodeJS.Signals | null
  } {
    return renderHostileSpecsInChildProcess([specLiteral])
  }

  let probeCounter = 0

  function gridSpec(nowMsLiteral: string): string {
    return `{ kind: 'control', idle: { variant: 'grid', nowMs: ${nowMsLiteral}, col: 0, row: 0 } }`
  }

  it.each(['NaN', 'Infinity', '-Infinity'])(
    'renders a full key buffer, in a real child process, for grid idle.nowMs = %s',
    (nowMsLiteral) => {
      const { status, signal } = renderHostileSpecInChildProcess(gridSpec(nowMsLiteral))
      expect(signal).toBeNull()
      expect(status).toBe(0)
    },
  )

  it('still renders a real clock correctly through the same child-process path', () => {
    const { status, signal } = renderHostileSpecInChildProcess(gridSpec('1786549560000'))
    expect(signal).toBeNull()
    expect(status).toBe(0)
  })

  /**
   * The same fatal class, for the ambient effect layer (task 42).
   *
   * MEASURED on 2026-08-18, with the `out.fx` block deleted from
   * `sanitizeKeySpec` and the variants bundled through this same path:
   *
   * | variant | non-finite result |
   * | --- | --- |
   * | `snow`, `cloud` | exit 134, SIGABRT — a Rust panic inside `ctx.arc` |
   * | `wind` | exit 1, an ordinary catchable JS throw |
   * | `rain`, `storm`, `fog`, `sun` | exit 0, survived unguarded |
   *
   * So only `snow` and `cloud` belong here. They pass a non-finite CENTRE to
   * `ctx.arc`, which is the fatal case; `sun` passes only a non-finite radius
   * and was measured to survive it. The other five are covered in-process
   * below, exactly as `C1/I4` already splits the idle variants — testing a
   * fatal case in-process would mean a future regression in `sanitizeKeySpec`
   * aborts this whole file's vitest worker instead of failing one test.
   */
  /**
   * All three non-finite values for one variant go through ONE child process,
   * rather than one process each.
   *
   * The failure being detected is fatal to the whole process, so a single child
   * that renders all three still dies if any one of them aborts, and the
   * variant name still identifies what broke — which is the actionable part.
   * Spawning six processes instead of two bought no extra information, and it
   * measurably raised the subprocess load of the whole suite: a pre-existing
   * fixed-sleep race in `tests/install/statusline-wrapper.test.ts` (M-8, which
   * signals the wrapper after a flat 300 ms) began firing about once in six
   * full-suite runs, while never failing in ten isolated runs of its own file.
   * Keeping this block cheap is what keeps that unrelated race asleep.
   */
  it.each(['snow', 'cloud'])('renders a full key buffer, in a real child process, for every non-finite fx %s', (variant) => {
    const specs = ['NaN', 'Infinity', '-Infinity']
      .map((bad) => `{ kind: 'gauge', fx: { variant: '${variant}', nowMs: ${bad}, intensity: ${bad}, seed: ${bad} } }`)
    const { status, signal } = renderHostileSpecsInChildProcess(specs)
    expect(signal).toBeNull()
    expect(status).toBe(0)
  })

  it('still renders a real clock correctly for both fatal-capable variants through the same child-process path', () => {
    const specs = ['snow', 'cloud']
      .map((v) => `{ kind: 'gauge', fx: { variant: '${v}', nowMs: 1786549560000, intensity: 1, seed: 3 } }`)
    const { status, signal } = renderHostileSpecsInChildProcess(specs)
    expect(signal).toBeNull()
    expect(status).toBe(0)
  })
})

/**
 * I4 (folded into C1's boundary sweep): every other hostile numeric field
 * throws a plain, catchable JS error rather than aborting the process, so
 * these run in-process directly. Before `sanitizeKeySpec`, `lineSizes` and
 * `glyphPulse.phase` reached a font string built from their own value and
 * threw `is not valid font style`; a spark with >=125,000 points threw
 * `Maximum call stack size exceeded` from `Math.min(...values)`'s argument
 * spread.
 */
describe('C1/I4: hostile numeric specs never throw, across every numeric field and all three idle variants', () => {
  const HOSTILE = [NaN, Infinity, -Infinity]

  // `'grid'` is deliberately excluded from this in-process loop: it is the
  // one variant whose `ctx.arc` call is uniquely fatal (not merely
  // throwing) on a non-finite `nowMs`, and the describe block above already
  // covers exactly that combination through the isolated child-process
  // probe. Testing it here too, in-process, would mean a FUTURE regression
  // in `sanitizeKeySpec` aborts this whole file's vitest worker instead of
  // failing one test — confirmed by deliberately breaking both the
  // sanitizer and the belt-and-braces `arc` guard during development: with
  // `'grid'` in this loop, that break took down all 153 tests in this file,
  // not just this one. `'rain'` and `'glitch'` never call `arc` at all, so
  // they carry no such risk and are safe to test directly.
  it.each(HOSTILE)('idle.nowMs = %s renders for rain and glitch, in-process', (nowMs) => {
    for (const variant of ['rain', 'glitch'] as const) {
      expect(() => renderKey({ kind: 'control', idle: { variant, nowMs, col: 0, row: 0 } })).not.toThrow()
    }
  })

  it.each(HOSTILE)('idle.col / idle.row = %s render without throwing', (n) => {
    expect(() =>
      renderKey({ kind: 'control', idle: { variant: 'grid', nowMs: 0, col: n as never, row: n as never } }),
    ).not.toThrow()
  })

  it.each(HOSTILE)('lineSizes = %s (plain number) renders without throwing', (size) => {
    expect(() => renderKey({ kind: 'gauge', lines: ['A'], lineSizes: [size] })).not.toThrow()
  })

  it.each(HOSTILE)('lineSizes = [[%s]] (candidate array) renders without throwing', (size) => {
    expect(() => renderKey({ kind: 'gauge', lines: ['A'], lineSizes: [[size]] })).not.toThrow()
  })

  it.each(HOSTILE)('lineY = %s renders without throwing', (y) => {
    expect(() => renderKey({ kind: 'gauge', lines: ['A'], lineY: [y] })).not.toThrow()
  })

  it.each(HOSTILE)('glyphPulse.phase = %s renders without throwing', (phase) => {
    expect(() =>
      renderKey({ kind: 'control', glyph: '🔊', glyphFont: 'emoji', glyphPulse: { phase } }),
    ).not.toThrow()
  })

  it.each(HOSTILE)('bar.value = %s renders without throwing (already clamp01-guarded)', (value) => {
    expect(() => renderKey({ kind: 'gauge', bar: { value, color: theme.green } })).not.toThrow()
    expect(() => renderStrip({ lines: ['a'], bar: { value, color: theme.green } })).not.toThrow()
  })

  it.each(HOSTILE)('imageCrop with %s in every field renders without throwing', async (n) => {
    const img = await solidImage(10, 20, 30)
    expect(() =>
      renderKey({ kind: 'image', image: img, imageCrop: { sx: n, sy: n, sw: n, sh: n } }),
    ).not.toThrow()
  })

  it.each(HOSTILE)('spark.values containing %s renders without throwing', (v) => {
    expect(() =>
      renderKey({ kind: 'gauge', spark: { values: [1, v, 5, v, 9], color: theme.green } }),
    ).not.toThrow()
  })

  it('a spark with 200,000 points renders without throwing (the Math.min/max spread limit)', () => {
    const values = Array.from({ length: 200_000 }, (_, i) => i % 100)
    expect(() => renderKey({ kind: 'gauge', spark: { values, color: theme.green } })).not.toThrow()
  })

  it('one key with every hostile numeric field set at once still renders a full buffer', () => {
    // `idle.variant` is `'rain'` here, deliberately, not `'grid'`: this test
    // runs IN-PROCESS (lesson from developing C1's fix — see the describe
    // block above), and `grid` combined with a non-finite `nowMs` is the one
    // combination that must only ever be exercised through the isolated
    // child-process probe, because it stays reachable to the fatal `ctx.arc`
    // panic if `sanitizeKeySpec` ever regresses. `rain` never calls `arc`, so
    // it safely covers every OTHER hostile field at once without that risk.
    const buf = renderKey({
      kind: 'control',
      lines: ['A', 'B'],
      lineSizes: [NaN, [Infinity, -Infinity]],
      lineY: [NaN, Infinity],
      bar: { value: NaN, color: theme.green },
      glyph: '🔊',
      glyphFont: 'emoji',
      glyphPulse: { phase: Infinity },
      spark: { values: [1, NaN, Infinity, -Infinity, 9], color: theme.green },
      idle: { variant: 'rain', nowMs: NaN, col: Infinity as never, row: -Infinity as never },
    } as unknown as KeySpec)
    expect(buf.length).toBe(KEY_SIZE * KEY_SIZE * 4)
  })
})

/**
 * Task 36: the daemon's press-feedback flash moved from a full-key `bg` fill
 * (task 32, reported "too bright" on real hardware) to a thin perimeter
 * ring. These tests prove the ring is visible on all four sides, prove the
 * interior stays pixel-identical to the unflashed key (the whole point of an
 * outline instead of a fill), and prove it wins the overlap with a page's
 * own left-edge `border` — see `canvas.ts`'s `FLASH_RING_INSET`/
 * `FLASH_RING_THICKNESS` doc comment for the exact measurement.
 */
describe('renderKey flashRing', () => {
  it('draws nothing extra when flashRing is absent, exactly as before this field existed', () => {
    const withoutField = renderKey({ kind: 'gauge', lines: ['A'], border: theme.amber, pulseOn: true })
    const explicitlyUndefined = renderKey({
      kind: 'gauge', lines: ['A'], border: theme.amber, pulseOn: true, flashRing: undefined,
    })
    expect(withoutField.equals(explicitlyUndefined)).toBe(true)
  })

  it('draws a visible ring on all four sides of the key', () => {
    const buf = renderKey({ kind: 'gauge', flashRing: theme.flashWhite })
    near(probe(buf, 2, 48), theme.flashWhite) // left
    near(probe(buf, 93, 48), theme.flashWhite) // right
    near(probe(buf, 48, 2), theme.flashWhite) // top
    near(probe(buf, 48, 93), theme.flashWhite) // bottom
  })

  it('wins the overlap with a pulsing left-edge border, leaving only 1 of 96 columns showing the border colour', () => {
    // Measured (see canvas.ts's doc comment): the border occupies columns 0
    // to 2. The ring, drawn afterwards, covers columns 1 to 4, so only
    // column 0 still shows the border's own colour.
    const buf = renderKey({ kind: 'session', border: theme.amber, pulseOn: true, flashRing: theme.flashWhite })
    near(probe(buf, 0, 48), theme.amber)
    near(probe(buf, 1, 48), theme.flashWhite)
    near(probe(buf, 2, 48), theme.flashWhite)
  })

  it('leaves the key interior pixel-identical to the unflashed key — only the ring band differs', () => {
    const base: KeySpec = {
      kind: 'session',
      lines: ['THINKING', 'my-project'],
      border: theme.amber,
      pulseOn: true,
    }
    const plain = renderKey(base)
    const flashed = renderKey({ ...base, flashRing: theme.flashWhite })
    // The ring's band, derived from the same constants `canvas.ts` draws
    // with, not hard-coded (M7) — so a change to either one tightens or
    // loosens this check automatically instead of silently going stale.
    // `FLASH_RING_INSET` is 1, so columns/rows 0 and (KEY_SIZE - 1) are NOT
    // part of the ring at all and must be checked, not skipped — the old
    // hard-coded band (`x <= 4 || x >= 91`) skipped them too, which is
    // exactly the slack this rewrite removes.
    const nearStart = FLASH_RING_INSET
    const nearEnd = FLASH_RING_INSET + FLASH_RING_THICKNESS - 1
    const farStart = KEY_SIZE - FLASH_RING_INSET - FLASH_RING_THICKNESS
    const farEnd = KEY_SIZE - FLASH_RING_INSET - 1
    const inBand = (v: number) => (v >= nearStart && v <= nearEnd) || (v >= farStart && v <= farEnd)
    const inRingBand = (x: number, y: number) => inBand(x) || inBand(y)
    let checked = 0
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        if (inRingBand(x, y)) continue
        expect(probe(flashed, x, y)).toEqual(probe(plain, x, y))
        checked++
      }
    }
    // Sanity: the loop actually visited a substantial interior area, so a
    // bug that shrank the skip-band to cover everything could not pass by
    // accident.
    expect(checked).toBeGreaterThan(7000)
  })

  it('differs visibly between the handled (white) and ignored/failed (red) rings', () => {
    const white = renderKey({ kind: 'gauge', flashRing: theme.flashWhite })
    const red = renderKey({ kind: 'gauge', flashRing: theme.flashRed })
    expect(white.equals(red)).toBe(false)
  })

  it('uses colours dimmer than the old full-brightness white and red', () => {
    const luma = (c: readonly [number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    expect(luma(theme.flashWhite)).toBeLessThan(luma(theme.white))
    expect(luma(theme.flashRed)).toBeLessThan(luma(theme.red))
  })

  it('keeps flashWhite and flashRed clearly apart from every other theme colour and from each other', () => {
    const all = [
      theme.bg, theme.text, theme.textDim, theme.white, theme.red, theme.green,
      theme.amber, theme.blue, theme.cyan, theme.gray, theme.barTrack,
    ]
    const dist = (a: readonly number[], b: readonly number[]) =>
      Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]!) ** 2, 0))
    for (const c of all) {
      expect(dist(theme.flashWhite, c)).toBeGreaterThan(30)
      expect(dist(theme.flashRed, c)).toBeGreaterThan(30)
    }
    expect(dist(theme.flashWhite, theme.flashRed)).toBeGreaterThan(30)
  })
})

describe('measured text width', () => {
  it('fits "95°/77°" at 16 px within the 81 px usable key width', () => {
    // Per VERIFIED-FACTS.md: 77 px at 16 px, and 82 px (over budget) at
    // 17 px. This guards against a future font change silently clipping the
    // temperature line.
    const c = createCanvas(KEY_SIZE, KEY_SIZE)
    const ctx = c.getContext('2d')
    ctx.font = '16px Menlo'
    const width = ctx.measureText('95°/77°').width
    expect(width).toBeLessThanOrEqual(81)
  })

  // Task 38: the volume key's caption is drawn at a FIXED size
  // (GLYPH_CAPTION_SIZE, 11px), entirely independent of glyphPulse's scale
  // — the pulse only ever resizes `glyph`, never `glyphCaption`'s own font.
  // So the widest realistic caption cannot be "pushed" wider by the
  // animation's largest frame; this measures it anyway, per the brief's
  // explicit request, rather than asserting that from the code structure
  // alone.
  it('fits "100%" (the widest realistic volume caption) at 11px within the 81px usable width', () => {
    const c = createCanvas(KEY_SIZE, KEY_SIZE)
    const ctx = c.getContext('2d')
    ctx.font = '11px Menlo'
    const width = ctx.measureText('100%').width
    expect(width).toBeLessThanOrEqual(81)
  })
})

/**
 * Builds a 96 by 96 solid-colour image, already decoded. It goes through
 * JPEG on purpose: real album art arrives as JPEG, decoded by the producer
 * before it reaches `renderKey`.
 */
async function solidImage(r: number, g: number, b: number): Promise<Image> {
  const c = createCanvas(96, 96)
  const ctx = c.getContext('2d')
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.fillRect(0, 0, 96, 96)
  return loadImage(c.toBuffer('image/jpeg'))
}

/*
 * Task 39's four cross-page golden-hash tests lived here. They proved, AT
 * COMMIT TIME, that the idle-animation rewrite changed no other page's
 * pixels — and they did their job. They are deleted rather than updated:
 * a frozen whole-key hash pins every FUTURE legitimate change to those
 * pages too, and it broke within the hour when a review fix changed the
 * Claude session tile on purpose. The durable form of the same guarantee
 * lives in each page's own suite (no page sets `KeySpec.idle`, and
 * `keyHash` coverage is tested per field). Do not re-add cross-page
 * golden hashes; see docs/LESSONS.md lesson 22.
 */

/**
 * The ambient effect layer (task 42). Every effect draws BENEATH a key's own
 * content, so the properties that matter are: it paints, it moves, it stays
 * under the brightness cap, it loops invisibly, and it is deterministic for
 * one clock. Each of those is asserted over a REGION, never one pixel column
 * (lesson 22 in docs/LESSONS.md).
 */
describe('fx layer', () => {
  const BG: Rgb = [18, 28, 44]
  const ALL_VARIANTS: readonly FxVariant[] = [
    'rain', 'snow', 'storm', 'fog', 'wind', 'sun', 'cloud',
  ]

  /**
   * An ABSOLUTE brightness ceiling for any effect pixel over a dark condition
   * tint — deliberately NOT derived from `FX_MAX_ALPHA`.
   *
   * The first version of this proof computed its ceiling from `FX_MAX_ALPHA`
   * itself, so raising that constant raised the bar in lockstep and the test
   * could not fail. Breaking the fix (setting the cap to 1) exposed it: the
   * cap tests all still passed. That is lesson 22's exact shape, caught by
   * the discipline rather than by review.
   *
   * Measured on 2026-08-18: a solid-white layer at the shipped cap composites
   * to at most `(84,91,103)` over the rain tint `(18,28,44)`, the brightest of
   * the eight tints in this direction. 110 leaves headroom for anti-aliasing
   * while still failing if the cap rises to 0.35.
   */
  const FX_ABSOLUTE_CEILING = 110

  function assertUnderCap(buf: Buffer, _bg: Rgb): void {
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        const px = probe(buf, x, y)
        for (let i = 0; i < 3; i++) {
          expect(px[i]!).toBeLessThanOrEqual(FX_ABSOLUTE_CEILING)
        }
      }
    }
  }

  it('keeps the cap constant itself inside its design bound', () => {
    // The absolute ceiling above catches a large increase. This catches any
    // increase at all, so the constant cannot creep upward unnoticed.
    expect(FX_MAX_ALPHA).toBeLessThanOrEqual(0.3)
    expect(FX_MAX_ALPHA).toBeGreaterThan(0)
  })

  /** Counts pixels that differ from the flat background, so a test can compare
   * how much of the key an effect actually covers. */
  function inkCount(buf: Buffer, bg: Rgb): number {
    let n = 0
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        const p = probe(buf, x, y)
        if (
          Math.abs(p[0]! - bg[0]) > 1 ||
          Math.abs(p[1]! - bg[1]) > 1 ||
          Math.abs(p[2]! - bg[2]) > 1
        ) n++
      }
    }
    return n
  }

  function lum(p: readonly number[]): number {
    return p[0]! + p[1]! + p[2]!
  }

  it.each(ALL_VARIANTS)('paints into the key, for %s', (variant) => {
    const plain = renderKey({ kind: 'gauge', bg: BG })
    const withFx = renderKey({
      kind: 'gauge', bg: BG, fx: { variant, nowMs: 4200, intensity: 1, seed: 3 },
    })
    expect(withFx.equals(plain)).toBe(false)
  })

  it.each(ALL_VARIANTS)('never exceeds the alpha cap at full intensity, for %s', (variant) => {
    const buf = renderKey({
      kind: 'gauge', bg: BG, fx: { variant, nowMs: 4200, intensity: 1, seed: 3 },
    })
    assertUnderCap(buf, BG)
  })

  it.each(ALL_VARIANTS)('animates over time, for %s', (variant) => {
    // Three seconds apart, which is longer than the fastest variant's whole
    // period and far enough into the slowest one's to move it visibly. The
    // property is "time moves it", not "it moves within one tick".
    const at = (nowMs: number) => renderKey({
      kind: 'gauge', bg: BG, fx: { variant, nowMs, intensity: 1, seed: 3 },
    })
    expect(at(0).equals(at(3000))).toBe(false)
  })

  it.each(ALL_VARIANTS)('is deterministic for one clock, for %s', (variant) => {
    const at = (nowMs: number) => renderKey({
      kind: 'gauge', bg: BG, fx: { variant, nowMs, intensity: 1, seed: 3 },
    })
    expect(at(4200).equals(at(4200))).toBe(true)
  })

  it.each(ALL_VARIANTS)('differs between two seeds, so neighbours do not animate in lockstep, for %s', (variant) => {
    const at = (seed: number) => renderKey({
      kind: 'gauge', bg: BG, fx: { variant, nowMs: 4200, intensity: 1, seed },
    })
    expect(at(0).equals(at(5))).toBe(false)
  })

  it.each(ALL_VARIANTS)('dims along with the rest of the key, for %s', (variant) => {
    const fx = { variant, nowMs: 4200, intensity: 1, seed: 3 } as const
    const bright = renderKey({ kind: 'gauge', bg: BG, fx })
    const dimmed = renderKey({ kind: 'gauge', bg: BG, fx, dim: true })
    expect(dimmed.equals(bright)).toBe(false)
    // Dimming must REDUCE the layer, not merely change it — a stale key whose
    // effect stayed bright is the exact defect lesson 15 describes.
    expect(inkCount(dimmed, BG)).toBeLessThan(inkCount(bright, BG))
  })

  it('renders byte-identical output when fx is absent', () => {
    const a = renderKey({ kind: 'gauge', bg: BG, lines: ['NOW', '95°/77°'] })
    const b = renderKey({ kind: 'gauge', bg: BG, lines: ['NOW', '95°/77°'] })
    expect(a.equals(b)).toBe(true)
  })

  // `snow` and `cloud` are deliberately excluded: both were MEASURED to abort
  // the process (SIGABRT) on a non-finite `ctx.arc` centre, so they are proven
  // through the isolated child-process probe instead. Running them here would
  // mean a future sanitizer regression kills this whole file's vitest worker
  // rather than failing one test — the same split `C1/I4` already uses for the
  // `grid` idle variant.
  const IN_PROCESS_SAFE_VARIANTS: readonly FxVariant[] = [
    'rain', 'storm', 'fog', 'wind', 'sun',
  ]

  it.each(IN_PROCESS_SAFE_VARIANTS)('survives a non-finite fx without throwing, for %s', (variant) => {
    // Measured: unguarded, `wind` throws a catchable error from
    // `createLinearGradient`, and the other four survive. The sanitizer is
    // what turns all five into a plain, safely-rendered key.
    const buf = renderKey({
      kind: 'gauge', bg: BG,
      fx: {
        variant,
        nowMs: Number.NaN,
        intensity: Number.POSITIVE_INFINITY,
        seed: Number.NEGATIVE_INFINITY,
      },
    })
    expect(buf.length).toBe(KEY_SIZE * KEY_SIZE * 4)
  })

  it.each(['rain', 'snow', 'fog', 'cloud', 'wind'] as const)('draws %s more sparsely or faintly at low intensity', (variant) => {
    const full = renderKey({
      kind: 'gauge', bg: BG, fx: { variant, nowMs: 7700, intensity: 1, seed: 1 },
    })
    const low = renderKey({
      kind: 'gauge', bg: BG,
      fx: { variant, nowMs: 7700, intensity: FX_INTENSITY_MIN, seed: 1 },
    })
    expect(inkCount(full, BG)).toBeGreaterThan(inkCount(low, BG))
  })

  it('slides a rain streak fully in from above and fully out below before it wraps', () => {
    // At the wrap instant every part of the streak must be off-key, or the
    // whole strand vanishes mid-key — the exact defect the matrix rain
    // shipped with once. See `rainColumnSpan`'s own doc comment.
    const spans = Array.from({ length: 400 }, (_, i) => fxRainDropSpan(3, 0, i * 25))
    expect(spans.some((s) => s.tail < 0 && s.head > 0)).toBe(true)
    expect(spans.some((s) => s.tail < KEY_SIZE && s.head > KEY_SIZE)).toBe(true)
    for (const s of spans) {
      expect(s.head).toBeGreaterThan(s.tail)
    }
    // The streak leaves completely: some sample has its trailing end at or
    // past the bottom edge.
    expect(spans.some((s) => s.tail >= KEY_SIZE - 1)).toBe(true)
    // And it enters completely: some sample has its leading end at or above
    // the top edge.
    expect(spans.some((s) => s.head <= 0)).toBe(true)
  })

  it('drifts a snowflake fully in from above and fully out below before it wraps', () => {
    const samples = Array.from({ length: 600 }, (_, i) => fxSnowFlakeY(5, 0, i * 40))
    expect(samples.some((s) => s.y <= 0)).toBe(true)
    expect(samples.some((s) => s.y >= KEY_SIZE)).toBe(true)
    for (const s of samples) {
      expect(s.y).toBeGreaterThanOrEqual(-2 * FX_SNOW_R - 1)
      expect(s.y).toBeLessThanOrEqual(KEY_SIZE + 2 * FX_SNOW_R + 1)
    }
  })

  it('slides a wind streak fully in from the left and out to the right before it wraps', () => {
    const spans = Array.from({ length: 500 }, (_, i) => fxWindStreakSpan(4, 0, i * 15))
    expect(spans.some((s) => s.trail < 0 && s.lead > 0)).toBe(true)
    expect(spans.some((s) => s.trail < KEY_SIZE && s.lead > KEY_SIZE)).toBe(true)
    for (const s of spans) expect(s.lead).toBeGreaterThan(s.trail)
    expect(spans.some((s) => s.trail >= KEY_SIZE - 1)).toBe(true)
    expect(spans.some((s) => s.lead <= 0)).toBe(true)
  })

  /** The render rate the weather page actually uses while its effects run. A
   * strike must be reachable at THIS sampling rate, not merely in continuous
   * time. */
  const PAGE_TICK_MS = 100

  it('strikes sometimes, and stays dark most of the time', () => {
    const samples = Array.from({ length: 1000 }, (_, i) => fxStormStrike(2, i * 10))
    const lit = samples.filter((v) => v !== null).length
    expect(lit).toBeGreaterThan(0)
    expect(lit).toBeLessThan(samples.length / 5)
  })

  it('lets EVERY tile catch its strikes at the page\'s real 100 ms tick', () => {
    // The defect this exists for: the first version used a flat 4300 ms period,
    // which is exactly 43 ticks at 100 ms. Every tile therefore sampled ONE
    // phase value forever, so a tile either always caught its flash or never
    // did — measured on the real seven-tile deck, seed 4 never lit once in 860
    // consecutive frames, permanently.
    //
    // Sampling on the exact tick grid is the whole point. A test that swept a
    // finer grid, or continuous time, would have passed against that bug.
    for (let seed = 0; seed < 8; seed++) {
      let lit = 0
      for (let frame = 0; frame < 900; frame++) {
        if (fxStormStrike(seed, frame * PAGE_TICK_MS) !== null) lit++
      }
      expect(lit, `seed ${seed} never lights at a ${PAGE_TICK_MS} ms tick`).toBeGreaterThan(0)
    }
  })

  it('keeps no seed\'s strike period at a whole number of render ticks', () => {
    // Pins the period property on its OWN, because the widened strike window
    // already defeats the aliasing by itself: breaking the period back to a flat
    // 4300 ms did NOT fail the sampling test above, since a 240 ms window always
    // contains at least two points of a 100 ms grid whatever the phase. The
    // non-multiple period is therefore defence in depth — it keeps the bug from
    // returning if the window is ever narrowed again — and defence in depth that
    // nothing asserts is just a comment.
    for (let seed = 0; seed < 8; seed++) {
      const period = fxStormStrikePeriodMs(seed)
      const ticks = period / PAGE_TICK_MS
      expect(Math.abs(ticks - Math.round(ticks)), `seed ${seed} period is ${period} ms`)
        .toBeGreaterThan(0.02)
    }
  })

  it('keeps the strike window wider than one render tick', () => {
    expect(FX_STORM_STRIKE_DURATION_MS).toBeGreaterThan(PAGE_TICK_MS * 2)
  })

  it('keeps each strike lit for at least two render frames', () => {
    // A window narrower than the tick makes catching a strike a coin toss.
    for (let seed = 0; seed < 8; seed++) {
      let best = 0
      let run = 0
      for (let frame = 0; frame < 900; frame++) {
        run = fxStormStrike(seed, frame * PAGE_TICK_MS) !== null ? run + 1 : 0
        best = Math.max(best, run)
      }
      expect(best, `seed ${seed} never stays lit for two frames`).toBeGreaterThanOrEqual(2)
    }
  })

  it('holds one bolt still for the whole strike, then draws a different one next time', () => {
    // A bolt re-jittered every frame reads as noise. The shape comes from the
    // strike index, so it is stable within a strike and new between strikes.
    const frames: number[] = []
    for (let frame = 0; frame < 900; frame++) {
      if (fxStormStrike(3, frame * PAGE_TICK_MS) !== null) frames.push(frame)
    }
    expect(frames.length).toBeGreaterThan(2)
    const indexAt = (frame: number) => fxStormStrike(3, frame * PAGE_TICK_MS)!.index
    // Consecutive lit frames belong to the same strike.
    const firstRun = frames.filter((f, i) => i === 0 || f === frames[i - 1]! + 1)
    expect(firstRun.length).toBeGreaterThanOrEqual(2)
    expect(indexAt(firstRun[0]!)).toBe(indexAt(firstRun[1]!))
    // A later strike is a different index, so a different shape.
    const later = frames.find((f) => indexAt(f) !== indexAt(frames[0]!))
    expect(later).toBeDefined()
  })

  it('makes the storm brighter than plain rain at a real strike instant', () => {
    // The instant comes from the predicate itself, not a guessed timestamp, so
    // this cannot silently start sampling a dark frame.
    const strikeMs = Array.from({ length: 2000 }, (_, i) => i * 5)
      .find((ms) => fxStormStrike(2, ms) !== null)
    expect(strikeMs).toBeDefined()
    const total = (buf: Buffer) => {
      let sum = 0
      for (let y = 0; y < KEY_SIZE; y++) {
        for (let x = 0; x < KEY_SIZE; x++) sum += lum(probe(buf, x, y))
      }
      return sum
    }
    const fxAt = (variant: FxVariant) => renderKey({
      kind: 'gauge', bg: BG, fx: { variant, nowMs: strikeMs!, intensity: 1, seed: 2 },
    })
    expect(total(fxAt('storm'))).toBeGreaterThan(total(fxAt('rain')))
  })

  it('draws a bolt, not a uniform wash, so a strike cannot read as a dimmed key', () => {
    // The first version filled the whole key evenly at full strength. That read
    // as the tile being greyed out — colliding with the page's own staleness
    // signal — rather than as lightning. A bolt is bright and LOCAL, so the
    // brightest pixel must stand well clear of the key's average.
    const strikeMs = Array.from({ length: 2000 }, (_, i) => i * 5)
      .find((ms) => fxStormStrike(2, ms) !== null)!
    const buf = renderKey({
      kind: 'gauge', bg: BG, fx: { variant: 'storm', nowMs: strikeMs, intensity: 1, seed: 2 },
    })
    let brightest = 0
    let sum = 0
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        const l = lum(probe(buf, x, y))
        brightest = Math.max(brightest, l)
        sum += l
      }
    }
    const mean = sum / (KEY_SIZE * KEY_SIZE)
    expect(brightest).toBeGreaterThan(mean * 1.6)
  })

  it('keeps a strike under the cap, bolt and sky glow together', () => {
    const strikeMs = Array.from({ length: 2000 }, (_, i) => i * 5)
      .find((ms) => fxStormStrike(2, ms) !== null)!
    assertUnderCap(
      renderKey({ kind: 'gauge', bg: BG, fx: { variant: 'storm', nowMs: strikeMs, intensity: 1, seed: 2 } }),
      BG,
    )
  })

  it('leans and lengthens storm rain well past plain rain, between strikes', () => {
    // Between strikes the two variants differ only in their streaks, which is
    // exactly the case that was indistinguishable on the real deck. Compares
    // ink coverage: a longer, wider, more slanted streak covers more pixels.
    const darkMs = Array.from({ length: 4000 }, (_, i) => i * 5)
      .find((ms) => fxStormStrike(5, ms) === null)!
    const at = (variant: FxVariant) => renderKey({
      kind: 'gauge', bg: BG, fx: { variant, nowMs: darkMs, intensity: 0.7, seed: 5 },
    })
    expect(inkCount(at('storm'), BG)).toBeGreaterThan(inkCount(at('rain'), BG) * 1.3)
  })

  it('separates a light shower from a heavy one by more than the drop count', () => {
    // 40 percent against 90 percent used to differ only by five streaks out of
    // sixteen, which is not a visible difference on a 96 px key. Length and
    // opacity now scale with intensity as well.
    //
    // The threshold is MEASURED, not guessed, because the obvious version of
    // this test could not fail: at 1.8 it passed even with length and opacity
    // scaling removed, since the drop count alone already clears that. Measured
    // on 2026-08-18 — count only: 2.09. With length and opacity scaling: 3.30.
    // 2.7 sits between them with margin on both sides.
    const MEASURED_SCALING_RATIO = 2.7
    const light = renderKey({ kind: 'gauge', bg: BG, fx: { variant: 'rain', nowMs: 4200, intensity: 0.4, seed: 1 } })
    const heavy = renderKey({ kind: 'gauge', bg: BG, fx: { variant: 'rain', nowMs: 4200, intensity: 0.95, seed: 1 } })
    expect(inkCount(heavy, BG)).toBeGreaterThan(inkCount(light, BG) * MEASURED_SCALING_RATIO)
  })

  it('leaves the key\'s own content brighter than the layer beneath it', () => {
    const fx = { variant: 'storm' as const, nowMs: 0, intensity: 1, seed: 2 }
    const withText = renderKey({ kind: 'gauge', bg: BG, fx, lines: ['NOW', '95°/77°', '100%'] })
    const layerOnly = renderKey({ kind: 'gauge', bg: BG, fx })
    let brightestLayer = 0
    let brightestContent = 0
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        const under = probe(layerOnly, x, y)
        const over = probe(withText, x, y)
        brightestLayer = Math.max(brightestLayer, lum(under))
        if (!near3(over, under, 1)) brightestContent = Math.max(brightestContent, lum(over))
      }
    }
    expect(brightestContent).toBeGreaterThan(brightestLayer * 1.5)
  })

  it('draws the layer beneath the text, never over it', () => {
    // Same text, two different effect clocks: the opaque text pixels must be
    // identical in both, because the layer is composited underneath and the
    // glyph interiors are opaque.
    //
    // Uses the weather day tile's REAL line sizes and positions, not the 11 px
    // default. Measured on 2026-08-18: at 11 px only 18 pixels of this text
    // are within 6 of `theme.text`, because a small thin glyph is almost all
    // anti-aliased edge — the shipped sizes give 204. Testing the default
    // would have made this proof nearly vacuous (lesson 22).
    const lines = ['NOW', '95°/77°', '100%']
    const shipped = {
      kind: 'gauge' as const, bg: BG, lines,
      lineSizes: [12, [16, 13, 11], 20], lineY: [3, 54, 74], align: 'center' as const,
    }
    const a = renderKey({ ...shipped, fx: { variant: 'rain', nowMs: 0, intensity: 1, seed: 1 } })
    const b = renderKey({ ...shipped, fx: { variant: 'rain', nowMs: 5000, intensity: 1, seed: 1 } })
    const plain = renderKey(shipped)
    let textPixels = 0
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        // Only OPAQUE glyph interiors, matched against the real text colour.
        // An anti-aliased glyph edge is partly transparent by design, so it
        // legitimately blends with whatever moves underneath it; asserting on
        // those pixels would test canvas anti-aliasing, not the draw order.
        if (near3(probe(plain, x, y), theme.text, 6)) {
          textPixels++
          near(probe(a, x, y), probe(b, x, y), 1)
        }
      }
    }
    // Guards against a vacuous pass: there must BE text pixels to compare.
    expect(textPixels).toBeGreaterThan(100)
  })
})

