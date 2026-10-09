/**
 * Live game data for the football source: the one boundary for ESPN's live schema.
 *
 * Every field that ESPN sends for a game in progress is read here and nowhere
 * else. ESPN's core API is private and undocumented, so its shape can change
 * without notice. The parsers below never throw. A field that is missing or has
 * the wrong type yields `null` (unknown), never a zero or an empty default
 * (docs/LESSONS.md #18, #20).
 *
 * Measured on 2026-10-09 against `sports.core.api.espn.com`, the open host that
 * `football.ts` already uses. Fixtures are in `tests/fixtures/football/`.
 *
 * - The event body links a status, a situation, and one score per competitor.
 *   Each is a `$ref` and costs one request.
 * - The status ref carries `{ clock, displayClock, period, type: { state,
 *   shortDetail } }`. `state` is `pre`, `in` or `post`.
 * - A score ref carries `{ value: 24.0, displayValue: '24' }`.
 * - The situation ref carries `lastPlay.$ref` and `isRedZone`. Its own `down`
 *   and `distance` are present but unlabelled, so this module does not read them.
 * - A play ref carries `shortText`, `scoringPlay`, `type.text`, and an `end`
 *   block with `shortDownDistanceText` (`2nd & 10`), `possessionText`
 *   (`TB 18`) and `team.$ref`, the team that has the ball after the play.
 *
 * No football game was live during the measurement. The `in` status shape is
 * therefore reconstructed from the real final status of the same game, and the
 * value `in` itself was measured on a live event of another sport on the same
 * host. See `tests/fixtures/football/reconstructed-in-status.json`.
 */

/** ESPN's game state. `pre` = not started, `in` = in progress (halftime
 * included), `post` = over (final, or ended some other way). */
export type LiveState = 'pre' | 'in' | 'post'

/** Which side of the game, relative to the configured team. */
export type Side = 'mine' | 'opponent'

/**
 * What a scoring event most likely was.
 *
 * A rise of 6 points or more between two reads always contains a touchdown. A
 * smaller rise uses the last play's own type when that play is a scoring play,
 * and the size of the rise otherwise. A rise of 2 with no scoring play to read
 * is `other`, because a safety and a two-point conversion are both worth 2.
 */
export type ScoreKind = 'touchdown' | 'field-goal' | 'safety' | 'conversion' | 'other'

/**
 * One score change, seen between two consecutive successful reads.
 *
 * `id` is unique for the life of the process. A page fires a one-shot
 * celebration when `id` differs from the last id it celebrated. The source
 * never creates an event from the first read of a game, so a game that was
 * already 21-7 when the deck started never fires.
 */
export interface ScoringEvent {
  /** `<gameId>:<seq>`. */
  id: string
  /** Counts up from 1 within one game. Never decreases. */
  seq: number
  side: Side
  /** The rise in that side's score. Always at least 1. */
  points: number
  kind: ScoreKind
  /** When the source SAW the change (its own clock), not when ESPN logged the play. */
  atMs: number
  /** The play id, when the last play is a scoring play. Null otherwise. */
  playId: string | null
  /** The score right after the change. */
  myScore: number
  opponentScore: number
}

/**
 * The live state of one team's current game. Returned by
 * `FootballSource.getLive(team)`.
 *
 * Every `null` means UNKNOWN. A page must draw an unknown as a placeholder,
 * never as `0`.
 */
export interface LiveGame {
  /** ESPN's event id. Matches `Game.id` in the schedule. */
  gameId: string
  /** The scheduled kickoff, from the schedule. */
  kickoffEpochMs: number
  state: LiveState
  /** ESPN's short status line: `5:35 - 4th`, `Halftime`, `Final`, `Final/OT`.
   * Empty when ESPN sent none. */
  detail: string
  /** 1-4 for the quarters, 5 and up for overtime. Null unless `state` is `in`. */
  period: number | null
  /** The game clock as ESPN prints it, `5:35`. Null unless `state` is `in`. */
  clock: string | null
  /** The same clock in seconds. Null unless `state` is `in`. */
  clockSeconds: number | null
  /** Null before kickoff and whenever a score is unknown. */
  myScore: number | null
  opponentScore: number | null
  /** Who has the ball after the last play. Null unless `state` is `in`. */
  possession: Side | null
  /** `2nd & 10`. Null unless `state` is `in`, and null after a score or at a
   * break, where ESPN sends no down. */
  downDistance: string | null
  /** The ball's spot, `TB 18`. Same null rules as `downDistance`. */
  fieldPosition: string | null
  /** Null unless `state` is `in` and ESPN sent the flag. */
  redZone: boolean | null
  /** ESPN's short text for the last play. Null unless `state` is `in`. */
  lastPlay: string | null
  /** The most recent score change, or null when none was seen. */
  lastScore: ScoringEvent | null
  /** When the source last read this game successfully (its own clock, ms). */
  updatedAtMs: number
  /**
   * True when the latest read failed, or the data is older than its state's
   * poll interval allows. The values above are the last known ones; a page
   * should dim them, not hide them.
   */
  stale: boolean
}

