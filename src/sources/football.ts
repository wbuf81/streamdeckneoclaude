import { EventEmitter } from 'node:events'
import { loadImage, type Image } from '@napi-rs/canvas'
import { log } from '../log.js'

/**
 * Data source note, measured 2026-08-14 (see the task 40 report folded into
 * docs/VERIFIED-FACTS.md): ESPN's unofficial schedule API is blocked from
 * this machine with HTTP 403 (Akamai "Access Denied"), confirmed with
 * Node's own `fetch` and a full browser `User-Agent` — not just `curl`. Per
 * docs/LESSONS.md #10, a 403 cannot succeed on retry, so this source never
 * calls that API at all. ESPN's logo CDN is a SEPARATE, open host and is
 * used below for tile art only.
 *
 * The schedule itself comes from TheSportsDB's free tier (public test key
 * `3`). Team ids are widely misreported online — the brief's own trap,
 * id `134938`, returns a Chicago Bears vs Cleveland Browns game, not the
 * Jaguars. The ids below were resolved directly via `searchteams.php` and
 * cross-checked: every event this source accepts must actually name the
 * requested id as its home or away team (see `parseEvent`), so a future
 * aliasing response is rejected rather than silently trusted.
 */
export const JAGUARS_TEAM_ID = '134928'
export const GATORS_TEAM_ID = '136887'

export type Team = 'jaguars' | 'gators'
/** Which of the two calls this source makes per team. */
export type Slot = 'next' | 'last'

const TEAM_IDS: Readonly<Record<Team, string>> = {
  jaguars: JAGUARS_TEAM_ID,
  gators: GATORS_TEAM_ID,
}

/**
 * ESPN's logo CDN, measured OPEN (200, real PNGs) on 2026-08-14 while the
 * schedule API on the SAME company's other host is blocked. These are team
 * logos, not literal helmets, but they are legitimate art for a 96 px tile.
 */
export const LOGO_URLS: Readonly<Record<Team, string>> = {
  jaguars: 'https://a.espncdn.com/i/teamlogos/nfl/500/jax.png',
  gators: 'https://a.espncdn.com/i/teamlogos/ncaa/500/57.png',
}

const SPORTSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/3'

function nextUrl(teamId: string): string {
  return `${SPORTSDB_BASE}/eventsnext.php?id=${encodeURIComponent(teamId)}`
}

function lastUrl(teamId: string): string {
  return `${SPORTSDB_BASE}/eventslast.php?id=${encodeURIComponent(teamId)}`
}

function keyOf(team: Team, slot: Slot): string {
  return `${team}:${slot}`
}

export type FootballStatus = 'ok' | 'offline' | 'empty'

/**
 * One game, either the team's next scheduled matchup or its most recently
 * finished one. `kickoffEpochMs` is the ONE source of both the date and the
 * time shown on the deck (see the formatting helpers in
 * `pages/football-page.ts`): TheSportsDB's `dateEvent` is a UTC calendar
 * date, and a late-kickoff West Coast game can fall on the PREVIOUS day once
 * converted to US Eastern (measured: `Oregon vs Portland State`,
 * `dateEvent` `2026-09-19`, `strTime` `02:30:00`, converts to 2026-09-18
 * evening Eastern). Deriving the displayed date from anything other than
 * this same epoch would risk exactly the "wrong-timezone kickoff" the task
 * brief warns is worse than no kickoff at all.
 *
 * `kickoffEpochMs` is null when the source has no usable date or time for
 * this game — a real, honest "unknown," never a fabricated stand-in
 * (docs/LESSONS.md #18). Measured caveat, recorded for the next person
 * touching this file rather than silently assumed: TheSportsDB's free tier
 * has no field that distinguishes a genuinely unannounced kickoff from a
 * real one that happens to fall on `00:00:00` UTC (a common, legitimate
 * value — an 8 PM US Eastern kickoff is exactly midnight UTC). A whole
 * far-future round (NFL Week 18, `2027-01-10`) was observed with every game
 * sharing the identical placeholder `00:00:00`, which is the closest thing
 * to a real "TBD" signal this API exposes, but it cannot be told apart from
 * a legitimate prime-time kickoff on a single event alone. This source does
 * not guess: it treats `00:00:00` as a real time like any other, and only
 * an absent or malformed `dateEvent`/`strTime` pair renders as unknown. See
 * the task 40 report for the full measurement.
 */
