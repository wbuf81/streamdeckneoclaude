/**
 * The Claude page glow-up: a pettable crab, a breathing permission tile, and a
 * strip that does not say the same thing twice for one session.
 *
 * A separate file on purpose: it loads the REAL crab frames from `assets/crab`
 * into `sprites.ts`'s module-level cache, and claude-page.test.ts has tests
 * that depend on `idle` still being uncached. Vitest isolates each file.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import {
  ClaudePage, petMotion, permissionBg, singleSessionFacts,
  PET_THANKS_TEXT, PET_THANKS_MS, PERMIT_BG_MIN, PERMIT_BG_MAX, PERMIT_BREATHE_PERIOD_MS,
} from '../../src/pages/claude-page.js'
import { keyHash, stripHash } from '../../src/render/specs.js'
import type { KeySpec } from '../../src/render/specs.js'
import { theme, blend } from '../../src/render/theme.js'
import { loadCrabFrames } from '../../src/render/sprites.js'
import { renderKey, renderStrip, probe, KEY_SIZE, STRIP_WIDTH } from '../../src/render/canvas.js'
import type { Session } from '../../src/sources/claude.js'
import type { SessionMeta } from '../../src/sources/usage.js'

const NOW = 1786549560
const T = NOW * 1000
const ASSETS = join(import.meta.dirname, '..', '..', 'assets')

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 'aaaa', state: 'tool', label: 'Running command', tool: 'Bash',
    project: 'deckd', cwd: '/x', termProgram: 'ghostty',
    pid: 4242, startedAt: NOW - 840, ts: NOW, ...over,
  }
}

function build(sessions: Session[] = [session()], meta = new Map<string, SessionMeta>()) {
  return new ClaudePage(
    { getSessions: () => sessions, directoryExists: () => true },
    { getUsage: () => null, isStale: () => false, getMeta: (id) => meta.get(id) ?? null },
    async () => true,
  )
}

const isBg = (p: readonly number[]) => p[0] === theme.bg[0] && p[1] === theme.bg[1] && p[2] === theme.bg[2]

/** The first row, top down, with any non-background pixel across the WHOLE
 * key width. A region sweep, never one column. */
function inkTop(buf: Buffer): number {
  for (let y = 0; y < KEY_SIZE; y++) {
    for (let x = 0; x < KEY_SIZE; x++) if (!isBg(probe(buf, x, y))) return y
  }
  return KEY_SIZE
}

/** The crab image alone: no hearts, so the hop is measured on the crab. */
function crabOnly(key: KeySpec): Buffer {
  const { effects: _e, ...rest } = key
  return renderKey(rest)
}

beforeAll(async () => {
  // Real extracted frames, the same ones the deck draws.
  await loadCrabFrames(ASSETS, ['idle', 'permission'])
})

