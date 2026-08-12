import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePlayer, pickArtUrl, SpotifySource } from '../../src/sources/spotify.js'
import type { Tokens } from '../../src/sources/spotify-auth.js'
import type { Image } from '@napi-rs/canvas'
import { log } from '../../src/log.js'

const PLAYER = {
  is_playing: true,
  progress_ms: 134000,
  shuffle_state: true,
  repeat_state: 'context',
  device: { volume_percent: 55 },
  item: {
    id: 'track-1',
    name: 'Planet Caravan',
    duration_ms: 272000,
    artists: [{ name: 'Black Sabbath' }],
    album: {
      name: 'Paranoid',
      images: [
        { url: 'https://i/large.jpg', width: 640, height: 640 },
        { url: 'https://i/mid.jpg', width: 300, height: 300 },
        { url: 'https://i/small.jpg', width: 64, height: 64 },
      ],
    },
  },
}

describe('parsePlayer', () => {
  it('reads the track, the artist, and the album', () => {
    const s = parsePlayer(PLAYER)!
    expect(s.title).toBe('Planet Caravan')
    expect(s.artist).toBe('Black Sabbath')
    expect(s.album).toBe('Paranoid')
    expect(s.trackId).toBe('track-1')
  })

  it('reads the position and the duration in milliseconds', () => {
    const s = parsePlayer(PLAYER)!
    expect(s.positionMs).toBe(134000)
    expect(s.durationMs).toBe(272000)
  })

  it('reads the transport flags', () => {
    const s = parsePlayer(PLAYER)!
    expect(s.isPlaying).toBe(true)
    expect(s.shuffle).toBe(true)
    expect(s.repeat).toBe('context')
    expect(s.volumePercent).toBe(55)
  })

  it('joins more than one artist with a comma', () => {
    const s = parsePlayer({ ...PLAYER, item: { ...PLAYER.item, artists: [{ name: 'A' }, { name: 'B' }] } })!
    expect(s.artist).toBe('A, B')
  })

  it('returns null for an empty 204 body', () => {
    expect(parsePlayer(null)).toBeNull()
    expect(parsePlayer(undefined)).toBeNull()
    expect(parsePlayer('')).toBeNull()
  })

  it('returns null when there is no item', () => {
    expect(parsePlayer({ is_playing: false, item: null })).toBeNull()
  })

  it('handles a missing device block', () => {
    const s = parsePlayer({ ...PLAYER, device: null })!
    expect(s.hasDevice).toBe(false)
    expect(s.volumePercent).toBeNull()
  })

  it('handles a track with no album art', () => {
    const s = parsePlayer({ ...PLAYER, item: { ...PLAYER.item, album: { name: 'X', images: [] } } })!
    expect(s.artUrl).toBeNull()
  })
})

describe('pickArtUrl', () => {
  const images = [
    { url: 'large', width: 640 },
    { url: 'mid', width: 300 },
    { url: 'small', width: 64 },
  ]

  it('picks the smallest image at or above the minimum width', () => {
    expect(pickArtUrl(images, 96)).toBe('mid')
  })

  it('picks the largest available when none reach the minimum', () => {
    expect(pickArtUrl([{ url: 'tiny', width: 32 }], 96)).toBe('tiny')
  })

  it('returns null for an empty list', () => {
    expect(pickArtUrl([], 96)).toBeNull()
  })

  it('accepts an exact match on the minimum width', () => {
    expect(pickArtUrl([{ url: 'exact', width: 96 }], 96)).toBe('exact')
  })
})

function tokens(over: Partial<Tokens> = {}): Tokens {
  return { accessToken: 'at', refreshToken: 'rt', expiresAt: 9_999_999_999, ...over }
}

