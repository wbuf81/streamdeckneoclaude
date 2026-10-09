import { EventEmitter } from 'node:events'
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
import { log } from '../log.js'
import type { League, TeamConfig, TeamPair } from '../config.js'
import { theme } from '../render/theme.js'
import { dominantColor } from '../render/canvas.js'
import type { Rgb } from '../render/specs.js'
import {
  applyLiveFailure,
  applyLiveReading,
  parseLiveRefs,
  parsePlay,
  parseScore,
  parseSituation,
  parseStatus,
  toLiveGame,
  type LiveEntry,
  type LiveGame,
  type LiveRefs,
  type LiveSituation,
  type PlaySnapshot,
} from './football-live.js'

export type { LiveGame, LiveState, ScoreKind, ScoringEvent, Side } from './football-live.js'

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

/**
 * A configured team's id, taken from `config.json`.
 *
 * This was a `'jaguars' | 'gators'` union while the two teams were compiled
 * in. The teams are configuration now, so an id is an opaque string and the
 * source carries each team's own `TeamConfig`. Nothing downstream ever
 * enumerated the union — the page asks the source which two teams exist, in
 * row order — so widening it costs no type safety that was being used.
 */
export type Team = string

export type { League, TeamConfig, TeamPair } from '../config.js'

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

/** One event's own body, which links its live status, situation and scores. */
function eventUrl(league: League, gameId: string): string {
  return `${CORE_BASE}/${league}/events/${gameId}?lang=en&region=us`
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
  /**
   * How this game ended for THIS team, or null.
   *
   * Read from `competitors[].winner`, which ESPN sends INLINE on every event —
   * measured 2026-08-18. The scores and the game clock are `$ref` links needing
   * their own fetches, but the result costs nothing, and this parser used to
   * throw it away.
   *
   * `null` covers two different things the inline flags cannot tell apart: a game
   * not yet played, and a genuine TIE (where neither competitor is the winner).
   * Rendering a tie as "no result" is the honest reading — the season tie count
   * is still available on `TeamRecord` — and it is never rendered as a loss.
   */
  result: GameResult
}

/** How a game ended for the team being asked about. See `Game.result`. */
export type GameResult = 'win' | 'loss' | null

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
  // `winner` is a real boolean on each competitor when the game is decided, and
  // false on both while it is not. Reading BOTH sides is what distinguishes a
  // loss from an undecided game: my side false alone means nothing.
  let mineWon = false
  let opponentWon = false
  for (const c of competitors) {
    const isMine = strOf(c, 'id') === espnId
    const won = asObj(c).winner === true
    if (isMine) {
      isHome = strOf(c, 'homeAway') === 'home'
      mineWon = won
    } else if (won) {
      opponentWon = true
    }
  }
  if (isHome === null) return null

  // Neither flag set means undecided or a tie. Both cases render as no result
  // rather than as a guess (see `Game.result`).
  const result: GameResult = mineWon ? 'win' : opponentWon ? 'loss' : null

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
    result,
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
 * Live poll cadence. These are the only intervals the live loop uses.
 *
 * - `LIVE_POLL_MS` applies ONLY while the latest read of a game succeeded and
 *   said `in`. Any other state — not yet read, a failed read, `pre` — uses
 *   `WINDOW_POLL_MS`. An unknown state never polls fast.
 * - The window opens `LIVE_LEAD_MS` before a KNOWN kickoff and closes
 *   `LIVE_TAIL_MS` after it, or as soon as a read says `post`. A TBD kickoff
 *   opens no window: an unknown time is not a reason to poll.
 * - Outside every window the live loop makes no request at all. It sleeps
 *   until the next window opens, at most `POLL_MS` ahead.
 *
 * A live read costs up to five requests (status, two scores, situation, last
 * play) and the last play is fetched only when its ref changes. A `pre` read
 * costs one.
 */
export const LIVE_POLL_MS = 20_000
export const WINDOW_POLL_MS = 120_000
export const LIVE_LEAD_MS = 15 * 60 * 1000
/** Long enough for overtime and a weather delay. */
export const LIVE_TAIL_MS = 6 * 60 * 60 * 1000

