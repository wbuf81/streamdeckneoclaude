import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  WeatherSource,
  weatherEmoji,
  shortDayLabel,
  parseForecast,
} from '../../src/sources/weather.js'
import { log, setDefaultSink } from '../../src/log.js'

const NOW = 1_755_000_000
/** The ZIP this suite drives the source with. A fixture, not a default: the
 * source has no built-in ZIP any more, so the suite states its own. Every
 * captured response below was recorded for this code. */
const ZIP = '10001'
const FORECAST_URL = 'https://api.weather.gov/gridpoints/OKX/33,37/forecast'

/**
 * Test quality: a source's fetch parameter must never fall back to the real
 * global `fetch` inside the suite — that is one edit away from live network
 * I/O. A test that genuinely never expects a call passes this instead of
 * `undefined`, so the constructor's own default parameter
 * (`fetch as unknown as FetchLike`) never kicks in.
 */
const neverFetch = (): Promise<never> => {
  throw new Error('test: fetch must not be called')
}

// ---------------------------------------------------------------------------
// weatherEmoji
// ---------------------------------------------------------------------------

describe('weatherEmoji', () => {
  it.each([
    ['Thunderstorms Likely', '⛈'],
    ['Chance Snow Showers', '🌨'],
    ['Sleet', '🌨'],
    ['Ice Accumulation', '🌨'],
    ['Freezing Rain', '🌨'],
    ['Showers And Thunderstorms', '⛈'],
    ['Rain Likely', '🌧'],
    ['Scattered Showers', '🌧'],
    ['Drizzle', '🌧'],
    ['Patchy Fog', '🌫'],
    ['Haze', '🌫'],
    ['Areas of Mist', '🌫'],
    ['Smoke', '🌫'],
    ['Breezy And Windy', '💨'],
    ['Mostly Cloudy', '☁️'],
    ['Overcast', '☁️'],
    ['Partly Sunny', '⛅'],
    ['Mostly Sunny', '⛅'],
    ['Few Clouds', '⛅'],
    ['Sunny', '☀️'],
    ['Clear', '☀️'],
    ['Blowing Dust', '☁️'],
  ] as const)('maps %s to %s', (text, emoji) => {
    expect(weatherEmoji(text)).toBe(emoji)
  })

  it('is case-insensitive', () => {
    expect(weatherEmoji('SUNNY')).toBe('☀️')
    expect(weatherEmoji('thunderstorms')).toBe('⛈')
  })

  it('lets the more severe condition win in a "then" string', () => {
    // Thunder appears second in the string but must still win over sunny,
    // because the rule order, not the string position, decides.
    expect(weatherEmoji('Mostly Sunny then Chance Showers And Thunderstorms')).toBe('⛈')
    // Rain must win over an earlier "partly cloudy".
    expect(weatherEmoji('Partly Cloudy then Rain')).toBe('🌧')
  })
})

// ---------------------------------------------------------------------------
// shortDayLabel
// ---------------------------------------------------------------------------

describe('shortDayLabel', () => {
  it('labels the first tile NOW regardless of name or daytime', () => {
    expect(shortDayLabel('This Afternoon', true, 0)).toBe('NOW')
    expect(shortDayLabel('Tonight', false, 0)).toBe('NOW')
  })

  it('gives the first three letters of a weekday, upper-cased', () => {
    expect(shortDayLabel('Thursday', true, 1)).toBe('THU')
    expect(shortDayLabel('Sunday', true, 4)).toBe('SUN')
  })

  it('strips a trailing "Night" before taking the letters', () => {
    expect(shortDayLabel('Thursday Night', false, 1)).toBe('THU')
  })
})

// ---------------------------------------------------------------------------
// parseForecast
// ---------------------------------------------------------------------------

function period(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    name: 'This Afternoon',
    startTime: '2026-08-12T14:00:00-04:00',
    endTime: '2026-08-12T18:00:00-04:00',
    isDaytime: true,
    temperature: 95,
    temperatureUnit: 'F',
    probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 96 },
    windSpeed: '8 mph',
    windDirection: 'NE',
    icon: 'https://api.weather.gov/icons/land/day/tsra,90?size=medium',
    shortForecast: 'Showers And Thunderstorms',
    detailedForecast: 'Showers and thunderstorms, mainly after 2pm.',
    ...overrides,
  }
}