/** The links one game's live data is read from. */
export interface LiveRefs {
  statusUrl: string
  /** Null when the event names no situation. Down, possession and last play
   * are then unknown, but the score still works. */
  situationUrl: string | null
  myScoreUrl: string
  opponentScoreUrl: string
  opponentEspnId: string
}

export interface LiveStatus {
  state: LiveState
  /** ESPN's status name, `STATUS_IN_PROGRESS`, `STATUS_HALFTIME`, ... Empty when absent. */
  name: string
  detail: string
  period: number | null
  clock: string | null
  clockSeconds: number | null
}

export interface LiveSituation {
  lastPlayUrl: string | null
  redZone: boolean | null
}

export interface PlaySnapshot {
  id: string
  text: string | null
  scoringPlay: boolean
  /** ESPN's play type, `Passing Touchdown`. Empty when absent. */
  typeText: string
  /** The ESPN team id that has the ball after this play, or null. */
  possessionEspnId: string | null
  downDistance: string | null
  fieldPosition: string | null
}

/** One successful read of a game: the status, and the scores when the game
 * has started. */
export interface LiveReading {
  gameId: string
  kickoffEpochMs: number
  myEspnId: string
  opponentEspnId: string
  status: LiveStatus
  myScore: number | null
  opponentScore: number | null
  situation: LiveSituation | null
  play: PlaySnapshot | null
}

/** The score a later read is compared against. */
export interface ScoreBaseline {
  mine: number
  opponent: number
  atMs: number
}

/** What the source keeps per team between reads. A `LiveGame` without
 * `stale`, plus the bookkeeping scoring detection needs. */
export interface LiveEntry extends Omit<LiveGame, 'stale'> {
  /** True when the latest read of this game failed. */
  readFailed: boolean
  seq: number
  baseline: ScoreBaseline | null
}

/**
 * The longest gap between two reads that can still produce a scoring event.
 *
 * A wider gap means the deck was not watching: the page was hidden, or reads
 * kept failing. A score that changed during that gap becomes the new baseline
 * and fires nothing, which is the same rule as a first load. 150 s is longer
 * than the 120 s window cadence, so one slow read still counts as watching.
 */
export const SCORE_FRESH_MS = 150_000

/** How old live data may be before it reads as stale, per state. The `in`
 * value is three missed 20 s polls; the `pre` value is two missed 120 s polls.
 * A final score never goes stale by age. */
export const LIVE_STALE_MS: Readonly<Record<LiveState, number>> = {
  pre: 300_000,
  in: 60_000,
  post: Number.POSITIVE_INFINITY,
}

const CORE_HOST = 'sports.core.api.espn.com'

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Accepts a `$ref` only when it points at ESPN's core host, and upgrades it to
 * https. ESPN sends its refs as `http://`. A ref to any other host is refused,
 * so a changed or hostile payload cannot send this source somewhere else.
 */
export function normalizeRef(ref: unknown): string | null {
  if (typeof ref !== 'string') return null
  let url: URL
  try {
    url = new URL(ref)
  } catch {
    return null
  }
  if (url.hostname !== CORE_HOST) return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.protocol = 'https:'
  return url.toString()
}

function refOf(v: unknown): string | null {
  return normalizeRef(asObj(v)['$ref'])
}

/** The ESPN team id at the end of a `.../teams/<id>` ref, or null. */
function teamIdFromRef(ref: unknown): string | null {
  if (typeof ref !== 'string') return null
  const m = /\/teams\/(\d+)(?:[/?]|$)/.exec(ref)
  return m?.[1] ?? null
}

/**
 * Reads the live links out of an event body. Null when the event does not
 * name `myEspnId`, or lacks a status or either score link.
 */