export interface GameSummary {
  /** TheSportsDB's own event id. Not used for selection (the page selects by
   * team and slot, which are both fixed), kept for traceability only. */
  id: string
  opponent: string
  isHome: boolean
  kickoffEpochMs: number | null
  /** Empty when unknown. Never a fabricated placeholder. */
  venue: string
  /** Empty when unknown. Never a fabricated placeholder. */
  city: string
  /** True only when BOTH scores parsed as real numbers — never inferred from
   * `strStatus`, which this file has not measured every value of. */
  finished: boolean
  /** This team's own score. Null unless `finished`. */
  teamScore: number | null
  /** The opponent's score. Null unless `finished`. */
  opponentScore: number | null
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}>

/** Schedules change weekly, not hourly — the task brief's own instruction to
 * poll rarely. */
const POLL_MS = 6 * 60 * 60 * 1000
/** A schedule older than this counts as stale, so the page never presents an
 * old snapshot as current. Four times the poll interval, the same scaling
 * `stocks.ts`'s yearly cache uses relative to its own refresh interval. */
const STALE_SECONDS = 24 * 60 * 60
/** How long a failed (or not-yet-attempted) logo load is left alone before a
 * retry. Without this, a render happening once a second would start a
 * brand-new load every tick for a logo that never resolves — the exact
 * request-storm shape docs/LESSONS.md #10 describes for Spotify's album art. */
const LOGO_RETRY_COOLDOWN_SECONDS = 5 * 60

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function strOf(o: unknown, key: string): string {
  const v = asObj(o)[key]
  return typeof v === 'string' ? v : ''
}

/** TheSportsDB serves scores as numeric strings (or `null` before a game is
 * played). Accepts either shape; anything else is unknown, never 0. */
function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/

/**
 * Combines TheSportsDB's `dateEvent` and `strTime` into one UTC epoch.
 * Measured 2026-08-14 (see the task 40 report): the Jaguars' next game
 * carries `dateEvent: "2026-08-15"`, `strTime: "20:00:00"`, and
 * `strTimestamp: "2026-08-15T20:00:00"` — the same two fields concatenated
 * with no offset suffix — cross-checked against `strTimeLocal` and the
 * venue's own timezone (New Orleans, UTC-5 CDT: 15:00 local matches 20:00
 * UTC exactly). So this parses the pair as a literal UTC instant, `Z`
 * appended, rather than trusting `strTimestamp` verbatim (a shape TheSportsDB
 * could change without notice) or guessing a local offset from the venue.
 * Returns null for a missing or malformed pair — never a fabricated instant.
 */
