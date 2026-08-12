import { describe, it, expect } from 'vitest'
import { contentBounds, squareBox, pickFrameIndices } from '../../scripts/extract-crab-frames.js'

/** Builds a `w` by `h` RGBA buffer, opaque inside `r`, transparent outside it. */
function bufferWithRect(w: number, h: number, r: { x: number; y: number; w: number; h: number }): Uint8Array {
  const buf = new Uint8Array(w * h * 4)
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      buf[(y * w + x) * 4 + 3] = 255
    }
  }
  return buf
}

describe('contentBounds', () => {
  it('finds the exact bounds of a known opaque rectangle', () => {
    const rect = { x: 4, y: 6, w: 10, h: 5 }
    const buf = bufferWithRect(32, 32, rect)
    expect(contentBounds(buf, 32, 32)).toEqual(rect)
  })

  it('returns a safe full-image box for a fully transparent buffer', () => {
    const buf = new Uint8Array(32 * 32 * 4)
    const box = contentBounds(buf, 32, 32)
    expect(box.w).toBeGreaterThan(0)
    expect(box.h).toBeGreaterThan(0)
    expect(box).toEqual({ x: 0, y: 0, w: 32, h: 32 })
  })

  it('ignores pixels below the alpha threshold', () => {
    const buf = new Uint8Array(16 * 16 * 4)
    buf[(8 * 16 + 8) * 4 + 3] = 5 // below the default threshold of 16
    const box = contentBounds(buf, 16, 16)
    expect(box).toEqual({ x: 0, y: 0, w: 16, h: 16 })
  })
})

describe('squareBox', () => {
  it('expands a wide box to a centred square with margin', () => {
    const box = squareBox({ x: 40, y: 45, w: 20, h: 10 }, 100, 100, 0)
    expect(box.w).toBe(box.h)
    // Centred on the original box's centre: cx=50, cy=50, side=20.
    expect(box).toEqual({ x: 40, y: 40, w: 20, h: 20 })
  })

  it('clamps at the top-left image edge instead of going negative', () => {
    const box = squareBox({ x: 0, y: 0, w: 10, h: 4 }, 100, 100, 0)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box).toEqual({ x: 0, y: 0, w: 10, h: 10 })
  })

  it('clamps at the bottom-right image edge instead of overflowing', () => {
    const box = squareBox({ x: 92, y: 96, w: 8, h: 4 }, 100, 100, 0)
    expect(box.x + box.w).toBeLessThanOrEqual(100)
    expect(box.y + box.h).toBeLessThanOrEqual(100)
    expect(box).toEqual({ x: 92, y: 92, w: 8, h: 8 })
  })

  it('never produces a box larger than the image', () => {
    const box = squareBox({ x: 0, y: 0, w: 100, h: 100 }, 100, 100, 0.5)
    expect(box).toEqual({ x: 0, y: 0, w: 100, h: 100 })
  })
})

describe('pickFrameIndices', () => {
  it('returns every index when total is below max', () => {
    expect(pickFrameIndices(5, 24)).toEqual([0, 1, 2, 3, 4])
  })

  it('returns every index when total equals max', () => {
    expect(pickFrameIndices(24, 24)).toEqual(Array.from({ length: 24 }, (_, i) => i))
  })

  it('samples evenly, ascending and unique, when total exceeds max', () => {
    const indices = pickFrameIndices(120, 24)
    expect(indices.length).toBeLessThanOrEqual(24)
    expect(indices[0]).toBe(0)
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]!).toBeGreaterThan(indices[i - 1]!)
    }
    expect(new Set(indices).size).toBe(indices.length)
  })

  it('includes the first frame when heavily oversampled', () => {
    const indices = pickFrameIndices(1000, 24)
    expect(indices[0]).toBe(0)
    expect(indices.length).toBeLessThanOrEqual(24)
  })

  it('returns nothing for zero total frames', () => {
    expect(pickFrameIndices(0, 24)).toEqual([])
  })
})
