import { describe, it, expect } from 'vitest'
import { Image } from '@napi-rs/canvas'
import { keyHash, stripHash, blankKey } from '../../src/render/specs.js'
import type { KeySpec } from '../../src/render/specs.js'

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
})

describe('stripHash', () => {
  it('differs when the bar value changes', () => {
    expect(stripHash({ lines: ['a'], bar: { value: 0.1, color: [0, 255, 0] } }))
      .not.toBe(stripHash({ lines: ['a'], bar: { value: 0.2, color: [0, 255, 0] } }))
  })
})
