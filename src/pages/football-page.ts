import type { Image } from '@napi-rs/canvas'
import type { DeckFrame, KeySpec, OneShotSpec, Rgb, StripSpec, TapeSegment } from '../render/specs.js'
import { theme, blend } from '../render/theme.js'
import { truncate, formatEasternTime } from '../render/text.js'
import type { Page, PressOutcome } from './types.js'
import type {
  FootballStatus,
  Game,
  GameResult,
  LiveGame,
  NextKickoff,
  ScoringEvent,
  Team,
  TeamRecord,
} from '../sources/football.js'
import { LOGO_ART_FRACTION } from '../sources/football.js'
import { tapeOffsetPx } from '../render/canvas.js'

/** Measured limit for one strip line. See `render/canvas.ts`. */
const STRIP_CHARS = 30
/** Fixed size for a short, always-safe header line (home/away plus a short
 * opponent code, e.g. `@ NO`, `vs GA`). Matches `weather-page.ts`'s own
 * `DAY_LABEL_SIZE` precedent for a short label that never needs measuring. */
const HEADER_SIZE = 12
/** Candidate sizes for the opponent's full name. Measured (`@napi-rs/canvas`,
 * Menlo, docs/VERIFIED-FACTS.md's advance table): a 12-character name like
 * `JACKSONVILLE` clears 81 px only at 11 px (79.4 px) or smaller; `TEXAS A&M`
 * and `South Carolina` both need the renderer's own measure-and-shrink path
 * too. The renderer picks the size that actually fits, per
 * docs/LESSONS.md #17 — this page never reasons about the width itself. */
const OPPONENT_SIZES = [13, 11]
/** Fixed size for the short date line (`AUG 15`) — always exactly 6
 * characters, measured 47.0 px at 13 px, well inside the 81 px budget. */
const DATE_SIZE = 13
/** Candidate sizes for the kickoff time line. `12:00 PM EDT` (the widest
 * realistic reading) is 79.5 px at 11 px but 93.9 px at 13 px — over budget
 * — so 11 px is what the renderer actually picks every time; still declared
 * as a candidate array, not assumed, per docs/LESSONS.md #17. */
const TIME_SIZES = [13, 11]
/** Candidate sizes for the season record line (`8-3`, `12-1-1`). Even the
 * widest realistic case, a six-character record with a tie (`16-0-1`,
 * college football's longest possible regular season), is 72.2 px at 20 px
 * — inside the 81 px budget with room to spare. */
const RECORD_SIZES = [20, 16, 13]
const BACK_SIZE = 16

/**
 * The logo tile's record line sits inside the plain background band
 * `compositeLogo` (in `sources/football.ts`) reserves at the bottom of the
 * image — this page never draws its own background box (it cannot; it owns
 * no canvas code), so the two files share this one fraction. `RECORD_Y` is
 * the top edge of the text, chosen to sit roughly centred within that band:
 * band starts at `96 * LOGO_ART_FRACTION` (~61 px) and runs to 96, so 70
 * leaves comfortable clearance above and below a 20 px line.
 */
const RECORD_BAND_TOP = Math.round(96 * LOGO_ART_FRACTION)
const RECORD_Y = RECORD_BAND_TOP + 8

/* Team labels and short codes used to live here as a `Record<Team, string>`
 * keyed by the two compiled-in teams. They are configuration now, so the page
 * asks the source for them (`getLabel`, `getShort`) instead of holding a map
 * it could not populate for a team it has never heard of. */

/** How many upcoming games each grid tile group shows. */
const NEXT_COUNT = 3
/** How many games the full-schedule drill-down shows at once (keys 0-6;
 * key 7 is BACK). Chosen — see `scheduleWindow` — over round-button paging:
 * this project leaves the round buttons unbound on every existing page
 * (`claude-page.ts`'s own note: "always ignored — nothing is bound to
 * them"), and the closest precedent for "more items than tiles"
 * (`claude-page.ts`/`codex-page.ts`'s own session/task overflow) is a
 * relevant WINDOW plus a "+N more" count, not pagination controls. */
const SCHEDULE_WINDOW = 7

interface Selection {
  team: Team
}

/** `AUG 15`, in US Eastern time — derived from the SAME epoch `formatKickoff`
 * reads, never from a raw UTC calendar string. `--` when the kickoff instant
 * itself is unknown. */
export function formatShortDate(kickoffEpochMs: number | null): string {
  if (kickoffEpochMs === null) return '--'
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: '2-digit',
    })
      .format(new Date(kickoffEpochMs))
      .toUpperCase()
  } catch {
    return '--'
  }
}

/** `SAT`, the Eastern weekday. `''` when the kickoff is unknown. */
function shortWeekday(kickoffEpochMs: number | null): string {
  if (kickoffEpochMs === null) return ''
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
      .format(new Date(kickoffEpochMs))
      .toUpperCase()
  } catch {
    return ''
  }
}

/**
 * `4:00 PM EDT`, through the ONE shared time formatter. `TBA` — never a
 * fabricated time — when the kickoff instant itself is unknown, OR when
 * `game.timeTbd` is true: ESPN's own `timeValid` flag, measured live to be
 * `false` on real, still-scheduled games well before the two-week mark, not
 * only on placeholder far-future rows (docs/VERIFIED-FACTS.md). The DATE
 * line still shows the scheduled week; only the exact clock time is
 * withheld here.
 */
export function formatKickoff(game: Pick<Game, 'kickoffEpochMs' | 'timeTbd'>): string {
  if (game.kickoffEpochMs === null || game.timeTbd) return 'TBA'
  return formatEasternTime(game.kickoffEpochMs)
}

/** `8-3`, `12-1-1` (a tie only appears when there is one). `--` for an
 * explicit unknown record — never a fabricated `0-0` for a season that has
 * not started (docs/LESSONS.md #18). */
export function formatRecord(record: TeamRecord | null): string {
  if (!record || !record.started) return '--'
  return record.ties > 0 ? `${record.wins}-${record.losses}-${record.ties}` : `${record.wins}-${record.losses}`
}

/** `@ NO`, `vs GA`. Falls back to just `@`/`vs` (still correct and still
 * informative about home/away) when `opponentShort` could not be extracted. */
function homeAwayHeader(game: Pick<Game, 'isHome' | 'opponentShort'>): string {
  const prefix = game.isHome ? 'vs' : '@'
  return game.opponentShort ? `${prefix} ${game.opponentShort}` : prefix
}