/**
 * The game whose live window contains `nowMs`, or null. `finishedIds` are
 * games already read as `post`; they close their window early.
 */
export function liveWindowGame(schedule: readonly Game[], nowMs: number, finishedIds: ReadonlySet<string> = new Set()): Game | null {
  for (const g of schedule) {
    if (g.timeTbd || g.kickoffEpochMs === null) continue
    if (finishedIds.has(g.id)) continue
    if (nowMs >= g.kickoffEpochMs - LIVE_LEAD_MS && nowMs <= g.kickoffEpochMs + LIVE_TAIL_MS) return g
  }
  return null
}

/** When the next live window opens after `nowMs`, or null when no known
 * kickoff lies ahead. */
function nextWindowStartMs(schedule: readonly Game[], nowMs: number): number | null {
  let best: number | null = null
  for (const g of schedule) {
    if (g.timeTbd || g.kickoffEpochMs === null) continue
    const start = g.kickoffEpochMs - LIVE_LEAD_MS
    if (start > nowMs && (best === null || start < best)) best = start
  }
  return best
}

/** The next game to kick off, for a countdown. See `nextKickoff`. */
export interface NextKickoff extends Game {
  kickoffEpochMs: number
}

/**
 * The first game whose kickoff is after `nowMs`, or null. Pure.
 *
 * A game with `timeTbd: true` is returned too, because its DATE is real. A
 * page must not count down to its time of day: ESPN's placeholder time is not
 * a kickoff (see `Game.timeTbd`).
 */