function build(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string }> = []
  let i = 0
  const fetchFn = vi.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const r = responses[Math.min(i++, responses.length - 1)]!
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body ?? {},
      arrayBuffer: async () => new ArrayBuffer(8),
    }
  })
  // `refreshTokens` (from spotify-auth.ts, not modified by this task) always
  // uses the global `fetch`, with no way to inject a fake. Stubbing the
  // global to the same mock keeps the 401-refresh path offline too, and
  // folds its call into the same `calls` array the tests assert against.
  vi.stubGlobal('fetch', fetchFn)
  const store = {
    load: () => tokens(),
    save: vi.fn(),
    clear: vi.fn(),
  }
  const src = new SpotifySource('cid', store as never, fetchFn as never, () => 1000)
  return { src, calls, fetchFn, store }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('SpotifySource', () => {
  it('reports ok and the state after a good poll', async () => {
    const { src } = build([{ status: 200, body: PLAYER }])
    await src.poll()
    expect(src.getStatus()).toBe('ok')
    expect(src.getState()!.title).toBe('Planet Caravan')
  })

  it('reports no-device on an empty 204', async () => {
    const { src } = build([{ status: 204 }])
    await src.poll()
    expect(src.getStatus()).toBe('no-device')
    expect(src.getState()).toBeNull()
  })

  it('refreshes once on a 401 and retries', async () => {
    const { src, calls } = build([
      { status: 401 },
      { status: 200, body: { access_token: 'new', expires_in: 3600 } },
      { status: 200, body: PLAYER },
    ])
    await src.poll()
    expect(src.getStatus()).toBe('ok')
    expect(calls.some((c) => c.url.includes('/api/token'))).toBe(true)
  })

  it('reports unauthorized after a second 401', async () => {
    const { src } = build([
      { status: 401 },
      { status: 200, body: { access_token: 'new', expires_in: 3600 } },
      { status: 401 },
    ])
    await src.poll()
    expect(src.getStatus()).toBe('unauthorized')
  })

  it('reports unauthorized when no token is stored', async () => {
    const src = new SpotifySource('cid', { load: () => null, save: () => {}, clear: () => {} } as never)
    await src.poll()
    expect(src.getStatus()).toBe('unauthorized')
  })

  it('reports offline when fetch throws', async () => {
    const src = new SpotifySource(
      'cid',
      { load: () => tokens(), save: () => {}, clear: () => {} } as never,
      (async () => { throw new Error('ENOTFOUND') }) as never,
    )
    await src.poll()
    expect(src.getStatus()).toBe('offline')
  })

  it('keeps the last known state when it goes offline', async () => {
    const { src } = build([{ status: 200, body: PLAYER }])
    await src.poll()
    src.setFetchForTest((async () => { throw new Error('down') }) as never)
    await src.poll()
    expect(src.getStatus()).toBe('offline')
    expect(src.getState()!.title).toBe('Planet Caravan')
  })

  it('honours Retry-After on a 429', async () => {
    const { src } = build([{ status: 429, headers: { 'retry-after': '7' } }])
    await src.poll()
    expect(src.retryAfterSeconds()).toBe(7)
  })

  it('advances the position locally between polls', async () => {
    const { src } = build([{ status: 200, body: PLAYER }])
    await src.poll()
    // The poll happened at now = 1000. Read the state 3 seconds later.
    expect(src.interpolate(1003)!.positionMs).toBe(134000 + 3000)
  })

  it('does not advance the position while paused', async () => {
    const { src } = build([{ status: 200, body: { ...PLAYER, is_playing: false } }])
    await src.poll()
    expect(src.interpolate(1010)!.positionMs).toBe(134000)
  })

  it('never advances past the track duration', async () => {
    const { src } = build([{ status: 200, body: PLAYER }])
    await src.poll()
    expect(src.interpolate(99999)!.positionMs).toBe(272000)
  })

  it('sends a PUT to pause', async () => {
    const { src, calls } = build([{ status: 200, body: PLAYER }, { status: 204 }])
    await src.poll()
    await src.pause()
    const last = calls[calls.length - 1]!
    expect(last.method).toBe('PUT')
    expect(last.url).toContain('/me/player/pause')
  })

  it('sends a POST to skip forward', async () => {
    const { src, calls } = build([{ status: 200, body: PLAYER }, { status: 204 }])
    await src.poll()
    await src.next()
    const last = calls[calls.length - 1]!
    expect(last.method).toBe('POST')
    expect(last.url).toContain('/me/player/next')
  })

  it('clamps the volume to 0 and 100', async () => {
    const { src, calls } = build([{ status: 200, body: PLAYER }, { status: 204 }, { status: 204 }])
    await src.poll()
    await src.setVolume(150)
    expect(calls[calls.length - 1]!.url).toContain('volume_percent=100')
    await src.setVolume(-20)
    expect(calls[calls.length - 1]!.url).toContain('volume_percent=0')
  })

  it('cycles repeat off to context to track and back', () => {
    expect(SpotifySource.nextRepeat('off')).toBe('context')
    expect(SpotifySource.nextRepeat('context')).toBe('track')
    expect(SpotifySource.nextRepeat('track')).toBe('off')
  })

  it('reports no-device when a control returns 403', async () => {
    const { src } = build([{ status: 200, body: PLAYER }, { status: 403 }])
    await src.poll()
    expect(await src.pause()).toBe(false)
    expect(src.getStatus()).toBe('no-device')
  })

  it('returns true when a control succeeds', async () => {
    const { src } = build([{ status: 200, body: PLAYER }, { status: 204 }])
    await src.poll()
    expect(await src.pause()).toBe(true)
  })
})

