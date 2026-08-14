import { EventEmitter } from 'node:events'
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import { log } from '../log.js'
import { theme } from '../render/theme.js'

/**
 * Data source note, measured 2026-08-14 (see docs/VERIFIED-FACTS.md, task 42).
 * TheSportsDB's free tier (the previous source for this page) returns
 * exactly ONE event per team per call — it cannot show "next three games."
 * `site.api.espn.com`, the host the task 40 brief measured, is Akamai-
 * blocked (403), confirmed again with Node's own `fetch`. Per
 * docs/LESSONS.md #10, a 403 cannot succeed on retry, so this source never
 * calls that host.
 *
 * A DIFFERENT ESPN host, `sports.core.api.espn.com`, is open and returns a
 * team's full season of events (20 for an NFL team, 12 for a college team),
 * each as a `$ref` link rather than inlined. Following one gives a real
 * event object with a UTC `date`, a `timeValid` flag (see `parseEvent`), and
 * competitor ids/`homeAway` — but NOT an inlined score or status (those are
 * `$ref` links too, one more request each). This source never follows those:
 * the three things the user asked for (next three games, season record,
 * full schedule) do not need a score, and record comes from a dedicated,
 * far cheaper endpoint (see `parseRecord`).
 */

export type Team = 'jaguars' | 'gators'
type League = 'nfl' | 'college-football'

interface TeamConfig {
  readonly espnId: string
  readonly league: League
  /** The exact string ESPN's own `name` field uses for this team — the key
   * that lets `splitEventName` pull the OPPONENT's name out of "Away Team at
   * Home Team" without an extra request per game. Measured live: this exact
   * string appears at one end of `name` in every event fetched for this
   * team (32/32 across both teams' full seasons, task 42 report). */
  readonly fullName: string
  readonly logoUrl: string
}

export const JAGUARS_ESPN_ID = '30'
export const GATORS_ESPN_ID = '57'

const TEAM_CONFIG: Readonly<Record<Team, TeamConfig>> = {
  jaguars: {
    espnId: JAGUARS_ESPN_ID,
    league: 'nfl',
    fullName: 'Jacksonville Jaguars',
    logoUrl: 'https://a.espncdn.com/i/teamlogos/nfl/500/jax.png',
  },
  gators: {
    espnId: GATORS_ESPN_ID,
    league: 'college-football',
    fullName: 'Florida Gators',
    logoUrl: 'https://a.espncdn.com/i/teamlogos/ncaa/500/57.png',
  },
}

/** ESPN's logo CDN, measured OPEN (200, real PNGs) — a separate host from
 * the blocked one, same as the previous version of this source recorded. */
export const LOGO_URLS: Readonly<Record<Team, string>> = {
  jaguars: TEAM_CONFIG.jaguars.logoUrl,
  gators: TEAM_CONFIG.gators.logoUrl,
}

/**
 * The season this source reads. Measured live 2026-08-14:
 * `sports.core.api.espn.com/v2/sports/football/leagues/<league>` DOES carry
 * the current season year inline (`season.year`), which would let this
 * self-correct every year — but that is one more request per league per
 * poll for a value that changes exactly once a year. Hardcoded here,
 * matching this project's existing convention for the team ids above: bump
 * this to `'2027'` when the 2027 season starts, or this source keeps
 * reading a closed season and every game reads as "already played."
 */
const SEASON_YEAR = '2026'
/**
 * ESPN's own season-type id for the regular season. Measured live for BOTH
 * leagues on 2026-08-14: `types/1` = Preseason, `types/2` = Regular Season,
 * `types/3` = Postseason, `types/4` = Off Season — identical numbering on
 * `nfl` and `college-football`. The season record shown on the logo tile
 * reads THIS type only, never preseason: a preseason result folded into "the
 * record for the year" would be wrong (the task brief's own words).
 */
const REGULAR_SEASON_TYPE = '2'

const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues'

function eventsListUrl(league: League, espnId: string): string {
  // limit=100 is generous headroom over the measured season sizes (20 NFL,
  // 12 college) so a normal season never needs a second page.
  return `${CORE_BASE}/${league}/seasons/${SEASON_YEAR}/teams/${espnId}/events?limit=100`
}

