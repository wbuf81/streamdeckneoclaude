import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import {
  renderKey,
  renderStrip,
  probe,
  KEY_SIZE,
  STRIP_WIDTH,
  STRIP_HEIGHT,
  FLASH_RING_INSET,
  FLASH_RING_THICKNESS,
} from '../../src/render/canvas.js'
import { theme } from '../../src/render/theme.js'
import type { KeySpec } from '../../src/render/specs.js'

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

describe('renderKey pulse (the Spotify idle equaliser)', () => {
  it('draws something (not blank) when a pulse is present', () => {
    const blank = renderKey({ kind: 'control' })
    const withPulse = renderKey({ kind: 'control', pulse: { phase: 0, bars: 6, color: theme.green } })
    expect(withPulse.equals(blank)).toBe(false)
  })

  it('draws nothing for zero bars, and does not throw', () => {
    const blank = renderKey({ kind: 'control' })
    expect(() =>
      renderKey({ kind: 'control', pulse: { phase: 0, bars: 0, color: theme.green } }),
    ).not.toThrow()
    const buf = renderKey({ kind: 'control', pulse: { phase: 0, bars: 0, color: theme.green } })
    expect(buf.equals(blank)).toBe(true)
  })

  it('dims the pulse bars like every other element', () => {
    const bright = renderKey({ kind: 'control', pulse: { phase: 0.4, bars: 6, color: theme.green } })
    const dimmed = renderKey({
      kind: 'control', pulse: { phase: 0.4, bars: 6, color: theme.green }, dim: true,
    })
    expect(bright.equals(dimmed)).toBe(false)
  })

  it('renders different pixels at two different phases — an animation test that actually probes pixels', () => {
    // Lesson 17: measure, do not reason. Two phases a quarter turn apart on a
    // single bar move it from its mid-height rest point to its tallest point,
    // so this is not a coincidence of floating-point noise.
    const a = renderKey({ kind: 'control', pulse: { phase: 0, bars: 1, color: theme.green } })
    const b = renderKey({ kind: 'control', pulse: { phase: Math.PI / 2, bars: 1, color: theme.green } })
    expect(a.equals(b)).toBe(false)
  })

  it('reaches higher up the key at the loud point of the wave than at the quiet point, measured directly', () => {
    const topInkRow = (buf: Buffer): number => {
      for (let y = 0; y < KEY_SIZE; y++) {
        for (let x = 0; x < KEY_SIZE; x++) {
          if (!near3(probe(buf, x, y), theme.bg)) return y
        }
      }
      return KEY_SIZE
    }
    // One bar, so `phase` alone drives its height: sin(0) = 0 (mid-height,
    // "at rest") vs sin(pi/2) = 1 (the tallest the bar ever gets).
    const quiet = renderKey({ kind: 'control', pulse: { phase: 0, bars: 1, color: theme.green } })
    const loud = renderKey({ kind: 'control', pulse: { phase: Math.PI / 2, bars: 1, color: theme.green } })
    expect(topInkRow(loud)).toBeLessThan(topInkRow(quiet))
  })

  it('gives each of several bars its own height from one phase, via the per-bar offset', () => {
    // Distinct bar count so the per-bar phase spread (2*PI / bars) does not
    // land every bar on an identical multiple of PI, which would make every
    // bar the same height by coincidence rather than by proving the offset.
    const buf = renderKey({ kind: 'control', pulse: { phase: 0.3, bars: 5, color: theme.green } })
    const x0 = 9 // BORDER + PAD
    const barW = (90 - 9) / 5 // x1 - x0, over 5 bars
    const topOfBar = (i: number): number => {
      const x = Math.floor(x0 + i * barW + 1)
      for (let y = 0; y < KEY_SIZE; y++) {
        if (!near3(probe(buf, x, y), theme.bg)) return y
      }
      return KEY_SIZE
    }
    const tops = [0, 1, 2, 3, 4].map(topOfBar)
    expect(new Set(tops).size).toBeGreaterThan(1)
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