describe('SpotifySource visibility-gated polling', () => {
  it('polls immediately when the page becomes visible', async () => {
    const { src } = build([{ status: 200, body: PLAYER }])
    const changed = new Promise<void>((resolve) => src.once('change', resolve))
    src.setVisible(true)
    await changed
    expect(src.getStatus()).toBe('ok')
    // setVisible(true) schedules a real (non-fake) timer for the next poll,
    // up to 30 seconds out. Stop it, so it does not hold the process open
    // after this test finishes.
    await src.stop()
  })

  it('stops polling once the page is hidden', async () => {
    vi.useFakeTimers()
    const { src, fetchFn } = build([{ status: 200, body: PLAYER }])
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    const callsAfterFirst = fetchFn.mock.calls.length
    src.setVisible(false)
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetchFn.mock.calls.length).toBe(callsAfterFirst)
  })

  it('schedules the next poll at the playing interval, not the idle one', async () => {
    vi.useFakeTimers()
    const { src, fetchFn } = build([{ status: 200, body: PLAYER }])
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    const afterFirst = fetchFn.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchFn.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it('stop() clears the poll timer', async () => {
    vi.useFakeTimers()
    const { src, fetchFn } = build([{ status: 200, body: PLAYER }])
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    const callsAfterFirst = fetchFn.mock.calls.length
    await src.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetchFn.mock.calls.length).toBe(callsAfterFirst)
  })
})

