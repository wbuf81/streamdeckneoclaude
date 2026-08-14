import type { Image } from '@napi-rs/canvas'
import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate, formatEasternTime } from '../render/text.js'
import type { Page, PressOutcome } from './types.js'
import type { FootballStatus, GameSummary, Slot, Team } from '../sources/football.js'

/** Measured limit for one strip line. See `render/canvas.ts`. */
const STRIP_CHARS = 30
/** Fixed size for the "NEXT"/"LAST" header line — matches the precedent
 * `weather-page.ts`'s `DAY_LABEL_SIZE` sets for a short, always-safe label
 * (measured well under the 81 px usable width at every real value here). */
const HEADER_SIZE = 12
/** Candidate sizes for the opponent name, largest first. Measured
 * (`@napi-rs/canvas`, Menlo, see the task 40 report): `JACKSONVILLE` (12
 * characters) is 93.9 px at 13 px — over the 81 px budget — but 79.5 px at
 * 11 px, just inside it; `TEXAS A&M` fits at both. The renderer measures and
 * picks the size that actually fits, per docs/LESSONS.md #17 — this page
 * never reasons about the width itself. */
const OPPONENT_SIZES = [13, 11]
/** Fixed size for the short date line (`AUG 15`) — always exactly 6
 * characters, measured 47.0 px at 13 px, well inside the 81 px budget at
 * every real month/day combination. */
const DATE_SIZE = 13
/** Candidate sizes for the kickoff time line. Measured: `12:00 PM EDT` (the
 * widest realistic reading, a mid-day kickoff) is 79.5 px at 11 px but 93.9
 * px at 13 px — over budget — so 11 px is what the renderer actually picks
 * every time; the candidate array is still declared, not assumed, per
 * docs/LESSONS.md #17. */
const TIME_SIZES = [13, 11]
/** Candidate sizes for the score line (`W 24-27`, `L 100-99`). Measured safe
 * even at 16 px (77.1 px for a 3-digit score), so this stays a size larger
 * than the text-only lines above. */
const SCORE_SIZES = [16, 13, 11]
/** Fixed size for a short, bounded status word (`HOME`, `AWAY`, `FINAL`). */
const STATUS_SIZE = 20
const BACK_SIZE = 16
/** Character budget for one wrapped venue/city line, sized to the smallest
 * `OPPONENT_SIZES` candidate (11 px): 81 px / 6.62 px per character
 * (docs/VERIFIED-FACTS.md's advance table) = 12.24, so 12 characters stays
 * inside the budget with room to spare — the same number weather-page.ts's
 * `TEXT_WRAP_CHARS` uses for the identical reason. */
const WRAP_CHARS = 12
const WRAP_LINES = 3

const TEAM_LABELS: Readonly<Record<Team, string>> = { jaguars: 'JAGUARS', gators: 'GATORS' }
/** Short strip abbreviations. `UF` matches the task brief's own example
 * strip text (`"UF vs UGA"`); `JAX` is the Jaguars' own standard abbreviation. */
const TEAM_SHORT: Readonly<Record<Team, string>> = { jaguars: 'JAX', gators: 'UF' }

const TEAMS: readonly Team[] = ['jaguars', 'gators']

interface Selection {
  team: Team
  slot: Slot
}

/**
 * Greedily wraps `text` into up to `maxLines` lines of at most `maxChars`
 * characters, breaking only between words. Text left over once every line is
 * full is folded onto the last line and cut with an ellipsis via `truncate`
 * — the same shape `weather-page.ts`'s own `wrapText` uses, kept as a
 * separate local copy rather than a shared import: each page owns its own
 * text-shaping helpers in this project (see `stocks-page.ts` and
 * `weather-page.ts`, neither of which imports the other's).
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  if (maxLines <= 0 || maxChars <= 0) return []
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []

  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      if (current) lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)

  if (lines.length <= maxLines) return lines

  const kept = lines.slice(0, maxLines - 1)
  const rest = lines.slice(maxLines - 1).join(' ')
  kept.push(truncate(rest, maxChars))
  return kept
}

/**
 * `AUG 15`, in US Eastern time — derived from the SAME epoch
 * `formatKickoff` reads, never from the source's raw (UTC-calendar)
 * `dateEvent`. A late-kickoff West Coast game can fall on the previous
 * Eastern calendar day (measured: `Oregon vs Portland State`, UTC date
 * 2026-09-19, converts to 2026-09-18 evening Eastern) — mixing a UTC date
 * with an Eastern time would be exactly the "wrong-timezone kickoff" the
 * task brief calls worse than no kickoff. `--` when the kickoff itself is
 * unknown, since there is then no single instant to derive a date from.
 *
 * This is a calendar DATE, not a wall-clock TIME, so it does not go through
 * `formatEasternTime` (AGENTS.md's shared formatter is for times); it uses
 * `Intl.DateTimeFormat` directly, the same primitive `text.ts`'s own
 * `easternZoneAbbr` is built on.
 */
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

