import { describe, it, expect } from 'vitest'
import { WeatherPage, conditionTint, heatColor } from '../../src/pages/weather-page.js'
import { theme } from '../../src/render/theme.js'
import { ZIP, weatherEmoji } from '../../src/sources/weather.js'
import type { Conditions, DayForecast, WeatherStatus } from '../../src/sources/weather.js'

const NOW = 1786549560

function day(label: string, over: Partial<DayForecast> = {}): DayForecast {
  return {
    label,
    emoji: '☀️',
    high: 90,
    low: 70,
    precipPercent: 20,
    shortForecast: 'Sunny',
    ...over,
  }
}

const LABELS = ['NOW', 'THU', 'FRI', 'SAT', 'SUN', 'MON', 'TUE']

function sevenDays(): DayForecast[] {
  return LABELS.map((l) => day(l))
}

interface Fakes {
  days: DayForecast[]
  conditions: Conditions | null
  status: WeatherStatus
  place: string
  stale: boolean
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    days: sevenDays(),
    conditions: { windSpeed: '8 mph', temperature: 91, shortForecast: 'Sunny' },
    status: 'ok',
    place: 'Brooklyn FL',
    stale: false,
    ...over,
  }
  const calls: string[] = []
  const source = {
    getDays: () => f.days,
    getConditions: () => f.conditions,
    getStatus: () => f.status,
    getPlace: () => f.place,
    isStale: () => f.stale,
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
  }
  return { page: new WeatherPage(source as never), calls, f }
}

describe('WeatherPage layout', () => {
  it('returns 8 keys: 7 day tiles plus a conditions tile', () => {
    const { page } = build()
    const keys = page.render(NOW).keys
    expect(keys).toHaveLength(8)
  })

  it('labels the day tiles in order', () => {
    const { page } = build()
    const keys = page.render(NOW).keys
    LABELS.forEach((label, i) => expect(keys[i]!.lines![0]).toBe(label))
  })

  it('shows the emoji for each day tile', () => {
    const days = sevenDays()
    days[1] = day('THU', { emoji: '⛈' })
    const { page } = build({ days })
    expect(page.render(NOW).keys[1]!.emoji).toBe('⛈')
  })

  it('shows high and low temperatures together', () => {
    const days = sevenDays()
    days[0] = day('NOW', { high: 95, low: 77 })
    const { page } = build({ days })
    expect(page.render(NOW).keys[0]!.lines![1]).toBe('95°/77°')
  })

  it('shows only the low when the high is null', () => {
    const days = sevenDays()
    days[0] = day('NOW', { high: null, low: 77 })
    const { page } = build({ days })
    expect(page.render(NOW).keys[0]!.lines![1]).toBe('77°')
  })

  it('shows -- for the temperature line when both high and low are null', () => {
    const days = sevenDays()
    days[0] = day('NOW', { high: null, low: null })
    const { page } = build({ days })
    expect(page.render(NOW).keys[0]!.lines![1]).toBe('--')
  })

  it('shows the precip percent', () => {
    const days = sevenDays()
    days[0] = day('NOW', { precipPercent: 96 })
    const { page } = build({ days })
    expect(page.render(NOW).keys[0]!.lines![2]).toBe('96%')
  })

  it('shows -- for precip, never 0%, when the value is unknown', () => {
    const days = sevenDays()
    days[0] = day('NOW', { precipPercent: null })
    const { page } = build({ days })
    const key = page.render(NOW).keys[0]!
    expect(key.lines![2]).toBe('--')
    expect(key.lines!.join('')).not.toContain('0%')
  })

  it('colours the precip line blue at 50 percent or more', () => {
    const days = sevenDays()
    days[0] = day('NOW', { precipPercent: 50 })
    const { page } = build({ days })
    const key = page.render(NOW).keys[0]!
    expect(key.lineColors?.[2]).toEqual(theme.blue)
  })

  it('colours the precip line dim just below the 50 percent threshold', () => {
    const days = sevenDays()
    days[0] = day('NOW', { precipPercent: 49 })
    const { page } = build({ days })
    const key = page.render(NOW).keys[0]!
    expect(key.lineColors?.[2]).toEqual(theme.textDim)
  })

  it('colours the temperature line by heat, using the high when present', () => {
    const days = sevenDays()
    days[0] = day('NOW', { high: 95, low: 40 })
    const { page } = build({ days })
    const key = page.render(NOW).keys[0]!
    expect(key.lineColors?.[1]).toEqual(theme.red)
  })

  it('colours the temperature line using the low when the high is null', () => {
    const days = sevenDays()
    days[0] = day('NOW', { high: null, low: 55 })
    const { page } = build({ days })
    const key = page.render(NOW).keys[0]!
    expect(key.lineColors?.[1]).toEqual(theme.blue)
  })

  it('shows a placeholder tile when a day slot has no data yet', () => {
    const days = sevenDays().slice(0, 3)
    const { page } = build({ days })
    const key = page.render(NOW).keys[5]!
    expect(key.dim).toBe(true)
  })

  it('builds a conditions tile with wind speed, the ZIP, and the truncated place', () => {
    const { page } = build()
    const key = page.render(NOW).keys[7]!
    expect(key.lines).toContain('8 mph')
    expect(key.lines).toContain(ZIP)
  })

  it('shows -- for wind speed when conditions are unknown', () => {
    const { page } = build({ conditions: null })
    const key = page.render(NOW).keys[7]!
    expect(key.lines![1]).toBe('--')
  })
})

