/**
 * The glow-up render primitives: line spark, bar-spark floor, hero text,
 * range gauge, one-shot effects, soft cloud, fog and compass glyphs, mascots,
 * image transform, edge progress, strip banner and sprite, and `breathe`.
 *
 * Every geometric claim probes a REGION, never one pixel column (lesson 22).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as esbuild from 'esbuild'
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import {
  renderKey, renderStrip, probe, KEY_SIZE, STRIP_WIDTH, STRIP_HEIGHT,
  sparkScale, SPARK_BAR_MIN_H, fxCloudLobes,
} from '../../src/render/canvas.js'
import {
  breathe, blockPerimeterProgress, canonicalKeySpec, oneShotElapsed, linePopScale,
  ONE_SHOT_DURATION_MS, BREATHE_QUANTUM_MS,
} from '../../src/render/motion.js'
import { brickShakePx, rangeFraction, RANGE_X0, RANGE_X1 } from '../../src/render/overlays.js'
import { bullHopPx } from '../../src/render/mascots.js'
import { keyHash, stripHash } from '../../src/render/specs.js'
import type { KeySpec, Rgb, StripSpec } from '../../src/render/specs.js'
import { theme } from '../../src/render/theme.js'

const T = 1_786_549_560_000

type Box = { x0: number; y0: number; x1: number; y1: number }

/** Pixels in `box` (inclusive-exclusive) that differ from `bg` by more than
 * `tol` on any channel. */
function inkIn(buf: Buffer, box: Box, bg: Rgb = theme.bg, tol = 12, width = KEY_SIZE): number {
  let n = 0
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const p = probe(buf, x, y, width)
      if (Math.abs(p[0] - bg[0]) > tol || Math.abs(p[1] - bg[1]) > tol || Math.abs(p[2] - bg[2]) > tol) n++
    }
  }
  return n
}

/** The bounding box of every pixel `pick` accepts, or null. */
function bbox(buf: Buffer, pick: (p: Rgb) => boolean, width = KEY_SIZE, height = KEY_SIZE): Box | null {
  let b: Box | null = null
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pick(probe(buf, x, y, width))) continue
      if (!b) b = { x0: x, y0: y, x1: x + 1, y1: y + 1 }
      else {
        b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y)
        b.x1 = Math.max(b.x1, x + 1); b.y1 = Math.max(b.y1, y + 1)
      }
    }
  }
  return b
}

const notBg = (p: Rgb): boolean =>
  Math.abs(p[0] - theme.bg[0]) > 12 || Math.abs(p[1] - theme.bg[1]) > 12 || Math.abs(p[2] - theme.bg[2]) > 12
const greenish = (p: Rgb): boolean => p[1] > 120 && p[1] > p[0] + 40
const cyanish = (p: Rgb): boolean => p[2] > 170 && p[1] > 150 && p[0] < 120

const WHOLE: Box = { x0: 0, y0: 0, x1: KEY_SIZE, y1: KEY_SIZE }

describe('bar spark draws every value, the minimum included', () => {
  it('puts ink in every bar slot, including the lowest value', () => {
    const values = [3, 1, 4, 1, 5, 9, 2, 6]
    const buf = renderKey({ kind: 'gauge', spark: { values, color: theme.green } })
    const x0 = 9
    const barW = (90 - x0) / values.length
    for (let i = 0; i < values.length; i++) {
      const sx = Math.round(x0 + i * barW)
      // The bottom four rows of this bar's own slot, its full width.
      const ink = inkIn(buf, { x0: sx, y0: 84, x1: Math.round(sx + barW - 1), y1: 88 })
      expect(ink, `bar ${i} (value ${values[i]})`).toBeGreaterThan(0)
    }
  })

  it('draws the minimum at the floor height, no more', () => {
    const buf = renderKey({ kind: 'gauge', spark: { values: [0, 10], color: theme.green } })
    // The first bar spans x 9..48. Its ink must be exactly SPARK_BAR_MIN_H rows.
    const b = bbox(buf, greenish)!
    expect(b).not.toBeNull()
    let rows = 0
    for (let y = 0; y < KEY_SIZE; y++) if (inkIn(buf, { x0: 12, y0: y, x1: 40, y1: y + 1 }) > 0) rows++
    expect(rows).toBe(SPARK_BAR_MIN_H)
  })
})

describe('sparkScale', () => {
  it('uses min and max alone when nothing else is set', () => {
    expect(sparkScale([1, 5, 3])).toEqual({ lo: 1, hi: 5 })
  })
  it('always includes the baseline', () => {
    expect(sparkScale([1, 2], 0)).toEqual({ lo: 0, hi: 2 })
  })
  it('widens to the minimum half-range around the baseline', () => {
    expect(sparkScale([0.05, 0.1], 0, 1)).toEqual({ lo: -1, hi: 1 })
  })
  it('centres the half-range on the series midpoint without a baseline', () => {
    expect(sparkScale([9, 11], undefined, 5)).toEqual({ lo: 5, hi: 15 })
  })
})

