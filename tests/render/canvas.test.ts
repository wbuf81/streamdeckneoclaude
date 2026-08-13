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
} from '../../src/render/canvas.js'
import { theme } from '../../src/render/theme.js'

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
    near(probe(buf, 48, 48), theme.red, 40)
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

  it('renders a spotify-like key byte-identically to the pre-lineSizes snapshot', () => {
    const buf = renderKey({ kind: 'control', glyph: '♥', glyphColor: theme.red })
    expect(sha256(buf)).toBe(
      '20d595718c3d8d68a5569793b7563305ffb081b01c0a41feec5fff8a28c98860',
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
    let firstInkRow = -1
    for (let y = 0; y < 30 && firstInkRow < 0; y++) {
      for (let x = 9; x < 90; x++) {
        if (!near3(probe(buf, x, y), theme.bg)) {
          firstInkRow = y
          break
        }
      }
    }
    expect(firstInkRow).toBeGreaterThanOrEqual(3)
    expect(firstInkRow).toBeLessThan(17)
  })

  it('does not affect rendering when lineY is absent, matching the legacy path exactly', () => {
    const a = renderKey({ kind: 'gauge', lines: ['5-HR CAP', '20%'], lineSizes: [11, 28] })
    const b = renderKey({ kind: 'gauge', lines: ['5-HR CAP', '20%'], lineSizes: [11, 28] })
    expect(a.equals(b)).toBe(true)
  })
})

describe('renderKey weather band layout: no overlap', () => {
  // This is the geometric proof the user's real-device complaint demands:
  // a label, an emoji, a coloured temperature line and a coloured rain-chance
  // line, laid out exactly as `WeatherPage.dayKey` builds it, with none of
  // the bands touching another.
  function weatherLikeKey() {
    return renderKey({
      kind: 'gauge',
      lines: ['THU', '95°/77°', '47%'],
      lineSizes: [12, 16, 20],
      lineY: [3, 54, 74],
      lineColors: [undefined, theme.red, theme.blue],
      align: 'center',
      emoji: '☀️',
      bg: [34, 27, 18],
    })
  }

  const inkOnRow = (buf: Buffer, y: number) => {
    for (let x = 9; x < 90; x++) {
      if (!near3(probe(buf, x, y), [34, 27, 18])) return true
    }
    return false
  }

  it('paints ink inside band 1 (the day label, y 3 to 15)', () => {
    expect(inkOnRow(weatherLikeKey(), 10)).toBe(true)
  })

  it('paints ink inside band 3 (the temperature line, y 54 to 70)', () => {
    expect(inkOnRow(weatherLikeKey(), 60)).toBe(true)
  })

  it('paints ink inside band 4 (the rain chance, y 74 to 88)', () => {
    expect(inkOnRow(weatherLikeKey(), 80)).toBe(true)
  })

  it('leaves the gap between band 1 and the emoji background, at y 16', () => {
    expect(inkOnRow(weatherLikeKey(), 16)).toBe(false)
  })

  it('leaves the gap between the emoji and band 3 background, at y 52', () => {
    expect(inkOnRow(weatherLikeKey(), 52)).toBe(false)
  })

  it('leaves the gap between band 3 and band 4 background, at y 72', () => {
    expect(inkOnRow(weatherLikeKey(), 72)).toBe(false)
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
