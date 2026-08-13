import { EventEmitter } from 'node:events'
import { log } from '../log.js'

/** The ZIP code this whole app forecasts for. A single-user deck needs no
 * per-user configuration. */
export const ZIP = '10001'

const ZIPPOPOTAM_BASE = 'https://api.zippopotam.us/us'
const POINTS_BASE = 'https://api.weather.gov/points'
/** NWS rejects a request with no User-Agent. */
const USER_AGENT = 'deckd/0.1 (personal use)'
/** A forecast does not change minute to minute, and this is a free public
 * service that must not be hammered. */
const POLL_MS = 15 * 60 * 1000
/** A forecast older than this counts as stale, so the page never presents an
 * old forecast as current. */
const STALE_SECONDS = 2 * 60 * 60
/**
 * I3 — the resolved gridpoint forecast URL used to be cached for the whole
 * process life with no route back to unresolved. NWS re-grids offices and
 * retires gridpoint URLs — a real, recurring behaviour, not a hypothetical —
 * so a URL that once worked can start 404ing at any time, and the source
 * kept re-hitting the dead URL forever, only recoverable with a daemon
 * restart. This many CONSECUTIVE forecast-fetch failures (network, HTTP, or
 * JSON — see `fetchForecastBody`) retire the cached URL, so the next refresh
 * re-resolves it from `/points/` using the already-cached coordinates,
 * instead of the ZIP lookup running again too. The counter only ever resets
 * on a genuine successful parse (lesson 10: a guard cleared in a `finally`
 * regardless of outcome is not a guard, it is a request storm) — never
 * cleared eagerly on every attempt, or a URL that fails every OTHER poll
 * would never accumulate enough failures to retire.
 */
const FORECAST_URL_RETIRE_AFTER_FAILURES = 3

export interface DayForecast {
  /** Short label for the key, for example `THU`. `NOW` for the current period. */
  label: string
  /**
   * A stable, UNIQUE identity for this day tile, taken from the anchor
   * period's own `startTime` plus whether the anchor is a day or a night
   * period: `"2026-08-14:day"`, never a bare calendar date. Per
   * docs/LESSONS.md lesson 19: the array this came from is rebuilt from
   * scratch on every poll, and its length and contents shift as periods
   * expire (the period at `label` "NOW" changes which real day it is every
   * time the current period ends). A page that keeps only the array INDEX
   * of the day the user opened would silently follow whatever day slides
   * into that index next, not the day the user actually selected. `id`
   * never changes for the same real day-half, so it is what a page should
   * persist across a poll instead of the index.
   *
   * A bare calendar date is NOT enough: between midnight and 06:00 local,
   * NWS emits a leading "Overnight" period (isDaytime false) whose
   * `startTime` falls on the SAME calendar date as the daytime period that
   * follows it, so tile 0 (NOW, the overnight half) and tile 1 (that same
   * date's day-plus-night pair) would collide on a bare date — a real
   * defect measured live, see docs/PROJECT-STATE.md's review history. The
   * `:day`/`:night` suffix is what makes the two tiles distinguishable.
   *
   * Empty when the anchor period carries no usable `startTime` — this tile
   * then has NO identity at all and a page must never let it be selected
   * (see `WeatherPage.activeDay`/`onKeyPress`), rather than risk two
   * identity-less tiles colliding on the same empty string.
   */
  id: string
  emoji: string
  high: number | null
  low: number | null
  /** Percent, 0 to 100, or null when unknown. */
  precipPercent: number | null
  shortForecast: string
  /**
   * The daytime half of this day, for the detail view. Null when this day
   * tile has no day period — only tile 0 ("NOW") can be missing it, when the
   * forecast opens at night.
   */
  day: PeriodDetail | null
  /**
   * The nighttime half of this day, for the detail view. Null when this day
   * tile has no night period — only the LAST tile can be missing it, when
   * the 14-period series runs out before a closing night.
   */
  night: PeriodDetail | null
}

/**
 * One half (day or night) of a day tile, carrying the fields the detail
 * view needs beyond what the grid tile's summary already has. Every field
 * comes from the SAME period object the summary already reads — no second
 * fetch, per the user's decision to use only data the source already gets.
 */
export interface PeriodDetail {
  emoji: string
  /** Degrees Fahrenheit, or null when unknown. */
  temperature: number | null
  /** Percent, 0 to 100, or null when unknown. Null must never render as 0%. */
  precipPercent: number | null
  shortForecast: string
  /** A full paragraph. The detail view truncates it; it never fits whole. */
  detailedForecast: string
  /** For example `"8 mph"` or `"5 to 9 mph"` — a string, never a number. */
  windSpeed: string
  /** For example `"NE"`. Empty when unknown. */
  windDirection: string
}

