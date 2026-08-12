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

  it('differs when the emoji changes, so the daemon redraws a changed forecast icon', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['THU'], emoji: '☀️' }
    const b: KeySpec = { kind: 'gauge', lines: ['THU'], emoji: '⛈' }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })
})

describe('stripHash', () => {
  it('differs when the bar value changes', () => {
    expect(stripHash({ lines: ['a'], bar: { value: 0.1, color: [0, 255, 0] } }))
      .not.toBe(stripHash({ lines: ['a'], bar: { value: 0.2, color: [0, 255, 0] } }))
  })
})