describe('line spark', () => {
  const wiggle = Array.from({ length: 40 }, (_, k) => 0.1 * (k / 39) + Math.sin(k) * 0.04)
  const line = (extra: Partial<NonNullable<KeySpec['spark']>> = {}): Buffer =>
    renderKey({ kind: 'gauge', spark: { values: wiggle, color: theme.green, style: 'line', baseline: 0, ...extra } })

  it('reads a 0.1 percent day as nearly flat with a 1 percent minimum half-range', () => {
    const flat = bbox(line({ minHalfRange: 1, endDot: false }), greenish)!
    const stretched = bbox(line({ endDot: false }), greenish)!
    expect(flat.y1 - flat.y0).toBeLessThan(12)
    expect(stretched.y1 - stretched.y0).toBeGreaterThan(25)
  })

  it('draws an emphasised end dot on the last point', () => {
    const values = [0, 1, 2, 3, 4, 5]
    const withDot = renderKey({ kind: 'gauge', spark: { values, color: theme.green, style: 'line' } })
    const noDot = renderKey({ kind: 'gauge', spark: { values, color: theme.green, style: 'line', endDot: false } })
    // The last point sits at the top right of the band: the dot's region.
    const region = { x0: 78, y0: 44, x1: 92, y1: 58 }
    expect(inkIn(withDot, region)).toBeGreaterThan(inkIn(noDot, region) + 20)
  })

  it('draws the dot only on the slice that carries the last point', () => {
    const values = [0, 1, 2, 3, 4, 5]
    const region = { x0: 78, y0: 0, x1: 92, y1: KEY_SIZE }
    const counts = [0, 1, 2].map((index) => {
      const spec = { values, color: theme.green, style: 'line' as const, fullHeight: true, slice: { index, count: 3 } }
      return inkIn(renderKey({ kind: 'gauge', spark: spec }), region) -
        inkIn(renderKey({ kind: 'gauge', spark: { ...spec, endDot: false } }), region)
    })
    expect(counts[0]).toBe(0)
    expect(counts[1]).toBe(0)
    expect(counts[2]).toBeGreaterThan(20)
  })

  it('fills a soft area between the line and the baseline', () => {
    // A rising series on a baseline at its minimum: the area lies under the line.
    const values = [0, 10]
    const buf = renderKey({ kind: 'gauge', spark: { values, color: theme.green, style: 'line', baseline: 0, endDot: false } })
    // Below the diagonal, above the baseline: x 60..80, y 78..85.
    let tinted = 0
    for (let y = 78; y < 85; y++) for (let x = 60; x < 80; x++) {
      const p = probe(buf, x, y)
      if (p[1] > theme.bg[1] + 3 && p[1] < 150) tinted++
    }
    expect(tinted).toBeGreaterThan(100)
  })

  it('marks the baseline with a dotted rule: lit and unlit runs along one row', () => {
    const buf = renderKey({ kind: 'gauge', spark: { values: [1, 2], color: theme.green, style: 'line', baseline: 0, minHalfRange: 3, endDot: false } })
    // Baseline 0 in a -3..3 scale sits mid-band: find the rule's row in a
    // band to the right of the line's start, where only the rule draws.
    // The rule is neutral grey; the area above it is green. Count grey only.
    const grey = (p: Rgb): boolean => Math.abs(p[0] - p[1]) < 12 && Math.abs(p[1] - p[2]) < 12 && p[0] > theme.bg[0] + 30
    let best = 0
    let bestRow = -1
    for (let y = 48; y < 90; y++) {
      let n = 0
      for (let x = 12; x < 88; x++) if (grey(probe(buf, x, y))) n++
      if (n > best) { best = n; bestRow = y }
    }
    expect(bestRow).toBeGreaterThan(0)
    // Dotted, not solid: between a quarter and two thirds of the row is lit.
    expect(best).toBeGreaterThan(76 * 0.25)
    expect(best).toBeLessThan(76 * 0.66)
  })

  it('is deterministic', () => {
    expect(line().equals(line())).toBe(true)
  })
})

