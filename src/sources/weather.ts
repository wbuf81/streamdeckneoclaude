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

export interface DayForecast {
  /** Short label for the key, for example `THU`. `NOW` for the current period. */
  label: string
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

  return { days, conditions }
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

  getDays(): DayForecast[] {
    return this.days
  }

  getConditions(): Conditions | null {
    return this.conditions
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
   * starts the poll loop. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) {
      this.stopped = false
      void this.refresh().then(() => this.schedule())
    } else if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
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
      void this.refresh().then(() => this.schedule())
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
              log.clearOnce('weather-forecast-parse')
          } else {
            log.once('weather-forecast-parse', 'Forecast response has no usable periods.')
          }
        }
      }
    }

    if (ok) this.lastSuccessAt = this.now()
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