/** `SAT`, the Eastern weekday for the strip's matchup line. `''` when the
 * kickoff is unknown. */
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

/** `4:00 PM EDT`, through the ONE shared time formatter (AGENTS.md's
 * "Product conventions"). `TBA` — never a fabricated time — when the source
 * has no usable kickoff instant, per docs/LESSONS.md #18 and the task
 * brief's own instruction. */
export function formatKickoff(kickoffEpochMs: number | null): string {
  if (kickoffEpochMs === null) return 'TBA'
  return formatEasternTime(kickoffEpochMs)
}

/** `W 24-27`, `L 100-99`, `T 20-20`. `--` when the game has not finished, or
 * a score is somehow still missing despite `finished` being true (never a
 * fabricated `0-0`). */
export function formatScore(game: GameSummary): string {
  if (!game.finished || game.teamScore === null || game.opponentScore === null) return '--'
  const letter = game.teamScore > game.opponentScore ? 'W' : game.teamScore < game.opponentScore ? 'L' : 'T'
  return `${letter} ${game.teamScore}-${game.opponentScore}`
}

/** The part of `FootballSource` this page needs. */
export interface FootballReader {
  getGame(team: Team, slot: Slot): GameSummary | null
  getStatus(): FootballStatus
  getLastUpdatedAt(): number
  isStale(): boolean
  getLogo(team: Team): Image | null
  setVisible(visible: boolean): void
}

/**
 * The Jacksonville Jaguars' and Florida Gators' schedules: a logo tile and a
 * NEXT/LAST game tile per team. Measured 2026-08-14 (task 40 report):
 * TheSportsDB's free tier returns exactly one future and one past event per
 * team, not "next three" — showing three would mean fabricating two of
 * them, so this page shows the one real game in each direction instead.
 * Pressing a NEXT or LAST tile opens a detail view for that one game (date,
 * kickoff, venue, city, result), with BACK on key 7 — the same
 * mode-of-the-page pattern the stocks and weather pages use for their own
 * drill-downs. A key dims when the shared schedule is stale or absent, so a
 * stale or missing schedule never presents as current.
 */
export class FootballPage implements Page {
  readonly name = 'football'

  /** The selected team/slot, or null on the grid. `onLeave` always clears
   * this, so the page reopens on the grid every time it becomes visible
   * again — matching `WeatherPage`/`StocksPage`. Unlike those pages, there
   * is no array-position risk here (docs/LESSONS.md #19): a team and a slot
   * are both fixed identities, never a position in a rebuilt array. */
  private selected: Selection | null = null

  constructor(private readonly source: FootballReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.selected = null
    this.source.setVisible(false)
  }

  /** The selected game, or null when nothing is selected OR the selected
   * slot has gone missing (data lost on a later refresh) — either way there
   * is nothing to show a detail view for, so `render` falls back to the
   * grid. Computed fresh every call rather than cached, so `render` never
   * mutates `this.selected` (a page must not mutate its own state inside
   * `render`) — `onKeyPress` calls this too, so the two stay consistent. */
  private activeGame(): GameSummary | null {
    if (!this.selected) return null
    return this.source.getGame(this.selected.team, this.selected.slot)
  }

  render(_now: number): DeckFrame {
    const status = this.source.getStatus()
    const stale = this.source.isStale()
    const dim = stale || status !== 'ok'

    const game = this.activeGame()
    if (game && this.selected) return this.detailFrame(this.selected.team, game, dim)

    const keys: KeySpec[] = [
      this.logoKey('jaguars', dim),
      this.gameKey('jaguars', 'next', dim),
      this.gameKey('jaguars', 'last', dim),
      { kind: 'blank' },
      this.logoKey('gators', dim),
      this.gameKey('gators', 'next', dim),
      this.gameKey('gators', 'last', dim),
      { kind: 'blank' },
    ]

    return { keys, strip: this.strip(), buttons: [theme.gray, theme.gray] }
  }