describe('hero text: per-line alignment, weight and pop', () => {
  it('right-aligns a line to the right padding, sharing a row with a left one', () => {
    const buf = renderKey({ kind: 'gauge', lines: ['TSLA', '241.18'], lineY: [6, 6], lineAligns: ['left', 'right'] })
    const right = bbox(buf, notBg)!
    expect(right.x1).toBeGreaterThanOrEqual(88)
    expect(right.x1).toBeLessThanOrEqual(91)
    expect(right.x0).toBeLessThanOrEqual(11)
  })

  it('draws bold with more ink than regular', () => {
    const regular = renderKey({ kind: 'gauge', lines: ['+3.41%'], lineSizes: [19] })
    const bold = renderKey({ kind: 'gauge', lines: ['+3.41%'], lineSizes: [19], lineWeights: ['bold'] })
    expect(inkIn(bold, WHOLE)).toBeGreaterThan(inkIn(regular, WHOLE) * 1.1)
  })

  const hero = (pop?: KeySpec['linePop']): KeySpec => ({
    kind: 'gauge', lines: ['NVDA', '+3%'], lineSizes: [11, 19], align: 'center', ...(pop ? { linePop: pop } : {}),
  })

  it('swells the popped line in place, and only that line', () => {
    const rest = bbox(renderKey(hero()), notBg)!
    const popped = renderKey(hero({ line: 1, startedAtMs: T, nowMs: T + 40 }))
    const p = bbox(popped, notBg)!
    expect(p.x1 - p.x0).toBeGreaterThan(rest.x1 - rest.x0 + 6)
    // The first line's own band is untouched by the pop.
    const restBuf = renderKey(hero())
    expect(inkIn(popped, { x0: 0, y0: 0, x1: KEY_SIZE, y1: 14 })).toBe(inkIn(restBuf, { x0: 0, y0: 0, x1: KEY_SIZE, y1: 14 }))
  })

  it('never pops a wide line past the key edges', () => {
    const buf = renderKey({ kind: 'gauge', lines: ['+13.41%'], lineSizes: [19], align: 'center', linePop: { line: 0, startedAtMs: T, nowMs: T } })
    expect(inkIn(buf, { x0: 0, y0: 0, x1: 1, y1: KEY_SIZE })).toBe(0)
    expect(inkIn(buf, { x0: 95, y0: 0, x1: 96, y1: KEY_SIZE })).toBe(0)
  })

  it('draws exactly the resting frame, and hashes the same, once the pop is over', () => {
    const done = hero({ line: 1, startedAtMs: T, nowMs: T + 1000 })
    expect(renderKey(done).equals(renderKey(hero()))).toBe(true)
    expect(keyHash(done)).toBe(keyHash(hero()))
    expect(linePopScale(1000)).toBe(1)
    expect(linePopScale(0)).toBeGreaterThan(1.3)
  })
})

describe('range gauge', () => {
  const marker = (spec: NonNullable<KeySpec['range']>): number => {
    const buf = renderKey({ kind: 'gauge', range: spec })
    // The arrow's rows, above the track: average x of white ink.
    let sum = 0
    let n = 0
    const y = spec.y ?? 44
    for (let yy = y - 9; yy < y - 2; yy++) for (let x = 0; x < KEY_SIZE; x++) {
      const p = probe(buf, x, yy)
      if (p[0] > 200 && p[1] > 200 && p[2] > 200) { sum += x; n++ }
    }
    expect(n).toBeGreaterThan(5)
    return sum / n
  }

  it('places the marker at the value', () => {
    expect(Math.abs(marker({ lo: 0, hi: 100, value: 25 }) - (RANGE_X0 + 0.25 * (RANGE_X1 - RANGE_X0)))).toBeLessThan(1)
  })
  it('clamps a value outside the range to the nearest end', () => {
    expect(marker({ lo: 0, hi: 10, value: 99 })).toBeGreaterThan(RANGE_X1 - 3)
    expect(marker({ lo: 0, hi: 10, value: -99 })).toBeLessThan(RANGE_X0 + 3)
  })
  it('centres the marker for a degenerate range', () => {
    expect(rangeFraction(5, 5, 5)).toBe(0.5)
    expect(Math.abs(marker({ lo: 5, hi: 5, value: 5 }) - KEY_SIZE / 2)).toBeLessThan(1)
  })
  it('paints the track across its whole width, red to green with a gradient', () => {
    const buf = renderKey({ kind: 'gauge', range: { lo: 0, hi: 1, value: 0.5, gradient: [theme.red, theme.green], marker: 'tick', color: theme.blue } })
    const left = probe(buf, RANGE_X0 + 3, 48)
    const right = probe(buf, RANGE_X1 - 3, 48)
    expect(left[0]).toBeGreaterThan(left[1])
    expect(right[1]).toBeGreaterThan(right[0])
  })
})