function recordUrl(league: League, espnId: string): string {
  return `${CORE_BASE}/${league}/seasons/${SEASON_YEAR}/types/${REGULAR_SEASON_TYPE}/teams/${espnId}/record`
}

export interface Game {
  /** ESPN's own event id, extracted from the event's `$ref` URL. Stable
   * across refreshes — the merge key that lets one bad event ref keep the
   * REST of a team's schedule instead of blanking it (see `refreshSchedule`). */
  id: string
  /** The opponent's full name, e.g. `New Orleans Saints`. Empty when
   * `splitEventName` could not find the expected separator — an honest
   * unknown, never a guess (docs/LESSONS.md #18). */
  opponent: string
  /** The opponent's short code, e.g. `NO`, from `shortName`. Empty under the
   * same unknown condition as `opponent`. */
  opponentShort: string
  isHome: boolean
  /** The UTC instant of `date`. Null only for a missing or malformed date —
   * measured, this never actually happens on this host, but the field stays
   * honest rather than assumed. */
  kickoffEpochMs: number | null
  /**
   * True when ESPN's own `timeValid` is anything other than the literal
   * `true` — measured live 2026-08-14: `timeValid` is `false` on real,
   * still-scheduled games well before the two-week mark (a Gators game five
   * weeks out, several Jaguars Week 18 games), not just on placeholder far-
   * future rows. The DATE portion of `date` still reflects the scheduled
   * week and is shown as-is; only the KICKOFF TIME is treated as unknown —
   * this is the exact distinction TheSportsDB's free tier could not make
   * (docs/VERIFIED-FACTS.md's prior note on `00:00:00`), and this host can.
   */
  timeTbd: boolean
}

export interface TeamRecord {
  wins: number
  losses: number
  ties: number
  /**
   * False when the record endpoint's own `gamesPlayed` stat is 0 — the
   * regular season has not started yet, so `wins`/`losses` are REAL zeros
   * with nothing behind them, not a played record. The page must render
   * this as an explicit unknown, never the literal `0-0` (docs/LESSONS.md
   * #18) — a glance at a tile showing `0-0` reads as "just lost or tied
   * everything," not "season has not begun."
   */
  started: boolean
}

export type FootballStatus = 'ok' | 'offline' | 'empty'

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}>

/** Schedules change weekly, not hourly. */
const POLL_MS = 6 * 60 * 60 * 1000
const STALE_SECONDS = 24 * 60 * 60
const LOGO_RETRY_COOLDOWN_SECONDS = 5 * 60
/**
 * How many event `$ref`s this source follows at once per team. Measured
 * live 2026-08-14 (task 42 report): 32 real event refs (20 NFL + 12 college,
 * the full combined season for both teams) fetched at concurrency 10
 * completed in 0.58 s, all 200s. 6 is deliberately gentler than that
 * measured ceiling — a full 20-game refresh still finishes in about a
 * second — while keeping this source far from a 32-request burst. This
 * only ever runs on the periodic poll or the initial visible-refresh, NEVER
 * from a key press (see `football-page.ts`'s `onKeyPress`, which does no
 * network I/O at all).
 */
const EVENT_FETCH_CONCURRENCY = 6

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function strOf(o: unknown, key: string): string {
  const v = asObj(o)[key]
  return typeof v === 'string' ? v : ''
}

