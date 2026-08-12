import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePlayer, pickArtUrl, SpotifySource } from '../../src/sources/spotify.js'
import type { Tokens } from '../../src/sources/spotify-auth.js'
import type { Image } from '@napi-rs/canvas'

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
})
