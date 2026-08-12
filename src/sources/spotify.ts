import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { loadImage, type Image } from '@napi-rs/canvas'
import { paths } from '../paths.js'
import { log } from '../log.js'
import { TokenStore, refreshTokens, type Tokens } from './spotify-auth.js'

const API = 'https://api.spotify.com/v1'
const POLL_PLAYING_MS = 3000
const POLL_IDLE_MS = 30000
const ART_MIN_WIDTH = 96
const ART_CACHE_MAX = 200
/** How long a failed (or URL-less) art attempt is left alone before a retry.
 * Without this, a render loop that asks for art once a second would start a
 * brand-new load every tick for a track whose art never resolves. */
const ART_RETRY_COOLDOWN_SECONDS = 60
/** The API needs a moment to settle after a command, so poll again shortly. */
const SETTLE_MS = 300

export type RepeatMode = 'off' | 'context' | 'track'
export type SpotifyStatus = 'ok' | 'unauthorized' | 'offline' | 'no-device'

export interface PlayerState {
  isPlaying: boolean
  title: string
  artist: string
  album: string
  positionMs: number
  durationMs: number
  trackId: string
  artUrl: string | null
  shuffle: boolean
  repeat: RepeatMode
  volumePercent: number | null
  hasDevice: boolean
}

interface ImageLike {
  url?: unknown
  width?: unknown
}

/**
 * Picks the smallest image at or above `minWidth`, or the largest one
 * available when none reach it. Returns null for an empty list.
 */
export function pickArtUrl(images: ImageLike[], minWidth: number): string | null {
  const sized = images
    .filter((i): i is { url: string; width: number } =>
      typeof i.url === 'string' && typeof i.width === 'number')
    .sort((a, b) => a.width - b.width)
  if (sized.length === 0) return null
  return (sized.find((i) => i.width >= minWidth) ?? sized[sized.length - 1]!).url
}

/** Parses the `/me/player` body. Returns null for an empty body or no track. */
export function parsePlayer(body: unknown): PlayerState | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, any>
  const item = b.item
  if (!item || typeof item !== 'object') return null

  const artists = Array.isArray(item.artists) ? item.artists : []
  const images = Array.isArray(item.album?.images) ? item.album.images : []
  const repeat: RepeatMode =
    b.repeat_state === 'context' || b.repeat_state === 'track' ? b.repeat_state : 'off'

  return {
    isPlaying: b.is_playing === true,
    title: typeof item.name === 'string' ? item.name : '',
    artist: artists.map((a: any) => a?.name).filter(Boolean).join(', '),
    album: typeof item.album?.name === 'string' ? item.album.name : '',
    positionMs: typeof b.progress_ms === 'number' ? b.progress_ms : 0,
    durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : 0,
    trackId: typeof item.id === 'string' ? item.id : '',
    artUrl: pickArtUrl(images, ART_MIN_WIDTH),
    shuffle: b.shuffle_state === true,
    repeat,
    volumePercent:
      typeof b.device?.volume_percent === 'number' ? b.device.volume_percent : null,
    hasDevice: Boolean(b.device),
  }
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}>

interface Store {
  load(): Tokens | null
  save(t: Tokens): void
  clear(): void
}

/**
 * Reads and controls Spotify playback. It polls only while the page is
 * visible, and it advances the playback position locally between polls, so a
 * smooth progress bar costs no extra requests.
 */
export class SpotifySource extends EventEmitter {
  private state: PlayerState | null = null
  private status: SpotifyStatus = 'unauthorized'
  private polledAt = 0
  private retryAfter = 0
  private timer: NodeJS.Timeout | null = null
  private settleTimer: NodeJS.Timeout | null = null
  private visible = false
  /** Set by `stop()`, so a poll continuation that was already in flight
   * cannot arm a new timer after shutdown. Distinct from `visible`, which is
   * the page-visibility signal, not a shutdown signal. */
  private stopped = false
  /** Decoded images, keyed by track id. */
  private artCache = new Map<string, Image>()
  /** Track ids with a load in flight, so one miss starts one load. */
  private pending = new Set<string>()
  /** Track ids whose last attempt failed (or had no URL), mapped to the
   * earliest time (in `now()` seconds) a retry is allowed. */
  private artRetryAt = new Map<string, number>()

  constructor(
    private readonly clientId: string,
    private readonly store: Store = new TokenStore(),
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    /** Injected so a test can decode without a real image. */
    private readonly loadImageFn: (b: Buffer) => Promise<Image> = loadImage,
    /** Where decoded art bytes are cached on disk. A test injects a temp dir,
     * so the suite never writes under the real state directory. */
    private readonly artDir: string = paths.artDir,
  ) {
    super()
  }

  /** Test helper. Swaps the fetch implementation mid-test. */
  setFetchForTest(f: FetchLike): void {
    this.fetchFn = f
  }