describe('heatColor', () => {
  it('colours red at 90 and above', () => {
    expect(heatColor(90, null)).toEqual(theme.red)
  })

  it('colours amber at 89', () => {
    expect(heatColor(89, null)).toEqual(theme.amber)
  })

  it('colours amber at 80', () => {
    expect(heatColor(80, null)).toEqual(theme.amber)
  })

  it('colours neutral at 79', () => {
    expect(heatColor(79, null)).toEqual(theme.text)
  })

  it('colours neutral at 70', () => {
    expect(heatColor(70, null)).toEqual(theme.text)
  })

  it('colours blue at 69', () => {
    expect(heatColor(69, null)).toEqual(theme.blue)
  })

  it('stays neutral for a null temperature', () => {
    expect(heatColor(null, null)).toEqual(theme.text)
  })

  it('uses the high over the low when both are present', () => {
    expect(heatColor(95, 40)).toEqual(theme.red)
  })

  it('falls back to the low when the high is null', () => {
    expect(heatColor(null, 65)).toEqual(theme.blue)
  })
})

describe('conditionTint', () => {
  it('agrees with the emoji matcher for a plain forecast string', () => {
    const emoji = weatherEmoji('Sunny')
    expect(emoji).toBe('☀️')
    // The tint for this emoji must be the warm amber-brown the brief assigns
    // to sunny/clear, proving the lookup used the SAME emoji, not a second
    // independent keyword match that happens to agree by coincidence.
    expect(conditionTint(emoji)).toEqual([34, 27, 18])
  })

  it('agrees with the emoji matcher when severity wins in a "then" string', () => {
    // Per `weatherEmoji`'s own doc comment, the rules run most severe first,
    // so this string maps to the thunderstorm icon rather than the sunny one
    // that appears first in the text.
    const forecast = 'Mostly Sunny then Chance Showers And Thunderstorms'
    const emoji = weatherEmoji(forecast)
    expect(emoji).toBe('⛈')
    expect(conditionTint(emoji)).toEqual([28, 24, 48])
  })

  it('agrees with the emoji matcher for a rain forecast', () => {
    const emoji = weatherEmoji('Chance Rain Showers')
    expect(emoji).toBe('🌧')
    expect(conditionTint(emoji)).toEqual([18, 28, 44])
  })

  it('agrees with the emoji matcher for a snow forecast', () => {
    const emoji = weatherEmoji('Snow likely')
    expect(emoji).toBe('🌨')
    expect(conditionTint(emoji)).toEqual([26, 32, 40])
  })

  it('agrees with the emoji matcher for a fog forecast', () => {
    const emoji = weatherEmoji('Patchy Fog')
    expect(emoji).toBe('🌫')
    expect(conditionTint(emoji)).toEqual([28, 28, 30])
  })

  it('agrees with the emoji matcher for an overcast forecast', () => {
    const emoji = weatherEmoji('Mostly Cloudy')
    expect(emoji).toBe('☁️')
    expect(conditionTint(emoji)).toEqual([22, 24, 28])
  })

  it('agrees with the emoji matcher for a partly cloudy forecast', () => {
    const emoji = weatherEmoji('Partly Sunny')
    expect(emoji).toBe('⛅')
    expect(conditionTint(emoji)).toEqual([28, 26, 24])
  })

  it('falls back to the cloudy tint for an emoji it does not recognise', () => {
    expect(conditionTint('🤷')).toEqual([22, 24, 28])
  })
})