  /** Keys 0 and 4: a team's logo once decoded, or its name while the image
   * is still downloading — the same fallback-then-image shape
   * `spotify-page.ts` uses for album art. */
  private logoKey(team: Team, dim: boolean): KeySpec {
    const logo = this.source.getLogo(team)
    if (logo) {
      return { kind: 'image', image: logo, imageKey: team, dim }
    }
    // Matches `spotify-page.ts`'s own art-not-ready fallback: `dim` follows
    // the page's OWN freshness signal, not a hard-coded true — a logo still
    // downloading on an otherwise-fresh page is not "stale data".
    return { kind: 'control', lines: [TEAM_LABELS[team]], align: 'center', dim }
  }

  /** Keys 1, 2, 5 and 6: one NEXT or LAST game tile. Empty (no game known
   * for this slot yet) draws the same dashed placeholder shape the weather
   * page uses for a missing day, rather than a bare, left-hugging fallback. */
  private gameKey(team: Team, slot: Slot, dim: boolean): KeySpec {
    const game = this.source.getGame(team, slot)
    const header = slot === 'next' ? 'NEXT' : 'LAST'
    if (!game) {
      return {
        kind: 'gauge',
        lines: [header, '--', '--'],
        lineSizes: [HEADER_SIZE, OPPONENT_SIZES, DATE_SIZE],
        align: 'center',
        dim: true,
      }
    }

    const lastLine = slot === 'next' ? formatKickoff(game.kickoffEpochMs) : formatScore(game)
    const key: KeySpec = {
      kind: 'gauge',
      lines: [header, game.opponent || '--', formatShortDate(game.kickoffEpochMs), lastLine],
      lineSizes: [HEADER_SIZE, OPPONENT_SIZES, DATE_SIZE, slot === 'next' ? TIME_SIZES : SCORE_SIZES],
    }
    if (dim) key.dim = true
    return key
  }

  /**
   * The detail view for one game, spread across all eight keys:
   *
   * - Key 0: the same tile shown on the grid, so the tile the user just
   *   pressed stays recognisable inside the detail view.
   * - Key 1: DATE.
   * - Key 2: KICKOFF (or `TBA`).
   * - Key 3: HOME/AWAY, or FINAL once the game has been played.
   * - Key 4: VENUE, wrapped.
   * - Key 5: CITY, wrapped.
   * - Key 6: SCORE (`--` for a game not yet played).
   * - Key 7: BACK.
   */
  private detailFrame(team: Team, game: GameSummary, dim: boolean): DeckFrame {
    const slot = this.selected!.slot
    const keys: KeySpec[] = [
      this.gameKey(team, slot, dim),
      this.labelKey('DATE', formatShortDate(game.kickoffEpochMs), DATE_SIZE, dim),
      this.labelKey('KICKOFF', formatKickoff(game.kickoffEpochMs), TIME_SIZES, dim),
      this.labelKey('STATUS', game.finished ? 'FINAL' : game.isHome ? 'HOME' : 'AWAY', STATUS_SIZE, dim),
      this.wrappedKey('VENUE', game.venue, dim),
      this.wrappedKey('CITY', game.city, dim),
      this.labelKey('SCORE', formatScore(game), SCORE_SIZES, dim),
      this.backKey(),
    ]
    return { keys, strip: this.detailStrip(team, game), buttons: [theme.gray, theme.gray] }
  }

  /** A simple header-plus-value tile, used for the detail view's fixed-fact
   * keys. `valueSize` is either a fixed size (bounded text) or a candidate
   * array (variable-length text) — the renderer resolves either, per
   * `KeySpec.lineSizes`'s own doc comment. */
  private labelKey(label: string, value: string, valueSize: number | number[], dim: boolean): KeySpec {
    const key: KeySpec = {
      kind: 'gauge',
      lines: [label, value || '--'],
      lineSizes: [HEADER_SIZE, valueSize],
    }
    if (dim) key.dim = true
    return key
  }