export function parseLiveRefs(eventBody: unknown, myEspnId: string): LiveRefs | null {
  const competitions = asObj(eventBody)['competitions']
  if (!Array.isArray(competitions)) return null
  const comp = asObj(competitions[0])
  const competitors = comp['competitors']
  if (!Array.isArray(competitors) || competitors.length !== 2) return null

  let mine: Record<string, unknown> | null = null
  let opponent: Record<string, unknown> | null = null
  for (const c of competitors) {
    const o = asObj(c)
    if (o['id'] === myEspnId) mine = o
    else opponent = o
  }
  if (!mine || !opponent) return null
  const opponentEspnId = nonEmptyString(opponent['id'])
  const statusUrl = refOf(comp['status'])
  const myScoreUrl = refOf(mine['score'])
  const opponentScoreUrl = refOf(opponent['score'])
  if (!opponentEspnId || !statusUrl || !myScoreUrl || !opponentScoreUrl) return null
  return { statusUrl, situationUrl: refOf(comp['situation']), myScoreUrl, opponentScoreUrl, opponentEspnId }
}

/**
 * Reads a status body. Null when `type.state` is not one of the three known
 * values: an unknown state must not look like a game that has not started.
 *
 * The clock and period are kept only for `in`. Before and after a game ESPN
 * sends `0:00` and a period of 0 or 4, which are placeholders, not readings.
 */
export function parseStatus(body: unknown): LiveStatus | null {
  const obj = asObj(body)
  const type = asObj(obj['type'])
  const state = type['state']
  if (state !== 'pre' && state !== 'in' && state !== 'post') return null
  const detail = nonEmptyString(type['shortDetail']) ?? nonEmptyString(type['detail']) ?? ''
  const name = nonEmptyString(type['name']) ?? ''
  if (state !== 'in') return { state, name, detail, period: null, clock: null, clockSeconds: null }

  const rawPeriod = finiteNumber(obj['period'])
  const period = rawPeriod !== null && Number.isInteger(rawPeriod) && rawPeriod >= 1 ? rawPeriod : null
  const rawSeconds = finiteNumber(obj['clock'])
  const clockSeconds = rawSeconds !== null && rawSeconds >= 0 ? rawSeconds : null
  return { state, name, detail, period, clock: nonEmptyString(obj['displayClock']), clockSeconds }
}

/** Reads a score body. `value` first, then an all-digit `displayValue`.
 * Null when neither is a whole, non-negative number. */
export function parseScore(body: unknown): number | null {
  const obj = asObj(body)
  const value = finiteNumber(obj['value'])
  if (value !== null && value >= 0 && Number.isInteger(value)) return value
  const display = obj['displayValue']
  if (typeof display === 'string' && /^\d{1,3}$/.test(display)) return Number(display)
  return null
}

export function parseSituation(body: unknown): LiveSituation {
  const obj = asObj(body)
  const red = obj['isRedZone']
  return { lastPlayUrl: refOf(obj['lastPlay']), redZone: typeof red === 'boolean' ? red : null }
}

/** Reads a play body. Null when it has no id. */
export function parsePlay(body: unknown): PlaySnapshot | null {
  const obj = asObj(body)
  const id = nonEmptyString(obj['id'])
  if (!id) return null
  const end = asObj(obj['end'])
  return {
    id,
    text: nonEmptyString(obj['shortText']) ?? nonEmptyString(obj['text']),
    scoringPlay: obj['scoringPlay'] === true,
    typeText: nonEmptyString(asObj(obj['type'])['text']) ?? '',
    possessionEspnId: teamIdFromRef(asObj(end['team'])['$ref']),
    downDistance: nonEmptyString(end['shortDownDistanceText']),
    fieldPosition: nonEmptyString(end['possessionText']),
  }
}

/** See `ScoreKind`. */
export function classifyScore(points: number, play: PlaySnapshot | null): ScoreKind {
  if (points >= 6) return 'touchdown'
  if (play?.scoringPlay) {
    const t = play.typeText.toLowerCase()
    if (t.includes('touchdown')) return 'touchdown'
    if (t.includes('field goal')) return 'field-goal'
    if (t.includes('safety')) return 'safety'
    if (t.includes('extra point') || t.includes('two-point') || t.includes('conversion')) return 'conversion'
  }
  if (points === 3) return 'field-goal'
  if (points === 1) return 'conversion'
  return 'other'
}

/**
 * Decides whether one side scored between `baseline` and this read.
 *
 * Returns null when there is nothing to compare: no baseline (a first load),
 * an unknown score, or a baseline older than `SCORE_FRESH_MS`. Also null when
 * BOTH sides rose: one read cannot say which play was which, and a wrong
 * celebration is worse than a missing one. A fall (a score ESPN corrected)
 * fires nothing, and `applyLiveReading` keeps the baseline at the highest
 * score seen, so restoring the corrected score fires nothing either.
 */