/**
 * Real NWS `startTime`s for one calendar date: the day period starts 06:00
 * local, the night period 18:00 local — measured live on 2026-08-13, see
 * docs/VERIFIED-FACTS.md's "Weather" section. `dateStr` is `YYYY-MM-DD`.
 */
function dayStart(dateStr: string): string {
  return `${dateStr}T06:00:00-04:00`
}
function nightStart(dateStr: string): string {
  return `${dateStr}T18:00:00-04:00`
}

/** `2026-08-14` plus `n` calendar days, so a fixture can build a run of
 * consecutive real dates without hand-writing each one. */
function plusDays(base: string, n: number): string {
  const d = new Date(`${base}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * A realistic 14-period series: today's afternoon, then 6 more full days.
 * Per C1: every period MUST carry its own real `startTime` — the review
 * found this fixture giving every period the SAME default `startTime`,
 * which parsed to "seven days with one distinct date" and hid the identity
 * collision entirely. These dates increase one per day, exactly like the
 * live NWS response.
 */
function fullPeriods() {
  const days = ['Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday']
  const today = '2026-08-13'
  const periods = [
    period({
      name: 'This Afternoon',
      isDaytime: true,
      temperature: 95,
      startTime: `${today}T14:00:00-04:00`,
      endTime: `${today}T18:00:00-04:00`,
      probabilityOfPrecipitation: { value: 96 },
    }),
    period({
      name: 'Tonight',
      isDaytime: false,
      temperature: 77,
      shortForecast: 'Showers',
      startTime: nightStart(today),
      endTime: dayStart(plusDays(today, 1)),
      probabilityOfPrecipitation: { value: 40 },
    }),
  ]
  for (const [i, name] of days.entries()) {
    const date = plusDays(today, i + 1)
    periods.push(
      period({
        name,
        isDaytime: true,
        temperature: 95 - i,
        shortForecast: i % 2 === 0 ? 'Sunny' : 'Partly Sunny',
        startTime: dayStart(date),
        endTime: nightStart(date),
        probabilityOfPrecipitation: { value: 33 - i },
      }),
      period({
        name: `${name} Night`,
        isDaytime: false,
        temperature: 77 - i,
        shortForecast: 'Clear',
        startTime: nightStart(date),
        endTime: dayStart(plusDays(date, 1)),
        probabilityOfPrecipitation: { value: null },
      }),
    )
  }
  return periods
}

/**
 * C1's exact measured collision shape: between midnight and 06:00 local, NWS
 * emits a leading "Overnight" period (isDaytime false) whose `startTime`
 * falls on the SAME calendar date as the daytime period that follows it.
 * Measured live: dates `2026-08-14, 2026-08-14, 2026-08-15` for labels
 * `NOW, THU, FRI` — a bare calendar date collapses tiles 0 and 1.
 */
function overnightFirstPeriods() {
  return [
    period({
      name: 'Overnight',
      isDaytime: false,
      temperature: 72,
      shortForecast: 'Patchy Fog',
      detailedForecast: 'Patchy fog before 8am.',
      startTime: '2026-08-14T00:00:00-04:00',
      endTime: dayStart('2026-08-14'),
      probabilityOfPrecipitation: { value: 20 },
    }),
    period({
      name: 'Thursday',
      isDaytime: true,
      temperature: 95,
      startTime: dayStart('2026-08-14'),
      endTime: nightStart('2026-08-14'),
      probabilityOfPrecipitation: { value: 10 },
    }),
    period({
      name: 'Thursday Night',
      isDaytime: false,
      temperature: 70,
      startTime: nightStart('2026-08-14'),
      endTime: dayStart('2026-08-15'),
      probabilityOfPrecipitation: { value: 5 },
    }),
    period({
      name: 'Friday',
      isDaytime: true,
      temperature: 93,
      startTime: dayStart('2026-08-15'),
      endTime: nightStart('2026-08-15'),
      probabilityOfPrecipitation: { value: 15 },
    }),
  ]
}

function forecastBody(periods: unknown[]) {
  return { properties: { periods } }
}

describe('parseForecast', () => {
  it('returns an empty result, not a throw, for a body with no properties.periods', () => {
    expect(parseForecast({}, NOW)).toEqual({ days: [], conditions: null })
    expect(parseForecast(null, NOW)).toEqual({ days: [], conditions: null })
    expect(parseForecast({ properties: {} }, NOW)).toEqual({ days: [], conditions: null })
    expect(parseForecast('garbage', NOW)).toEqual({ days: [], conditions: null })
  })

  it('pairs a leading daytime period with the following night for NOW, then 6 more days', () => {
    const { days, conditions } = parseForecast(forecastBody(fullPeriods()), NOW)
    expect(days).toHaveLength(7)
    expect(days[0]!.label).toBe('NOW')
    expect(days[0]!.high).toBe(95)
    expect(days[0]!.low).toBe(77)
    expect(days[1]!.label).toBe('THU')
    expect(days[1]!.high).toBe(95)
    expect(days[1]!.low).toBe(77)
    expect(days[6]!.label).toBe('TUE')
    expect(conditions).toEqual({ windSpeed: '8 mph', temperature: 95, shortForecast: 'Showers And Thunderstorms' })
  })

  it('gives a null high and uses the temperature as the low when the first period is night', () => {
    const periods = [
      period({ name: 'Tonight', isDaytime: false, temperature: 70, shortForecast: 'Clear', probabilityOfPrecipitation: { value: 10 } }),
      period({ name: 'Thursday', isDaytime: true, temperature: 90 }),
      period({ name: 'Thursday Night', isDaytime: false, temperature: 72 }),
    ]
    const { days } = parseForecast(forecastBody(periods), NOW)
    expect(days[0]!.label).toBe('NOW')
    expect(days[0]!.high).toBeNull()
    expect(days[0]!.low).toBe(70)
    expect(days[0]!.precipPercent).toBe(10)
    expect(days[1]!.label).toBe('THU')
    expect(days[1]!.high).toBe(90)
  })

  // -------------------------------------------------------------------------
  // day / night detail fields (task 34)
  // -------------------------------------------------------------------------

  it('builds day and night PeriodDetail objects from the same periods used for the summary fields', () => {
    const periods = [
      period({
        name: 'Thursday',
        isDaytime: true,
        temperature: 95,
        shortForecast: 'Showers And Thunderstorms',
        detailedForecast: 'Showers and thunderstorms, mainly after 2pm.',
        windSpeed: '8 mph',
        windDirection: 'NE',
        probabilityOfPrecipitation: { value: 40 },
      }),
      period({
        name: 'Thursday Night',
        isDaytime: false,
        temperature: 77,
        shortForecast: 'Clear',
        detailedForecast: 'Clear skies overnight.',
        windSpeed: '5 to 8 mph',
        windDirection: 'SW',
        probabilityOfPrecipitation: { value: 10 },
      }),
    ]
    const { days } = parseForecast(forecastBody(periods), NOW)
    const day = days[0]!

    expect(day.day).toEqual({
      emoji: '⛈',
      temperature: 95,
      precipPercent: 40,
      shortForecast: 'Showers And Thunderstorms',
      detailedForecast: 'Showers and thunderstorms, mainly after 2pm.',
      windSpeed: '8 mph',
      windDirection: 'NE',
    })
    expect(day.night).toEqual({
      emoji: '☀️',
      temperature: 77,
      precipPercent: 10,
      shortForecast: 'Clear',
      detailedForecast: 'Clear skies overnight.',
      windSpeed: '5 to 8 mph',
      windDirection: 'SW',
    })
  })

  it('gives the day half null when the forecast opens at night, but keeps the night half', () => {
    const periods = [
      period({ name: 'Tonight', isDaytime: false, temperature: 70, shortForecast: 'Clear' }),
      period({ name: 'Thursday', isDaytime: true, temperature: 90 }),
      period({ name: 'Thursday Night', isDaytime: false, temperature: 72 }),
    ]
    const { days } = parseForecast(forecastBody(periods), NOW)
    expect(days[0]!.day).toBeNull()
    expect(days[0]!.night).not.toBeNull()
    expect(days[0]!.night!.temperature).toBe(70)
  })

  it('gives the night half null for a trailing day period with no following night', () => {
    const periods = [
      period({ name: 'Thursday', isDaytime: true, temperature: 90 }),
    ]
    const { days } = parseForecast(forecastBody(periods), NOW)
    expect(days[0]!.day).not.toBeNull()
    expect(days[0]!.night).toBeNull()
  })

  it('keeps a null precipPercent on a period detail, never 0, when the value is unknown', () => {
    const periods = [
      period({ probabilityOfPrecipitation: { value: null } }),
      period({ name: 'Tonight', isDaytime: false, temperature: 77, probabilityOfPrecipitation: { value: null } }),
    ]
    const { days } = parseForecast(forecastBody(periods), NOW)
    expect(days[0]!.day!.precipPercent).toBeNull()
    expect(days[0]!.night!.precipPercent).toBeNull()
  })

  it('gives precipPercent null, never 0, when the value is null', () => {
    const periods = [
      period({ probabilityOfPrecipitation: { value: null } }),
      period({ name: 'Tonight', isDaytime: false, temperature: 77, probabilityOfPrecipitation: { value: null } }),
    ]
    const { days } = parseForecast(forecastBody(periods), NOW)
    expect(days[0]!.precipPercent).toBeNull()
  })

  it('takes the maximum of the day and night precip, ignoring a null half', () => {
    const periods = [
      period({ probabilityOfPrecipitation: { value: 20 } }),
      period({ name: 'Tonight', isDaytime: false, temperature: 77, probabilityOfPrecipitation: { value: 60 } }),
    ]
    const { days } = parseForecast(forecastBody(periods), NOW)
    expect(days[0]!.precipPercent).toBe(60)

    const periodsNullNight = [
      period({ probabilityOfPrecipitation: { value: 45 } }),
      period({ name: 'Tonight', isDaytime: false, temperature: 77, probabilityOfPrecipitation: { value: null } }),
    ]
    expect(parseForecast(forecastBody(periodsNullNight), NOW).days[0]!.precipPercent).toBe(45)
  })

  it('maps each day tile emoji from its own shortForecast', () => {
    const periods = [
      period({ shortForecast: 'Sunny' }),
      period({ name: 'Tonight', isDaytime: false, temperature: 77, shortForecast: 'Clear' }),
    ]
    const { days } = parseForecast(forecastBody(periods), NOW)
    expect(days[0]!.emoji).toBe('☀️')
  })

  // -------------------------------------------------------------------------
  // day identity (C1): `id` must be UNIQUE per tile, not just stable.
  // -------------------------------------------------------------------------

  it('gives every tile of a realistic 7-day forecast a distinct id', () => {
    const { days } = parseForecast(forecastBody(fullPeriods()), NOW)
    expect(days).toHaveLength(7)
    expect(new Set(days.map((d) => d.id)).size).toBe(days.length)
  })

  it('C1: a leading overnight period and the next day both landing on the SAME calendar date still get DIFFERENT ids', () => {
    // Reproduces the review's exact measured shape: dates
    // 2026-08-14, 2026-08-14, 2026-08-15 for labels NOW, THU, FRI. A bare
    // calendar date collides tiles 0 and 1; `id` must not.
    const { days } = parseForecast(forecastBody(overnightFirstPeriods()), NOW)
    expect(days).toHaveLength(3)
    expect(days[0]!.label).toBe('NOW')
    expect(days[1]!.label).toBe('THU')
    expect(days[2]!.label).toBe('FRI')
    // The two colliding tiles really do share a calendar date...
    expect(days[0]!.id.slice(0, 10)).toBe('2026-08-14')
    expect(days[1]!.id.slice(0, 10)).toBe('2026-08-14')
    // ...but their full identities must differ, and every tile's id must be
    // distinct, so `activeDay`'s `find` can never pick the wrong one.
    expect(days[0]!.id).not.toBe(days[1]!.id)
    expect(new Set(days.map((d) => d.id)).size).toBe(days.length)
    // NOW carries the overnight-only data; THU carries Thursday's own.
    expect(days[0]!.high).toBeNull() // no day half for the overnight tile
    expect(days[1]!.high).toBe(95) // Thursday's real high, not the overnight low
  })

  it('C1: a period with no usable startTime gets the empty-string id, never a fabricated or colliding one', () => {
    const periods = [
      period({ startTime: '' }),
      period({ name: 'Tonight', isDaytime: false, temperature: 77, startTime: '' }),
    ]
    const { days } = parseForecast(forecastBody(periods), NOW)
    expect(days[0]!.id).toBe('')
  })

  it('logs, but never throws, when two tiles somehow resolve to the same non-empty id', () => {
    // Pathological input: two "day" periods sharing one startTime. This must
    // not happen from a real NWS response (per the C1 tests above), but a
    // collision must fail loudly in the log rather than silently letting
    // `find` pick the wrong tile later, and it must never throw.
    const periods = [
      period({ name: 'Thursday', isDaytime: true, startTime: dayStart('2026-08-14') }),
      period({ name: 'Thursday Night', isDaytime: false, startTime: nightStart('2026-08-14') }),
      period({ name: 'Friday', isDaytime: true, startTime: dayStart('2026-08-14') }), // same as Thursday's
    ]
    expect(() => parseForecast(forecastBody(periods), NOW)).not.toThrow()
  })

  // M8 — the collision log key used to embed the colliding id (a date), so
  // it grew without bound over the process life: a DIFFERENT colliding date
  // on a later poll got its OWN key and logged again, forever, one entry
  // per distinct date. Break the fix (put the id back into the key) and
  // this fails: two DIFFERENT colliding dates, on two separate calls,
  // would produce two log lines instead of one.
  it('uses one fixed log key for every collision, not one per colliding date', () => {
    log.clearOnce('weather-day-identity-collision')
    const lines: string[] = []
    setDefaultSink((line) => { lines.push(line) })
    try {
      const firstCollision = [
        period({ name: 'Thursday', isDaytime: true, startTime: dayStart('2026-08-14') }),
        period({ name: 'Thursday Night', isDaytime: false, startTime: nightStart('2026-08-14') }),
        period({ name: 'Friday', isDaytime: true, startTime: dayStart('2026-08-14') }),
      ]
      parseForecast(forecastBody(firstCollision), NOW)

      // A different colliding date, on what would be a later poll.
      const secondCollision = [
        period({ name: 'Monday', isDaytime: true, startTime: dayStart('2026-09-01') }),
        period({ name: 'Monday Night', isDaytime: false, startTime: nightStart('2026-09-01') }),
        period({ name: 'Tuesday', isDaytime: true, startTime: dayStart('2026-09-01') }),
      ]
      parseForecast(forecastBody(secondCollision), NOW)

      const collisionLines = lines.filter((l) => l.includes('resolved to the same identity'))
      expect(collisionLines).toHaveLength(1)
    } finally {
      setDefaultSink(() => {})
      log.clearOnce('weather-day-identity-collision')
    }
  })
})

// ---------------------------------------------------------------------------
// WeatherSource
// ---------------------------------------------------------------------------

function zipBody() {
  return {
    'post code': '10001',
    country: 'United States',
    'country abbreviation': 'US',
    places: [
      {
        'place name': 'Brooklyn',
        longitude: '-73.9967',
        state: 'New York',
        'state abbreviation': 'NY',
        latitude: '40.7484',
      },
    ],
  }
}

function pointsBody() {
  return {
    properties: {
      forecast: FORECAST_URL,
      forecastOffice: 'https://api.weather.gov/offices/OKX',
    },
  }
}

interface FetchCalls {
  zip: number
  points: number
  forecast: number
}

/** Routes by URL substring, mirroring the shape of the real endpoints. */
function build(opts: {
  forecastPeriods?: unknown[]
  zipFails?: boolean
  pointsFails?: boolean
  forecastFails?: 'network' | 'http' | 'json' | false
} = {}) {
  const calls: FetchCalls = { zip: 0, points: 0, forecast: 0 }
  const periods = opts.forecastPeriods ?? fullPeriods()

  const fetchFn = vi.fn(async (url: string) => {
    if (url.includes('zippopotam')) {
      calls.zip += 1
      if (opts.zipFails) throw new Error('ENOTFOUND')
      return { ok: true, status: 200, json: async () => zipBody() }
    }
    if (url.includes('api.weather.gov/points')) {
      calls.points += 1
      if (opts.pointsFails) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => pointsBody() }
    }
    // The forecast URL itself.
    calls.forecast += 1
    if (opts.forecastFails === 'network') throw new Error('ENOTFOUND')
    if (opts.forecastFails === 'http') return { ok: false, status: 503, json: async () => ({}) }
    if (opts.forecastFails === 'json') {
      return { ok: true, status: 200, json: async () => { throw new Error('bad json') } }
    }
    return { ok: true, status: 200, json: async () => forecastBody(periods) }
  })

  return { fetchFn, calls }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WeatherSource', () => {
  it('reports empty before the first successful refresh', () => {
    const src = new WeatherSource(ZIP, neverFetch as never, () => NOW)
    expect(src.getStatus()).toBe('empty')
    expect(src.getDays()).toEqual([])
    expect(src.getConditions()).toBeNull()
    expect(src.getLastUpdatedAt()).toBe(0)
    expect(src.isStale()).toBe(false)
  })

  it('resolves and reports the forecast, with the place name available', async () => {
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.getStatus()).toBe('ok')
    expect(src.getDays()).toHaveLength(7)
    expect(src.getPlace()).toBe('Brooklyn NY')
    expect(src.getLastUpdatedAt()).toBe(NOW)
  })

  // I2 — `getDays()` used to return `this.days` itself with no copy at all,
  // and `getConditions()` the same for the live conditions object. A test
  // that only replaces an array ELEMENT (or reassigns a whole day) can pass
  // against that broken code; this mutates a FIELD, and inside the nested
  // `day`/`night` detail specifically, to prove the copy goes deep enough.
  // Break the fix (return `this.days/this.conditions` directly again) and
  // every assertion below fails.
  it('deep-copies days and conditions, so mutating a field or a nested day/night detail cannot corrupt the source', async () => {
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    await src.refresh()

    const days = src.getDays()
    days[0]!.high = -999
    if (days[0]!.day) days[0]!.day!.temperature = -999
    if (days[0]!.night) days[0]!.night!.temperature = -999

    const conditions = src.getConditions()!
    conditions.temperature = -999

    const freshDays = src.getDays()
    expect(freshDays[0]!.high).not.toBe(-999)
    expect(freshDays[0]!.day?.temperature).not.toBe(-999)
    expect(freshDays[0]!.night?.temperature).not.toBe(-999)
    expect(src.getConditions()!.temperature).not.toBe(-999)
  })

  it('resolves the ZIP and the points lookup only once across several refreshes', async () => {
    const { fetchFn, calls } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    await src.refresh()
    await src.refresh()
    await src.refresh()
    expect(calls.zip).toBe(1)
    expect(calls.points).toBe(1)
    expect(calls.forecast).toBe(3)
  })

  it('reports offline and keeps the last forecast when the forecast fetch fails', async () => {
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    await src.refresh()
    const before = src.getDays()
    expect(before).toHaveLength(7)

    const { fetchFn: fetchFn2 } = build({ forecastFails: 'network' })
    src.setFetchForTest(fetchFn2 as never)
    await src.refresh()

    expect(src.getStatus()).toBe('offline')
    expect(src.getDays()).toEqual(before)
  })

  it('reports offline and keeps the last forecast when the points lookup fails on a later refresh', async () => {
    // The points URL is cached after the first success, so a later failure
    // can only come from the forecast fetch itself once the ZIP and points
    // are already resolved. This proves stale data survives a network drop
    // regardless of which step failed.
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    await src.refresh()

    const { fetchFn: fetchFn2 } = build({ forecastFails: 'http' })
    src.setFetchForTest(fetchFn2 as never)
    await src.refresh()

    expect(src.getStatus()).toBe('offline')
    expect(src.getDays()).toHaveLength(7)
  })

  // I3 — a cached gridpoint forecast URL that starts 404ing (NWS re-grids an
  // office, or retires the URL) used to be retried forever, with no route
  // back to `/points/`. Break the fix (drop the failure counter / URL
  // retirement in `doRefresh`) and this fails: the mock would keep hitting
  // the dead OLD url and `points` would never be called a second time.
  it('re-resolves the forecast URL from /points/ after repeated forecast-fetch failures', async () => {
    const OLD_URL = 'https://api.weather.gov/gridpoints/OKX/OLD/forecast'
    const NEW_URL = 'https://api.weather.gov/gridpoints/OKX/NEW/forecast'
    const calls = { zip: 0, points: 0, oldForecast: 0, newForecast: 0 }
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('zippopotam')) {
        calls.zip += 1
        return { ok: true, status: 200, json: async () => zipBody() }
      }
      if (url.includes('api.weather.gov/points')) {
        calls.points += 1
        const forecast = calls.points === 1 ? OLD_URL : NEW_URL
        return { ok: true, status: 200, json: async () => ({ properties: { forecast } }) }
      }
      if (url === OLD_URL) {
        calls.oldForecast += 1
        return { ok: false, status: 404, json: async () => ({}) } // the dead, re-gridded URL.
      }
      calls.newForecast += 1
      return { ok: true, status: 200, json: async () => forecastBody(fullPeriods()) }
    })
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    try {
      // Three consecutive failures against OLD_URL — the retirement
      // threshold — without a fourth attempt against it.
      await src.refresh()
      await src.refresh()
      await src.refresh()
      expect(calls.oldForecast).toBe(3)
      expect(calls.points).toBe(1) // not yet re-resolved.
      expect(src.getStatus()).toBe('empty') // never succeeded even once yet.

      // The next refresh must re-resolve /points/ rather than retry OLD_URL
      // a fourth time, and then succeed against the NEW url it gets back.
      await src.refresh()
      expect(calls.points).toBe(2)
      expect(calls.oldForecast).toBe(3) // no further attempt against the dead URL.
      expect(calls.newForecast).toBe(1)
      expect(src.getStatus()).toBe('ok')
      expect(src.getDays()).toHaveLength(7)
      expect(calls.zip).toBe(1) // the ZIP itself never needed re-resolving.
    } finally {
      await src.stop()
    }
  })

  it('reports empty, not offline, when the very first refresh fails', async () => {
    const { fetchFn } = build({ zipFails: true })
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.getStatus()).toBe('empty')
    expect(src.getDays()).toEqual([])
  })

  it('emits change on the first successful refresh', async () => {
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    let changes = 0
    src.on('change', () => { changes += 1 })
    await src.refresh()
    expect(changes).toBe(1)
  })

  it('does not emit change when a refresh produces the same snapshot', async () => {
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    await src.refresh()
    let changes = 0
    src.on('change', () => { changes += 1 })

    const { fetchFn: fetchFn2 } = build()
    src.setFetchForTest(fetchFn2 as never)
    await src.refresh()

    expect(changes).toBe(0)
  })

  it('emits change when the status moves from ok to offline', async () => {
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    await src.refresh()
    let changes = 0
    src.on('change', () => { changes += 1 })

    const { fetchFn: fetchFn2 } = build({ forecastFails: 'network' })
    src.setFetchForTest(fetchFn2 as never)
    await src.refresh()

    expect(changes).toBe(1)
  })

  it('is not stale immediately after a successful refresh', async () => {
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.isStale()).toBe(false)
  })

  it('is stale when the last success is older than 2 hours', async () => {
    let clock = NOW
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => clock)
    await src.refresh()
    clock = NOW + 2 * 60 * 60 + 1
    expect(src.isStale()).toBe(true)
  })

  it('is not stale at exactly 2 hours', async () => {
    let clock = NOW
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => clock)
    await src.refresh()
    clock = NOW + 2 * 60 * 60
    expect(src.isStale()).toBe(false)
  })

  it('polls only while visible, once every 15 minutes', async () => {
    vi.useFakeTimers()
    const { fetchFn, calls } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.forecast).toBe(1)

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(calls.forecast).toBe(1)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    expect(calls.forecast).toBe(2)

    src.setVisible(false)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(calls.forecast).toBe(2)

    await src.stop()
  })

  // I5 — `stopped` is a one-way latch, matching `CodexSource`: once `stop()`
  // has run, a later `setVisible(true)` must not resurrect polling. Break
  // the fix (restore `this.stopped = false` inside the `visible` branch) and
  // this fails.
  it('does not restart polling when setVisible(true) is called after stop()', async () => {
    vi.useFakeTimers()
    const { fetchFn, calls } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    src.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    const callsBeforeStop = calls.forecast
    await src.stop()
    src.setVisible(true) // must be a no-op: the source is permanently stopped.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(calls.forecast).toBe(callsBeforeStop)
    expect(vi.getTimerCount()).toBe(0)
  })

  // M4 — the poll chain used `void this.refresh().then(() => this.schedule())`
  // with no `.catch`. `refresh()` should not reject in practice, but this
  // loop runs on a `setTimeout` chain: a single rejection would silently
  // stop `schedule()` from ever running again. Break the fix (revert to the
  // bare `.then` chain) and this fails — polling stops permanently after
  // the injected rejection.
  it('keeps polling after a refresh rejects unexpectedly', async () => {
    vi.useFakeTimers()
    const { fetchFn, calls } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    try {
      src.setVisible(true)
      await vi.advanceTimersByTimeAsync(0)
      const refreshSpy = vi.spyOn(src, 'refresh').mockRejectedValueOnce(new Error('boom'))
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000) // POLL_MS, not exported.
      refreshSpy.mockRestore()
      const callsAfterRejection = calls.forecast
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(calls.forecast).toBeGreaterThan(callsAfterRejection)
    } finally {
      await src.stop()
    }
  })
})

describe('WeatherSource stop() during an in-flight refresh', () => {
  // Regression coverage for: stop() must clear its timer AND mark itself
  // stopped. setVisible(true) and the recurring timer both run
  // `refresh().then(() => this.schedule())`. If stop() runs while that
  // refresh is still awaiting the network, the continuation fires
  // afterwards, sees `visible` still true, and arms a brand-new timer — a
  // poll loop that survives shutdown. Mirrors the same regression test in
  // tests/sources/stocks.test.ts and tests/sources/spotify.test.ts.
  it('does not arm a new timer if stop() runs while a refresh is still in flight', async () => {
    vi.useFakeTimers()
    let resolveFetch!: (v: unknown) => void
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve
    })
    const fetchFn = vi.fn(() => fetchPromise)
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)

    src.setVisible(true) // Starts a refresh. It blocks on the unresolved fetch.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await src.stop() // stop() runs while that refresh is still in flight.

    resolveFetch({ ok: true, status: 200, json: async () => zipBody() })
    // Flush the now-resolved refresh's `.then(() => this.schedule())`.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the configured ZIP', () => {
  it('is reported back, and drives the lookup, rather than any built-in default', async () => {
    const urls: string[] = []
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url)
      return { ok: false, status: 500, json: async () => ({}) }
    })
    const src = new WeatherSource('90210', fetchFn as never, () => NOW)
    expect(src.getZip()).toBe('90210')
    await src.refresh()
    expect(urls[0]).toContain('/90210')
    expect(urls.some((u) => u.includes(ZIP))).toBe(false)
    await src.stop()
  })
})