describe('one-shot effects', () => {
  const base: KeySpec = { kind: 'gauge', lines: ['NVDA', '+3.41%'], lineSizes: [11, 19], align: 'center' }
  const withFx = (variant: 'burst' | 'brick' | 'sweep' | 'hearts', e: number, extra = {}): KeySpec => ({
    ...base, effects: [{ variant, startedAtMs: T, nowMs: T + e, ...extra }],
  })
  const plain = renderKey(base)

  it.each(['burst', 'brick', 'sweep', 'hearts'] as const)('%s draws while running and nothing once finished', (v) => {
    expect(renderKey(withFx(v, 240)).equals(plain)).toBe(false)
    const d = ONE_SHOT_DURATION_MS[v]
    expect(renderKey(withFx(v, d)).equals(plain)).toBe(true)
    expect(renderKey(withFx(v, -5)).equals(plain)).toBe(true)
  })

  it.each(['burst', 'brick', 'sweep', 'hearts'] as const)('%s drops out of the hash once finished, and before it starts', (v) => {
    expect(keyHash(withFx(v, ONE_SHOT_DURATION_MS[v] + 5000))).toBe(keyHash(base))
    expect(keyHash(withFx(v, -1))).toBe(keyHash(base))
  })

  it('hashes a running effect by its quantised elapsed time, so absolute clocks do not matter', () => {
    const a: KeySpec = { ...base, effects: [{ variant: 'burst', startedAtMs: T, nowMs: T + 105 }] }
    const b: KeySpec = { ...base, effects: [{ variant: 'burst', startedAtMs: T + 5000, nowMs: T + 5000 + 119 }] }
    const c: KeySpec = { ...base, effects: [{ variant: 'burst', startedAtMs: T, nowMs: T + 125 }] }
    expect(keyHash(a)).toBe(keyHash(b))
    expect(keyHash(a)).not.toBe(keyHash(c))
    expect(renderKey(a).equals(renderKey(b))).toBe(true)
    expect(oneShotElapsed(T, T + 119, 1500)).toBe(80)
  })

  it('bursts confetti outward from the origin, in colour', () => {
    const early = renderKey(withFx('burst', 40))
    const late = renderKey(withFx('burst', 700))
    // Early: everything near the origin. Late: pieces far from it.
    const far = (b: Buffer): number =>
      inkIn(b, { x0: 0, y0: 0, x1: 20, y1: KEY_SIZE }, theme.bg, 30) + inkIn(b, { x0: 76, y0: 0, x1: 96, y1: KEY_SIZE }, theme.bg, 30)
    expect(far(late)).toBeGreaterThan(far(early) + 10)
  })

  it('drops a brick onto the content and shakes it after landing', () => {
    expect(brickShakePx(200)).toBe(0)
    expect(Math.abs(brickShakePx(380))).toBeGreaterThan(0.5)
    expect(brickShakePx(1000)).toBe(0)
    const brickRed = (p: Rgb): boolean => p[0] > 120 && p[0] < 180 && p[1] > 55 && p[1] < 95 && p[2] < 80
    const landed = renderKey(withFx('brick', 500))
    const b = bbox(landed, brickRed)!
    expect(b.y0).toBeGreaterThanOrEqual(24)
    expect(b.y1).toBeLessThanOrEqual(50)
    const falling = bbox(renderKey(withFx('brick', 120)), brickRed)
    expect(falling === null || falling.y1 < b.y0).toBe(true)
  })

  it('sweeps a mint flash that fades', () => {
    const lum = (b: Buffer): number => { const p = probe(b, 48, 80); return p[0] + p[1] + p[2] }
    expect(lum(renderKey(withFx('sweep', 0)))).toBeGreaterThan(lum(renderKey(withFx('sweep', 300))) + 60)
    expect(lum(renderKey(withFx('sweep', 300)))).toBeGreaterThan(lum(plain) + 20)
  })

  it('floats hearts upward from the origin', () => {
    const pink = (p: Rgb): boolean => p[0] > 180 && p[1] < 190 && p[2] > 100 && p[0] > p[1] + 40
    const early = bbox(renderKey({ kind: 'gauge', effects: [{ variant: 'hearts', startedAtMs: T, nowMs: T + 200 }] }), pink)!
    const late = bbox(renderKey({ kind: 'gauge', effects: [{ variant: 'hearts', startedAtMs: T, nowMs: T + 900 }] }), pink)!
    expect(late.y0).toBeLessThan(early.y0 - 10)
  })

  it.each(['burst', 'hearts'] as const)('%s treats a non-finite origin as its default origin', (v) => {
    const def = renderKey({ kind: 'gauge', effects: [{ variant: v, startedAtMs: T, nowMs: T + 300 }] })
    const bad = renderKey({ kind: 'gauge', effects: [{ variant: v, startedAtMs: T, nowMs: T + 300, x: Number.NaN, y: Infinity, count: Number.NaN }] })
    expect(bad.equals(def)).toBe(true)
  })

  it('is deterministic for a fixed clock', () => {
    expect(renderKey(withFx('burst', 600, { seed: 3 })).equals(renderKey(withFx('burst', 600, { seed: 3 })))).toBe(true)
    expect(renderKey(withFx('burst', 600, { seed: 3 })).equals(renderKey(withFx('burst', 600, { seed: 4 })))).toBe(false)
  })
})