/**
 * The games with a KNOWN future kickoff, ascending — `schedule` is already sorted
 * ascending by the source's own contract.
 *
 * A game stays for `WARMTH_GAME_WINDOW_MS` AFTER its kickoff, so a game in
 * progress remains on the grid. Without that window it vanished the instant
 * kickoff passed — leaving dashed placeholders at exactly the moment the game was
 * the most interesting thing on the deck, and making `kickoffWarmth`'s
 * post-kickoff branch unreachable from the grid. Found by rendering the
 * kickoff-passed case and looking at it.
 *
 * A TBD kickoff (`kickoffEpochMs === null`) is excluded. The previous version of
 * this comment claimed "or unknown-but-not-past", which the filter below has
 * never done — that describes `scheduleWindow`, which DOES include nulls because
 * a drill-down showing the whole season should not hide a game just because its
 * time is unannounced. The grid's next-three tiles and the strip's tape both read
 * this function, so they agree with each other; only the drill-down differs, and
 * deliberately.
 */
function upcoming(schedule: Game[], nowMs: number): Game[] {
  return schedule.filter(
    (g) => g.kickoffEpochMs !== null && g.kickoffEpochMs >= nowMs - WARMTH_GAME_WINDOW_MS,
  )
}

/**
 * The "most relevant window" of up to `SCHEDULE_WINDOW` games for the full-
 * schedule drill-down: as many of the NEXT games as fit, backfilled with the
 * most recent past games once fewer than a full window of upcoming games
 * remain (late in a season). `schedule` must already be sorted ascending.
 */
export function scheduleWindow(schedule: Game[], nowMs: number, size: number = SCHEDULE_WINDOW): Game[] {
  if (schedule.length <= size) return schedule.slice()
  let idx = schedule.findIndex((g) => g.kickoffEpochMs === null || g.kickoffEpochMs >= nowMs)
  if (idx === -1) idx = schedule.length
  const start = Math.max(0, Math.min(idx, schedule.length - size))
  return schedule.slice(start, start + size)
}

/** The part of `FootballSource` this page needs. */
/**
 * How far above or below .500 a record has to be before its wash is at full
 * strength. A 6-0 start and a 12-0 season should both read as "emphatically
 * winning" rather than the second looking twice as green.
 */
const RECORD_SATURATION_GAMES = 4
/** The most of the trend colour a record wash may blend in. Kept low for the
 * same reason the weather tints and the stocks wash are: the tile's white record
 * text has to stay crisp on top of it. */
const RECORD_MAX_BLEND = 0.3

/**
 * How long before kickoff a tile starts to warm, and how long after kickoff it
 * stays hot.
 *
 * The tail matters: a game that has just started must not go instantly cold, or
 * the tile would look like the least interesting one on the deck at exactly the
 * moment it is the most interesting. A game-length window keeps it hot.
 */
const WARMTH_LEAD_MS = 7 * 24 * 60 * 60 * 1000
const WARMTH_GAME_WINDOW_MS = 4 * 60 * 60 * 1000
/** The most of the team colour a countdown wash may blend in. */
const WARMTH_MAX_BLEND = 0.34

/** How many games the strip's ticker tape lists, across both teams combined.
 * Bounded so the loop stays short enough to actually watch. */
const TAPE_GAME_COUNT = 6
/** How fast the schedule tape crawls, in pixels per second, and how often the
 * page renders while it does. Matches the stocks ticker, which was tuned against
 * a rendered preview: 60 px per second at a 40 ms tick is 2.4 px per frame. */
const TAPE_PX_PER_SEC = 60
const TAPE_TICK_MS = 40

/**
 * The record tile's wash: green above .500, red below, nothing at .500 or for an
 * unknown record.
 *
 * An absent record draws NO wash rather than a neutral-looking one — the tile
 * already shows `--` for the text, and a coloured background would suggest a
 * reading that does not exist.
 */
export function recordWash(record: TeamRecord | null): Rgb | undefined {
  if (!record) return undefined
  const margin = record.wins - record.losses
  if (margin === 0) return undefined
  const magnitude = Math.min(1, Math.abs(margin) / RECORD_SATURATION_GAMES)
  const target = margin > 0 ? theme.green : theme.red
  return blend(theme.bg, target, magnitude * RECORD_MAX_BLEND)
}

/**
 * How hot an upcoming game's tile is, 0 to 1.
 *
 * Ramps from nothing a week out to full at kickoff, then HOLDS full through a
 * game-length window before dropping away. A TBD kickoff yields 0: an unknown
 * time is not a countdown, and warming a tile for a game that might be days away
 * would be inventing information (lesson 18).
 */
export function kickoffWarmth(kickoffEpochMs: number | null, nowMs: number): number {
  if (kickoffEpochMs === null || !Number.isFinite(kickoffEpochMs)) return 0
  if (!Number.isFinite(nowMs)) return 0
  const untilKickoff = kickoffEpochMs - nowMs
  // After kickoff: hot for the length of a game, then cold.
  if (untilKickoff <= 0) {
    return -untilKickoff <= WARMTH_GAME_WINDOW_MS ? 1 : 0
  }
  if (untilKickoff >= WARMTH_LEAD_MS) return 0
  return 1 - untilKickoff / WARMTH_LEAD_MS
}

/** The countdown wash for one upcoming tile, or undefined when it is cold. */
export function warmthWash(warmth: number, accent: Rgb): Rgb | undefined {
  if (warmth <= 0) return undefined
  return blend(theme.bg, accent, warmth * WARMTH_MAX_BLEND)
}

/**
 * The wash for a game whose result is known: green for a win, red for a loss.
 *
 * `null` — not played, or a tie the inline flags cannot distinguish — gets no
 * wash, so an undecided game never looks like a lost one.
 */
export function resultWash(result: GameResult): Rgb | undefined {
  if (result === null) return undefined
  return blend(theme.bg, result === 'win' ? theme.green : theme.red, RECORD_MAX_BLEND)
}

/* ------------------------------------------------------------ live game */

/** The placeholder for an unknown live value. Never `0`: an unknown score
 * drawn as 0 reads as a real score (docs/LESSONS.md #18). */
export const UNKNOWN = '—'