function numOf(o: unknown, key: string): number | null {
  const v = asObj(o)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/

/** Parses ESPN's `date` field (`2026-08-15T20:00Z`) as a literal UTC
 * instant. Returns null for a missing or malformed value — never a
 * fabricated instant (docs/LESSONS.md #18). */
export function parseKickoffEpochMs(date: string): number | null {
  if (!DATE_RE.test(date)) return null
  const ms = Date.parse(date)
  return Number.isFinite(ms) ? ms : null
}

const NAME_SEPARATOR = ' at '

/**
 * Splits ESPN's own `name` field ("Away Team at Home Team") into its away
 * and home halves. Measured live 2026-08-14 across the FULL season for both
 * teams (32 real events, task 42 report): `name` uses this exact separator,
 * in Away-then-Home order, 32 times out of 32 — including neutral-site games
 * (`shortName` switches to "VS" there, but `name` still says "at"). Returns
 * null when the separator is missing, or appears more than once (a team
 * name that happened to contain " at " would make the split ambiguous) —
 * an honest unknown rather than a guess.
 *
 * This does NOT decide home or away — that comes from `competitors[].
 * homeAway`, matched by id, in `parseEvent`. This only extracts readable
 * names once home/away is already known, per the task brief's own warning
 * against inferring home/away from string order.
 */
export function splitEventName(name: string): { away: string; home: string } | null {
  const idx = name.indexOf(NAME_SEPARATOR)
  if (idx === -1) return null
  if (idx !== name.lastIndexOf(NAME_SEPARATOR)) return null
  const away = name.slice(0, idx).trim()
  const home = name.slice(idx + NAME_SEPARATOR.length).trim()
  if (!away || !home) return null
  return { away, home }
}

const SHORT_SEPARATORS = [' @ ', ' VS ', ' vs ']

/** The same split as `splitEventName`, for the abbreviated `shortName`
 * field (`JAX @ NO`, or `FLA VS UGA` on a neutral site). Tried against each
 * known separator in turn; null when none matches exactly once. */
export function splitShortName(shortName: string): { away: string; home: string } | null {
  for (const sep of SHORT_SEPARATORS) {
    const idx = shortName.indexOf(sep)
    if (idx === -1) continue
    if (idx !== shortName.lastIndexOf(sep)) return null
    const away = shortName.slice(0, idx).trim()
    const home = shortName.slice(idx + sep.length).trim()
    if (!away || !home) return null
    return { away, home }
  }
  return null
}

/**
 * Parses one ESPN core-API event object (the body of following an event's
 * `$ref`) into a `Game`, for the team named by `espnId`. Returns null when
 * the event does not actually name `espnId` as either competitor — the same
 * trap-guard shape the previous TheSportsDB-based version of this file used
 * for its own measured id-aliasing trap, applied here in case a stale or
 * malformed ref ever pointed at the wrong event.
 */
export function parseEvent(body: unknown, espnId: string): Game | null {
  const obj = asObj(body)
  const id = strOf(obj, 'id')
  if (!id) return null

  const competitions = Array.isArray(obj.competitions) ? obj.competitions : []
  const comp = asObj(competitions[0])
  const competitors = Array.isArray(comp.competitors) ? comp.competitors : []

  let isHome: boolean | null = null
  for (const c of competitors) {
    if (strOf(c, 'id') === espnId) {
      isHome = strOf(c, 'homeAway') === 'home'
      break
    }
  }
  if (isHome === null) return null

  const nameSplit = splitEventName(strOf(obj, 'name'))
  const shortSplit = splitShortName(strOf(obj, 'shortName'))
  const opponent = nameSplit ? (isHome ? nameSplit.away : nameSplit.home) : ''
  const opponentShort = shortSplit ? (isHome ? shortSplit.away : shortSplit.home) : ''

  const timeValid = asObj(obj).timeValid
  return {
    id,
    opponent,
    opponentShort,
    isHome,
    kickoffEpochMs: parseKickoffEpochMs(strOf(obj, 'date')),
    // Conservative default: anything other than an explicit `true` (false,
    // missing, malformed) renders as TBD. Showing "TBA" when the time is
    // actually known is a smaller harm than showing a confident, possibly
    // wrong kickoff time (docs/LESSONS.md #18).
    timeTbd: timeValid !== true,
  }
}

/**
 * Parses the record endpoint's body (`.../types/2/teams/<id>/record`) into a
 * `TeamRecord`. Measured live 2026-08-14: `items` holds several named
 * records (`overall`, home/road/division splits, ...); this reads the
 * `overall` one, falling back to `items[0]` if that name is ever missing.
 * Its own `stats` array is a flat list of `{name, value}` pairs — `wins`,
 * `losses`, `ties` and `gamesPlayed` were all confirmed present, real
 * numbers (not strings), in the live probe. Returns null when the shape is
 * not recognizable at all — never a fabricated record.
 */
export function parseRecord(body: unknown): TeamRecord | null {
  const items = asObj(body).items
  if (!Array.isArray(items) || items.length === 0) return null
  const overall = items.find((it) => strOf(it, 'name') === 'overall') ?? items[0]
  const stats = asObj(overall).stats
  if (!Array.isArray(stats)) return null

  const byName = new Map<string, number>()
  for (const s of stats) {
    const name = strOf(s, 'name')
    const value = numOf(s, 'value')
    if (name && value !== null) byName.set(name, value)
  }

  const wins = byName.get('wins')
  const losses = byName.get('losses')
  const gamesPlayed = byName.get('gamesPlayed')
  if (wins === undefined || losses === undefined || gamesPlayed === undefined) return null

  return { wins, losses, ties: byName.get('ties') ?? 0, started: gamesPlayed > 0 }
}

/** Extracts the numeric event id from an event `$ref` URL
 * (`.../events/401873281?lang=en&region=us` -> `401873281`), used as the
 * merge key for a schedule refresh (see `refreshSchedule`) before the event
 * itself has even been fetched. Empty string when the shape is unexpected. */
function idFromRef(ref: string): string {
  const m = /\/events\/(\d+)(?:[/?]|$)/.exec(ref)
  return m?.[1] ?? ''
}

/** Extracts the ordered list of event `$ref` URLs from the events-list
 * endpoint's body. Empty array for any unrecognized shape. */
function extractRefs(body: unknown): string[] {
  const items = asObj(body).items
  if (!Array.isArray(items)) return []
  const refs: string[] = []
  for (const it of items) {
    const ref = strOf(it, '$ref')
    if (ref) refs.push(ref)
  }
  return refs
}

/** Runs `fn` over `items` with at most `limit` in flight at once. Order of
 * `results` matches `items`, regardless of completion order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i] as T)
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

/** Ascending by kickoff. A null (unknown) kickoff always sorts last — there
 * is no honest place to put an unknown date among known ones. */
function byKickoffAscending(a: Game, b: Game): number {
  const av = a.kickoffEpochMs ?? Number.POSITIVE_INFINITY
  const bv = b.kickoffEpochMs ?? Number.POSITIVE_INFINITY
  return av - bv
}

/**
 * The fraction of the composited logo's height given to the actual crest
 * art; the rest is filled with the exact key background colour, reserved
 * for the page's own record text. Measured 2026-08-14 (task 42 report):
 * drawing the raw Jaguars and Gators PNGs full-bleed onto a 96 px key and
 * scanning upward from the bottom row, the Jaguars crest's own ink reaches
 * to within 15 px of the bottom edge (the Gators crest, 20 px) — too thin
 * and too inconsistent between the two logos to trust for a legible record
 * line. 0.64 reserves roughly 35 px at key scale, more than double the
 * tighter of the two measured margins, on BOTH tiles alike regardless of
 * which way a future logo redesign shifts.
 */
export const LOGO_ART_FRACTION = 0.64
const LOGO_CANVAS_SIZE = 200

/**
 * Composites the raw fetched logo onto a canvas whose bottom
 * `1 - LOGO_ART_FRACTION` band is filled with the plain key background
 * colour, then re-decodes the result as an `Image` — the ONLY way to get an
 * image that occupies less than the full key with the renderer this project
 * ships (`render/canvas.ts`'s `drawCroppedImage` always draws to the full
 * 96x96 destination; this file may not change that, per the task brief's
 * file ownership). Runs once per team, off the render path, cached
 * alongside the decoded image itself (see `loadLogo`) — never per frame.
 */
export async function compositeLogo(
  raw: Image,
  loadImageFn: (b: Buffer) => Promise<Image> = loadImage,
): Promise<Image> {
  const canvas = createCanvas(LOGO_CANVAS_SIZE, LOGO_CANVAS_SIZE)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = `rgb(${theme.bg[0]}, ${theme.bg[1]}, ${theme.bg[2]})`
  ctx.fillRect(0, 0, LOGO_CANVAS_SIZE, LOGO_CANVAS_SIZE)

  const artW = LOGO_CANVAS_SIZE
  const artH = LOGO_CANVAS_SIZE * LOGO_ART_FRACTION
  const scale = Math.min(artW / raw.width, artH / raw.height)
  const w = raw.width * scale
  const h = raw.height * scale
  ctx.drawImage(raw, (artW - w) / 2, (artH - h) / 2, w, h)

  const buf = canvas.toBuffer('image/png')
  return loadImageFn(buf)
}

/**
 * Reads the Jacksonville Jaguars' and Florida Gators' full schedules and
 * season records from ESPN's open `sports.core.api.espn.com` host, plus
 * their ESPN CDN logos. Polls only while the page is visible, at 6 hours,
 * and never wipes known-good data on a failure — it reports `offline` and
 * keeps showing what it had.
 *
 * Per-event data (opponent, date, home/away, TBD) is merged by event id on
 * every refresh: a ref that fails to fetch this round keeps its PREVIOUS
 * value rather than dropping out of the schedule, so one flaky request does
 * not blank a game the page showed a moment ago.
 */
export class FootballSource extends EventEmitter {
  private schedules = new Map<Team, Game[]>()
  private records = new Map<Team, TeamRecord | null>()
  private status: FootballStatus = 'empty'
  private lastSuccessAt = 0
  private timer: NodeJS.Timeout | null = null
  private visible = false
  private stopped = false
  private inFlight: Promise<void> | null = null
  private lastKey = ''
  /** Per docs/LESSONS.md #10: a URL that has ever answered 403 is never
   * fetched again this process. */
  private blockedUrls = new Set<string>()

  private logoCache = new Map<Team, Image>()
  private logoPending = new Set<Team>()
  private logoRetryAt = new Map<Team, number>()

  constructor(
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly loadImageFn: (b: Buffer) => Promise<Image> = loadImage,
    private readonly compositeLogoFn: (raw: Image, loadImageFn: (b: Buffer) => Promise<Image>) => Promise<Image> = compositeLogo,
  ) {
    super()
  }

  /** Test helper. Swaps the fetch implementation mid-test. */
  setFetchForTest(f: FetchLike): void {
    this.fetchFn = f
  }

  /** The team's full known schedule, oldest game first, unknown-kickoff
   * games last. A deep-enough copy (every field is a primitive) — mutating
   * the result cannot corrupt this source's own cache. */
  getSchedule(team: Team): Game[] {
    return (this.schedules.get(team) ?? []).map((g) => ({ ...g }))
  }

  getRecord(team: Team): TeamRecord | null {
    const r = this.records.get(team)
    return r ? { ...r } : null
  }

  getStatus(): FootballStatus {
    return this.status
  }

  getLastUpdatedAt(): number {
    return this.lastSuccessAt
  }

  isStale(): boolean {
    if (this.lastSuccessAt === 0) return false
    return this.now() - this.lastSuccessAt > STALE_SECONDS
  }

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
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    if (!this.visible) return
    this.timer = setTimeout(() => {
      void this.refreshAndSchedule()
    }, POLL_MS)
  }

  /** Fetches and merges one team's full schedule. Returns `ok: false` (and
   * leaves the existing cache untouched) only when the events-LIST fetch
   * itself failed — an individual event ref failing keeps that one game's
   * previous value via `oldById`, rather than failing the whole team. */
  private async refreshSchedule(team: Team): Promise<{ ok: boolean; games: Game[] | null }> {
    const config = TEAM_CONFIG[team]
    const listUrl = eventsListUrl(config.league, config.espnId)
    const logKey = `football-events-${team}`
    if (this.blockedUrls.has(listUrl)) return { ok: false, games: null }

    let res
    try {
      res = await this.fetchFn(listUrl)
    } catch (e) {
      log.once(`${logKey}-network`, `Football events list for ${team} failed: ${String(e)}`)
      return { ok: false, games: null }
    }
    log.clearOnce(`${logKey}-network`)

    if (res.status === 403) {
      this.blockedUrls.add(listUrl)
      log.once(`${logKey}-403`, `Football events list for ${team} returned 403; will not retry this session.`)
      return { ok: false, games: null }
    }
    if (!res.ok) {
      log.once(`${logKey}-http`, `Football events list for ${team} failed with status ${res.status}.`)
      return { ok: false, games: null }
    }
    log.clearOnce(`${logKey}-http`)

    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      log.once(`${logKey}-json`, `Football events list for ${team} is not valid JSON: ${String(e)}`)
      return { ok: false, games: null }
    }
    log.clearOnce(`${logKey}-json`)

    const refs = extractRefs(body)
    const oldById = new Map((this.schedules.get(team) ?? []).map((g) => [g.id, g] as const))

    let anyEventFailed = false
    const fetched = await mapWithConcurrency(refs, EVENT_FETCH_CONCURRENCY, async (ref) => {
      const fallback = () => oldById.get(idFromRef(ref)) ?? null
      if (this.blockedUrls.has(ref)) return fallback()
      try {
        const r = await this.fetchFn(ref)
        if (r.status === 403) {
          this.blockedUrls.add(ref)
          anyEventFailed = true
          return fallback()
        }
        if (!r.ok) {
          anyEventFailed = true
          return fallback()
        }
        const b = await r.json()
        return parseEvent(b, config.espnId) ?? fallback()
      } catch {
        anyEventFailed = true
        return fallback()
      }
    })

    if (anyEventFailed) {
      log.once(`${logKey}-event`, `One or more ${team} event refs failed this refresh; kept prior values for those games.`)
    } else {
      log.clearOnce(`${logKey}-event`)
    }

    const games = fetched.filter((g): g is Game => g !== null).sort(byKickoffAscending)
    return { ok: true, games }
  }

  private async refreshRecord(team: Team): Promise<{ ok: boolean; record: TeamRecord | null }> {
    const config = TEAM_CONFIG[team]
    const url = recordUrl(config.league, config.espnId)
    const logKey = `football-record-${team}`
    if (this.blockedUrls.has(url)) return { ok: false, record: null }

    let res
    try {
      res = await this.fetchFn(url)
    } catch (e) {
      log.once(`${logKey}-network`, `Football record for ${team} failed: ${String(e)}`)
      return { ok: false, record: null }
    }
    log.clearOnce(`${logKey}-network`)

    if (res.status === 403) {
      this.blockedUrls.add(url)
      log.once(`${logKey}-403`, `Football record for ${team} returned 403; will not retry this session.`)
      return { ok: false, record: null }
    }
    if (!res.ok) {
      log.once(`${logKey}-http`, `Football record for ${team} failed with status ${res.status}.`)
      return { ok: false, record: null }
    }
    log.clearOnce(`${logKey}-http`)

    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      log.once(`${logKey}-json`, `Football record for ${team} is not valid JSON: ${String(e)}`)
      return { ok: false, record: null }
    }
    log.clearOnce(`${logKey}-json`)

    return { ok: true, record: parseRecord(body) }
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** Emits `change` only when the whole snapshot actually differs from the
   * last one (docs/LESSONS.md #7). */
  private async doRefresh(): Promise<void> {
    const [jagSchedule, gatSchedule, jagRecord, gatRecord] = await Promise.all([
      this.refreshSchedule('jaguars'),
      this.refreshSchedule('gators'),
      this.refreshRecord('jaguars'),
      this.refreshRecord('gators'),
    ])

    let anySuccess = false
    if (jagSchedule.ok) {
      this.schedules.set('jaguars', jagSchedule.games ?? [])
      anySuccess = true
    }
    if (gatSchedule.ok) {
      this.schedules.set('gators', gatSchedule.games ?? [])
      anySuccess = true
    }
    if (jagRecord.ok) {
      this.records.set('jaguars', jagRecord.record)
      anySuccess = true
    }
    if (gatRecord.ok) {
      this.records.set('gators', gatRecord.record)
      anySuccess = true
    }

    const hasAnyData = this.schedules.size > 0 || this.records.size > 0
    this.status = anySuccess ? 'ok' : hasAnyData ? 'offline' : 'empty'
    if (anySuccess) this.lastSuccessAt = this.now()

    const key = JSON.stringify({
      schedules: [...this.schedules.entries()],
      records: [...this.records.entries()],
      status: this.status,
    })
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit('change')
  }

  /**
   * Returns the cached, decoded-and-composited logo for `team`, or null.
   * Mirrors `SpotifySource.getArt`: decodes off the render path, caches the
   * result, and starts exactly one load per miss (guarded by `logoPending`).
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
      const raw = await this.loadImageFn(bytes)
      let composited: Image
      try {
        composited = await this.compositeLogoFn(raw, this.loadImageFn)
      } catch (e) {
        // A composite failure still leaves a usable (if uncropped) logo —
        // better than showing nothing.
        log.once(`football-logo-composite-${team}`, `Logo composite for ${team} failed: ${String(e)}`)
        composited = raw
      }
      this.logoCache.set(team, composited)
      this.emit('change')
      ok = true
    } catch (e) {
      log.once(`football-logo-failed-${team}`, `Logo decode for ${team} failed: ${String(e)}`)
    } finally {
      this.logoPending.delete(team)
      if (ok) {
        this.logoRetryAt.delete(team)
      } else {
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