describe('cloud fx: soft puffs that stay inside the tile', () => {
  it('keeps every lobe wholly inside the tile, for every seed, clock and intensity', () => {
    for (let seed = 0; seed < 8; seed++) {
      for (let ms = 0; ms < 40_000; ms += 700) {
        for (const intensity of [0.25, 0.4, 0.75, 1]) {
          for (const l of fxCloudLobes(seed, ms, intensity)) {
            expect(l.x - l.r).toBeGreaterThanOrEqual(-0.001)
            expect(l.x + l.r).toBeLessThanOrEqual(KEY_SIZE + 0.001)
            expect(l.y - l.r).toBeGreaterThanOrEqual(-0.001)
            expect(l.y + l.r).toBeLessThanOrEqual(KEY_SIZE + 0.001)
          }
        }
      }
    }
  })

  it('leaves the tile frame almost untouched, so no puff reads as cut by an edge', () => {
    const BG: Rgb = [22, 24, 28]
    for (const ms of [0, 2500, 5000, 7500, 10000, 12500]) {
      const buf = renderKey({ kind: 'gauge', bg: BG, fx: { variant: 'cloud', nowMs: ms, intensity: 1, seed: 2 } })
      const frame = inkIn(buf, { x0: 0, y0: 0, x1: KEY_SIZE, y1: 1 }, BG, 3) +
        inkIn(buf, { x0: 0, y0: 95, x1: KEY_SIZE, y1: 96 }, BG, 3) +
        inkIn(buf, { x0: 0, y0: 0, x1: 1, y1: KEY_SIZE }, BG, 3) +
        inkIn(buf, { x0: 95, y0: 0, x1: 96, y1: KEY_SIZE }, BG, 3)
      expect(frame, `at ${ms} ms`).toBe(0)
      // Yet the puffs are there.
      expect(inkIn(buf, WHOLE, BG, 3)).toBeGreaterThan(800)
    }
  })

  it('moves over time', () => {
    const a = renderKey({ kind: 'gauge', fx: { variant: 'cloud', nowMs: 0, intensity: 1, seed: 1 } })
    const b = renderKey({ kind: 'gauge', fx: { variant: 'cloud', nowMs: 4000, intensity: 1, seed: 1 } })
    expect(a.equals(b)).toBe(false)
  })
})

describe('drawn icons', () => {
  it('draws the fog glyph only inside the emoji band', () => {
    const buf = renderKey({ kind: 'gauge', icon: { kind: 'fog' } })
    const b = bbox(buf, notBg)!
    expect(b.y0).toBeGreaterThanOrEqual(17)
    expect(b.y1).toBeLessThanOrEqual(49)
    expect(b.x1 - b.x0).toBeGreaterThan(30)
    // Four separate bars: four ink runs down the centre column band.
    let runs = 0
    let inRun = false
    for (let y = 17; y < 50; y++) {
      const lit = inkIn(buf, { x0: 40, y0: y, x1: 56, y1: y + 1 }) > 0
      if (lit && !inRun) runs++
      inRun = lit
    }
    expect(runs).toBe(4)
  })

  it.each([[0, 0, -1], [90, 1, 0], [180, 0, 1], [270, -1, 0]])('points the compass arrow toward %i degrees', (deg, dx, dy) => {
    const buf = renderKey({ kind: 'gauge', icon: { kind: 'compass', bearingDeg: deg } })
    let sx = 0, sy = 0, n = 0
    for (let y = 0; y < KEY_SIZE; y++) for (let x = 0; x < KEY_SIZE; x++) {
      if (cyanish(probe(buf, x, y))) { sx += x; sy += y; n++ }
    }
    expect(n).toBeGreaterThan(40)
    const cx = sx / n - 48
    const cy = sy / n - 38
    if (dx !== 0) expect(Math.sign(cx)).toBe(dx)
    if (dy !== 0) expect(Math.sign(cy)).toBe(dy)
    expect(Math.abs(dx !== 0 ? cx : cy)).toBeGreaterThan(3)
  })

  it('keeps the compass clear of the bottom line band, with a gap above y 76', () => {
    for (const deg of [0, 90, 180, 270, 45]) {
      const buf = renderKey({ kind: 'gauge', icon: { kind: 'compass', bearingDeg: deg } })
      // Two clear rows above the documented line top, so a line's ascenders
      // never touch the S.
      expect(inkIn(buf, { x0: 0, y0: 74, x1: KEY_SIZE, y1: KEY_SIZE })).toBe(0)
    }
  })

  it('reads a non-finite bearing as north rather than dropping the arrow', () => {
    const north = renderKey({ kind: 'gauge', icon: { kind: 'compass', bearingDeg: 0 } })
    expect(renderKey({ kind: 'gauge', icon: { kind: 'compass', bearingDeg: Number.NaN } }).equals(north)).toBe(true)
  })

  it('quantises the icon clock to 100 ms', () => {
    const a = renderKey({ kind: 'gauge', icon: { kind: 'fog', nowMs: 1200 } })
    const b = renderKey({ kind: 'gauge', icon: { kind: 'fog', nowMs: 1299 } })
    expect(a.equals(b)).toBe(true)
    expect(keyHash({ kind: 'gauge', icon: { kind: 'fog', nowMs: 1200 } })).toBe(keyHash({ kind: 'gauge', icon: { kind: 'fog', nowMs: 1299 } }))
  })
})