export function detectScore(
  baseline: ScoreBaseline | null,
  myScore: number | null,
  opponentScore: number | null,
  nowMs: number,
): { side: Side; points: number } | null {
  if (!baseline || myScore === null || opponentScore === null) return null
  if (nowMs - baseline.atMs > SCORE_FRESH_MS) return null
  const mine = myScore - baseline.mine
  const opp = opponentScore - baseline.opponent
  if (mine > 0 && opp > 0) return null
  if (mine > 0) return { side: 'mine', points: mine }
  if (opp > 0) return { side: 'opponent', points: opp }
  return null
}

/**
 * Folds one successful read into the previous entry for the same team.
 *
 * A `prev` for a different game is ignored, so a new game starts clean. A
 * fresh `pre` read sets a 0-0 baseline: every game starts at 0-0, so a score
 * on the opening drive still fires. Any other first read only sets the
 * baseline, and fires nothing.
 */
export function applyLiveReading(prev: LiveEntry | null, r: LiveReading, nowMs: number): LiveEntry {
  const same = prev && prev.gameId === r.gameId ? prev : null
  const { status } = r
  const live = status.state === 'in'

  let myScore = status.state === 'pre' ? null : r.myScore
  let opponentScore = status.state === 'pre' ? null : r.opponentScore
  let seq = same?.seq ?? 0
  let lastScore = same?.lastScore ?? null
  let baseline = same?.baseline ?? null

  if (status.state === 'pre') {
    baseline = { mine: 0, opponent: 0, atMs: nowMs }
  } else {
    const change = detectScore(baseline, myScore, opponentScore, nowMs)
    if (change && myScore !== null && opponentScore !== null) {
      seq += 1
      const scoringPlay = r.play?.scoringPlay ? r.play : null
      lastScore = {
        id: `${r.gameId}:${seq}`,
        seq,
        side: change.side,
        points: change.points,
        kind: classifyScore(change.points, r.play),
        atMs: nowMs,
        playId: scoringPlay?.id ?? null,
        myScore,
        opponentScore,
      }
    }
    if (myScore !== null && opponentScore !== null) {
      // A HIGH-WATER mark within a fresh run of reads, so a score ESPN lowers
      // and then restores fires nothing the second time. A stale baseline is
      // replaced outright, as on a first load.
      const fresh = baseline !== null && nowMs - baseline.atMs <= SCORE_FRESH_MS
      baseline = fresh && baseline
        ? { mine: Math.max(baseline.mine, myScore), opponent: Math.max(baseline.opponent, opponentScore), atMs: nowMs }
        : { mine: myScore, opponent: opponentScore, atMs: nowMs }
    }
  }

  // An unknown score this read keeps the last known one on the glass. The
  // entry is not stale (the read worked), but the number is the previous one.
  if (myScore === null && status.state !== 'pre') myScore = same?.myScore ?? null
  if (opponentScore === null && status.state !== 'pre') opponentScore = same?.opponentScore ?? null

  const play = live ? r.play : null
  const holder = play?.possessionEspnId ?? null
  const possession: Side | null =
    holder === null ? null : holder === r.myEspnId ? 'mine' : holder === r.opponentEspnId ? 'opponent' : null

  return {
    gameId: r.gameId,
    kickoffEpochMs: r.kickoffEpochMs,
    state: status.state,
    detail: status.detail,
    period: status.period,
    clock: status.clock,
    clockSeconds: status.clockSeconds,
    myScore,
    opponentScore,
    possession,
    downDistance: play?.downDistance ?? null,
    fieldPosition: play?.fieldPosition ?? null,
    redZone: live ? r.situation?.redZone ?? null : null,
    lastPlay: play?.text ?? null,
    lastScore,
    updatedAtMs: nowMs,
    readFailed: false,
    seq,
    baseline,
  }
}

/** Marks a failed read. Every value stays as it was, so the page can keep
 * showing it dimmed. */
export function applyLiveFailure(prev: LiveEntry): LiveEntry {
  return { ...prev, readFailed: true }
}

/** The public view of an entry at `nowMs`. */
export function toLiveGame(entry: LiveEntry, nowMs: number): LiveGame {
  const { readFailed, seq: _seq, baseline: _baseline, ...rest } = entry
  const tooOld = nowMs - entry.updatedAtMs > LIVE_STALE_MS[entry.state]
  return { ...rest, lastScore: rest.lastScore ? { ...rest.lastScore } : null, stale: readFailed || tooOld }
}
