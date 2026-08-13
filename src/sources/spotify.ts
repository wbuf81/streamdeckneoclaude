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
/** Page size for the one-time saved-library load. 946 saved tracks is 19
 * requests at this size. */
const SAVED_LIBRARY_PAGE_SIZE = 50

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

interface SavedLibraryPage {
  items: unknown[]
  total: number
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
  /** Set while a token refresh is in flight, so a second caller that also
   * needs a refresh awaits THIS one instead of starting its own. Without
   * this, the poll and the one-time saved-library load — both started
   * together by the first `setVisible(true)` — each read the same
   * about-to-expire token and each call `refreshTokens` independently.
   * Spotify rotates the refresh token on use, so the loser's copy is
   * already stale by the time its own request lands: it fails, and its
   * failure handler sets `status` to `'unauthorized'`, overwriting whatever
   * the winner (or the poll itself) had just found — even though nothing is
   * actually wrong with the user's authorization. A second `setVisible(true)`
   * (leaving the page and coming back) never repeats this, because the
   * saved-library load runs at most once per process, so this is exactly the
   * "won't load, until I flip pages and back" defect. */
  private refreshPromise: Promise<string | null> | null = null
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
  /**
   * The user's entire saved-tracks library, loaded once. `null` means
   * unknown: not yet loaded, or the one load attempt failed. There is no
   * per-track lookup — Spotify's app-level restriction returns 403 on both
   * `GET /v1/me/tracks/contains` and `PUT /v1/me/tracks`, confirmed against
   * the live API with a token that DID carry the library scopes, so no
   * amount of retrying or re-authorizing unblocks them. `GET /v1/me/tracks`
   * (the bulk list) works, so the heart is read-only, backed by a single
   * paged load of this set.
   */
  private savedIds: Set<string> | null = null
  /** True once a saved-library load has been started, successful or not, so
   * it is attempted at most once per process — never on a timer, and never
   * retried after a failure. */
  private savedIdsAttempted = false

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

  /** Called when the Spotify page becomes visible. It starts the poll loop,
   * and on the FIRST visit only, starts the one-time saved-library load. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) {
      this.stopped = false
      // Lazy: a session that never opens this page costs zero requests for
      // this. Once-only: the flag is set before the load even starts, so a
      // second `setVisible(true)` — even while the first load is still in
      // flight — can never start a second one, success or failure.
      if (!this.savedIdsAttempted) {
        this.savedIdsAttempted = true
        void this.loadSavedIds()
      }
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

  /** Refreshes the access token, sharing ONE in-flight attempt across every
   * concurrent caller. The poll and the once-only saved-library load can
   * both decide they need a refresh in the same tick — see `refreshPromise`
   * — and issuing two real requests risks the second one failing against an
   * already-rotated refresh token and wrongly marking the source
   * unauthorized. */
  private async doRefresh(t: Tokens): Promise<string | null> {
    if (this.refreshPromise) return this.refreshPromise
    const attempt = this.performRefresh(t)
    this.refreshPromise = attempt
    try {
      return await attempt
    } finally {
      this.refreshPromise = null
    }
  }

