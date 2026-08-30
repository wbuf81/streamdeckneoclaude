import type { Image } from '@napi-rs/canvas'
import type { DeckFrame, KeySpec, Rgb, StripSpec, TapeSegment } from '../render/specs.js'
import { theme, blend } from '../render/theme.js'
import { truncate, formatEasternTime } from '../render/text.js'
import type { Page, PressOutcome } from './types.js'
import type { FootballStatus, Game, GameResult, Team, TeamRecord } from '../sources/football.js'
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

    const keys: KeySpec[] = [
      this.logoKey(top, dim, topColor),
      ...this.nextThreeKeys(top, clockMs, dim, topColor),
      this.logoKey(bottom, dim, bottomColor),
      ...this.nextThreeKeys(bottom, clockMs, dim, bottomColor),
    ]

    // The ONE page where the two round buttons should differ. Every other page
    // shows a single board-level signal, so two colours would read as two
    // unrelated controls — but here the deck genuinely splits by row, one team on
    // top and one beneath, so each light names its own row.
    return {
      keys,
      strip: this.strip(clockMs, topColor, bottomColor),
      buttons: [topColor, bottomColor],
    }
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