describe('petting the crab (key 3)', () => {
  it('reports handled, and stamps the press on the NEXT render, not before', async () => {
    const page = build()
    expect(await page.onKeyPress(3)).toBe('handled')
    // The page has no clock in onKeyPress: the first render after the press
    // owns its start time, however late that render is.
    const key = page.render(NOW + 5, T + 5000).keys[3]!
    expect(key.effects).toEqual([
      expect.objectContaining({ variant: 'hearts', startedAtMs: T + 5000, nowMs: T + 5000 }),
    ])
  })

  it('draws nothing extra on the crab tile without a press', () => {
    const key = build().render(NOW, T).keys[3]!
    expect(key.effects).toBeUndefined()
    expect(key.imageTransform).toBeUndefined()
  })

  it('hops in a ~500 ms arc, quantised to 40 ms, whole pixels', () => {
    expect(petMotion(0, false)).toEqual({})
    expect(petMotion(120, false)).toEqual({ dy: -11 })
    expect(petMotion(139, false)).toEqual(petMotion(120, false))
    expect(petMotion(240, false)).toEqual({ dy: -16 })
    expect(petMotion(480, false)!.dy).toBeGreaterThan(-3)
    expect(petMotion(500, false)).toBeNull()
    expect(petMotion(-1, false)).toBeNull()
    expect(petMotion(Number.NaN, false)).toBeNull()
  })

  it('lifts the real crab ink by about 16 px at the top of the hop (region probe)', async () => {
    const pet = build()
    const still = build()
    pet.render(NOW, T)
    still.render(NOW, T)
    await pet.onKeyPress(3)
    pet.render(NOW, T)
    // Same nowMs on both, so both draw the same sprite frame.
    const lifted = inkTop(crabOnly(pet.render(NOW, T + 240).keys[3]!))
    const resting = inkTop(crabOnly(still.render(NOW, T + 240).keys[3]!))
    expect(resting).toBeLessThan(KEY_SIZE)
    expect(resting - lifted).toBeGreaterThanOrEqual(12)
  })

  it('pops a heart over the crab tile (region probe)', async () => {
    const page = build()
    await page.onKeyPress(3)
    page.render(NOW, T)
    const key = page.render(NOW, T + 400).keys[3]!
    const withHeart = renderKey(key)
    const without = crabOnly(key)
    let changed = 0
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        const a = probe(withHeart, x, y)
        const b = probe(without, x, y)
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) changed++
      }
    }
    expect(changed).toBeGreaterThan(40)
  })

  it('spins once on the third press inside 1.2 s', async () => {
    const page = build()
    await page.onKeyPress(3); page.render(NOW, T)
    await page.onKeyPress(3); page.render(NOW, T + 300)
    await page.onKeyPress(3); page.render(NOW, T + 600)
    const key = page.render(NOW, T + 750).keys[3]!
    // 150 ms in, quantised down to 120 ms: 120 / 600 of a turn.
    expect(key.imageTransform?.rotateDeg).toBe(72)
    // Three hearts for the spin, one each for the two plain pets.
    expect(key.effects!.map((e) => e.count)).toEqual([1, 1, 3])
    // The spin is over after 600 ms.
    expect(page.render(NOW, T + 1200).keys[3]!.imageTransform).toBeUndefined()
  })

  it('does not spin for three presses spread past 1.2 s', async () => {
    const page = build()
    await page.onKeyPress(3); page.render(NOW, T)
    await page.onKeyPress(3); page.render(NOW, T + 700)
    await page.onKeyPress(3); page.render(NOW, T + 1400)
    const key = page.render(NOW, T + 1550).keys[3]!
    expect(key.imageTransform?.rotateDeg).toBeUndefined()
    expect(key.imageTransform?.dy).toBeLessThan(0)
  })

  it('never hides the permission alert, not even during the hop', async () => {
    const page = build([session({ state: 'permission' })])
    expect(page.render(NOW, T).keys[3]!.imageKey).toMatch(/^crab:permission:/)
    await page.onKeyPress(3)
    page.render(NOW, T)
    const hop = page.render(NOW, T + 200).keys[3]!
    expect(hop.imageTransform?.dy).toBeLessThan(0)
    expect(hop.imageKey).toMatch(/^crab:permission:/)
    expect(page.render(NOW, T + 520).keys[3]!.imageKey).toMatch(/^crab:permission:/)
  })

  it('costs nothing once the heart has gone: the crab key hashes as if never petted', async () => {
    const pet = build()
    const still = build()
    await pet.onKeyPress(3)
    pet.render(NOW, T)
    still.render(NOW, T)
    const at = T + PET_THANKS_MS
    expect(keyHash(pet.render(NOW, at).keys[3]!)).toBe(keyHash(still.render(NOW, at).keys[3]!))
    expect(stripHash(pet.render(NOW, at).strip)).toBe(stripHash(still.render(NOW, at).strip))
  })

  it('forgets a pending pet when the page is left', async () => {
    const page = build()
    await page.onKeyPress(3)
    page.onLeave()
    const key = page.render(NOW, T).keys[3]!
    expect(key.effects).toBeUndefined()
    expect(page.render(NOW, T).strip.lines[1]).not.toBe(PET_THANKS_TEXT)
  })
})

describe('the strip thanks the user for a pet', () => {
  const two = [session({ sessionId: 'a' }), session({ sessionId: 'b', project: 'website', ts: NOW - 5 })]

  it('takes line 2 for 1.5 s, and the tape stands down', async () => {
    const page = build(two)
    expect(page.render(NOW, T).strip.tape).toBeDefined()
    await page.onKeyPress(3)
    for (const dt of [0, 700, PET_THANKS_MS - 1]) {
      const strip = page.render(NOW, T + dt).strip
      expect(strip.lines[1]).toBe(PET_THANKS_TEXT)
      expect(strip.tape).toBeUndefined()
    }
    const after = page.render(NOW, T + PET_THANKS_MS).strip
    expect(after.lines[1]).not.toBe(PET_THANKS_TEXT)
    expect(after.tape).toBeDefined()
  })

  it('thanks the user even with no sessions, undimmed', async () => {
    const page = build([])
    await page.onKeyPress(3)
    const strip = page.render(NOW, T).strip
    expect(strip.lines).toEqual(['claude', PET_THANKS_TEXT])
    expect(strip.dim).toBeUndefined()
  })
})