describe('mascots', () => {
  const horn = (p: Rgb): boolean => p[0] > 220 && p[1] > 210 && p[2] > 170 && p[2] < 215
  it('hops the bull', () => {
    expect(bullHopPx(0)).toBe(0)
    const rest = bbox(renderKey({ kind: 'gauge', mascot: { kind: 'bull', nowMs: 0 } }), horn)!
    const air = bbox(renderKey({ kind: 'gauge', mascot: { kind: 'bull', nowMs: 500 } }), horn)!
    expect(rest.y0 - air.y0).toBeGreaterThanOrEqual(6)
  })

  it('floats the bear\'s z up and away', () => {
    const z = (b: Buffer): Box | null => bbox(b, (p) => p[0] > 120 && p[1] > 120 && p[2] > 120 && Math.abs(p[0] - p[2]) < 30)
    const early = z(renderKey({ kind: 'gauge', mascot: { kind: 'bear', nowMs: 0 } }))!
    const later = z(renderKey({ kind: 'gauge', mascot: { kind: 'bear', nowMs: 900 } }))!
    expect(later.y0).toBeLessThan(early.y0)
  })

  it('keeps the band below y 80 free for the label', () => {
    for (const kind of ['bull', 'bear'] as const) {
      const buf = renderKey({ kind: 'gauge', mascot: { kind, nowMs: 0 } })
      // The glow is faint; anything bright there would be sprite.
      let bright = 0
      for (let y = 80; y < KEY_SIZE; y++) for (let x = 0; x < KEY_SIZE; x++) {
        const p = probe(buf, x, y)
        if (p[0] + p[1] + p[2] > 150) bright++
      }
      expect(bright).toBe(0)
    }
  })

  it('quantises the mascot clock to 100 ms, in pixels and in the hash', () => {
    const a: KeySpec = { kind: 'gauge', mascot: { kind: 'bull', nowMs: 1234 } }
    const b: KeySpec = { kind: 'gauge', mascot: { kind: 'bull', nowMs: 1299 } }
    expect(renderKey(a).equals(renderKey(b))).toBe(true)
    expect(keyHash(a)).toBe(keyHash(b))
  })
})

describe('imageTransform', () => {
  let bar: Image
  beforeAll(async () => {
    // A white horizontal bar in the key's middle, on transparent.
    const c = createCanvas(96, 96)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(18, 44, 60, 8)
    bar = await loadImage(c.toBuffer('image/png'))
  })
  const white = (p: Rgb): boolean => p[0] > 200 && p[1] > 200 && p[2] > 200

  it('lifts the image by dy', () => {
    const rest = bbox(renderKey({ kind: 'image', image: bar }), white)!
    const up = bbox(renderKey({ kind: 'image', image: bar, imageTransform: { dy: -16 } }), white)!
    expect(rest.y0 - up.y0).toBeGreaterThanOrEqual(15)
    expect(rest.y0 - up.y0).toBeLessThanOrEqual(17)
  })

  it('turns the image about the key centre', () => {
    const b = bbox(renderKey({ kind: 'image', image: bar, imageTransform: { rotateDeg: 90 } }), white)!
    expect(b.y1 - b.y0).toBeGreaterThan(50)
    expect(b.x1 - b.x0).toBeLessThan(12)
    expect((b.x0 + b.x1) / 2).toBeCloseTo(48, -1)
  })
})

describe('edge progress', () => {
  it('splits a fraction clockwise around a 3x2 block', () => {
    const cells = blockPerimeterProgress(3, 2, 0.5)
    // 10 units, 5 lit: the three tops, then the right edges of both right keys.
    expect(cells[0]![0]).toEqual({ runs: [{ edge: 'top', from: 0, to: 1 }] })
    expect(cells[0]![2]).toEqual({ runs: [{ edge: 'top', from: 0, to: 1 }, { edge: 'right', from: 0, to: 1 }] })
    expect(cells[1]![2]).toEqual({ runs: [{ edge: 'right', from: 0, to: 1 }] })
    expect(cells[1]![0]).toBeUndefined()
    expect(cells[1]![1]).toBeUndefined()
    const end = blockPerimeterProgress(3, 2, 0.95)
    expect(end[1]![0]).toEqual({ runs: [{ edge: 'bottom', from: 0, to: 1 }, { edge: 'left', from: 0, to: 1 }] })
    expect(end[0]![0]).toEqual({ runs: [{ edge: 'top', from: 0, to: 1 }, { edge: 'left', from: 0, to: 0.5 }] })
    expect(blockPerimeterProgress(3, 2, Number.NaN).flat().every((c) => c === undefined)).toBe(true)
  })

  it('lights exactly the run it is given, along the key edge', () => {
    const buf = renderKey({ kind: 'gauge', edgeProgress: { runs: [{ edge: 'top', from: 0, to: 0.5 }] } })
    expect(inkIn(buf, { x0: 2, y0: 0, x1: 44, y1: 3 })).toBe(42 * 3)
    expect(inkIn(buf, { x0: 52, y0: 0, x1: 96, y1: 6 })).toBe(0)
    expect(inkIn(buf, { x0: 0, y0: 10, x1: KEY_SIZE, y1: KEY_SIZE })).toBe(0)
  })

  it('runs bottom right-to-left and left bottom-to-top, as clockwise order says', () => {
    const bottom = renderKey({ kind: 'gauge', edgeProgress: { runs: [{ edge: 'bottom', from: 0, to: 0.25 }] } })
    expect(inkIn(bottom, { x0: 75, y0: 93, x1: 94, y1: 96 })).toBeGreaterThan(40)
    expect(inkIn(bottom, { x0: 0, y0: 90, x1: 60, y1: 96 })).toBe(0)
    const left = renderKey({ kind: 'gauge', edgeProgress: { runs: [{ edge: 'left', from: 0, to: 0.25 }] } })
    expect(inkIn(left, { x0: 0, y0: 75, x1: 3, y1: 94 })).toBeGreaterThan(40)
    expect(inkIn(left, { x0: 0, y0: 0, x1: 8, y1: 60 })).toBe(0)
  })

  it('snaps fractions to half a pixel in the hash', () => {
    const a: KeySpec = { kind: 'gauge', edgeProgress: { runs: [{ edge: 'top', from: 0, to: 0.5 }] } }
    const b: KeySpec = { kind: 'gauge', edgeProgress: { runs: [{ edge: 'top', from: 0, to: 0.5001 }] } }
    expect(keyHash(a)).toBe(keyHash(b))
    expect(canonicalKeySpec({ kind: 'gauge', edgeProgress: { runs: [{ edge: 'top', from: 0, to: 0 }] } }).edgeProgress).toBeUndefined()
  })
})

