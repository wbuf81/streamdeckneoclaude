import { describe, it, expect } from 'vitest'
import { Image } from '@napi-rs/canvas'
import { keyHash, stripHash, blankKey } from '../../src/render/specs.js'
import type { KeySpec, Rgb } from '../../src/render/specs.js'

describe('keyHash', () => {
  it('matches for two equal specs', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['5h', '62%'] }
    const b: KeySpec = { kind: 'gauge', lines: ['5h', '62%'] }
    expect(keyHash(a)).toBe(keyHash(b))
  })

  it('differs when a text line changes', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['5h', '62%'] }
    const b: KeySpec = { kind: 'gauge', lines: ['5h', '63%'] }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('ignores the image and uses imageKey', () => {
    const a: KeySpec = { kind: 'image', image: new Image(), imageKey: 'track-1' }
    const b: KeySpec = { kind: 'image', image: new Image(), imageKey: 'track-1' }
    expect(keyHash(a)).toBe(keyHash(b))
  })

  it('differs when imageKey changes', () => {
    const sameImage = new Image()
    const a: KeySpec = { kind: 'image', image: sameImage, imageKey: 'track-1' }
    const b: KeySpec = { kind: 'image', image: sameImage, imageKey: 'track-2' }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('differs when the border pulse phase changes', () => {
    const a: KeySpec = { kind: 'session', border: [255, 176, 0], pulseOn: true }
    const b: KeySpec = { kind: 'session', border: [255, 176, 0], pulseOn: false }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('gives a blank key a stable hash', () => {
    expect(keyHash(blankKey())).toBe(keyHash(blankKey()))
  })

  it('differs when the spark series changes', () => {
    const a: KeySpec = { kind: 'gauge', spark: { values: [1, 2, 3], color: [70, 200, 110] } }
    const b: KeySpec = { kind: 'gauge', spark: { values: [3, 2, 1], color: [70, 200, 110] } }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  // Keys 4, 5 and 6 on the stock detail view all share one series and one
  // imageKey-like identity: only `slice.index` tells them apart. If it were
  // missing from the hash, two of the three slices would never redraw on a
  // price move — the exact defect that hit the Spotify 2x2 album art
  // (lesson 11 in docs/LESSONS.md), now for a spark instead of an image crop.
  it('differs when the spark slice index changes, even with the same values and color', () => {
    const values = [1, 2, 3, 4, 5, 6]
    const color: Rgb = [70, 200, 110]
    const a: KeySpec = { kind: 'gauge', spark: { values, color, slice: { index: 0, count: 3 } } }
    const b: KeySpec = { kind: 'gauge', spark: { values, color, slice: { index: 1, count: 3 } } }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('differs for all three slice indices used by the stock detail chart', () => {
    const values = [1, 2, 3, 4, 5, 6]
    const color: Rgb = [70, 200, 110]
    const hashes = [0, 1, 2].map((index) =>
      keyHash({ kind: 'gauge', spark: { values, color, slice: { index, count: 3 } } }),
    )
    expect(new Set(hashes).size).toBe(3)
  })

  it('matches when slice is absent on both sides, keeping the single-key sparkline path untouched', () => {
    const a: KeySpec = { kind: 'gauge', spark: { values: [1, 2, 3], color: [70, 200, 110] } }
    const b: KeySpec = { kind: 'gauge', spark: { values: [1, 2, 3], color: [70, 200, 110] } }
    expect(keyHash(a)).toBe(keyHash(b))
  })

  it('differs when a line colour changes', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['x'], lineColors: [[70, 200, 110]] }
    const b: KeySpec = { kind: 'gauge', lines: ['x'], lineColors: [[230, 60, 60]] }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  // The daemon writes a key only when its hash changes. If a line size were
  // missing from the hash, a key whose text stayed the same but whose size
  // changed would never redraw, leaving stale pixels on the glass.
  it('differs when lineSizes changes', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['20%'], lineSizes: [11] }
    const b: KeySpec = { kind: 'gauge', lines: ['20%'], lineSizes: [28] }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  // The weather page's new banded layout places lines with `lineY` rather
  // than letting them step automatically. If it were missing from the hash,
  // a key whose text and size stayed the same but whose band moved would
  // never redraw, leaving stale pixels on the glass — the same risk
  // `lineSizes` already carries.
  it('differs when lineY changes', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['THU'], lineY: [3] }
    const b: KeySpec = { kind: 'gauge', lines: ['THU'], lineY: [10] }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('differs when the emoji changes, so the daemon redraws a changed forecast icon', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['THU'], emoji: '☀️' }
    const b: KeySpec = { kind: 'gauge', lines: ['THU'], emoji: '⛈' }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  // The most important test in this task. All four album-art quadrant keys
  // share one `imageKey` (the track id), so the daemon's change detection can
  // only tell two quadrants apart by their `imageCrop`. If `imageCrop` were
  // ever missing from the hash, three of the four keys would never redraw on
  // a track change, and the art would tear across the 2x2 block.
  it('differs when imageCrop changes, even with the same imageKey and image', () => {
    const sameImage = new Image()
    const topLeft: KeySpec = {
      kind: 'image',
      image: sameImage,
      imageKey: 'track-1',
      imageCrop: { sx: 0, sy: 0, sw: 0.5, sh: 0.5 },
    }
    const topRight: KeySpec = {
      kind: 'image',
      image: sameImage,
      imageKey: 'track-1',
      imageCrop: { sx: 0.5, sy: 0, sw: 0.5, sh: 0.5 },
    }
    expect(keyHash(topLeft)).not.toBe(keyHash(topRight))
  })

  it('differs for all four quadrant crops used by the Spotify page', () => {
    const crops = [
      { sx: 0.0, sy: 0.0, sw: 0.5, sh: 0.5 },
      { sx: 0.5, sy: 0.0, sw: 0.5, sh: 0.5 },
      { sx: 0.0, sy: 0.5, sw: 0.5, sh: 0.5 },
      { sx: 0.5, sy: 0.5, sw: 0.5, sh: 0.5 },
    ]
    const sameImage = new Image()
    const hashes = crops.map((imageCrop) =>
      keyHash({ kind: 'image', image: sameImage, imageKey: 'track-1', imageCrop }),
    )
    expect(new Set(hashes).size).toBe(4)
  })

  it('matches when imageCrop is equal', () => {
    const sameImage = new Image()
    const a: KeySpec = {
      kind: 'image', image: sameImage, imageKey: 'track-1',
      imageCrop: { sx: 0, sy: 0, sw: 0.5, sh: 0.5 },
    }
    const b: KeySpec = {
      kind: 'image', image: sameImage, imageKey: 'track-1',
      imageCrop: { sx: 0, sy: 0, sw: 0.5, sh: 0.5 },
    }
    expect(keyHash(a)).toBe(keyHash(b))
  })

  it('differs when the glyph colour changes', () => {
    const a: KeySpec = { kind: 'control', glyph: '♥' }
    const b: KeySpec = { kind: 'control', glyph: '♥', glyphColor: [230, 60, 60] }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  // Lesson 11: a new field must affect keyHash, or the daemon never redraws
  // a key whose only change was that field, leaving stale pixels.
  it('differs when spark.fullHeight changes, even with the same values and colour', () => {
    const values = [1, 2, 3]
    const color: Rgb = [70, 200, 110]
    const a: KeySpec = { kind: 'gauge', spark: { values, color } }
    const b: KeySpec = { kind: 'gauge', spark: { values, color, fullHeight: true } }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('differs when a lineSizes entry changes from an array of one candidate to another', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['1234.56'], lineSizes: [[24, 20, 16]] }
    const b: KeySpec = { kind: 'gauge', lines: ['1234.56'], lineSizes: [[24, 20]] }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  // Task 27's idle equaliser: the Spotify page recomputes `pulse.phase` from
  // `nowMs` on every render call, and that is the ONLY thing that changes
  // frame to frame — bars, color and kind all stay fixed. If `phase` were
  // ever missing from the hash, the daemon's dirty-key check would see no
  // difference between two ticks and the animation would freeze after its
  // first frame — lesson 11 in docs/LESSONS.md, the same defect that once
  // hit this page's `imageCrop`.
  it('differs when the pulse phase changes, so the daemon keeps redrawing the idle animation', () => {
    const a: KeySpec = { kind: 'control', pulse: { phase: 0, bars: 6, color: [70, 200, 110] } }
    const b: KeySpec = { kind: 'control', pulse: { phase: 1, bars: 6, color: [70, 200, 110] } }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('matches when the pulse spec is equal', () => {
    const a: KeySpec = { kind: 'control', pulse: { phase: 0.5, bars: 6, color: [70, 200, 110] } }
    const b: KeySpec = { kind: 'control', pulse: { phase: 0.5, bars: 6, color: [70, 200, 110] } }
    expect(keyHash(a)).toBe(keyHash(b))
  })
})

describe('stripHash', () => {
  it('differs when the bar value changes', () => {
    expect(stripHash({ lines: ['a'], bar: { value: 0.1, color: [0, 255, 0] } }))
      .not.toBe(stripHash({ lines: ['a'], bar: { value: 0.2, color: [0, 255, 0] } }))
  })
})