describe('WeatherPage day tile layout details', () => {
  it('gives each day tile a background tint that agrees with its own emoji', () => {
    const days = sevenDays()
    days[0] = day('NOW', { emoji: '⛈' })
    const { page } = build({ days })
    const key = page.render(NOW).keys[0]!
    expect(key.bg).toEqual(conditionTint('⛈'))
  })

  it('centres the day tile lines, to match the centred emoji', () => {
    const { page } = build()
    const key = page.render(NOW).keys[0]!
    expect(key.align).toBe('center')
  })

  it('places the label, temperature and rain-chance lines in their own bands, skipping the emoji band', () => {
    const { page } = build()
    const key = page.render(NOW).keys[0]!
    // Three explicit y positions, one per text line, none inside the emoji's
    // own band (roughly y 17 to 48 — see render/canvas.ts).
    expect(key.lineY).toHaveLength(3)
    const [labelY, tempY, precipY] = key.lineY!
    expect(labelY).toBeLessThan(17)
    expect(tempY).toBeGreaterThan(48)
    expect(precipY).toBeGreaterThan(tempY!)
  })

  it('gives the conditions tile a bigger size for the fixed-width ZIP line only', () => {
    const { page } = build()
    const key = page.render(NOW).keys[7]!
    // Line 1 (the wind reading) can run to 12 variable-length characters, so
    // it stays at the default 11 px and cannot clip. Line 2 (the ZIP code)
    // is always exactly 5 digits, so it is safe to enlarge.
    expect(key.lineSizes?.[1]).toBe(11)
    expect(key.lineSizes?.[2]).toBeGreaterThan(11)
  })
})

describe('WeatherPage staleness', () => {
  it('dims every key when the source reports stale', () => {
    const { page } = build({ stale: true })
    const keys = page.render(NOW).keys
    expect(keys.every((k) => k.dim === true)).toBe(true)
  })

  it('dims every key when the status is not ok', () => {
    const { page } = build({ status: 'offline' })
    const keys = page.render(NOW).keys
    expect(keys.every((k) => k.dim === true)).toBe(true)
  })

  it('dims every key when there is no data yet', () => {
    const { page } = build({ status: 'empty', days: [] })
    const keys = page.render(NOW).keys
    expect(keys.every((k) => k.dim === true)).toBe(true)
  })

  it('does not dim a fresh, ok forecast', () => {
    const { page } = build()
    expect(page.render(NOW).keys[0]!.dim).not.toBe(true)
    expect(page.render(NOW).keys[7]!.dim).not.toBe(true)
  })
})

describe('WeatherPage strip', () => {
  it('shows the place and the current short forecast on line 1', () => {
    const { page } = build()
    const line1 = page.render(NOW).strip.lines[0]!
    expect(line1).toContain('Brooklyn FL')
    expect(line1).toContain('Sunny')
  })

  it('shows offline on line 2 when the source is offline', () => {
    const { page } = build({ status: 'offline' })
    expect(page.render(NOW).strip.lines[1]).toBe('offline')
  })

  it('keeps both strip lines within 30 characters', () => {
    const { page } = build({ place: 'A Very Long Place Name Indeed FL', conditions: { windSpeed: '8 mph', temperature: 90, shortForecast: 'Chance Showers And Thunderstorms Likely' } })
    const strip = page.render(NOW).strip
    expect(strip.lines[0]!.length).toBeLessThanOrEqual(30)
    expect(strip.lines[1]!.length).toBeLessThanOrEqual(30)
  })
})

describe('WeatherPage presses', () => {
  it('does nothing on any press', () => {
    const { page } = build()
    expect(page.onKeyPress(0)).toBeUndefined()
    expect(page.onKeyPress(7)).toBeUndefined()
  })
})

describe('WeatherPage visibility', () => {
  it('tells the source when it becomes visible and when it leaves', () => {
    const { page, calls } = build()
    page.onEnter!()
    page.onLeave!()
    expect(calls).toEqual(['visible:true', 'visible:false'])
  })
})
