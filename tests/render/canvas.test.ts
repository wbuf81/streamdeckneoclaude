import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
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

describe('renderKey', () => {
  it('returns a 96 by 96 image', () => {
    const png = renderKey({ kind: 'blank' })
    expect(png.length).toBeGreaterThan(0)
    expect(probe(png, 0, 0)).toHaveLength(3)
    expect(KEY_SIZE).toBe(96)
  })

  it('fills a blank key with the background colour', () => {
    const png = renderKey({ kind: 'blank' })
    near(probe(png, 48, 48), theme.bg)
  })

  it('draws the border colour on the left edge', () => {
    const png = renderKey({ kind: 'session', border: theme.amber, pulseOn: true })
    near(probe(png, 1, 48), theme.amber)
  })

  it('draws a dark border when pulseOn is false', () => {
    const png = renderKey({ kind: 'session', border: theme.amber, pulseOn: false })
    const px = probe(png, 1, 48)
    expect(px[0]).toBeLessThan(theme.amber[0])
  })

  it('draws a solid border when pulseOn is absent', () => {
    const png = renderKey({ kind: 'session', border: theme.cyan })
    near(probe(png, 1, 48), theme.cyan)
  })

  it('draws a bar filled to the given fraction', () => {
    const png = renderKey({
      kind: 'gauge',
      bar: { value: 1.0, color: theme.green },
    })
    // The bar spans the key width at y = 70. A full bar paints the right end.
    near(probe(png, 80, 70), theme.green)
  })

  it('leaves the bar track unpainted past the fill', () => {
    const png = renderKey({
      kind: 'gauge',
      bar: { value: 0.1, color: theme.green },
    })
    near(probe(png, 80, 70), theme.barTrack)
  })

  it('clamps a bar value above 1', () => {
    const png = renderKey({ kind: 'gauge', bar: { value: 5, color: theme.green } })
    near(probe(png, 88, 70), theme.green)
  })

  it('clamps a bar value below 0', () => {
    const png = renderKey({ kind: 'gauge', bar: { value: -5, color: theme.green } })
    near(probe(png, 12, 70), theme.barTrack)
  })

  it('paints text pixels somewhere on the key', () => {
    const blank = renderKey({ kind: 'gauge' })
    const withText = renderKey({ kind: 'gauge', lines: ['HELLO'] })
    expect(withText.equals(blank)).toBe(false)
  })

  it('renders an image key from raw pixels', () => {
    const solid = solidPng(255, 0, 0)
    const png = renderKey({ kind: 'image', image: solid, imageKey: 'x' })
    near(probe(png, 48, 48), [255, 0, 0], 20)
  })
})

describe('renderStrip', () => {
  it('returns a 248 by 58 image', () => {
    expect(STRIP_WIDTH).toBe(248)
    expect(STRIP_HEIGHT).toBe(58)
    const png = renderStrip({ lines: ['hello'] })
    near(probe(png, 240, 4), theme.bg)
  })

  it('draws a progress bar filled to the fraction', () => {
    const png = renderStrip({
      lines: ['a', 'b'],
      bar: { value: 1.0, color: theme.green },
    })
    near(probe(png, 200, 50), theme.green)
  })
})

/** Builds a 96 by 96 solid-colour PNG, for the image test. */
function solidPng(r: number, g: number, b: number): Buffer {
  const c = createCanvas(96, 96)
  const ctx = c.getContext('2d')
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.fillRect(0, 0, 96, 96)
  return c.toBuffer('image/png')
}