  private async performRefresh(t: Tokens): Promise<string | null> {
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
   * True when the current track is in the saved-tracks library, false when
   * it is not, null when the library set has not loaded (or failed to
   * load). This is a LOCAL membership check against `savedIds` — no
   * network call per track, and no per-track lookup at all, because
   * Spotify's app-level restriction 403s that endpoint regardless of scope.
   */
  isSaved(): boolean | null {
    if (!this.savedIds) return null
    const trackId = this.state?.trackId
    if (!trackId) return null
    return this.savedIds.has(trackId)
  }

  /**
   * Pages through the entire saved-tracks library exactly once and builds
   * the id set. Requests are sequential, never parallel — a burst of ~19
   * requests against a rate-limited API, right when the user first opens
   * the page, is exactly the kind of storm this project has already been
   * bitten by once (see `artRetryAt`). Any failure — offline, a 429, or a
   * 403 — aborts the WHOLE load and leaves `savedIds` at null (unknown).
   * There is no retry: a 403 here is Spotify's app-level restriction on
   * this endpoint, confirmed present even with the correct scopes, so it
   * will never resolve itself, and `setVisible` already guarantees this
   * method itself is never called a second time.
   */
  private async loadSavedIds(): Promise<void> {
    const ids = new Set<string>()
    let offset = 0
    for (;;) {
      const page = await this.fetchSavedPage(offset)
      if (!page) return
      for (const item of page.items) {
        const id = (item as { track?: { id?: unknown } } | null)?.track?.id
        if (typeof id === 'string' && id) ids.add(id)
      }
      offset += SAVED_LIBRARY_PAGE_SIZE
      if (page.items.length === 0 || offset >= page.total) break
    }
    this.savedIds = ids
    this.emit('change')
  }

  /** Fetches one page of `/me/tracks`. Refreshes once on a 401 and retries.
   * A 429 or 403 aborts (returns null) rather than retrying: a 429 here
   * follows the same `retryAfter` bookkeeping the player poll uses, and a
   * 403 means the app-level restriction described on `isSaved`, which no
   * amount of retrying resolves. */
  private async fetchSavedPage(offset: number, retried = false): Promise<SavedLibraryPage | null> {
    const token = await this.accessToken()
    if (!token) return null

    let res
    try {
      res = await this.fetchFn(
        `${API}/me/tracks?limit=${SAVED_LIBRARY_PAGE_SIZE}&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
    } catch (e) {
      log.once('spotify-saved-offline', `spotify saved-library load failed: ${String(e)}`)
      return null
    }

    if (res.status === 401) {
      if (retried) return null
      const t = this.store.load()
      if (!t) return null
      const fresh = await this.doRefresh(t)
      if (!fresh) return null
      return this.fetchSavedPage(offset, true)
    }

    if (res.status === 429) {
      this.retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '5', 10) || 5
      log.once(
        'spotify-saved-rate-limited',
        `spotify saved-library load rate limited. Waiting ${this.retryAfter} seconds.`,
      )
      return null
    }

    if (res.status === 403) {
      log.once(
        'spotify-saved-scope',
        'spotify saved-library load got 403; leaving the saved-track state unknown',
      )
      return null
    }

    if (!res.ok) {
      log.once(
        'spotify-saved-load-failed',
        `spotify saved-library load failed with status ${res.status}`,
      )
      return null
    }

    const body = (await res.json()) as { items?: unknown[]; total?: unknown }
    return {
      items: Array.isArray(body.items) ? body.items : [],
      total: typeof body.total === 'number' ? body.total : 0,
    }
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
    retried = false,
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
      if (res.status === 401) {
        // Consistent with `pollInner`: refresh once and retry, rather than
        // reporting the control as failed while a fresh token would have
        // succeeded. Never more than once — `retried` guards that — and a
        // 403 is a separate branch below that this never reaches, so it
        // still never retries.
        if (retried) {
          this.status = 'unauthorized'
          return false
        }
        const t = this.store.load()
        if (!t) {
          this.status = 'unauthorized'
          return false
        }
        const fresh = await this.doRefresh(t)
        if (!fresh) return false
        return this.command(path, method, query, true)
      }
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
        this.rememberRetry(trackId, this.now() + ART_RETRY_COOLDOWN_SECONDS)
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

  /** Bounded the same way as `artCache`: unlike a decoded image, a cooldown
   * entry is small, but a track id that never resolves (or a listening
   * session that cycles through many tracks) would otherwise grow this map
   * forever, one entry per distinct track id, for the life of the process. */
  private rememberRetry(trackId: string, at: number): void {
    this.artRetryAt.set(trackId, at)
    while (this.artRetryAt.size > ART_CACHE_MAX) {
      const oldest = this.artRetryAt.keys().next().value
      if (oldest === undefined) break
      this.artRetryAt.delete(oldest)
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