export interface Conditions {
  /** From the current period. */
  windSpeed: string
  temperature: number | null
  shortForecast: string
}

export type WeatherStatus = 'ok' | 'offline' | 'empty'

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

interface Coordinates {
  lat: number
  lon: number
  /** For example `Brooklyn FL`. Empty when the lookup carried no name. */
  place: string
}

const EMOJI_RULES: readonly (readonly [RegExp, string])[] = [
  [/thunder/i, '⛈'],
  [/snow|sleet|ice|freezing/i, '🌨'],
  [/rain|shower|drizzle/i, '🌧'],
  [/fog|haze|mist|smoke/i, '🌫'],
  [/wind/i, '💨'],
  [/mostly cloudy|overcast/i, '☁️'],
  [/partly|mostly sunny|few clouds/i, '⛅'],
  [/sunny|clear/i, '☀️'],
]

/**
 * Maps a `shortForecast` string to one emoji. The rules run in order, most
 * severe first, so a string such as `"Mostly Sunny then Chance Showers And
 * Thunderstorms"` maps to the thunderstorm icon rather than the sunny one.
 */
export function weatherEmoji(shortForecast: string): string {
  for (const [pattern, emoji] of EMOJI_RULES) {
    if (pattern.test(shortForecast)) return emoji
  }
  return '☁️'
}

/**
 * Labels a day tile. The first tile (`index === 0`) is always `NOW`,
 * whatever its name. Every other tile takes the first three letters of its
 * period name, upper-cased, and drops a trailing `Night` first, so a night
 * period's name still gives the weekday, for example `Thursday Night`
 * becomes `THU`.
 */