describe('strip banner and sprite', () => {
  const sbg = theme.bg
  it('draws a large centred banner and suppresses the ordinary lines', () => {
    const buf = renderStrip({ lines: ['SHOULD NOT DRAW', 'NOR THIS'], right: '1:00', banner: { text: 'WEATHER' } })
    const b = bbox(buf, notBg, STRIP_WIDTH, STRIP_HEIGHT)!
    expect(Math.abs((b.x0 + b.x1) / 2 - STRIP_WIDTH / 2)).toBeLessThan(3)
    expect(b.y1 - b.y0).toBeGreaterThan(12)
    // Nothing in the left gutter where line 1 would start.
    expect(inkIn(buf, { x0: 0, y0: 0, x1: 40, y1: STRIP_HEIGHT }, sbg, 12, STRIP_WIDTH)).toBe(0)
  })

  it('renders a leading emoji in colour, not as a box', () => {
    const buf = renderStrip({ lines: [], banner: { text: '🔔 OPENING BELL', size: 16 } })
    let chroma = 0
    for (let y = 0; y < STRIP_HEIGHT; y++) for (let x = 0; x < STRIP_WIDTH; x++) {
      const p = probe(buf, x, y, STRIP_WIDTH)
      if (Math.max(...p) - Math.min(...p) > 60) chroma++
    }
    expect(chroma).toBeGreaterThan(20)
  })

  it('shrinks a long banner to fit inside the strip', () => {
    const buf = renderStrip({ lines: [], banner: { text: 'A VERY LONG BANNER THAT CANNOT FIT', size: 30 } })
    expect(inkIn(buf, { x0: 0, y0: 0, x1: 6, y1: STRIP_HEIGHT }, sbg, 12, STRIP_WIDTH)).toBe(0)
    expect(inkIn(buf, { x0: STRIP_WIDTH - 6, y0: 0, x1: STRIP_WIDTH, y1: STRIP_HEIGHT }, sbg, 12, STRIP_WIDTH)).toBe(0)
  })

  it('shrinks a banner to the largest size that fits, rather than truncating at the requested size', () => {
    // 22 Menlo characters: 17 px measures about 225 px and fits the 236 px
    // budget; 18 px does not. So a 20 px request must land on exactly 17.
    const text = 'WWWWWWWWWWWWWWWWWWWWWW'
    const asked = renderStrip({ lines: [], banner: { text, size: 20 } })
    expect(asked.equals(renderStrip({ lines: [], banner: { text, size: 17 } }))).toBe(true)
  })

  it('drops a finished banner pop from the hash and the pixels', () => {
    const rest: StripSpec = { lines: [], banner: { text: 'BELL' } }
    const done: StripSpec = { lines: [], banner: { text: 'BELL', pop: { startedAtMs: T, nowMs: T + 2000 } } }
    expect(stripHash(done)).toBe(stripHash(rest))
    expect(renderStrip(done).equals(renderStrip(rest))).toBe(true)
    const live: StripSpec = { lines: [], banner: { text: 'BELL', pop: { startedAtMs: T, nowMs: T + 40 } } }
    expect(renderStrip(live).equals(renderStrip(rest))).toBe(false)
  })

  it('draws the crab where x says, both frames different, clipped to the strip', () => {
    const crabby = (p: Rgb): boolean => p[0] > 200 && p[1] > 100 && p[1] < 150 && p[2] > 80 && p[2] < 130
    const a = renderStrip({ lines: [], sprite: { kind: 'crab', x: 100, frame: 0 } })
    const b = bbox(a, crabby, STRIP_WIDTH, STRIP_HEIGHT)!
    expect(b.x0).toBe(100)
    expect(b.x1).toBe(148)
    expect(b.y0).toBe(26)
    const f1 = renderStrip({ lines: [], sprite: { kind: 'crab', x: 100, frame: 1 } })
    expect(f1.equals(a)).toBe(false)
    const off = renderStrip({ lines: [], sprite: { kind: 'crab', x: -100, frame: 0 } })
    expect(off.equals(renderStrip({ lines: [] }))).toBe(true)
  })

  it('says its line to the right of the crab', () => {
    const quiet = renderStrip({ lines: [], sprite: { kind: 'crab', x: 40, frame: 0 } })
    const loud = renderStrip({ lines: [], sprite: { kind: 'crab', x: 40, frame: 0, say: 'hi!' } })
    expect(inkIn(loud, { x0: 92, y0: 10, x1: 130, y1: 26 }, sbg, 12, STRIP_WIDTH)).toBeGreaterThan(
      inkIn(quiet, { x0: 92, y0: 10, x1: 130, y1: 26 }, sbg, 12, STRIP_WIDTH) + 20,
    )
  })
})

