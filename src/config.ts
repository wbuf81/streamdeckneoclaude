import { readFileSync } from 'node:fs'
import { paths } from './paths.js'
import { log } from './log.js'

/**
 * User configuration, read once at startup from `config.json` in the state
 * directory.
 *
 * Everything here used to be a hardcoded constant, tuned to the author's own
 * ZIP code, watchlist, teams, and LAN. That made the daemon useless to anyone
 * else and put a home town in the source tree. The values now live outside the
 * repository, in the same 0600 file that already held the Spotify client id.
 *
 * Two rules shape this module, and both come from AGENTS.md:
 *
 * - **One bad section must not stop the daemon, or any unrelated page.** Each
 *   section is validated on its own. A malformed `football` block disables the
 *   football page and nothing else.
 * - **An absent signal is unknown, never a safe default.** Where no generic
 *   default can be correct — a ZIP code, a pair of teams, the address of a
 *   device on your own network — the section is absent and the page that needs
 *   it is not added at all. Only the watchlist gets a default, because a
 *   broad-market list is a real answer rather than a guess about you.
 */

/** The default watchlist, used when `stocks.symbols` is absent. Deliberately
 * generic: broad-market ETFs and the largest listed names, so a fresh install
 * shows a working page that reveals nothing about whoever installed it. */
export const DEFAULT_SYMBOLS: readonly string[] = [
  'SPY', 'QQQ', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META',
]

/** The stocks page draws one symbol per key, and the deck has eight keys. */
export const MAX_SYMBOLS = 8

export type League = 'nfl' | 'college-football'

/** One configured team. `id` is this team's key everywhere else in the code,
 * so it must be unique within a configuration. */
export interface TeamConfig {
  readonly id: string
  /** Shown on the team's own key, for example `GATORS`. */
  readonly label: string
  /** The short code used on the schedule tape, for example `UF`. */
  readonly short: string
  readonly league: League
  /** ESPN's own numeric team id, as a string. */
  readonly espnId: string
  /**
   * The exact string ESPN's `name` field uses for this team. It is the key
   * that lets `splitEventName` pull the OPPONENT's name out of
   * "Away Team at Home Team" without an extra request per game, so a wrong
   * value here costs one request per event rather than failing loudly.
   */
  readonly fullName: string
  readonly logoUrl: string
}

/** Exactly two teams: the football page draws one row each, top then bottom. */
export type TeamPair = readonly [TeamConfig, TeamConfig]

export interface DeckConfig {
  /** Empty until `deckd auth spotify` runs. */
  readonly spotifyClientId: string
  /** A US ZIP code, or null when unconfigured. Null omits the weather page. */
  readonly zip: string | null
  /** Never empty. Falls back to `DEFAULT_SYMBOLS`. */
  readonly symbols: readonly string[]
  /** Null omits the football page. */
  readonly teams: TeamPair | null
  /** Hostnames or addresses for the companion knob display, most likely
   * first. Empty disables the heartbeat entirely. */
  readonly knobHosts: readonly string[]
}

/** What a completely absent or unreadable config file yields. */
export const EMPTY_CONFIG: DeckConfig = {
  spotifyClientId: '',
  zip: null,
  symbols: DEFAULT_SYMBOLS,
  teams: null,
  knobHosts: [],
}

type Raw = Record<string, unknown>

function asRecord(v: unknown): Raw | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const item of v) {
    const s = asString(item)
    if (s === null) return null
    out.push(s)
  }
  return out
}

/**
 * A US ZIP code, five digits. Rejected rather than passed through, because
 * `api.zippopotam.us` answers a malformed code with a 404 that the weather
 * source would report as an outage rather than as a configuration mistake.
 */
function parseZip(raw: Raw, warn: (m: string) => void): string | null {
  const section = asRecord(raw['weather'])
  if (!section) return null
  const zip = asString(section['zip'])
  if (zip === null) return null
  if (!/^\d{5}$/.test(zip)) {
    warn(`weather.zip must be five digits; ignoring ${JSON.stringify(zip)}. The weather page is off.`)
    return null
  }
  return zip
}

function parseSymbols(raw: Raw, warn: (m: string) => void): readonly string[] {
  const section = asRecord(raw['stocks'])
  if (!section) return DEFAULT_SYMBOLS
  if (section['symbols'] === undefined) return DEFAULT_SYMBOLS
  const symbols = asStringArray(section['symbols'])
  if (symbols === null || symbols.length === 0) {
    warn('stocks.symbols must be a non-empty array of strings. Using the default watchlist.')
    return DEFAULT_SYMBOLS
  }
  const upper = symbols.map((s) => s.toUpperCase())
  if (upper.length > MAX_SYMBOLS) {
    warn(`stocks.symbols holds ${upper.length} symbols; the deck shows ${MAX_SYMBOLS}. Ignoring the rest.`)
    return upper.slice(0, MAX_SYMBOLS)
  }
  return upper
}