/** How long before a known kickoff a `pre` game takes over its row. */
export const SCOREBOARD_LEAD_MS = 15 * 60 * 1000

/** How long the row flood, the confetti and the button flash run. */
export const CELEBRATE_MS = 2000
/** How long the touchdown flood holds the row's tint. */
const FLOOD_MS = 1600
/** How long the strip banner stays after a score of mine. */
export const BANNER_MS = 6000
/** How long the strip note stays after a score that is not celebrated. */
export const NOTE_MS = 30_000
/**
 * A scoring event older than this, by the source's own clock, is recorded
 * but never celebrated. It covers the case where the source saw the score
 * while this page was not rendering (hidden, or in the drill-down): a
 * touchdown from five minutes ago must not erupt when the page comes back.
 */
export const CELEBRATE_FRESH_MS = 60_000
/** The cascade step between the four keys of a sweep, from the render API. */
const SWEEP_STAGGER_MS = 90
/** The button flash alternates at this period. Five changes a second costs
 * two cheap button writes each, and reads as a flash, not a flicker. */
const BUTTON_FLASH_MS = 200

/** The field bar's top edge and height. They match the renderer's own `bar`
 * band (y 66, 8 px), which draws the field when the ball's spot is unknown,
 * so the field sits in the same place with or without a ball. */
const FIELD_Y = 66
const FIELD_H = 8
const FIELD_EMPTY: Rgb = [42, 46, 56]

const SCORE_SIZES = [40, 32, 26]
const PERIOD_SIZES = [20, 16]
const COUNTDOWN_SIZES = [22, 18, 14]

/** The kinds of score this page celebrates, and how. */
export type CelebrationKind = 'touchdown' | 'field-goal' | 'note'

/** One score this page has reacted to, and when it first saw it. */
export interface Celebration {
  kind: CelebrationKind
  event: ScoringEvent
  /** The page's own render clock when the event was first seen. */
  startedAtMs: number
  /** The last play when the event was first seen, for the banner's sub line. */
  lastPlay: string | null
}

/** A score, or the unknown placeholder. */
export function formatScore(score: number | null): string {
  return score === null || !Number.isFinite(score) ? UNKNOWN : String(score)
}

/**
 * `Q3`, `OT`, `2OT`, or `HALF` at halftime. Unknown when the period is.
 * Halftime is read from ESPN's own detail text, which says `Halftime`.
 */
export function formatPeriod(live: Pick<LiveGame, 'period' | 'detail'>): string {
  if (/half/i.test(live.detail)) return 'HALF'
  const p = live.period
  if (p === null || !Number.isInteger(p) || p < 1) return UNKNOWN
  if (p <= 4) return `Q${p}`
  return p === 5 ? 'OT' : `${p - 4}OT`
}

/**
 * Time left until a kickoff, coarse enough to change at most once a minute:
 * `2d 3h`, `5h 12m`, `12m`, `<1m`. Never negative. Rounded DOWN, so the
 * countdown never claims more time than is left.
 */