describe('breathe', () => {
  const c: Rgb = [200, 100, 50]
  it('is the colour at the top of the cycle and dimmed by depth at the bottom', () => {
    expect(breathe(c, 0, 2000, 0.5)).toEqual(c)
    expect(breathe(c, 1000, 2000, 0.5)).toEqual([100, 50, 25])
  })
  it('changes at most ten times a second', () => {
    const seen: string[] = []
    for (let ms = 0; ms < 1000; ms++) {
      const v = breathe(c, T + ms, 1500, 0.8).join(',')
      if (seen[seen.length - 1] !== v) seen.push(v)
    }
    expect(seen.length).toBeLessThanOrEqual(1000 / BREATHE_QUANTUM_MS + 1)
    expect(seen.length).toBeGreaterThan(3)
  })
  it('returns finite channels for hostile input', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      const out = breathe(c, bad, bad, bad)
      expect(out.every((n) => Number.isFinite(n))).toBe(true)
    }
  })
})

describe('non-finite numbers never reach a drawing primitive (child process)', () => {
  let dir: string | null = null
  let bundle: string | null = null
  beforeAll(() => {
    const result = esbuild.buildSync({
      entryPoints: [join(process.cwd(), 'src/render/canvas.ts')],
      bundle: true, platform: 'node', format: 'esm', write: false, external: ['@napi-rs/canvas'],
    })
    dir = mkdtempSync(join(process.cwd(), '.glowup-probe-'))
    bundle = join(dir, 'canvas.bundle.mjs')
    writeFileSync(bundle, result.outputFiles[0]!.text)
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** Every new numeric field, with every non-finite value, in one child: a
   * Rust panic in `arc` kills the process, so a clean exit is the proof. */
  it('renders every glow-up spec with NaN and Infinity in every number', () => {
    const lines: string[] = [`import { renderKey, renderStrip } from ${JSON.stringify(bundle)}`]
    for (const bad of ['NaN', 'Infinity', '-Infinity']) {
      const specs = [
        `{ kind: 'gauge', spark: { values: [1, 2, 3], color: [1,2,3], style: 'line', baseline: ${bad}, minHalfRange: ${bad} } }`,
        `{ kind: 'gauge', spark: { values: [1, ${bad}, 3], color: [1,2,3], style: 'line', baseline: 0, minHalfRange: 1, slice: { index: 2, count: 3 } } }`,
        `{ kind: 'gauge', range: { lo: ${bad}, hi: ${bad}, value: ${bad}, y: ${bad}, height: ${bad} } }`,
        `{ kind: 'gauge', icon: { kind: 'compass', bearingDeg: ${bad}, nowMs: ${bad} } }`,
        `{ kind: 'gauge', icon: { kind: 'fog', nowMs: ${bad} } }`,
        `{ kind: 'gauge', mascot: { kind: 'bull', nowMs: ${bad} } }`,
        `{ kind: 'gauge', mascot: { kind: 'bear', nowMs: ${bad} } }`,
        `{ kind: 'gauge', lines: ['A', 'B'], lineSizes: [11, 19], linePop: { line: ${bad}, startedAtMs: 0, nowMs: 10 } }`,
        `{ kind: 'gauge', lines: ['A'], linePop: { line: 0, startedAtMs: ${bad}, nowMs: ${bad} } }`,
        `{ kind: 'gauge', edgeProgress: { runs: [{ edge: 'top', from: ${bad}, to: ${bad} }] } }`,
        ...['burst', 'brick', 'sweep', 'hearts'].flatMap((v) => [
          `{ kind: 'gauge', effects: [{ variant: '${v}', startedAtMs: 0, nowMs: 100, x: ${bad}, y: ${bad}, count: ${bad}, seed: ${bad} }] }`,
          `{ kind: 'gauge', effects: [{ variant: '${v}', startedAtMs: ${bad}, nowMs: ${bad} }] }`,
        ]),
        `{ kind: 'gauge', fx: { variant: 'cloud', nowMs: ${bad}, intensity: ${bad}, seed: ${bad} } }`,
      ]
      for (const s of specs) lines.push(`{ const b = renderKey(${s}); if (b.length !== 96 * 96 * 4) throw new Error('len') }`)
      lines.push(`renderStrip({ lines: [], banner: { text: 'X', size: ${bad}, pop: { startedAtMs: ${bad}, nowMs: ${bad} } }, sprite: { kind: 'crab', x: ${bad}, frame: 0, dy: ${bad} } })`)
    }
    const file = join(dir!, 'probe.mjs')
    writeFileSync(file, lines.join('\n'))
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.signal).toBeNull()
    expect(r.status).toBe(0)
  })
})