const LEAGUES: readonly string[] = ['nfl', 'college-football']

function parseTeam(v: unknown, where: string, warn: (m: string) => void): TeamConfig | null {
  const r = asRecord(v)
  if (!r) {
    warn(`football.${where} must be an object.`)
    return null
  }
  const id = asString(r['id'])
  const label = asString(r['label'])
  const short = asString(r['short'])
  const league = asString(r['league'])
  const espnId = asString(r['espnId'])
  const fullName = asString(r['fullName'])
  const logoUrl = asString(r['logoUrl'])
  const missing = [
    ['id', id], ['label', label], ['short', short],
    ['league', league], ['espnId', espnId], ['fullName', fullName], ['logoUrl', logoUrl],
  ].filter(([, value]) => value === null).map(([name]) => name)
  if (missing.length > 0) {
    warn(`football.${where} is missing ${missing.join(', ')}.`)
    return null
  }
  if (!LEAGUES.includes(league!)) {
    warn(`football.${where}.league must be one of ${LEAGUES.join(' or ')}; got ${JSON.stringify(league)}.`)
    return null
  }
  return {
    id: id!, label: label!, short: short!,
    league: league as League, espnId: espnId!, fullName: fullName!, logoUrl: logoUrl!,
  }
}

/**
 * Both teams, or null. There is no one-team form: the page's whole layout is
 * two rows, so a half-configured section is a mistake to report rather than a
 * shape to render around.
 */
function parseTeams(raw: Raw, warn: (m: string) => void): TeamPair | null {
  const section = asRecord(raw['football'])
  if (!section) return null
  const top = parseTeam(section['top'], 'top', warn)
  const bottom = parseTeam(section['bottom'], 'bottom', warn)
  if (!top || !bottom) {
    warn('football needs a valid `top` and `bottom` team. The football page is off.')
    return null
  }
  if (top.id === bottom.id) {
    warn(`football.top and football.bottom share the id ${JSON.stringify(top.id)}. The football page is off.`)
    return null
  }
  return [top, bottom]
}

function parseKnobHosts(raw: Raw, warn: (m: string) => void): readonly string[] {
  const section = asRecord(raw['knob'])
  if (!section) return []
  if (section['hosts'] === undefined) return []
  const hosts = asStringArray(section['hosts'])
  if (hosts === null) {
    warn('knob.hosts must be an array of strings. The knob heartbeat is off.')
    return []
  }
  return hosts
}

function parseSpotifyClientId(raw: Raw): string {
  const section = asRecord(raw['spotify'])
  if (!section) return ''
  return asString(section['clientId']) ?? ''
}

/**
 * Parses an already-loaded config object. Separated from the file read so a
 * test can drive every branch without touching a real path, and so a caller
 * that gets the JSON some other way can reuse the same validation.
 *
 * `warn` receives one message per problem found. Nothing here throws: a
 * configuration mistake disables the feature it belongs to and is reported,
 * because a daemon that refuses to start leaves the deck showing whatever was
 * on it when the Mac last slept.
 */
export function parseConfig(value: unknown, warn: (m: string) => void = (m) => log.warn(m)): DeckConfig {
  const raw = asRecord(value)
  if (!raw) {
    warn('config.json must hold a JSON object. Using defaults.')
    return EMPTY_CONFIG
  }
  return {
    spotifyClientId: parseSpotifyClientId(raw),
    zip: parseZip(raw, warn),
    symbols: parseSymbols(raw, warn),
    teams: parseTeams(raw, warn),
    knobHosts: parseKnobHosts(raw, warn),
  }
}

/**
 * Reads and parses `config.json`.
 *
 * An absent file is normal and silent — it is what a fresh install has, and
 * `EMPTY_CONFIG` is a working deck with four pages. Any other read or parse
 * failure is reported, because it means a file that exists is not being
 * honoured, which is far more confusing than one that is missing.
 */
export function loadConfig(
  file: string = paths.configFile,
  warn: (m: string) => void = (m) => log.warn(m),
): DeckConfig {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      warn(`cannot read ${file}: ${String(e)}. Using defaults.`)
    }
    return EMPTY_CONFIG
  }
  try {
    return parseConfig(JSON.parse(text), warn)
  } catch (e: unknown) {
    warn(`${file} is not valid JSON: ${String(e)}. Using defaults.`)
    return EMPTY_CONFIG
  }
}
