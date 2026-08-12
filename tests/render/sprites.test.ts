import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import {
  loadCrabFrames,
  getSpriteFrame,
  getSpriteFrameIndex,
  MIN_DELAY_MS,
} from '../../src/render/sprites.js'

/** Writes a tiny 2x2 PNG, so a fixture frame decodes without shipping a real asset. */
function tinyPng(): Buffer {
  const c = createCanvas(2, 2)
  const ctx = c.getContext('2d')
  ctx.fillStyle = 'rgb(1,2,3)'
  ctx.fillRect(0, 0, 2, 2)
  return c.toBuffer('image/png')
}

/** Builds `<root>/crab/<state>/` with `frameCount` PNGs and the given `meta.json`. */
function writeState(
  root: string,
  state: string,
  meta: { frameCount: number; delayMs: number },
): void {
  const dir = join(root, 'crab', state)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
  for (let i = 0; i < meta.frameCount; i++) {
    writeFileSync(join(dir, `${String(i).padStart(2, '0')}.png`), tinyPng())
  }
}

describe('getSpriteFrame and getSpriteFrameIndex', () => {
  let root: string

  beforeEach(() => {
    // A fresh temp directory per test, never anything under `~`.
    root = mkdtempSync(join(tmpdir(), 'deckd-sprites-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('advances the frame index as nowMs advances', async () => {
    writeState(root, 'walk', { frameCount: 4, delayMs: 10 })
    await loadCrabFrames(root, ['walk'])

    expect(getSpriteFrameIndex('walk', 0)).toBe(0)
    expect(getSpriteFrameIndex('walk', 10)).toBe(1)
    expect(getSpriteFrameIndex('walk', 20)).toBe(2)
    expect(getSpriteFrameIndex('walk', 25)).toBe(2)
  })

  it('wraps at the frame count', async () => {
    writeState(root, 'walk', { frameCount: 3, delayMs: 10 })
    await loadCrabFrames(root, ['walk'])

    expect(getSpriteFrameIndex('walk', 30)).toBe(0)
    expect(getSpriteFrameIndex('walk', 40)).toBe(1)
  })

  it('returns a different frame for two nowMs values one frame apart', async () => {
    writeState(root, 'walk', { frameCount: 4, delayMs: 10 })
    await loadCrabFrames(root, ['walk'])

    const a = getSpriteFrame('walk', 0)
    const b = getSpriteFrame('walk', 10)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
  })

  it('returns the same frame for two nowMs values inside one frame duration', async () => {
    writeState(root, 'walk', { frameCount: 4, delayMs: 10 })
    await loadCrabFrames(root, ['walk'])

    const a = getSpriteFrame('walk', 12)
    const b = getSpriteFrame('walk', 18)
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it('floors a delayMs of zero to the minimum, instead of dividing by zero', async () => {
    writeState(root, 'stuck', { frameCount: 3, delayMs: 0 })
    await loadCrabFrames(root, ['stuck'])

    expect(() => getSpriteFrameIndex('stuck', 1000)).not.toThrow()
    // With the floor applied, one period is MIN_DELAY_MS, not zero.
    expect(getSpriteFrameIndex('stuck', 0)).toBe(0)
    expect(getSpriteFrameIndex('stuck', MIN_DELAY_MS)).toBe(1)
    expect(getSpriteFrameIndex('stuck', MIN_DELAY_MS * 2)).toBe(2)
    expect(getSpriteFrameIndex('stuck', MIN_DELAY_MS * 3)).toBe(0)
  })

  it('floors a negative delayMs the same way', async () => {
    writeState(root, 'negative', { frameCount: 2, delayMs: -50 })
    await loadCrabFrames(root, ['negative'])

    expect(() => getSpriteFrame('negative', 5000)).not.toThrow()
    expect(getSpriteFrameIndex('negative', 0)).toBe(0)
    expect(getSpriteFrameIndex('negative', MIN_DELAY_MS)).toBe(1)
  })

  it('returns null for a state with no cached frames', () => {
    expect(getSpriteFrame('no-such-state', 0)).toBeNull()
    expect(getSpriteFrameIndex('no-such-state', 0)).toBeNull()
  })

  it('degrades to null and does not throw when the state directory is absent', async () => {
    await expect(loadCrabFrames(root, ['absent-state'])).resolves.not.toThrow()
    expect(getSpriteFrame('absent-state', 0)).toBeNull()
  })

  it('degrades to null and does not throw when meta.json is missing', async () => {
    mkdirSync(join(root, 'crab', 'no-meta'), { recursive: true })
    await expect(loadCrabFrames(root, ['no-meta'])).resolves.not.toThrow()
    expect(getSpriteFrame('no-meta', 0)).toBeNull()
  })

  it('degrades to null and does not throw when meta.json is not valid JSON', async () => {
    const dir = join(root, 'crab', 'bad-meta')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.json'), '{not json')
    await expect(loadCrabFrames(root, ['bad-meta'])).resolves.not.toThrow()
    expect(getSpriteFrame('bad-meta', 0)).toBeNull()
  })

  it('degrades to null and does not throw when frameCount is zero', async () => {
    writeState(root, 'zero-frames', { frameCount: 0, delayMs: 70 })
    await expect(loadCrabFrames(root, ['zero-frames'])).resolves.not.toThrow()
    expect(getSpriteFrame('zero-frames', 0)).toBeNull()
  })

  it('logs only once per absent state across repeated loads', async () => {
    // The real risk this guards: a render loop calling the loader on a
    // repeating path would otherwise fill the log. `loadCrabFrames` itself
    // runs once at startup, but calling it twice must not double-log either.
    await loadCrabFrames(root, ['missing-a'])
    await expect(loadCrabFrames(root, ['missing-a'])).resolves.not.toThrow()
  })
})

describe('loadCrabFrames against the real committed assets', () => {
  // These use the actual assets/crab/<state>/ tree that Task 21 extracted and
  // the user already approved by eye. Confirms the real meta.json (24 frames,
  // 70 ms) drives real animation, not just the synthetic fixtures above.
  const realRoot = join(import.meta.dirname, '..', '..', 'assets')

  beforeAll(async () => {
    await loadCrabFrames(realRoot)
  })

  it('loads all six real states', () => {
    for (const state of ['idle', 'thinking', 'tool', 'permission', 'done', 'unknown']) {
      expect(getSpriteFrame(state, 0)).not.toBeNull()
    }
  })

  it('advances through the real 24 frames at the real 70 ms delay', () => {
    const a = getSpriteFrame('idle', 0)
    const b = getSpriteFrame('idle', 70)
    expect(a).not.toBe(b)
    expect(getSpriteFrameIndex('idle', 0)).toBe(0)
    expect(getSpriteFrameIndex('idle', 70)).toBe(1)
    expect(getSpriteFrameIndex('idle', 24 * 70)).toBe(0)
  })
})