describe('SpotifySource.getArt', () => {
  let artDir: string

  beforeEach(() => {
    artDir = mkdtempSync(join(tmpdir(), 'deckd-art-'))
  })

  afterEach(() => {
    rmSync(artDir, { recursive: true, force: true })
  })

  const fakeImage = { width: 300, height: 300 } as unknown as Image

  function buildArt(opts: { withDiskCache?: boolean } = {}) {
    const fetchCalls: string[] = []
    const fetchFn = vi.fn(async (url: string) => {
      fetchCalls.push(url)
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(4) }
    })
    const loadImageCalls: Buffer[] = []
    const loadImageFn = vi.fn(async (b: Buffer) => {
      loadImageCalls.push(b)
      return fakeImage
    })
    const store = { load: () => tokens(), save: vi.fn(), clear: vi.fn() }
    if (opts.withDiskCache) {
      writeFileSync(join(artDir, 'track-1.img'), Buffer.from('cached-bytes'))
    }
    const src = new SpotifySource(
      'cid', store as never, fetchFn as never, () => 1000, loadImageFn as never, artDir,
    )
    return { src, fetchFn, fetchCalls, loadImageFn, loadImageCalls }
  }

  it('returns null on a miss and caches the decoded image once it loads', async () => {
    const { src, fetchCalls } = buildArt()
    expect(src.getArt('track-1', 'https://art/track-1.jpg')).toBeNull()
    const changed = new Promise<void>((resolve) => src.once('change', resolve))
    await changed
    expect(src.getArt('track-1', 'https://art/track-1.jpg')).toBe(fakeImage)
    expect(fetchCalls).toEqual(['https://art/track-1.jpg'])
  })

  it('starts only one background load per track on repeated misses', async () => {
    const { src, fetchFn, loadImageFn } = buildArt()
    src.getArt('track-1', 'https://art/track-1.jpg')
    src.getArt('track-1', 'https://art/track-1.jpg')
    src.getArt('track-1', 'https://art/track-1.jpg')
    const changed = new Promise<void>((resolve) => src.once('change', resolve))
    await changed
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(loadImageFn).toHaveBeenCalledTimes(1)
  })

  it('reads a disk-cached file without fetching over the network', async () => {
    const { src, fetchFn, loadImageFn } = buildArt({ withDiskCache: true })
    src.getArt('track-1', 'https://art/track-1.jpg')
    const changed = new Promise<void>((resolve) => src.once('change', resolve))
    await changed
    expect(fetchFn).not.toHaveBeenCalled()
    expect(loadImageFn).toHaveBeenCalledTimes(1)
    expect(src.getArt('track-1', 'https://art/track-1.jpg')).toBe(fakeImage)
  })

  it('returns null and starts nothing for an empty track id', () => {
    const { src, fetchFn } = buildArt()
    expect(src.getArt('', 'https://art/x.jpg')).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not fetch when there is no art url, and returns null', async () => {
    const { src, fetchFn } = buildArt()
    expect(src.getArt('track-2', null)).toBeNull()
    // Give the background task a tick to finish (it returns immediately).
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(src.getArt('track-2', null)).toBeNull()
  })

  // Regression coverage for: the once-per-track guard (`pending`) is cleared
  // the instant an attempt finishes, success or not. A render happens once a
  // second, so a track whose art fails forever — or a track with no art URL
  // — would otherwise start a brand-new load on every single tick, for as
  // long as it stays on screen. That is a request storm against a
  // rate-limited API, made with the user's credential.

  it('does not retry every render tick after a failed load; it backs off for a cooldown', async () => {
    let now = 1000
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    const store = { load: () => tokens(), save: vi.fn(), clear: vi.fn() }
    const src = new SpotifySource('cid', store as never, fetchFn as never, () => now, undefined, artDir)

    expect(src.getArt('track-3', 'https://art/track-3.jpg')).toBeNull()
    // Let the one failing attempt settle. It only awaits microtask-level work.
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // Simulate 30 render ticks, a simulated second apart, all still well
    // inside the 60 second cooldown. Before the fix, each call below starts
    // a brand-new load, because `pending` was already cleared.
    for (let i = 0; i < 30; i++) {
      now += 1
      expect(src.getArt('track-3', 'https://art/track-3.jpg')).toBeNull()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does not repeatedly attempt a track with no art url, even once a url becomes available inside the cooldown', async () => {
    let now = 1000
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(4),
    }))
    const store = { load: () => tokens(), save: vi.fn(), clear: vi.fn() }
    const src = new SpotifySource('cid', store as never, fetchFn as never, () => now, undefined, artDir)

    expect(src.getArt('track-4', null)).toBeNull()
    await new Promise((r) => setTimeout(r, 10))

    for (let i = 0; i < 5; i++) {
      now += 1
      expect(src.getArt('track-4', null)).toBeNull()
    }
    // A URL is now available, but the cooldown from the no-URL miss above has
    // not elapsed. Before the fix, this call alone starts a fetch, because a
    // miss with no URL left no memory that it had already been tried.
    expect(src.getArt('track-4', 'https://art/track-4.jpg')).toBeNull()
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

/**
 * Builds a `SpotifySource` whose `fetchFn` branches by URL rather than by
 * call order, because `setVisible(true)` fires the player poll and the
 * saved-library load concurrently, and their actual interleaving is an
 * implementation detail this suite should not need to pin down. `/me/player`
 * always answers with `PLAYER`. `/me/tracks?` (the bulk saved-library
 * endpoint, distinct from the removed per-track `/me/tracks/contains` and
 * `/me/tracks?ids=`) is served from `pages`, indexed by how many bulk calls
 * have happened so far, so a test can hand it exactly the page sequence it
 * wants to exercise.
 */
function buildSaved(pages: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: string[] = []
  let bulkCalls = 0
  const fetchFn = vi.fn(async (url: string) => {
    calls.push(url)
    if (url.includes('/me/player')) {
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => PLAYER, arrayBuffer: async () => new ArrayBuffer(0),
      }
    }
    const r = pages[Math.min(bulkCalls, pages.length - 1)]!
    bulkCalls++
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body ?? {},
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  })
  const store = { load: () => tokens(), save: vi.fn(), clear: vi.fn() }
  const src = new SpotifySource('cid', store as never, fetchFn as never, () => 1000)
  return { src, fetchFn, calls, store }
}