export function shortDayLabel(name: string, _isDaytime: boolean, index: number): string {
  if (index === 0) return 'NOW'
  const clean = name.replace(/\s+night$/i, '').trim()
  const letters = clean.slice(0, 3).toUpperCase()
  return letters || '---'
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function strOf(period: unknown, key: string): string {
  const v = asObj(period)[key]
  return typeof v === 'string' ? v : ''
}

/** The `YYYY-MM-DD` portion of a period's `startTime`, for example
 * `"2026-08-14T18:00:00-04:00"` becomes `"2026-08-14"`. Empty when `period`
 * carries no usable `startTime` — never throws, never fabricates a date. */
function dateOf(period: unknown): string {
  return strOf(period, 'startTime').slice(0, 10)
}

/**
 * The tile identity for `anchor`: its calendar date plus `:day` or `:night`,
 * so two tiles anchored on the SAME calendar date (an overnight period and
 * the daytime period that follows it, per C1) never collide. Empty when
 * `anchor` is null or carries no usable `startTime` — a tile with no
 * identity, which `WeatherPage` must never treat as selectable.
 */
function identityOf(anchor: unknown | null): string {
  if (anchor === null) return ''
  const date = dateOf(anchor)
  if (!date) return ''
  return `${date}:${boolOf(anchor, 'isDaytime') ? 'day' : 'night'}`
}

function boolOf(period: unknown, key: string): boolean {
  return asObj(period)[key] === true
}

function tempOf(period: unknown): number | null {
  const v = asObj(period).temperature
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Reads `probabilityOfPrecipitation.value`. Null (unknown or absent) stays
 * null, never 0 — a missing measurement is not the same as no rain. */
function precipOf(period: unknown): number | null {
  const p = asObj(period).probabilityOfPrecipitation
  const v = asObj(p).value
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The maximum of two precip readings, ignoring nulls. Null only when both are. */
function maxPrecip(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

function extractPeriods(body: unknown): unknown[] {
  const properties = asObj(body).properties
  const periods = asObj(properties).periods
  return Array.isArray(periods) ? periods : []
}

function extractConditions(period: unknown): Conditions {
  return {
    windSpeed: strOf(period, 'windSpeed'),
    temperature: tempOf(period),
    shortForecast: strOf(period, 'shortForecast'),
  }
}

/**
 * Builds the detail-view fields for one half (day or night) of a day tile,
 * straight from the same period object `buildDay` already reads for the
 * summary fields. Null in, null out: a day tile can be missing its day half
 * (the forecast opens at night) or its night half (the periods run out),
 * and the detail view must show that as unknown, never fabricate a period.
 */
function periodDetail(period: unknown | null): PeriodDetail | null {
  if (period === null) return null
  const shortForecast = strOf(period, 'shortForecast')
  return {
    emoji: weatherEmoji(shortForecast),
    temperature: tempOf(period),
    precipPercent: precipOf(period),
    shortForecast,
    detailedForecast: strOf(period, 'detailedForecast'),
    windSpeed: strOf(period, 'windSpeed'),
    windDirection: strOf(period, 'windDirection'),
  }
}

/**
 * Builds one day tile from a day period, a night period, or both. Either may
 * be null: the first tile is `null` for the day half when the forecast opens
 * at night, and the last tile is `null` for the night half when the periods
 * run out. The label is passed in already resolved, because the two halves
 * disagree on `index`.
 */
function buildDay(label: string, day: unknown | null, night: unknown | null): DayForecast {
  const high = day !== null ? tempOf(day) : null
  const low = night !== null ? tempOf(night) : null
  const precipPercent = maxPrecip(
    day !== null ? precipOf(day) : null,
    night !== null ? precipOf(night) : null,
  )
  const anchor = day ?? night
  const shortForecast = strOf(anchor, 'shortForecast')
  return {
    label,
    id: identityOf(anchor),
    emoji: weatherEmoji(shortForecast),
    high,
    low,
    precipPercent,
    shortForecast,
    day: periodDetail(day),
    night: periodDetail(night),
  }
}

/**
 * Parses `properties.periods` into at most 7 day tiles plus the current
 * conditions. The API alternates day and night periods, so this pairs each
 * daytime period with the night period that follows it for the low. A body
 * with no usable periods returns an empty result rather than throwing.
 */
export function parseForecast(
  body: unknown,
  _now: number,
): { days: DayForecast[]; conditions: Conditions | null } {
  const periods = extractPeriods(body)
  if (periods.length === 0) return { days: [], conditions: null }

  const conditions = extractConditions(periods[0])
  const days: DayForecast[] = []
  let i: number

  const p0 = periods[0]
  if (boolOf(p0, 'isDaytime')) {
    const p1 = periods[1] as unknown | undefined
    const hasNight = p1 !== undefined && !boolOf(p1, 'isDaytime')
    days.push(buildDay('NOW', p0, hasNight ? p1! : null))
    i = hasNight ? 2 : 1
  } else {
    days.push(buildDay('NOW', null, p0))
    i = 1
  }

  while (i < periods.length && days.length < 7) {
    const day = periods[i]
    const night = periods[i + 1] as unknown | undefined
    const hasNight = night !== undefined && !boolOf(night, 'isDaytime')
    const label = shortDayLabel(strOf(day, 'name'), boolOf(day, 'isDaytime'), days.length)
    days.push(buildDay(label, day, hasNight ? night! : null))
    i += hasNight ? 2 : 1
  }

  checkIdentitiesUnique(days)
  return { days, conditions }
}

/**
 * Per C1: an identity that is not actually unique is the same failure as no
 * identity at all — `Array.prototype.find` silently returns the wrong tile.
 * This never throws (a page must keep working), but a collision between two
 * REAL identities (both non-empty) is a defect in the data or in
 * `identityOf` itself, so it is logged loudly rather than trusted silently.
 * A period with no `startTime` gives the empty-string identity, which is
 * expected to repeat (every identity-less tile is equally unselectable) and
 * is not logged here.
 */
function checkIdentitiesUnique(days: readonly DayForecast[]): void {
  const seen = new Set<string>()
  for (const d of days) {
    if (d.id === '') continue
    if (seen.has(d.id)) {
      // M8: one fixed key for every collision, not one embedding the
      // colliding id. The id is a date, so a key built from it grows without
      // bound over the process life (`createLogger`'s `seen` set is
      // unbounded) — every other `log.once` key in the family is either
      // fixed or bounded by the eight symbols. The id itself still appears
      // in the MESSAGE, just not in the key that gates repetition.
      log.once(
        'weather-day-identity-collision',
        `Two day tiles resolved to the same identity (${d.id}); the day tile is unreliable this poll.`,
      )
      continue
    }
    seen.add(d.id)
  }
}

function parseZipBody(body: unknown): Coordinates | null {
  const places = asObj(body).places
  if (!Array.isArray(places) || places.length === 0) return null
  const p = asObj(places[0])
  const lat = typeof p.latitude === 'string' ? Number.parseFloat(p.latitude) : NaN
  const lon = typeof p.longitude === 'string' ? Number.parseFloat(p.longitude) : NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const name = typeof p['place name'] === 'string' ? (p['place name'] as string) : ''
  const stateAbbr =
    typeof p['state abbreviation'] === 'string' ? (p['state abbreviation'] as string) : ''
  const place = [name, stateAbbr].filter(Boolean).join(' ')
  return { lat, lon, place }
}

function extractForecastUrl(body: unknown): string | null {
  const forecast = asObj(asObj(body).properties).forecast
  return typeof forecast === 'string' && forecast ? forecast : null
}

/**
 * Reads the US National Weather Service forecast for a fixed ZIP code. It
 * resolves the ZIP to coordinates and the coordinates to a forecast URL only
 * once per process, then re-fetches only the forecast itself on each poll —
 * re-resolving every time would triple the request count for no benefit. It
 * polls only while the page is visible, at 15 minutes, and it never wipes the
 * last known forecast on a failure: it reports `offline` and keeps showing
 * what it had.
 */
export class WeatherSource extends EventEmitter {
  private days: DayForecast[] = []
  private conditions: Conditions | null = null
  private status: WeatherStatus = 'empty'
  private coords: Coordinates | null = null
  private forecastUrl: string | null = null
  /** I3 — consecutive forecast-fetch failures against the CURRENT
   * `forecastUrl`. Reset to 0 only on a genuine successful parse; a run of
   * `FORECAST_URL_RETIRE_AFTER_FAILURES` retires the URL so the next refresh
   * re-resolves it. */
  private forecastFailures = 0
  private lastSuccessAt = 0
  private timer: NodeJS.Timeout | null = null
  private visible = false
  /** Set by `stop()`, so a refresh continuation already in flight cannot arm
   * a new timer after shutdown. See `schedule()`, which checks this first. */
  private stopped = false
  private inFlight: Promise<void> | null = null
  private lastKey = ''

  constructor(
    private readonly zip: string = ZIP,
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super()
  }

  /** Test helper. Swaps the fetch implementation mid-test. */
  setFetchForTest(f: FetchLike): void {
    this.fetchFn = f
  }

  /**
   * I2: this used to return `this.days` itself — no copy at all, at either
   * the array or the `DayForecast` level. A caller mutating a returned tile
   * (or its nested `day`/`night` detail) corrupted the source's own live
   * forecast. A new array, holding a new object per day, holding a new
   * object for each non-null `day`/`night` half, is deep enough — every
   * other field on `DayForecast` and `PeriodDetail` is a primitive.
   */
  getDays(): DayForecast[] {
    return this.days.map((d) => ({
      ...d,
      day: d.day ? { ...d.day } : null,
      night: d.night ? { ...d.night } : null,
    }))
  }

  /** I2: `Conditions` is flat, so a shallow copy is deep enough — this used
   * to return the live object itself. */
  getConditions(): Conditions | null {
    return this.conditions ? { ...this.conditions } : null
  }

  getStatus(): WeatherStatus {
    return this.status
  }

  /** Epoch seconds of the newest successful forecast response, or 0 before one. */
  getLastUpdatedAt(): number {
    return this.lastSuccessAt
  }

  /** For example `Brooklyn FL`. Empty before the ZIP resolves. */
  getPlace(): string {
    return this.coords?.place ?? ''
  }

  /** True when the last successful fetch is older than 2 hours. False before
   * the first success — there is nothing stale about data that never arrived;
   * that case is `empty`, not stale. */
  isStale(): boolean {
    if (this.lastSuccessAt === 0) return false
    return this.now() - this.lastSuccessAt > STALE_SECONDS
  }

  /** Called when the weather page becomes visible. It refreshes at once and
   * starts the poll loop. I5: a source that has already been `stop()`ped
   * stays stopped — this never clears `stopped`, so a stray
   * `setVisible(true)` after shutdown cannot restart polling. Matches
   * `CodexSource`, the one sibling that already made `stopped` a one-way
   * latch. */
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

  /** M4: `refresh()` should not reject in practice — every network step
   * inside `doRefresh` already catches its own failure — but this loop runs
   * on a `setTimeout` chain, not `setInterval`: an uncaught rejection here
   * would silently stop `schedule()` from ever running again, unlike
   * `CodexSource`'s `setInterval` (which keeps ticking on its own) or
   * `SpotifySource.pollAndSchedule` (which already has this shape). A stray
   * failure is logged rather than swallowed, and polling continues either
   * way via the `finally`. */
  private async refreshAndSchedule(): Promise<void> {
    try {
      await this.refresh()
    } catch (e) {
      log.once('weather-refresh-unexpected', `weather refresh failed unexpectedly: ${String(e)}`)
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

  private async resolveZip(): Promise<Coordinates | null> {
    if (this.coords) return this.coords
    let res
    try {
      res = await this.fetchFn(`${ZIPPOPOTAM_BASE}/${encodeURIComponent(this.zip)}`, {
        headers: { 'User-Agent': USER_AGENT },
      })
    } catch (e) {
      // Runs on every poll while the network stays down, so it must log once.
      log.once('weather-zip-network', `ZIP lookup failed: ${String(e)}`)
      return null
    }
    log.clearOnce('weather-zip-network')
    if (!res.ok) {
      log.once('weather-zip-http', `ZIP lookup failed with status ${res.status}.`)
      return null
    }
    log.clearOnce('weather-zip-http')
    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      log.once('weather-zip-json', `ZIP lookup response is not valid JSON: ${String(e)}`)
      return null
    }
    log.clearOnce('weather-zip-json')
    const coords = parseZipBody(body)
    if (!coords) {
      log.once('weather-zip-parse', 'ZIP lookup response has no usable place data.')
      return null
    }
    log.clearOnce('weather-zip-parse')
    this.coords = coords
    return coords
  }

  private async resolvePoints(coords: Coordinates): Promise<string | null> {
    if (this.forecastUrl) return this.forecastUrl
    let res
    try {
      res = await this.fetchFn(`${POINTS_BASE}/${coords.lat},${coords.lon}`, {
        headers: { 'User-Agent': USER_AGENT },
      })
    } catch (e) {
      log.once('weather-points-network', `Points lookup failed: ${String(e)}`)
      return null
    }
    log.clearOnce('weather-points-network')
    if (!res.ok) {
      log.once('weather-points-http', `Points lookup failed with status ${res.status}.`)
      return null
    }
    log.clearOnce('weather-points-http')
    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      log.once('weather-points-json', `Points lookup response is not valid JSON: ${String(e)}`)
      return null
    }
    log.clearOnce('weather-points-json')
    const url = extractForecastUrl(body)
    if (!url) {
      log.once('weather-points-parse', 'Points lookup response has no forecast URL.')
      return null
    }
    log.clearOnce('weather-points-parse')
    this.forecastUrl = url
    return url
  }

  private async fetchForecastBody(url: string): Promise<unknown> {
    let res
    try {
      res = await this.fetchFn(url, { headers: { 'User-Agent': USER_AGENT } })
    } catch (e) {
      log.once('weather-forecast-network', `Forecast fetch failed: ${String(e)}`)
      return undefined
    }
    log.clearOnce('weather-forecast-network')
    if (!res.ok) {
      log.once('weather-forecast-http', `Forecast fetch failed with status ${res.status}.`)
      return undefined
    }
    log.clearOnce('weather-forecast-http')
    try {
      const body = await res.json()
      log.clearOnce('weather-forecast-json')
      return body
    } catch (e) {
      log.once('weather-forecast-json', `Forecast response is not valid JSON: ${String(e)}`)
      return undefined
    }
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /**
   * Emits `change` only when the whole parsed snapshot (days, conditions,
   * and status) actually differs from the last one, following the pattern in
   * `src/sources/claude.ts`: a partial comparison key can miss a real update
   * and leave stale text on the deck.
   */
  private async doRefresh(): Promise<void> {
    let ok = false

    const coords = await this.resolveZip()
    if (coords) {
      const url = await this.resolvePoints(coords)
      if (url) {
        const body = await this.fetchForecastBody(url)
        if (body !== undefined) {
          const parsed = parseForecast(body, this.now())
          if (parsed.days.length > 0) {
            this.days = parsed.days
            this.conditions = parsed.conditions
            ok = true
            this.forecastFailures = 0
            log.clearOnce('weather-forecast-parse')
          } else {
            log.once('weather-forecast-parse', 'Forecast response has no usable periods.')
          }
        } else {
          // I3: `fetchForecastBody` already logged the specific reason
          // (network, HTTP, or JSON). This counts consecutive failures
          // against the CURRENT url specifically, so a genuinely dead
          // gridpoint URL (NWS re-grid, a retired endpoint) is eventually
          // retired instead of retried forever.
          this.forecastFailures++
          if (this.forecastFailures >= FORECAST_URL_RETIRE_AFTER_FAILURES) {
            this.forecastUrl = null
            this.forecastFailures = 0
            log.once(
              'weather-forecast-url-retired',
              `Forecast URL failed ${FORECAST_URL_RETIRE_AFTER_FAILURES} times in a row; re-resolving from /points/ on the next refresh.`,
            )
          }
        }
      }
    }

    if (ok) {
      this.lastSuccessAt = this.now()
      log.clearOnce('weather-forecast-url-retired')
    }
    this.status = ok ? 'ok' : this.days.length > 0 ? 'offline' : 'empty'

    const key = JSON.stringify({
      days: this.days,
      conditions: this.conditions,
      status: this.status,
      lastSuccessAt: this.lastSuccessAt,
    })
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit('change')
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