export function nextKickoff(schedule: readonly Game[], nowMs: number): NextKickoff | null {
  let best: Game | null = null
  for (const g of schedule) {
    if (g.kickoffEpochMs === null || g.kickoffEpochMs <= nowMs) continue
    if (best === null || g.kickoffEpochMs < (best.kickoffEpochMs ?? Infinity)) best = g
  }
  return best ? { ...best, kickoffEpochMs: best.kickoffEpochMs as number } : null
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
 * Reads two configured teams' full schedules and season records from ESPN's
 * open `sports.core.api.espn.com` host, plus their ESPN CDN logos. Which two
 * teams is configuration (`football` in `config.json`); this source never
 * names one. Polls only while the page is visible, at 6 hours,
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

  /** The live state of each team's current game. See `getLive`. */
  private live = new Map<Team, LiveEntry>()
  /** Live links per game id, read once from the event body. */
  private liveRefs = new Map<string, LiveRefs>()
  /** The last play per game, keyed by its ref, so an unchanged ref costs no request. */
  private lastPlays = new Map<string, { url: string; play: PlaySnapshot }>()
  private liveTimer: NodeJS.Timeout | null = null
  private liveInFlight: Promise<void> | null = null
  private liveKey = ''

  private logoCache = new Map<Team, Image>()
  /** One accent colour per team, taken from the RAW crest. A `null` VALUE means
   * the crest has no usable accent; an absent key means the logo has not loaded
   * yet. */
  private teamColors = new Map<Team, Rgb | null>()
  private logoPending = new Set<Team>()
  private logoRetryAt = new Map<Team, number>()

  /** Each configured team, by id. */
  private readonly teamConfigs: ReadonlyMap<Team, TeamConfig>
  /** The two team ids in ROW order: top row first, bottom row second. The
   * page draws them in this order, so it is part of the configuration and
   * not an incidental map iteration order. */
  private readonly teamOrder: readonly [Team, Team]

  constructor(
    teams: TeamPair,
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly loadImageFn: (b: Buffer) => Promise<Image> = loadImage,
    private readonly compositeLogoFn: (raw: Image, loadImageFn: (b: Buffer) => Promise<Image>) => Promise<Image> = compositeLogo,
  ) {
    super()
    this.teamConfigs = new Map(teams.map((t) => [t.id, t]))
    this.teamOrder = [teams[0].id, teams[1].id]
  }

  /** The configured teams, in row order. The page reads this instead of
   * naming teams itself. */
  getTeams(): readonly [Team, Team] {
    return this.teamOrder
  }

  /** The team's key label, for example `GATORS`. Empty for an unknown id,
   * which cannot happen through `getTeams` but can through a stale press. */
  getLabel(team: Team): string {
    return this.teamConfigs.get(team)?.label ?? ''
  }

  /** The team's short code for the schedule tape, for example `UF`. */
  getShort(team: Team): string {
    return this.teamConfigs.get(team)?.short ?? ''
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

  /**
   * The live state of the team's current game, or null when no game is in its
   * window (15 min before a known kickoff to 6 h after it) or none has been
   * read yet. A copy: mutating it cannot change this source.
   */
  getLive(team: Team): LiveGame | null {
    const entry = this.live.get(team)
    if (!entry) return null
    const nowMs = this.now() * 1000
    if (nowMs > entry.kickoffEpochMs + LIVE_TAIL_MS) return null
    return toLiveGame(entry, nowMs)
  }

  /** The team's next kickoff after `nowMs`. A pure read of the cached
   * schedule; it never fetches. See `nextKickoff`. */
  getNextKickoff(team: Team, nowMs: number): NextKickoff | null {
    return nextKickoff(this.schedules.get(team) ?? [], nowMs)
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
    } else {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      if (this.liveTimer) clearTimeout(this.liveTimer)
      this.liveTimer = null
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
    // The schedule decides which games have a live window, so the live loop
    // runs after every schedule refresh. It makes no request outside a window.
    await this.pollLiveAndSchedule()
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
    const config = this.teamConfigs.get(team)
    if (!config) return { ok: false, games: null }
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
    const config = this.teamConfigs.get(team)
    if (!config) return { ok: false, record: null }
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
    const [first, second] = this.teamOrder
    const [firstSchedule, secondSchedule, firstRecord, secondRecord] = await Promise.all([
      this.refreshSchedule(first),
      this.refreshSchedule(second),
      this.refreshRecord(first),
      this.refreshRecord(second),
    ])

    let anySuccess = false
    for (const [team, result] of [[first, firstSchedule], [second, secondSchedule]] as const) {
      if (!result.ok) continue
      this.schedules.set(team, result.games ?? [])
      anySuccess = true
    }
    for (const [team, result] of [[first, firstRecord], [second, secondRecord]] as const) {
      if (!result.ok) continue
      this.records.set(team, result.record)
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
  /**
   * The team's accent colour, taken from its crest, or null when the crest has
   * none or has not loaded. Never triggers work — the colour is computed once,
   * when the logo is decoded.
   */
  getTeamColor(team: Team): Rgb | null {
    return this.teamColors.get(team) ?? null
  }

  getLogo(team: Team): Image | null {
    const cached = this.logoCache.get(team)
    if (cached) return cached
    if (this.logoPending.has(team)) return null
    const url = this.teamConfigs.get(team)?.logoUrl
    if (!url) return null
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
      // The team's accent colour, from the RAW crest — never the composited one,
      // whose reserved bottom band is a flat fill of `theme.bg` and would only
      // dilute the count. Extracted ONCE here, off the render path, exactly as
      // the Spotify source extracts an album's colour.
      try {
        this.teamColors.set(team, dominantColor(raw))
      } catch (e) {
        this.teamColors.set(team, null)
        log.once(`football-logo-color-${team}`, `Team colour extraction for ${team} failed: ${String(e)}`)
      }
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
    if (this.liveTimer) clearTimeout(this.liveTimer)
    this.liveTimer = null
  }

  // -------------------------------------------------------------------------
  // Live games
  // -------------------------------------------------------------------------

  /** Games already read as `post`. Their window closes early. */
  private finishedIds(): Set<string> {
    const ids = new Set<string>()
    for (const e of this.live.values()) if (e.state === 'post') ids.add(e.gameId)
    return ids
  }

  /** The delay before the next live read, or null for none. See `LIVE_POLL_MS`. */
  private liveDelayMs(nowMs: number): number | null {
    const finished = this.finishedIds()
    const delays: number[] = []
    for (const team of this.teamOrder) {
      const schedule = this.schedules.get(team) ?? []
      const game = liveWindowGame(schedule, nowMs, finished)
      if (game) {
        const entry = this.live.get(team)
        const confirmedLive = entry?.gameId === game.id && entry.state === 'in' && !entry.readFailed
        delays.push(confirmedLive ? LIVE_POLL_MS : WINDOW_POLL_MS)
        continue
      }
      const start = nextWindowStartMs(schedule, nowMs)
      if (start !== null) delays.push(Math.min(start - nowMs, POLL_MS))
    }
    return delays.length === 0 ? null : Math.min(...delays)
  }

  private scheduleLive(): void {
    if (this.stopped) return
    if (this.liveTimer) clearTimeout(this.liveTimer)
    this.liveTimer = null
    if (!this.visible) return
    const delay = this.liveDelayMs(this.now() * 1000)
    if (delay === null) return
    this.liveTimer = setTimeout(() => {
      void this.pollLiveAndSchedule()
    }, Math.max(0, delay))
  }

  private async pollLiveAndSchedule(): Promise<void> {
    try {
      await this.pollLive()
    } catch (e) {
      log.once('football-live-unexpected', `football live read failed unexpectedly: ${String(e)}`)
    } finally {
      this.scheduleLive()
    }
  }

  /** Reads every team whose game is in its live window. Never throws for a
   * network or schema failure: the old data stays and is marked stale. */
  async pollLive(): Promise<void> {
    if (this.liveInFlight) return this.liveInFlight
    this.liveInFlight = this.doPollLive().finally(() => {
      this.liveInFlight = null
    })
    return this.liveInFlight
  }

  private async doPollLive(): Promise<void> {
    const nowMs = this.now() * 1000
    const finished = this.finishedIds()
    const work: Promise<void>[] = []
    for (const team of this.teamOrder) {
      const game = liveWindowGame(this.schedules.get(team) ?? [], nowMs, finished)
      if (game) work.push(this.pollLiveTeam(team, game))
    }
    if (work.length === 0) return
    await Promise.all(work)

    // The whole snapshot, so any field change re-renders (docs/LESSONS.md #7).
    const key = JSON.stringify([...this.live.entries()])
    if (key === this.liveKey) return
    this.liveKey = key
    this.emit('change')
  }

  /**
   * Fetches one JSON body for the live loop. Null on any failure, logged once
   * per key and cleared on the next success. A 403 is never retried
   * (docs/LESSONS.md #10).
   */
  private async fetchLiveJson(url: string, logKey: string, what: string): Promise<unknown> {
    if (this.blockedUrls.has(url)) return null
    let res
    try {
      res = await this.fetchFn(url)
    } catch (e) {
      log.once(logKey, `Football live ${what} failed: ${String(e)}`)
      return null
    }
    if (res.status === 403) {
      this.blockedUrls.add(url)
      log.once(`${logKey}-403`, `Football live ${what} returned 403; will not retry this session.`)
      return null
    }
    if (!res.ok) {
      log.once(logKey, `Football live ${what} failed with status ${res.status}.`)
      return null
    }
    try {
      const body: unknown = await res.json()
      log.clearOnce(logKey)
      return body ?? null
    } catch (e) {
      log.once(logKey, `Football live ${what} is not valid JSON: ${String(e)}`)
      return null
    }
  }

  /** Keeps the last known values and marks them stale. */
  private markLiveFailure(team: Team, game: Game, reason: string): void {
    const prev = this.live.get(team)
    if (prev && prev.gameId === game.id) this.live.set(team, applyLiveFailure(prev))
    // Logged on the transition into failure; cleared by the next good read,
    // which logs the recovery.
    log.once(`football-live-${team}-failed`, `Football live data for ${team} is unavailable (${reason}); showing the last known values as stale.`)
  }

  private async pollLiveTeam(team: Team, game: Game): Promise<void> {
    const config = this.teamConfigs.get(team)
    if (!config || game.kickoffEpochMs === null) return
    const keyBase = `football-live-${team}`

    let refs = this.liveRefs.get(game.id)
    if (!refs) {
      const body = await this.fetchLiveJson(eventUrl(config.league, game.id), `${keyBase}-event`, `event for ${team}`)
      const parsed = body === null ? null : parseLiveRefs(body, config.espnId)
      if (!parsed) {
        if (body !== null) log.once(`${keyBase}-event-schema`, `Football live event for ${team} has no usable status or score links.`)
        this.markLiveFailure(team, game, 'event links')
        return
      }
      log.clearOnce(`${keyBase}-event-schema`)
      refs = parsed
      this.liveRefs.set(game.id, refs)
    }

    const statusBody = await this.fetchLiveJson(refs.statusUrl, `${keyBase}-status`, `status for ${team}`)
    const status = statusBody === null ? null : parseStatus(statusBody)
    if (!status) {
      if (statusBody !== null) log.once(`${keyBase}-status-schema`, `Football live status for ${team} has no known state.`)
      this.markLiveFailure(team, game, 'status')
      return
    }
    log.clearOnce(`${keyBase}-status-schema`)

    let myScore: number | null = null
    let opponentScore: number | null = null
    let situation: LiveSituation | null = null
    let play: PlaySnapshot | null = null
    if (status.state !== 'pre') {
      const [mine, theirs] = await Promise.all([
        this.fetchLiveJson(refs.myScoreUrl, `${keyBase}-score`, `score for ${team}`),
        this.fetchLiveJson(refs.opponentScoreUrl, `${keyBase}-opponent-score`, `opponent score for ${team}`),
      ])
      myScore = mine === null ? null : parseScore(mine)
      opponentScore = theirs === null ? null : parseScore(theirs)
      // The score is what the live row exists to show. A read without both
      // scores is a failed read, never a read with zeros.
      if (myScore === null || opponentScore === null) {
        if (mine !== null && theirs !== null) log.once(`${keyBase}-score-schema`, `Football live score for ${team} has no readable value.`)
        this.markLiveFailure(team, game, 'score')
        return
      }
      log.clearOnce(`${keyBase}-score-schema`)
    }

    if (status.state === 'in' && refs.situationUrl) {
      // Down, possession and last play are extras. Their failure makes them
      // unknown and leaves the score row working.
      const body = await this.fetchLiveJson(refs.situationUrl, `${keyBase}-situation`, `situation for ${team}`)
      situation = body === null ? null : parseSituation(body)
      const playUrl = situation?.lastPlayUrl ?? null
      if (playUrl) {
        const cached = this.lastPlays.get(game.id)
        if (cached && cached.url === playUrl) {
          play = cached.play
        } else {
          const pb = await this.fetchLiveJson(playUrl, `${keyBase}-play`, `last play for ${team}`)
          play = pb === null ? null : parsePlay(pb)
          if (play) this.lastPlays.set(game.id, { url: playUrl, play })
        }
      }
    }

    const prev = this.live.get(team) ?? null
    const next = applyLiveReading(prev, {
      gameId: game.id,
      kickoffEpochMs: game.kickoffEpochMs,
      myEspnId: config.espnId,
      opponentEspnId: refs.opponentEspnId,
      status,
      myScore,
      opponentScore,
      situation,
      play,
    }, this.now() * 1000)
    this.live.set(team, next)

    const samePrev = prev && prev.gameId === game.id ? prev : null
    if (samePrev?.readFailed) log.info(`Football live data for ${team} recovered.`)
    log.clearOnce(`football-live-${team}-failed`)
    const prevState = samePrev?.state ?? null
    if (prevState !== next.state) {
      const word = next.state === 'in' ? 'live' : next.state === 'post' ? 'over' : 'scheduled'
      log.info(`Football ${team} game ${game.id} is ${word}.`)
      // A game that ends while watched changes its result and the record.
      // Refresh them now rather than up to six hours later. `post` is
      // reached once per game, so this runs once per game.
      if (next.state === 'post' && prevState !== null) {
        this.refresh().catch((e: unknown) => log.once('football-refresh-unexpected', `football refresh failed unexpectedly: ${String(e)}`))
      }
    }
  }
}