  /** The VENUE and CITY detail keys: a header plus up to `WRAP_LINES` of
   * wrapped text, so a venue name too long for one line (`Ben Hill Griffin
   * Stadium`, measured well past the 81 px budget at every candidate size)
   * still shows most of itself instead of one truncated fragment. */
  private wrappedKey(label: string, text: string, dim: boolean): KeySpec {
    const wrapped = wrapText(text || '--', WRAP_CHARS, WRAP_LINES)
    const key: KeySpec = {
      kind: 'gauge',
      lines: [label, ...wrapped],
      lineSizes: [HEADER_SIZE, ...wrapped.map(() => OPPONENT_SIZES)],
    }
    if (dim) key.dim = true
    return key
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

  /** The nearer of the two teams' NEXT games — the one with the smaller
   * known kickoff. A team with no known kickoff never wins this comparison
   * over one that has one; two unknown kickoffs fall back to `jaguars`
   * arbitrarily (both equally unknown, so there is no wrong answer). */
  private nearestNext(): { team: Team; game: GameSummary } | null {
    let best: { team: Team; game: GameSummary } | null = null
    for (const team of TEAMS) {
      const game = this.source.getGame(team, 'next')
      if (!game) continue
      if (!best) {
        best = { team, game }
        continue
      }
      if (game.kickoffEpochMs === null) continue
      if (best.game.kickoffEpochMs === null || game.kickoffEpochMs < best.game.kickoffEpochMs) {
        best = { team, game }
      }
    }
    return best
  }

  private strip(): StripSpec {
    const status = this.source.getStatus()
    const nearest = this.nearestNext()

    let line1: string
    if (!nearest) {
      line1 = status === 'empty' ? 'football: no upcoming games yet' : 'football: no upcoming games'
    } else {
      const weekday = shortWeekday(nearest.game.kickoffEpochMs)
      const time = formatKickoff(nearest.game.kickoffEpochMs)
      const when = weekday ? `${weekday} ${time}` : time
      line1 = `${when} · ${TEAM_SHORT[nearest.team]} vs ${nearest.game.opponent}`
    }

    const updatedAt = this.source.getLastUpdatedAt()
    const line2 =
      status === 'offline' ? 'offline' : updatedAt > 0 ? `updated ${formatEasternTime(updatedAt * 1000)}` : 'updated --'

    return { lines: [truncate(line1, STRIP_CHARS), truncate(line2, STRIP_CHARS)] }
  }

  private detailStrip(team: Team, game: GameSummary): StripSpec {
    const line1 = truncate(`${TEAM_LABELS[team]} vs ${game.opponent || '--'}`, STRIP_CHARS)
    const line2 = truncate(`${game.venue || '--'} · ${game.city || '--'}`, STRIP_CHARS)
    const status = this.source.getStatus()
    const updatedAt = this.source.getLastUpdatedAt()
    const right =
      status === 'offline' ? 'offline' : updatedAt > 0 ? `updated ${formatEasternTime(updatedAt * 1000)}` : '--'
    return { lines: [line1, line2], right }
  }

  onKeyPress(index: number): PressOutcome {
    const game = this.activeGame()
    if (game && this.selected) {
      if (index === 7) {
        this.selected = null
        return 'handled'
      }
      // Keys 0 to 6 do nothing while a game is selected. Read-only: no
      // refresh-on-press, no browser.
      return 'ignored'
    }

    // Grid mode. Logo tiles (0, 4) and the two blank spacers (3, 7) carry no
    // action, per the task brief: "logo tiles and empty slots report
    // ignored."
    const target = GRID_TARGETS[index]
    if (!target) return 'ignored'
    const [team, slot] = target
    if (!this.source.getGame(team, slot)) return 'ignored'
    this.selected = { team, slot }
    return 'handled'
  }
}

/** Maps a grid key index to the team/slot it selects, or `undefined` for a
 * logo tile or blank spacer. A plain lookup table, checked once here, rather
 * than a chain of `if (index === ...)` branches repeated at each call site. */
const GRID_TARGETS: Readonly<Record<number, readonly [Team, Slot] | undefined>> = {
  1: ['jaguars', 'next'],
  2: ['jaguars', 'last'],
  5: ['gators', 'next'],
  6: ['gators', 'last'],
}