  static nextRepeat(mode: RepeatMode): RepeatMode {
    return mode === 'off' ? 'context' : mode === 'context' ? 'track' : 'off'
  }

  getState(): PlayerState | null {
    return this.state
  }

  getStatus(): SpotifyStatus {
    return this.status
  }

  retryAfterSeconds(): number {
    return this.retryAfter
  }

  /** Called when the Spotify page becomes visible. It starts the poll loop. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) {
      this.stopped = false
      void this.poll().then(() => this.schedule())
    } else if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    // A poll started before `stop()` can still be in flight when it
    // resolves. Its `.then(() => this.schedule())` continuation must not
    // arm a new timer after shutdown, so this check runs before anything
    // else, ahead of even the `visible` check below.
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    if (!this.visible) return
    const base = this.state?.isPlaying ? POLL_PLAYING_MS : POLL_IDLE_MS
    const delay = Math.max(base, this.retryAfter * 1000)
    this.timer = setTimeout(() => {
      void this.poll().then(() => this.schedule())
    }, delay)
  }

  private async accessToken(): Promise<string | null> {
    const t = this.store.load()
    if (!t) {
      this.status = 'unauthorized'
      return null
    }
    if (t.expiresAt > this.now() + 30) return t.accessToken
    return this.doRefresh(t)
  }

  private async doRefresh(t: Tokens): Promise<string | null> {
    try {
      const fresh = await refreshTokens(this.clientId, t.refreshToken, this.now)
      this.store.save(fresh)
      return fresh.accessToken
    } catch (e) {
      // This runs from the poll loop, so a persistent auth problem must not
      // spam the log every 3 to 30 seconds.
      log.once('spotify-refresh-failed', `spotify token refresh failed: ${String(e)}`)
      this.status = 'unauthorized'
      return null
    }
  }

  /** Polls the player. It refreshes the token once on a 401 and retries. */
  async poll(): Promise<void> {
    const before = JSON.stringify(this.state) + this.status
    await this.pollInner()
    if (JSON.stringify(this.state) + this.status !== before) this.emit('change')
  }