describe('SpotifySource saved-library', () => {
  it('does not load the saved library at construction — only setVisible(true) starts it', () => {
    const { fetchFn } = buildSaved([{ status: 200, body: { items: [], total: 0 } }])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns null before the saved library has loaded, then a boolean once it has', async () => {
    const { src } = buildSaved([{ status: 200, body: { items: [{ track: { id: 'track-1' } }], total: 1 } }])
    await src.poll() // Sets state.trackId. Polling alone never starts the bulk load.
    expect(src.isSaved()).toBeNull()
    src.setVisible(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(src.isSaved()).toBe(true)
    await src.stop()
  })

  it('pages through the saved-library endpoint sequentially and builds the id set', async () => {
    const { src, fetchFn } = buildSaved([
      { status: 200, body: { items: [{ track: { id: 'track-1' } }, { track: { id: 'b' } }], total: 60 } },
      { status: 200, body: { items: [{ track: { id: 'c' } }], total: 60 } },
    ])
    src.setVisible(true)
    await new Promise((r) => setTimeout(r, 20))
    const bulkCalls = fetchFn.mock.calls.filter(([url]) => String(url).includes('/me/tracks?')).length
    expect(bulkCalls).toBe(2)
    // 'track-1' (PLAYER's trackId) is in the first page, 'b' and 'c' are not
    // the current track but prove the set spans both pages.
    expect(src.isSaved()).toBe(true)
    await src.stop()
  })

  it('fetches saved-library pages sequentially, never in parallel', async () => {
    const order: string[] = []
    let resolveFirstPage!: (v: unknown) => void
    const fetchFn = vi.fn((url: string) => {
      if (url.includes('/me/player')) {
        return Promise.resolve({
          ok: true, status: 200, headers: { get: () => null },
          json: async () => PLAYER, arrayBuffer: async () => new ArrayBuffer(0),
        })
      }
      order.push(url)
      if (order.length === 1) {
        // The first page never resolves until the test says so below.
        return new Promise((resolve) => { resolveFirstPage = resolve })
      }
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ items: [], total: 0 }), arrayBuffer: async () => new ArrayBuffer(0),
      })
    })
    const store = { load: () => tokens(), save: vi.fn(), clear: vi.fn() }
    const src = new SpotifySource('cid', store as never, fetchFn as never, () => 1000)

    src.setVisible(true)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toHaveLength(1) // The second page must not be requested while the first is still pending.

    resolveFirstPage({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ items: [{ track: { id: 'x' } }], total: 60 }),
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toHaveLength(2) // Only after the first resolves does the second fire.
    await src.stop()
  })

  it('leaves the saved state unknown and logs exactly once, without retrying, on a 403', async () => {
    const onceSpy = vi.spyOn(log, 'once')
    try {
      const { src, fetchFn } = buildSaved([{ status: 403 }])
      src.setVisible(true)
      await new Promise((r) => setTimeout(r, 20))
      expect(src.isSaved()).toBeNull()
      const bulkCalls = fetchFn.mock.calls.filter(([url]) => String(url).includes('/me/tracks?')).length
      expect(bulkCalls).toBe(1) // Never retried.
      expect(onceSpy).toHaveBeenCalledTimes(1)
      expect(onceSpy.mock.calls[0]![0]).toBe('spotify-saved-scope')
      await src.stop()
    } finally {
      onceSpy.mockRestore()
    }
  })

  it('loads the saved library only once, even across several visibility toggles', async () => {
    const { src, fetchFn } = buildSaved([
      { status: 200, body: { items: [{ track: { id: 'track-1' } }], total: 1 } },
    ])
    src.setVisible(true)
    await new Promise((r) => setTimeout(r, 20))
    const afterFirst = fetchFn.mock.calls.filter(([url]) => String(url).includes('/me/tracks?')).length
    expect(afterFirst).toBe(1)

    src.setVisible(false)
    src.setVisible(true)
    src.setVisible(false)
    src.setVisible(true)
    await new Promise((r) => setTimeout(r, 20))
    const afterMore = fetchFn.mock.calls.filter(([url]) => String(url).includes('/me/tracks?')).length
    expect(afterMore).toBe(1) // Never re-fetched.
    await src.stop()
  })
})

describe('SpotifySource stop() during an in-flight poll', () => {
  // Regression coverage for: `stop()` cleared the timers but never marked
  // itself as stopped. `setVisible(true)` and the recurring timer both run
  // `poll().then(() => this.schedule())`. If `stop()` runs while that poll is
  // still awaiting a real HTTP round trip, the continuation fires afterwards,
  // sees `visible` still true, and arms a brand-new timer — a poll that
  // survives shutdown.
  it('does not arm a new timer if stop() runs while a poll is still in flight', async () => {
    vi.useFakeTimers()
    let resolveFetch!: (v: unknown) => void
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve
    })
    const fetchFn = vi.fn(() => fetchPromise)
    const store = { load: () => tokens(), save: vi.fn(), clear: vi.fn() }
    const src = new SpotifySource('cid', store as never, fetchFn as never, () => 1000)

    src.setVisible(true) // Starts a poll AND the one-time saved-library load.
    // `accessToken()` resolves through a couple of microtask ticks before
    // either reaches its fetch call. Flush those first.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // Two callers, both blocked on the same unresolved fetch: the player
    // poll, and the saved-library load that `setVisible(true)` also starts
    // on the very first visit.
    expect(fetchFn).toHaveBeenCalledTimes(2)

    await src.stop() // stop() runs while that poll is still in flight.

    resolveFetch({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    // Flush the now-resolved poll's `.then(() => this.schedule())` continuation.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()

    expect(vi.getTimerCount()).toBe(0)
  })
})