describe('a permission tile breathes amber', () => {
  it('changes at most 10 times a second, and does change', () => {
    const seen = new Set<string>()
    for (let ms = 0; ms < 1000; ms++) seen.add(JSON.stringify(permissionBg(T + ms)))
    expect(seen.size).toBeGreaterThan(1)
    expect(seen.size).toBeLessThanOrEqual(10)
  })

  it('swings between a faint and a quarter-strength amber over one breath', () => {
    const lum = (c: readonly number[]) => c[0]! + c[1]! + c[2]!
    let lo = Infinity
    let hi = 0
    for (let ms = 0; ms < PERMIT_BREATHE_PERIOD_MS; ms += 100) {
      const l = lum(permissionBg(ms))
      lo = Math.min(lo, l)
      hi = Math.max(hi, l)
    }
    expect(lo).toBe(lum(blend(theme.bg, theme.amber, PERMIT_BG_MIN)))
    expect(hi).toBe(lum(blend(theme.bg, theme.amber, PERMIT_BG_MAX)))
  })

  it('shows on the rendered tile background, not just in the spec (region probe)', () => {
    const page = build([session({ state: 'permission' })])
    // The background block right of the text and below it, swept whole.
    const region = (buf: Buffer) => {
      let sum = 0
      for (let y = 82; y < 94; y++) for (let x = 60; x < 94; x++) sum += probe(buf, x, y)[0]
      return sum / (12 * 34)
    }
    const top = region(renderKey(page.render(NOW, 0).keys[0]!))
    const bottom = region(renderKey(page.render(NOW, PERMIT_BREATHE_PERIOD_MS / 2).keys[0]!))
    expect(top - bottom).toBeGreaterThan(25)
    expect(bottom).toBeGreaterThan(theme.bg[0] + 10)
  })

  it.each(['thinking', 'tool', 'idle', 'done', 'unknown'] as const)('leaves a %s tile background alone', (state) => {
    const key = build([session({ state })]).render(NOW, T).keys[0]!
    expect(key.bg).toBeUndefined()
  })
})

describe('the strip with exactly one session', () => {
  const meta = new Map([['aaaa', { model: 'Opus 5', ctxPct: 41.4, costUsd: 1, ts: NOW }]])

  it('says what it is doing on line 1, and how long, which model and how full on line 2', () => {
    const strip = build([session()], meta).render(NOW, T).strip
    expect(strip.lines).toEqual(['deckd · Bash', 'running 14m · Opus 5 · ctx 41%'])
    // No tape: a one-segment tape would only repeat line 1.
    expect(strip.tape).toBeUndefined()
  })

  it('falls back to the session count when nothing else is known', () => {
    const strip = build([session({ startedAt: 0 })]).render(NOW, T).strip
    expect(strip.lines[1]).toBe('1 active')
  })

  it('draws line 2 as ink, not an empty band (region probe)', () => {
    const buf = renderStrip(build([session()], meta).render(NOW, T).strip)
    let ink = 0
    for (let y = 26; y < 46; y++) for (let x = 0; x < STRIP_WIDTH; x++) if (!isBg(probe(buf, x, y, STRIP_WIDTH))) ink++
    expect(ink).toBeGreaterThan(100)
  })

  it('keeps today\'s tape and count with several sessions', () => {
    const two = [session({ sessionId: 'a' }), session({ sessionId: 'b', project: 'website', ts: NOW - 5 })]
    const strip = build(two, meta).render(NOW, T).strip
    expect(strip.tape?.segments).toHaveLength(2)
    expect(strip.lines[1]).toBe('2 active')
    expect(strip.lines[0]).toContain('14m')
  })

  it('formats each fact only when its source knows it', () => {
    expect(singleSessionFacts('', null)).toBe('')
    expect(singleSessionFacts('3m', null)).toBe('running 3m')
    expect(singleSessionFacts('', { model: '', ctxPct: Number.NaN, costUsd: null, ts: 0 })).toBe('')
  })
})