export function formatCountdown(msUntil: number): string {
  if (!Number.isFinite(msUntil) || msUntil <= 0) return 'NOW'
  const totalMin = Math.floor(msUntil / 60_000)
  if (totalMin < 1) return '<1m'
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/**
 * The ball's spot as yards from MY goal line, 0 to 100, or null.
 *
 * ESPN prints the spot as `<team> <yard line>` (`TB 18`), measured in
 * `play-4018729803719.json`, using the same team code as the event's
 * `shortName` (`TB @ DAL`) — which is where `opponentShort` comes from. A
 * spot on the opponent's side is `100 - n`. The code names one of exactly
 * two teams, so a code that is not the opponent's is mine. `50` alone is
 * midfield.
 *
 * Null — and no ball drawn — when the text is absent or has another shape,
 * or when the opponent's code is unknown: without it the two halves cannot
 * be told apart.
 */
export function parseFieldPosition(text: string | null, opponentShort: string): number | null {
  if (!text) return null
  const t = text.trim()
  if (/^50$/.test(t)) return 50
  const m = /^([A-Za-z0-9&.]{1,6})\s+(\d{1,2})$/.exec(t)
  if (!m) return null
  const n = Number(m[2])
  if (!Number.isInteger(n) || n < 0 || n > 50) return null
  const opp = opponentShort.trim().toUpperCase()
  if (!opp) return null
  return m[1]!.toUpperCase() === opp ? 100 - n : n
}

/** Whether a live game owns its team's row: in progress, final, or about to
 * kick off. */
export function isScoreboard(live: LiveGame | null, nowMs: number): live is LiveGame {
  if (!live) return false
  if (live.state === 'in' || live.state === 'post') return true
  return Number.isFinite(live.kickoffEpochMs) && live.kickoffEpochMs - nowMs <= SCOREBOARD_LEAD_MS
}

/** Which celebration a new scoring event earns. Only my touchdowns and field
 * goals celebrate; everything else is a quiet strip note. */
export function celebrationKind(event: ScoringEvent): CelebrationKind {
  if (event.side !== 'mine') return 'note'
  if (event.kind === 'touchdown') return 'touchdown'
  if (event.kind === 'field-goal') return 'field-goal'
  return 'note'
}

const SCORE_KIND_LABEL: Record<ScoringEvent['kind'], string> = {
  touchdown: 'TD',
  'field-goal': 'FG',
  safety: 'SAFETY',
  conversion: 'PAT',
  other: 'SCORE',
}

export interface FootballReader {
  /** The two configured teams, in row order: top row first. The page draws
   * whatever it is given and never names a team itself. */
  getTeams(): readonly [Team, Team]
  /** The team's key label, for example `GATORS`. */
  getLabel(team: Team): string
  /** The team's short code for the tape and strip, for example `UF`. */
  getShort(team: Team): string
  getSchedule(team: Team): Game[]
  getRecord(team: Team): TeamRecord | null
  getStatus(): FootballStatus
  getLastUpdatedAt(): number
  isStale(): boolean
  getLogo(team: Team): Image | null
  /** The team's accent colour, taken from its crest, or null when it has none.
   * Computed once when the logo is decoded — never on the render path. */
  getTeamColor(team: Team): Rgb | null
  /** The live state of the team's current game, or null when no game is in
   * its live window. Every null field inside it means UNKNOWN. */
  getLive(team: Team): LiveGame | null
  /** The team's next kickoff after `nowMs`, or null. It may carry
   * `timeTbd: true`: its date is real, its time of day is not. */
  getNextKickoff(team: Team, nowMs: number): NextKickoff | null
  setVisible(visible: boolean): void
}

/**
 * Two configured teams' schedules, one row each. Keys 0 and 4 are the logo
 * tiles, each carrying the team's season (regular-season) record beneath the
 * crest, in the plain band `compositeLogo` reserves there. Keys 1-3 show the
 * TOP team's next three games; keys 5-7 the BOTTOM team's next three.
 * Pressing a logo tile opens that team's full schedule as a mode of the
 * page — the same mode-of-the-page pattern `stocks-page.ts` and
 * `weather-page.ts` use for their own drill-downs — with `◀ BACK` on key 7.
 * Game tiles themselves have no further drill-down: the task brief only
 * describes the logo as an interactive control, so a press on a game tile
 * reports `ignored`, truthfully, in both modes.
 */
export class FootballPage implements Page {
  /**
   * The clock the most recent `render` was given, so `tickMs` can answer without
   * reading the wall clock — which a page may never do.
   *
   * `null` before the first render, and `tickMs` then returns the safe default.
   * Treating an unset clock as 0 would put every future game "upcoming" relative
   * to the epoch and report a tape that has not been drawn yet — an answer derived
   * from a clock nobody supplied. The daemon re-reads `tickMs` every tick and
   * re-arms when it changes, so the real rate arrives one tick later at worst.
   */
  private lastRenderMs: number | null = null

  readonly name = 'football'

  /** The team whose schedule is open, or null on the grid. `onLeave` always
   * clears this, so the page reopens on the grid every time it becomes
   * visible again — matching `WeatherPage`/`StocksPage`. A team name is a
   * fixed identity, never a rebuilt array's position (docs/LESSONS.md #19),
   * so there is no stale-selection risk here. */
  private selected: Selection | null = null

  /**
   * The last scoring-event id seen per team, and `null` for "seen, no score
   * yet". A team with NO entry has never been seen live: its current score
   * is recorded on first sight and never celebrated, so a deck that starts
   * mid-game stays calm. Kept for the life of the page, across `onLeave`, so
   * nothing re-fires when the page comes back.
   */
  private readonly seenScoreIds = new Map<Team, string | null>()
  /** The latest score each team reacted to. Finished ones stay; every reader
   * checks the clock, and a finished one-shot costs no USB write. */
  private readonly celebrations = new Map<Team, Celebration>()

  constructor(private readonly source: FootballReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.selected = null
    this.source.setVisible(false)
  }

  /** `now` is unix seconds (matching every existing page); `nowMs`, when the
   * daemon supplies it, is the millisecond clock this page actually needs to
   * compare against `kickoffEpochMs` — defaulting to `now * 1000` keeps this
   * correct for any caller (including tests) that only passes `now`. */
  /**
   * A fast tick only while the schedule tape is actually scrolling.
   *
   * Like the stocks ticker, the tape's motion carries CONTENT — the strip shows a
   * fraction of it at once — so it keeps moving even for stale data, and staleness
   * shows through dimming instead. But when there is nothing upcoming there is no
   * tape, and the page has nothing else that moves.
   *
   * Reads the same `tapeSegments` the strip reads, so the declared rate cannot
   * disagree with whether anything is animating (lesson 21).
   */
  get tickMs(): number | undefined {
    // A drill-down carries no tape.
    if (this.selected) return undefined
    const nowMs = this.nowMsForTick()
    if (nowMs === null) return undefined
    // A celebration animates at the one-shot rate until it finishes.
    if (this.animating(nowMs)) return TAPE_TICK_MS
    // A live strip carries no tape, and the live data changes every 20 s at
    // the fastest — the default rate is plenty.
    if (this.liveFocus(nowMs)) return undefined
    const [top, bottom] = this.source.getTeams()
    const topColor = this.source.getTeamColor(top) ?? theme.gray
    const bottomColor = this.source.getTeamColor(bottom) ?? theme.gray
    const hasTape = this.tapeSegments(nowMs, topColor, bottomColor).length > 0
    return hasTape ? TAPE_TICK_MS : undefined
  }

  /**
   * The clock `tickMs` uses to decide whether a tape exists.
   *
   * `tickMs` is a property, so it gets no injected clock — but the answer only
   * depends on WHETHER any game is upcoming, which changes on the scale of days.
   * The last clock `render` was given is therefore both available and precise
   * enough, and it keeps this getter from reading the wall clock, which a page may
   * never do.
   */
  private nowMsForTick(): number | null {
    return this.lastRenderMs
  }

  render(now: number, nowMs?: number): DeckFrame {
    const clockMs = nowMs ?? now * 1000
    this.lastRenderMs = clockMs
    const status = this.source.getStatus()
    const stale = this.source.isStale()
    const dim = stale || status !== 'ok'

    if (this.selected) return this.scheduleFrame(this.selected.team, clockMs, dim)

    const [top, bottom] = this.source.getTeams()
    // Each team's own colour, taken from its crest. Falls back to the theme when a
    // crest has no usable accent — never a fabricated hue.
    const topColor = this.source.getTeamColor(top) ?? theme.gray
    const bottomColor = this.source.getTeamColor(bottom) ?? theme.gray

    const topLive = this.liveRow(top, clockMs)
    const bottomLive = this.liveRow(bottom, clockMs)
    const anyLive = topLive !== null || bottomLive !== null

    const keys: KeySpec[] = [
      ...this.rowKeys(top, topLive, anyLive, clockMs, dim, topColor),
      ...this.rowKeys(bottom, bottomLive, anyLive, clockMs, dim, bottomColor),
    ]

    const focus = this.liveFocus(clockMs)
    const strip = focus ? this.liveStrip(focus.team, focus.live, clockMs) : this.strip(clockMs, topColor, bottomColor)

    // The ONE page where the two round buttons should differ. Every other page
    // shows a single board-level signal, so two colours would read as two
    // unrelated controls — but here the deck genuinely splits by row, one team on
    // top and one beneath, so each light names its own row.
    const buttons: [Rgb, Rgb] = this.flashButtons(clockMs) ?? [topColor, bottomColor]
    return { keys, strip, buttons }
  }

  /* ---------------------------------------------------------- live game */

  /**
   * The team's live game when it owns the row, or null. Also the ONE place a
   * new scoring event is noticed, so every reader of the live state agrees
   * on whether a celebration exists.
   */
  private liveRow(team: Team, nowMs: number): LiveGame | null {
    const live = this.source.getLive(team)
    if (live) this.observe(team, live, nowMs)
    return isScoreboard(live, nowMs) ? live : null
  }

  /**
   * Records a scoring event the first time this page sees it, and starts its
   * celebration when it earns one.
   *
   * The invariant: an event fires AT MOST once, and only when it is new to
   * this page and fresh. Three routes to a wrong firing, and what stops each:
   * - first sight of a game already scored (deck start, page first shown):
   *   the first id per team is recorded, not celebrated;
   * - a score the source saw while this page was not rendering (hidden, or
   *   in the drill-down): the freshness check against the event's `atMs`;
   * - the same id seen again on a later render, or after `onLeave`: the seen
   *   id is kept for the life of the page.
   */
  private observe(team: Team, live: LiveGame, nowMs: number): void {
    const id = live.lastScore?.id ?? null
    const firstSight = !this.seenScoreIds.has(team)
    const prev = this.seenScoreIds.get(team) ?? null
    this.seenScoreIds.set(team, id)
    const event = live.lastScore
    if (firstSight || !event || id === prev) return
    if (!Number.isFinite(event.atMs) || Math.abs(nowMs - event.atMs) > CELEBRATE_FRESH_MS) return
    this.celebrations.set(team, {
      kind: celebrationKind(event),
      event: { ...event },
      startedAtMs: nowMs,
      lastPlay: live.lastPlay,
    })
  }

  /** The team's celebration while it still shows anything, or null. */
  private activeCelebration(team: Team, nowMs: number): Celebration | null {
    const c = this.celebrations.get(team)
    if (!c) return null
    const age = nowMs - c.startedAtMs
    const shownFor = c.kind === 'note' ? NOTE_MS : BANNER_MS
    return age >= 0 && age < shownFor ? c : null
  }

  /** True while any key, button or banner pop still moves. The ONE answer
   * `tickMs` reads, so the declared rate cannot disagree with the motion. */
  private animating(nowMs: number): boolean {
    for (const c of this.celebrations.values()) {
      if (c.kind === 'note') continue
      const age = nowMs - c.startedAtMs
      if (age >= 0 && age < CELEBRATE_MS) return true
    }
    return false
  }

  /**
   * The live game the strip talks about, or null when no row is live. A team
   * with a banner showing wins, then a game in progress, then the top row.
   */
  private liveFocus(nowMs: number): { team: Team; live: LiveGame } | null {
    const rows: { team: Team; live: LiveGame }[] = []
    for (const team of this.source.getTeams()) {
      const live = this.source.getLive(team)
      if (isScoreboard(live, nowMs)) rows.push({ team, live })
    }
    const banner = (team: Team): boolean => {
      const c = this.activeCelebration(team, nowMs)
      return c !== null && c.kind !== 'note'
    }
    return rows.find((r) => banner(r.team)) ?? rows.find((r) => r.live.state === 'in') ?? rows[0] ?? null
  }

  /** Both round buttons alternate the scoring team's colour and white, out
   * of phase, while a touchdown celebrates. Null otherwise. */
  private flashButtons(nowMs: number): [Rgb, Rgb] | null {
    for (const team of this.source.getTeams()) {
      const c = this.celebrations.get(team)
      if (!c || c.kind !== 'touchdown') continue
      const age = nowMs - c.startedAtMs
      if (!(age >= 0 && age < CELEBRATE_MS)) continue
      const accent = this.source.getTeamColor(team) ?? theme.gray
      return Math.floor(age / BUTTON_FLASH_MS) % 2 === 0 ? [accent, theme.white] : [theme.white, accent]
    }
    return null
  }

  /** The schedule entry for a live game, by id, or undefined. */
  private liveGame(team: Team, live: LiveGame): Game | undefined {
    return this.source.getSchedule(team).find((g) => g.id === live.gameId)
  }

  /**
   * One row of four keys. A live game takes the row over. A row that is not
   * live, while the other row is, trades its third schedule tile for a
   * kickoff countdown. Otherwise the row is the schedule, unchanged.
   */
  private rowKeys(team: Team, live: LiveGame | null, anyLive: boolean, nowMs: number, dim: boolean, accent: Rgb): KeySpec[] {
    if (live) return this.scoreboardKeys(team, live, nowMs, dim, accent)
    const games = this.nextThreeKeys(team, nowMs, dim, accent)
    if (anyLive) {
      const countdown = this.countdownKey(team, nowMs, dim, accent)
      if (countdown) return [this.logoKey(team, dim, accent), games[0]!, countdown, games[1]!]
    }
    return [this.logoKey(team, dim, accent), ...games]
  }

  /** `KICKOFF IN 2d 3h`, or the date alone when the time is TBD — never a
   * countdown to a placeholder time of day. Null when no kickoff lies ahead. */
  private countdownKey(team: Team, nowMs: number, dim: boolean, accent: Rgb): KeySpec | null {
    const next = this.source.getNextKickoff(team, nowMs)
    if (!next) return null
    const header = homeAwayHeader(next)
    const key: KeySpec = next.timeTbd
      ? {
          kind: 'gauge',
          lines: ['KICKOFF', formatShortDate(next.kickoffEpochMs), 'TIME TBA', header],
          lineSizes: [10, COUNTDOWN_SIZES, 11, 12],
          lineY: [12, 32, 58, 74],
          lineColors: [theme.textDim, blend(accent, theme.white, 0.35), theme.textDim, theme.text],
          lineWeights: ['bold', 'bold'],
          align: 'center',
        }
      : {
          kind: 'gauge',
          lines: ['KICKOFF IN', formatCountdown(next.kickoffEpochMs - nowMs), header],
          lineSizes: [10, COUNTDOWN_SIZES, 12],
          lineY: [12, 36, 70],
          lineColors: [theme.textDim, blend(accent, theme.white, 0.35), theme.text],
          lineWeights: ['bold', 'bold'],
          align: 'center',
        }
    key.border = accent
    if (dim) key.dim = true
    return key
  }

  /** Keys A-D of a live row: my score, the opponent's, the clock, the field. */
  private scoreboardKeys(team: Team, live: LiveGame, nowMs: number, pageDim: boolean, accent: Rgb): KeySpec[] {
    const dim = pageDim || live.stale
    const game = this.liveGame(team, live)
    const opponentCode = game?.opponentShort || game?.opponent || UNKNOWN
    const celebration = this.activeCelebration(team, nowMs)
    const ball = (side: 'mine' | 'opponent'): string => (live.possession === side ? '● BALL' : '')

    const mine: KeySpec = {
      kind: 'gauge',
      lines: [this.source.getLabel(team) || UNKNOWN, formatScore(live.myScore), ball('mine')],
      lineSizes: [[12, 11], SCORE_SIZES, 11],
      lineY: [8, 28, 78],
      lineColors: [theme.text, accent, theme.amber],
      lineWeights: ['bold', 'bold', 'bold'],
      align: 'center',
      bg: blend(theme.bg, accent, 0.14),
      border: accent,
    }
    const theirs: KeySpec = {
      kind: 'gauge',
      lines: [opponentCode, formatScore(live.opponentScore), ball('opponent')],
      lineSizes: [[12, 11], SCORE_SIZES, 11],
      lineY: [8, 28, 78],
      lineColors: [theme.text, theme.text, theme.amber],
      lineWeights: ['bold', 'bold', 'bold'],
      align: 'center',
      border: accent,
    }
    const keys = [mine, theirs, this.clockKey(live, nowMs, accent), this.fieldKey(live, game?.opponentShort ?? '', accent)]
    if (dim) for (const k of keys) k.dim = true

    if (celebration && celebration.kind !== 'note') {
      const start = celebration.startedAtMs
      // My score pops when it changes.
      mine.linePop = { line: 1, startedAtMs: start, nowMs }
      const colors: Rgb[] = [accent, theme.white, blend(accent, theme.white, 0.5)]
      if (celebration.kind === 'touchdown') {
        const flood = blend(theme.bg, accent, 0.45)
        keys.forEach((k, i) => {
          k.effects = [
            { variant: 'sweep', startedAtMs: start + i * SWEEP_STAGGER_MS, nowMs, color: accent },
            { variant: 'burst', startedAtMs: start + 150, nowMs, colors, seed: i + 1 },
          ]
          if (nowMs - start >= 0 && nowMs - start < FLOOD_MS) k.bg = flood
        })
      } else {
        mine.effects = [{ variant: 'burst', startedAtMs: start, nowMs, colors, count: 14, seed: 1 }]
      }
    }
    return keys
  }

  /** Key C: period, game clock, down and distance — or the kickoff before
   * the game, or FINAL after it. */
  private clockKey(live: LiveGame, nowMs: number, accent: Rgb): KeySpec {
    const base: KeySpec = { kind: 'gauge', align: 'center', border: accent }
    if (live.state === 'pre') {
      return {
        ...base,
        lines: ['KICKOFF IN', formatCountdown(live.kickoffEpochMs - nowMs), formatEasternTime(live.kickoffEpochMs, { zone: false })],
        lineSizes: [10, PERIOD_SIZES, [11, 10]],
        lineY: [12, 36, 72],
        lineColors: [theme.textDim, theme.amber, theme.textDim],
        lineWeights: ['bold', 'bold'],
      }
    }
    if (live.state === 'post') {
      return {
        ...base,
        lines: [/^final/i.test(live.detail) ? live.detail.toUpperCase() : 'FINAL'],
        lineSizes: [PERIOD_SIZES],
        lineY: [38],
        lineWeights: ['bold'],
      }
    }
    const period = formatPeriod(live)
    return {
      ...base,
      lines: [period, period === 'HALF' ? '' : live.clock ?? UNKNOWN, live.downDistance ?? UNKNOWN],
      lineSizes: [PERIOD_SIZES, PERIOD_SIZES, [12, 11]],
      lineY: [14, 42, 74],
      lineColors: [theme.text, theme.amber, theme.textDim],
      lineWeights: ['bold', 'bold'],
    }
  }

  /**
   * Key D: a small field, my end zone on the left. The ball is an arrow over
   * its spot when the spot parses. Otherwise the field draws with no ball: a
   * range always draws its marker, so the empty field is a plain bar at the
   * same height instead. Tinted red in the red zone. After the game it shows
   * the result.
   */
  private fieldKey(live: LiveGame, opponentShort: string, accent: Rgb): KeySpec {
    if (live.state === 'post') {
      const result =
        live.myScore === null || live.opponentScore === null
          ? null
          : live.myScore > live.opponentScore
            ? 'win'
            : live.myScore < live.opponentScore
              ? 'loss'
              : 'tie'
      const key: KeySpec = {
        kind: 'gauge',
        lines: [result ? result.toUpperCase() : UNKNOWN],
        lineSizes: [PERIOD_SIZES],
        lineY: [38],
        lineWeights: ['bold'],
        align: 'center',
        border: accent,
      }
      const wash = result === 'win' || result === 'loss' ? resultWash(result) : undefined
      if (wash) key.bg = wash
      return key
    }
    const yards = parseFieldPosition(live.fieldPosition, opponentShort)
    const key: KeySpec = {
      kind: 'gauge',
      lines: [live.fieldPosition ?? UNKNOWN, live.redZone === true ? 'RED ZONE' : ''],
      lineSizes: [[16, 14, 12], 10],
      lineY: [26, 80],
      lineColors: [theme.text, theme.red],
      lineWeights: ['bold', 'bold'],
      align: 'center',
      border: accent,
    }
    if (yards !== null) {
      key.range = { lo: 0, hi: 100, value: yards, y: FIELD_Y, height: FIELD_H, gradient: [accent, theme.gray], marker: 'arrow' }
    } else {
      key.bar = { value: 0, color: accent, bg: FIELD_EMPTY }
    }
    if (live.redZone === true) key.bg = blend(theme.bg, theme.red, 0.28)
    return key
  }

  /** The strip during a live game: the score line, then the last play. A
   * banner takes over after a score of mine; a quiet note after any other. */
  private liveStrip(team: Team, live: LiveGame, nowMs: number): StripSpec {
    const game = this.liveGame(team, live)
    const mine = this.source.getShort(team) || UNKNOWN
    const theirs = game?.opponentShort || UNKNOWN
    const celebration = this.activeCelebration(team, nowMs)

    if (celebration && celebration.kind !== 'note') {
      const accent = this.source.getTeamColor(team) ?? theme.gray
      const banner: NonNullable<StripSpec['banner']> = {
        text: celebration.kind === 'touchdown' ? 'TOUCHDOWN!' : 'FIELD GOAL',
        color: blend(accent, theme.white, 0.25),
        size: celebration.kind === 'touchdown' ? 24 : 20,
        pop: { startedAtMs: celebration.startedAtMs, nowMs },
      }
      if (celebration.lastPlay) banner.sub = celebration.lastPlay
      return { lines: [], banner }
    }

    // In Menlo the en dash and the unknown placeholder look alike, so an
    // unknown score never sits beside the separator: `UF — – — UGA` reads
    // as noise. It says the score is unknown in words instead.
    const score =
      live.myScore === null || live.opponentScore === null
        ? `${mine} vs ${theirs} · score ${UNKNOWN}`
        : `${mine} ${live.myScore} – ${live.opponentScore} ${theirs}`
    let line1: string
    if (live.state === 'pre') line1 = `${mine} vs ${theirs} · ${formatEasternTime(live.kickoffEpochMs)}`
    else if (live.state === 'post') line1 = `FINAL · ${score}`
    else {
      const period = formatPeriod(live)
      line1 = period === 'HALF' || live.clock === null ? `${score} · ${period}` : `${score} · ${period} ${live.clock}`
    }

    let line2: string
    if (celebration) {
      // A score that earns no celebration: one quiet line, then back to plays.
      const e = celebration.event
      line2 = `${e.side === 'mine' ? mine : theirs} ${SCORE_KIND_LABEL[e.kind]} · ${e.myScore}-${e.opponentScore}`
    } else if (live.state === 'in' && live.lastPlay) {
      line2 = live.lastPlay
    } else if (live.state === 'in' && live.downDistance && live.fieldPosition) {
      line2 = `${live.downDistance} at ${live.fieldPosition}`
    } else {
      line2 = `updated ${formatEasternTime(live.updatedAtMs)}`
    }
    const spec: StripSpec = { lines: [truncate(line1, STRIP_CHARS), truncate(line2, STRIP_CHARS)] }
    if (live.stale) spec.dim = true
    return spec
  }

  /** Keys 0 and 4: the team's composited logo (crest plus a reserved plain
   * band) with the season record drawn in that band, once the logo has
   * decoded — or a text-only fallback (team name AND record, so the record
   * is not lost just because the crest is still downloading) meanwhile. */
  private logoKey(team: Team, dim: boolean, accent: Rgb): KeySpec {
    const logo = this.source.getLogo(team)
    const record = this.source.getRecord(team)
    const recordText = formatRecord(record)
    if (logo) {
      const key: KeySpec = {
        kind: 'image',
        image: logo,
        imageKey: team,
        lines: [recordText],
        lineSizes: [RECORD_SIZES],
        lineY: [RECORD_Y],
        align: 'center',
        border: accent,
        dim,
      }
      // The record's own wash, behind the composited crest's reserved band. The
      // crest itself covers the upper part of the key, so this reads as a tint
      // under the record line rather than as a coloured logo.
      const wash = recordWash(record)
      if (wash) key.bg = wash
      return key
    }
    return {
      kind: 'control',
      lines: [this.source.getLabel(team), recordText],
      lineSizes: [HEADER_SIZE, RECORD_SIZES],
      align: 'center',
      dim,
    }
  }

  /** Keys 1-3 / 5-7: this team's next three games in chronological order. A
   * missing slot (fewer than three upcoming games left, or no data yet)
   * draws a dashed placeholder rather than a bare, left-hugging fallback. */
  private nextThreeKeys(team: Team, nowMs: number, dim: boolean, accent: Rgb): KeySpec[] {
    const next = upcoming(this.source.getSchedule(team), nowMs).slice(0, NEXT_COUNT)
    const keys: KeySpec[] = []
    for (let i = 0; i < NEXT_COUNT; i++) {
      const game = next[i]
      const key = this.gameKey(game, dim)
      key.border = accent
      // Warms as kickoff approaches, so the imminent game is the brightest thing
      // on the row without needing to read a date.
      if (game) {
        const wash = warmthWash(kickoffWarmth(game.kickoffEpochMs, nowMs), accent)
        if (wash) key.bg = wash
      }
      keys.push(key)
    }
    return keys
  }

  /** One game tile: home/away plus short opponent code, full opponent name,
   * date, kickoff or TBA. Used identically on the grid and inside the
   * schedule drill-down (`pastDim` additionally dims an already-played
   * game inside the drill-down, independent of the page-wide staleness dim). */
  private gameKey(game: Game | undefined, dim: boolean, pastDim = false): KeySpec {
    if (!game) {
      return {
        kind: 'gauge',
        lines: ['--', '--', '--'],
        lineSizes: [HEADER_SIZE, OPPONENT_SIZES, DATE_SIZE],
        dim: true,
      }
    }
    const key: KeySpec = {
      kind: 'gauge',
      lines: [homeAwayHeader(game), game.opponent || '--', formatShortDate(game.kickoffEpochMs), formatKickoff(game)],
      lineSizes: [HEADER_SIZE, OPPONENT_SIZES, DATE_SIZE, TIME_SIZES],
    }
    if (dim || pastDim) key.dim = true
    return key
  }

  /**
   * The full-schedule drill-down for one team, spread across keys 0-6 (a
   * "most relevant window" of up to `SCHEDULE_WINDOW` games — see
   * `scheduleWindow`), with `◀ BACK` on key 7. Deliberately does NOT
   * reserve a key for the team's logo (unlike the stocks/weather detail
   * views, which keep the pressed tile visible) — the whole point of this
   * mode is showing as much of the schedule as possible, per the user's own
   * request ("shows all the games"); team identity and record move to the
   * strip instead, costing no key.
   */
  private scheduleFrame(team: Team, nowMs: number, dim: boolean): DeckFrame {
    const schedule = this.source.getSchedule(team)
    const window = scheduleWindow(schedule, nowMs)

    const keys: KeySpec[] = []
    for (let i = 0; i < SCHEDULE_WINDOW; i++) {
      const game = window[i]
      const isPast = game !== undefined && game.kickoffEpochMs !== null && game.kickoffEpochMs < nowMs
      const key = this.gameKey(game, dim, isPast)
      // Green for a win, red for a loss, nothing for a game that is undecided or
      // a tie — so the whole season's shape reads down the deck at a glance. The
      // result costs no extra request: ESPN sends it inline on every event.
      if (game) {
        const wash = resultWash(game.result)
        if (wash) key.bg = wash
      }
      keys.push(key)
    }
    keys.push(this.backKey())

    return { keys, strip: this.scheduleStrip(team, schedule, window), buttons: [theme.gray, theme.gray] }
  }

  /** Key 7: BACK. A gray border and no fill colour, so it never reads as one
   * more data tile — the same look the stocks and weather detail views use. */
  private backKey(): KeySpec {
    return {
      kind: 'control',
      lines: ['◀ BACK'],
      lineSizes: [BACK_SIZE],
      lineY: [40],
      align: 'center',
      border: theme.gray,
    }
  }

  /** The nearer of the two teams' next games — the one with the smaller
   * known kickoff. A team with no known-kickoff game never wins this
   * comparison over one that has one. */
  private nearestNext(nowMs: number): { team: Team; game: Game } | null {
    let best: { team: Team; game: Game } | null = null
    for (const team of this.source.getTeams()) {
      const game = upcoming(this.source.getSchedule(team), nowMs)[0]
      if (!game) continue
      if (!best || game.kickoffEpochMs === null) {
        if (!best) best = { team, game }
        continue
      }
      if (best.game.kickoffEpochMs === null || game.kickoffEpochMs < best.game.kickoffEpochMs) {
        best = { team, game }
      }
    }
    return best
  }

  private strip(nowMs: number, topColor: Rgb, bottomColor: Rgb): StripSpec {
    const status = this.source.getStatus()
    const nearest = this.nearestNext(nowMs)

    let line1: string
    if (!nearest) {
      line1 = status === 'empty' ? 'football: no upcoming games yet' : 'football: no upcoming games'
    } else {
      const weekday = shortWeekday(nearest.game.kickoffEpochMs)
      const time = formatKickoff(nearest.game)
      const when = weekday ? `${weekday} ${time}` : time
      const prefix = nearest.game.isHome ? 'vs' : '@'
      // Team's own short code plus the FULL opponent name (never both the
      // short AND the full opponent name — that duplicated the same team
      // twice and pushed real matchups past the 30-character strip budget).
      line1 = `${when} · ${this.source.getShort(nearest.team)} ${prefix} ${nearest.game.opponent}`
    }

    const updatedAt = this.source.getLastUpdatedAt()
    const line2 =
      status === 'offline' ? 'offline' : updatedAt > 0 ? `updated ${formatEasternTime(updatedAt * 1000)}` : 'updated --'

    const spec: StripSpec = { lines: [truncate(line1, STRIP_CHARS), truncate(line2, STRIP_CHARS)] }

    // The season crawling across line 2's band, both teams in date order, each
    // segment in its own team's colour. Line 1 keeps the nearest game, so the
    // most useful fact is still readable without waiting for the tape.
    const segments = this.tapeSegments(nowMs, topColor, bottomColor)
    if (segments.length > 0) {
      spec.tape = { segments, offsetPx: tapeOffsetPx(nowMs, TAPE_PX_PER_SEC) }
    }

    return spec
  }

  /**
   * The next several games across BOTH teams, in date order, one tape segment
   * each. Bounded by `TAPE_GAME_COUNT` so the loop stays short enough to watch.
   *
   * A game with no known kickoff still appears — it is real, upcoming
   * information — but sorts last, since it cannot be placed on the timeline.
   */
  private tapeSegments(nowMs: number, topColor: Rgb, bottomColor: Rgb): TapeSegment[] {
    const [top] = this.source.getTeams()
    const entries: { game: Game; team: Team }[] = []
    for (const team of this.source.getTeams()) {
      for (const game of upcoming(this.source.getSchedule(team), nowMs)) {
        entries.push({ game, team })
      }
    }
    entries.sort((a, b) => {
      const ak = a.game.kickoffEpochMs
      const bk = b.game.kickoffEpochMs
      if (ak === null && bk === null) return 0
      if (ak === null) return 1
      if (bk === null) return -1
      return ak - bk
    })
    return entries.slice(0, TAPE_GAME_COUNT).map(({ game, team }) => ({
      text: `${this.source.getShort(team)} ${formatShortDate(game.kickoffEpochMs)} ${game.isHome ? 'vs' : '@'} ${game.opponentShort || game.opponent}`,
      color: team === top ? topColor : bottomColor,
    }))
  }

  private scheduleStrip(team: Team, fullSchedule: Game[], window: Game[]): StripSpec {
    const record = formatRecord(this.source.getRecord(team))
    const line1 = truncate(`${this.source.getLabel(team)} SCHEDULE · ${record}`, STRIP_CHARS)
    const hidden = fullSchedule.length - window.length
    const line2 = truncate(
      hidden > 0 ? `showing ${window.length} of ${fullSchedule.length} · ${hidden} more` : `showing all ${fullSchedule.length} games`,
      STRIP_CHARS,
    )
    const status = this.source.getStatus()
    const updatedAt = this.source.getLastUpdatedAt()
    const right =
      status === 'offline' ? 'offline' : updatedAt > 0 ? `updated ${formatEasternTime(updatedAt * 1000)}` : '--'
    return { lines: [line1, line2], right }
  }

  onKeyPress(index: number): PressOutcome {
    if (this.selected) {
      if (index === 7) {
        this.selected = null
        return 'handled'
      }
      // Keys 0-6 (game tiles) carry no drill-down of their own. Read-only:
      // no refresh-on-press, no network I/O from a key press at all (the
      // "do not fire 32 requests on a page press" rule the task brief
      // states plainly — this page's onKeyPress never calls the source's
      // fetch-driving methods, only its pure readers).
      return 'ignored'
    }

    // Grid mode. Only the two logo tiles (0, 4) are interactive.
    const [top, bottom] = this.source.getTeams()
    let team: Team | null = null
    if (index === 0) team = top
    else if (index === 4) team = bottom
    if (!team) return 'ignored'

    // A logo with no schedule data at all has nothing to drill into — per
    // the task brief, this reports `ignored`, truthfully, rather than
    // opening an empty schedule view.
    if (this.source.getSchedule(team).length === 0) return 'ignored'
    this.selected = { team }
    return 'handled'
  }
}