  private async pollInner(retried = false): Promise<void> {
    const token = await this.accessToken()
    if (!token) return

    let res
    try {
      res = await this.fetchFn(`${API}/me/player`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch (e) {
      // Keep the last known state. A dropped network is not a data change,
      // and this path runs on every poll while the network stays down, so it
      // must not spam the log.
      log.once('spotify-offline', `spotify player poll failed: ${String(e)}`)
      this.status = 'offline'
      return
    }

    if (res.status === 401) {
      if (retried) {
        this.status = 'unauthorized'
        return
      }
      const t = this.store.load()
      if (!t) {
        this.status = 'unauthorized'
        return
      }
      const fresh = await this.doRefresh(t)
      if (!fresh) return
      return this.pollInner(true)
    }

    if (res.status === 429) {
      this.retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '5', 10) || 5
      // A rate limit persists across polls until the wait elapses, so this
      // must log once rather than on every poll.
      log.once('spotify-rate-limited', `spotify rate limited. Waiting ${this.retryAfter} seconds.`)
      return
    }
    this.retryAfter = 0

    if (res.status === 204) {
      this.state = null
      this.status = 'no-device'
      return
    }

    if (!res.ok) {
      this.status = 'offline'
      return
    }

    const parsed = parsePlayer(await res.json())
    this.state = parsed
    this.status = parsed ? 'ok' : 'no-device'
    this.polledAt = this.now()
  }

  /**
   * Returns the state with the position advanced to `now`. The progress bar
   * moves once per second without a request. It never advances past the
   * track duration, and it does not advance at all while paused.
   */
  interpolate(now: number): PlayerState | null {
    if (!this.state) return null
    if (!this.state.isPlaying) return this.state
    const elapsedMs = Math.max(0, now - this.polledAt) * 1000
    const positionMs = Math.min(this.state.durationMs, this.state.positionMs + elapsedMs)
    return { ...this.state, positionMs }
  }

  private async command(
    path: string,
    method: 'PUT' | 'POST',
    query: Record<string, string> = {},
  ): Promise<boolean> {
    const token = await this.accessToken()
    if (!token) return false
    const url = new URL(`${API}${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    try {
      const res = await this.fetchFn(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' },
      })
      if (res.status === 403 || res.status === 404) {
        // Spotify returns these when no device is active. The failure must
        // be visible, so the page can dim the transport keys.
        this.status = 'no-device'
        this.emit('change')
        return false
      }
      if (!res.ok) return false
      // The API needs a moment to settle, so poll again shortly. Only while
      // the page is visible, and only after clearing any prior one, so this
      // never grows into more than one outstanding timer.
      if (this.settleTimer) clearTimeout(this.settleTimer)
      if (this.visible) {
        this.settleTimer = setTimeout(() => void this.poll(), SETTLE_MS)
      }
      return true
    } catch (e) {
      log.once('spotify-control-offline', `spotify control call failed: ${String(e)}`)
      this.status = 'offline'
      return false
    }
  }

  play(): Promise<boolean> {
    return this.command('/me/player/play', 'PUT')
  }
  pause(): Promise<boolean> {
    return this.command('/me/player/pause', 'PUT')
  }
  next(): Promise<boolean> {
    return this.command('/me/player/next', 'POST')
  }
  previous(): Promise<boolean> {
    return this.command('/me/player/previous', 'POST')
  }
  setVolume(percent: number): Promise<boolean> {
    const clamped = Math.min(100, Math.max(0, Math.round(percent)))
    return this.command('/me/player/volume', 'PUT', { volume_percent: String(clamped) })
  }
  toggleShuffle(): Promise<boolean> {
    const next = !(this.state?.shuffle ?? false)
    return this.command('/me/player/shuffle', 'PUT', { state: String(next) })
  }
  cycleRepeat(): Promise<boolean> {
    const next = SpotifySource.nextRepeat(this.state?.repeat ?? 'off')
    return this.command('/me/player/repeat', 'PUT', { state: next })
  }

  /**
   * Returns the cached, decoded album art for a track, or null. The renderer
   * cannot decode, because `@napi-rs/canvas` has no synchronous decode:
   * assigning bytes to `Image.src` sets width and height but leaves pixels
   * unavailable, so `drawImage` paints transparent black. Only `await
   * loadImage(bytes)` works, and the render loop cannot await. So this source
   * decodes in the background and caches the decoded `Image`.
   *
   * A miss returns null and starts the load exactly once per track, guarded
   * by `pending`. The page draws its fallback, and `change` fires when the
   * image is ready, so the next render picks it up. The render loop never
   * waits on the network or on a decode.
   */
  getArt(trackId: string, url: string | null = null): Image | null {
    if (!trackId) return null
    const cached = this.artCache.get(trackId)
    if (cached) return cached
    if (this.pending.has(trackId)) return null
    // A render happens once a second. Without this cooldown, a track whose
    // art fails (or has no URL at all) would start a brand-new load on every
    // tick for as long as it stays on screen — a request storm against a
    // rate-limited API, using the user's credential.
    const retryAt = this.artRetryAt.get(trackId)
    if (retryAt !== undefined && this.now() < retryAt) return null
    this.pending.add(trackId)
    void this.loadArt(trackId, url)
    return null
  }

  /** Reads the disk cache, or downloads. Then decodes and caches the image. */
  private async loadArt(trackId: string, url: string | null): Promise<void> {
    let ok = false
    try {
      const onDisk = join(this.artDir, `${trackId}.img`)
      let bytes: Buffer | null = null

      if (existsSync(onDisk)) {
        try {
          bytes = readFileSync(onDisk)
        } catch {
          bytes = null
        }
      }

      if (!bytes) {
        if (!url) return
        const res = await this.fetchFn(url, {})
        if (!res.ok) return
        bytes = Buffer.from(await res.arrayBuffer())
        // Spotify serves album art as JPEG. This cache stores whatever bytes
        // the server sent, decoded later by `loadImageFn`, which handles JPEG.
        mkdirSync(this.artDir, { recursive: true, mode: 0o700 })
        chmodSync(this.artDir, 0o700)
        writeFileSync(onDisk, bytes)
      }

      const img = await this.loadImageFn(bytes)
      this.remember(trackId, img)
      this.emit('change')
      ok = true
    } catch (e) {
      // No art this time. The page shows the fallback. A miss can recur on
      // every render that asks for this track, so this must not spam the log.
      log.once('spotify-art-failed', `spotify album art failed: ${String(e)}`)
    } finally {
      this.pending.delete(trackId)
      if (ok) {
        this.artRetryAt.delete(trackId)
      } else {
        // Covers both a genuine failure and the "no URL yet" case (the early
        // `return` above), so a URL that becomes available moments later
        // still waits out the cooldown rather than firing immediately.
        this.artRetryAt.set(trackId, this.now() + ART_RETRY_COOLDOWN_SECONDS)
      }
    }
  }

  private remember(trackId: string, img: Image): void {
    this.artCache.set(trackId, img)
    // A Map keeps insertion order, so the first key is the oldest.
    while (this.artCache.size > ART_CACHE_MAX) {
      const oldest = this.artCache.keys().next().value
      if (oldest === undefined) break
      this.artCache.delete(oldest)
    }
  }

  async start(): Promise<void> {
    // Nothing to do until the page becomes visible.
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.timer = null
    this.settleTimer = null
  }
}
