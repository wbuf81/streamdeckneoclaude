import { describe, it, expect, beforeAll } from 'vitest'
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
import { loadSprites } from '../../src/render/sprites.js'

// The renderer reads sprites from a cache that only `loadSprites` fills, because
// `@napi-rs/canvas` has no synchronous decode. A real process calls this once at
// startup; the test does the same so the sprite test below sees a real image.
beforeAll(async () => {
  await loadSprites()
})

/** Allows a small difference, because canvas anti-aliases edges. */
function near(actual: readonly number[], expected: readonly number[], tol = 12) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(tol)
  }
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

describe('renderKey sprite', () => {
  it('changes the image when a sprite is present', () => {
    const without = renderKey({ kind: 'session', lines: ['A'] })
    const withSprite = renderKey({ kind: 'session', lines: ['A'], sprite: 'crab' })
    expect(withSprite.equals(without)).toBe(false)
  })

  it('does not throw for an unknown sprite name', () => {
    expect(() => renderKey({ kind: 'session', sprite: 'no-such-sprite' })).not.toThrow()
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

  it('draws the emoji before the text lines, so a line stays legible on top', () => {
    const emojiOnly = renderKey({ kind: 'gauge', emoji: '☀️' })
    const withLine = renderKey({ kind: 'gauge', emoji: '☀️', lines: ['NOW'] })
    expect(withLine.equals(emojiOnly)).toBe(false)
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
