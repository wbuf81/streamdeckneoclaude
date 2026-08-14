import type { Image } from '@napi-rs/canvas'
import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate, formatEasternTime } from '../render/text.js'
import type { Page, PressOutcome } from './types.js'
import type { FootballStatus, Game, Team, TeamRecord } from '../sources/football.js'
import { LOGO_ART_FRACTION } from '../sources/football.js'

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

const TEAM_LABELS: Readonly<Record<Team, string>> = { jaguars: 'JAGUARS', gators: 'GATORS' }
/** Short strip abbreviations, matching the task brief's own example strip
 * text (`"UF vs UGA"`). */
const TEAM_SHORT: Readonly<Record<Team, string>> = { jaguars: 'JAX', gators: 'UF' }

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

/** The games with a known future (or unknown-but-not-past) kickoff, ascending
 * — `schedule` is already sorted ascending by the source's own contract. */
function upcoming(schedule: Game[], nowMs: number): Game[] {
  return schedule.filter((g) => g.kickoffEpochMs !== null && g.kickoffEpochMs >= nowMs)
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
export interface FootballReader {
  getSchedule(team: Team): Game[]
  getRecord(team: Team): TeamRecord | null
  getStatus(): FootballStatus
  getLastUpdatedAt(): number
  isStale(): boolean
  getLogo(team: Team): Image | null
  setVisible(visible: boolean): void
}

/**
 * The Florida Gators' and Jacksonville Jaguars' schedules. Keys 0 and 4 are
 * the logo tiles, each carrying the team's season (regular-season) record
 * beneath the crest, in the plain band `compositeLogo` reserves there. Keys
 * 1-3 show the Gators' next three games; keys 5-7 the Jaguars' next three.
 * Pressing a logo tile opens that team's full schedule as a mode of the
 * page — the same mode-of-the-page pattern `stocks-page.ts` and
 * `weather-page.ts` use for their own drill-downs — with `◀ BACK` on key 7.
 * Game tiles themselves have no further drill-down: the task brief only
 * describes the logo as an interactive control, so a press on a game tile
 * reports `ignored`, truthfully, in both modes.
 */
export class FootballPage implements Page {
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
  render(now: number, nowMs?: number): DeckFrame {
    const clockMs = nowMs ?? now * 1000
    const status = this.source.getStatus()
    const stale = this.source.isStale()
    const dim = stale || status !== 'ok'

    if (this.selected) return this.scheduleFrame(this.selected.team, clockMs, dim)

    const keys: KeySpec[] = [
      this.logoKey('gators', dim),
      ...this.nextThreeKeys('gators', clockMs, dim),
      this.logoKey('jaguars', dim),
      ...this.nextThreeKeys('jaguars', clockMs, dim),
    ]

    return { keys, strip: this.strip(clockMs), buttons: [theme.gray, theme.gray] }
  }

  /** Keys 0 and 4: the team's composited logo (crest plus a reserved plain
   * band) with the season record drawn in that band, once the logo has
   * decoded — or a text-only fallback (team name AND record, so the record
   * is not lost just because the crest is still downloading) meanwhile. */
  private logoKey(team: Team, dim: boolean): KeySpec {
    const logo = this.source.getLogo(team)
    const recordText = formatRecord(this.source.getRecord(team))
    if (logo) {
      return {
        kind: 'image',
        image: logo,
        imageKey: team,
        lines: [recordText],
        lineSizes: [RECORD_SIZES],
        lineY: [RECORD_Y],
        align: 'center',
        dim,
      }
    }
    return {
      kind: 'control',
      lines: [TEAM_LABELS[team], recordText],
      lineSizes: [HEADER_SIZE, RECORD_SIZES],
      align: 'center',
      dim,
    }
  }

  /** Keys 1-3 / 5-7: this team's next three games in chronological order. A
   * missing slot (fewer than three upcoming games left, or no data yet)
   * draws a dashed placeholder rather than a bare, left-hugging fallback. */
  private nextThreeKeys(team: Team, nowMs: number, dim: boolean): KeySpec[] {
    const next = upcoming(this.source.getSchedule(team), nowMs).slice(0, NEXT_COUNT)
    const keys: KeySpec[] = []
    for (let i = 0; i < NEXT_COUNT; i++) {
      keys.push(this.gameKey(next[i], dim))
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
      keys.push(this.gameKey(game, dim, isPast))
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
    for (const team of ['jaguars', 'gators'] as const) {
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

  private strip(nowMs: number): StripSpec {
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
      line1 = `${when} · ${TEAM_SHORT[nearest.team]} ${prefix} ${nearest.game.opponent}`
    }

    const updatedAt = this.source.getLastUpdatedAt()
    const line2 =
      status === 'offline' ? 'offline' : updatedAt > 0 ? `updated ${formatEasternTime(updatedAt * 1000)}` : 'updated --'

    return { lines: [truncate(line1, STRIP_CHARS), truncate(line2, STRIP_CHARS)] }
  }

  private scheduleStrip(team: Team, fullSchedule: Game[], window: Game[]): StripSpec {
    const record = formatRecord(this.source.getRecord(team))
    const line1 = truncate(`${TEAM_LABELS[team]} SCHEDULE · ${record}`, STRIP_CHARS)
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
    let team: Team | null = null
    if (index === 0) team = 'gators'
    else if (index === 4) team = 'jaguars'
    if (!team) return 'ignored'

    // A logo with no schedule data at all has nothing to drill into — per
    // the task brief, this reports `ignored`, truthfully, rather than
    // opening an empty schedule view.
    if (this.source.getSchedule(team).length === 0) return 'ignored'
    this.selected = { team }
    return 'handled'
  }
}