function parseKickoffEpochMs(dateEvent: string, time: string): number | null {
  if (!DATE_RE.test(dateEvent) || !TIME_RE.test(time)) return null
  const ms = Date.parse(`${dateEvent}T${time}Z`)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Parses one TheSportsDB event object into a `GameSummary` for `teamId`.
 * Returns null when the body carries no usable event, OR — per the brief's
 * own measured trap (id `134938` silently returning a Bears/Browns game) —
 * when the one event present does not actually name `teamId` as either
 * side. The same cross-check `stocks.ts`'s `parseQuote` already applies to a
 * mismatched Yahoo symbol.
 */
export function parseEvent(body: unknown, teamId: string): GameSummary | null {
  const events = asObj(body).events
  if (!Array.isArray(events) || events.length === 0) return null
  const e = events[0]
  const idHome = strOf(e, 'idHomeTeam')
  const idAway = strOf(e, 'idAwayTeam')
  if (idHome !== teamId && idAway !== teamId) return null

  const isHome = idHome === teamId
  const opponent = isHome ? strOf(e, 'strAwayTeam') : strOf(e, 'strHomeTeam')
  const homeScore = numberOrNull(asObj(e).intHomeScore)
  const awayScore = numberOrNull(asObj(e).intAwayScore)
  const finished = homeScore !== null && awayScore !== null

  return {
    id: strOf(e, 'idEvent'),
    opponent,
    isHome,
    kickoffEpochMs: parseKickoffEpochMs(strOf(e, 'dateEvent'), strOf(e, 'strTime')),
    venue: strOf(e, 'strVenue'),
    city: strOf(e, 'strCity'),
    finished,
    teamScore: finished ? (isHome ? homeScore : awayScore) : null,
    opponentScore: finished ? (isHome ? awayScore : homeScore) : null,
  }
}

/**
 * Reads the next scheduled and most recently finished game for the
 * Jacksonville Jaguars and the Florida Gators from TheSportsDB's free tier,
 * plus their ESPN CDN logos. It polls only while the page is visible, at 6
 * hours (schedules change weekly), and never wipes the last known schedule
 * on a failure — it reports `offline` and keeps showing what it had.
 *
 * Measured 2026-08-14 (task 40 report): the free tier's `eventsnext.php` and
 * `eventslast.php` each return exactly ONE event per team, not the "next
 * three games" the original brief sketch assumed — confirmed against three
 * different NFL team ids and both Florida endpoints, and independently
 * against `eventsseason.php`/`eventsround.php`, which are capped at 5 rows
 * for an entire league regardless of team, not filterable by team on this
 * key. One game per team, in each direction, is what this tier actually
 * supports; showing three would mean fabricating two of them.
 */
export class FootballSource extends EventEmitter {
  private games = new Map<string, GameSummary | null>()
  private status: FootballStatus = 'empty'
  private lastSuccessAt = 0
  private timer: NodeJS.Timeout | null = null
  private visible = false
  /** Set by `stop()`, so a refresh continuation already in flight cannot arm
   * a new timer after shutdown. See `schedule()`, which checks this first. */
  private stopped = false
  private inFlight: Promise<void> | null = null
  private lastKey = ''
  /** Per docs/LESSONS.md #10: a URL that has ever answered 403 is never
   * fetched again this process — a 403 cannot succeed on retry, whether it
   * is TheSportsDB or the logo CDN that returns it. */
  private blockedUrls = new Set<string>()

  private logoCache = new Map<Team, Image>()
  private logoPending = new Set<Team>()
  private logoRetryAt = new Map<Team, number>()

  constructor(
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly loadImageFn: (b: Buffer) => Promise<Image> = loadImage,
  ) {
    super()
  }

  /** Test helper. Swaps the fetch implementation mid-test. */
  setFetchForTest(f: FetchLike): void {
    this.fetchFn = f
  }

  /** The requested team's game for that slot, or null when unknown. A copy —
   * `GameSummary` is flat, so a shallow spread is deep enough — so a caller
   * cannot mutate this source's own cache through the result. */
  getGame(team: Team, slot: Slot): GameSummary | null {
    const g = this.games.get(keyOf(team, slot))
    return g ? { ...g } : null
  }

  getStatus(): FootballStatus {
    return this.status
  }

  getLastUpdatedAt(): number {
    return this.lastSuccessAt
  }

  /** True when the last successful fetch is older than 24 hours. False
   * before the first success — that is `empty`, not stale. */
  isStale(): boolean {
    if (this.lastSuccessAt === 0) return false
    return this.now() - this.lastSuccessAt > STALE_SECONDS
  }

  /** Called when the football page becomes visible. It refreshes at once and
   * starts the poll loop. Per docs/LESSONS.md #18/I5 pattern shared with
   * `WeatherSource`/`StockSource`: `stopped` is a one-way latch, so a stray
   * `setVisible(true)` after shutdown cannot restart polling. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (this.stopped) return
    if (visible) {
      void this.refreshAndSchedule()
    } else if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async refreshAndSchedule(): Promise<void> {
    try {
      await this.refresh()
    } catch (e) {
      log.once('football-refresh-unexpected', `football refresh failed unexpectedly: ${String(e)}`)
    } finally {
      this.schedule()
    }
  }

  private schedule(): void {
    // A refresh started before `stop()` can still be in flight when it
    // settles. Its continuation must not arm a new timer after shutdown, so
    // this check runs before anything else, ahead of even the `visible`
    // check below.
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    if (!this.visible) return
    this.timer = setTimeout(() => {
      void this.refreshAndSchedule()
    }, POLL_MS)
  }

  private async fetchGame(teamId: string, slot: Slot): Promise<{ ok: boolean; game: GameSummary | null }> {
    const url = slot === 'next' ? nextUrl(teamId) : lastUrl(teamId)
    const logKey = `football-${slot}-${teamId}`
    if (this.blockedUrls.has(url)) return { ok: false, game: null }

    let res
    try {
      res = await this.fetchFn(url)
    } catch (e) {
      // Runs on every poll while the network stays down, so it must log once.
      log.once(`${logKey}-network`, `Football ${slot} fetch for ${teamId} failed: ${String(e)}`)
      return { ok: false, game: null }
    }
    log.clearOnce(`${logKey}-network`)

    if (res.status === 403) {
      // Per docs/LESSONS.md #10: a 403 cannot succeed on retry. Blocked for
      // the rest of this process, not just cooled down.
      this.blockedUrls.add(url)
      log.once(`${logKey}-403`, `Football ${slot} fetch for ${teamId} returned 403; will not retry this session.`)
      return { ok: false, game: null }
    }
    if (!res.ok) {
      log.once(`${logKey}-http`, `Football ${slot} fetch for ${teamId} failed with status ${res.status}.`)
      return { ok: false, game: null }
    }
    log.clearOnce(`${logKey}-http`)

    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      log.once(`${logKey}-json`, `Football ${slot} response for ${teamId} is not valid JSON: ${String(e)}`)
      return { ok: false, game: null }
    }
    log.clearOnce(`${logKey}-json`)

    return { ok: true, game: parseEvent(body, teamId) }
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /**
   * Emits `change` only when the whole snapshot (every game, plus status)
   * actually differs from the last one, following the pattern in
   * `src/sources/claude.ts`: a partial comparison key can miss a real update
   * and leave stale text on the deck.
   */
  private async doRefresh(): Promise<void> {
    const [jagNext, jagLast, gatNext, gatLast] = await Promise.all([
      this.fetchGame(TEAM_IDS.jaguars, 'next'),
      this.fetchGame(TEAM_IDS.jaguars, 'last'),
      this.fetchGame(TEAM_IDS.gators, 'next'),
      this.fetchGame(TEAM_IDS.gators, 'last'),
    ])

    const next = new Map(this.games)
    let anySuccess = false
    if (jagNext.ok) { next.set(keyOf('jaguars', 'next'), jagNext.game); anySuccess = true }
    if (jagLast.ok) { next.set(keyOf('jaguars', 'last'), jagLast.game); anySuccess = true }
    if (gatNext.ok) { next.set(keyOf('gators', 'next'), gatNext.game); anySuccess = true }
    if (gatLast.ok) { next.set(keyOf('gators', 'last'), gatLast.game); anySuccess = true }
    this.games = next

    this.status = anySuccess ? 'ok' : this.games.size > 0 ? 'offline' : 'empty'
    if (anySuccess) this.lastSuccessAt = this.now()

    const key = JSON.stringify({ games: [...this.games.entries()], status: this.status })
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit('change')
  }

  /**
   * Returns the cached, decoded logo for `team`, or null. Mirrors
   * `SpotifySource.getArt`: `@napi-rs/canvas` has no synchronous decode
   * (assigning bytes to `Image.src` sets width/height but leaves pixels
   * unavailable), so this source decodes off the render path and caches the
   * decoded `Image`. A miss returns null and starts the load exactly once,
   * guarded by `logoPending`; `change` fires when the image is ready. Unlike
   * album art, there are only ever two possible teams, so the cache needs no
   * eviction — it cannot grow unbounded the way a per-track cache could.
   */
  getLogo(team: Team): Image | null {
    const cached = this.logoCache.get(team)
    if (cached) return cached
    if (this.logoPending.has(team)) return null
    const url = LOGO_URLS[team]
    if (this.blockedUrls.has(url)) return null
    const retryAt = this.logoRetryAt.get(team)
    if (retryAt !== undefined && this.now() < retryAt) return null
    this.logoPending.add(team)
    void this.loadLogo(team, url)
    return null
  }

  private async loadLogo(team: Team, url: string): Promise<void> {
    let ok = false
    try {
      const res = await this.fetchFn(url)
      if (res.status === 403) {
        this.blockedUrls.add(url)
        log.once(`football-logo-403-${team}`, `Logo fetch for ${team} returned 403; will not retry this session.`)
        return
      }
      if (!res.ok) {
        log.once(`football-logo-http-${team}`, `Logo fetch for ${team} failed with status ${res.status}.`)
        return
      }
      log.clearOnce(`football-logo-http-${team}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      const img = await this.loadImageFn(bytes)
      this.logoCache.set(team, img)
      this.emit('change')
      ok = true
    } catch (e) {
      log.once(`football-logo-failed-${team}`, `Logo decode for ${team} failed: ${String(e)}`)
    } finally {
      this.logoPending.delete(team)
      if (ok) {
        this.logoRetryAt.delete(team)
      } else {
        // Covers both a genuine failure and the 403 early-return: a cooldown,
        // not a guard cleared unconditionally (docs/LESSONS.md #10) — a
        // render happening once a second must not retry every tick.
        this.logoRetryAt.set(team, this.now() + LOGO_RETRY_COOLDOWN_SECONDS)
      }
    }
  }

  async start(): Promise<void> {
    // Nothing to do until the page becomes visible.
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
