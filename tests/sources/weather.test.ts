import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ZIP,
  WeatherSource,
  weatherEmoji,
  shortDayLabel,
  parseForecast,
} from '../../src/sources/weather.js'

const NOW = 1_755_000_000
const FORECAST_URL = 'https://api.weather.gov/gridpoints/OKX/33,37/forecast'

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

/** A realistic 14-period series: today's afternoon, then 6 more full days. */
function fullPeriods() {
  const days = ['Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday']
  const periods = [
    period({ name: 'This Afternoon', isDaytime: true, temperature: 95, probabilityOfPrecipitation: { value: 96 } }),
    period({ name: 'Tonight', isDaytime: false, temperature: 77, shortForecast: 'Showers', probabilityOfPrecipitation: { value: 40 } }),
  ]
  for (const [i, name] of days.entries()) {
    periods.push(
      period({
        name,
        isDaytime: true,
        temperature: 95 - i,
        shortForecast: i % 2 === 0 ? 'Sunny' : 'Partly Sunny',
        probabilityOfPrecipitation: { value: 33 - i },
      }),
      period({
        name: `${name} Night`,
        isDaytime: false,
        temperature: 77 - i,
        shortForecast: 'Clear',
        probabilityOfPrecipitation: { value: null },
      }),
    )
  }
  return periods
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
        state: 'Florida',
        'state abbreviation': 'FL',
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
    const src = new WeatherSource(ZIP, undefined, () => NOW)
    expect(src.getStatus()).toBe('empty')
    expect(src.getDays()).toEqual([])
    expect(src.getConditions()).toBeNull()
    expect(src.isStale()).toBe(false)
  })

  it('resolves and reports the forecast, with the place name available', async () => {
    const { fetchFn } = build()
    const src = new WeatherSource(ZIP, fetchFn as never, () => NOW)
    await src.refresh()
    expect(src.getStatus()).toBe('ok')
    expect(src.getDays()).toHaveLength(7)
    expect(src.getPlace()).toBe('Brooklyn FL')
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

describe('ZIP', () => {
  it('is the configured ZIP code for this deck', () => {
    expect(ZIP).toBe('10001')
  })
})
