import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { WeatherPage, conditionTint, conditionFx, precipIntensity, heatColor, wrapText } from '../../src/pages/weather-page.js'
import { theme } from '../../src/render/theme.js'
import { renderKey, renderStrip, probe, KEY_SIZE, STRIP_WIDTH, STRIP_HEIGHT, FONT, FX_INTENSITY_MIN } from '../../src/render/canvas.js'
import { ZIP, weatherEmoji } from '../../src/sources/weather.js'
import type { Conditions, DayForecast, PeriodDetail, WeatherStatus } from '../../src/sources/weather.js'
import type { KeySpec } from '../../src/render/specs.js'

const NOW = 1786549560
/** The millisecond clock the daemon injects, for the proofs that need the
 * ambient effects actually running. */
const FX_NOW_MS = NOW * 1000

/** Allows a small difference, because canvas anti-aliases edges. */
function near3(actual: readonly number[], expected: readonly number[], tol = 12): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(actual[i]! - expected[i]!) > tol) return false
  }
  return true
}

/**
 * Strips a key's own content, keeping its background wash and its ambient
 * effect exactly as they were. Rendering this and the real key, then diffing
 * the two, isolates content ink — text, emoji, border — from the moving layer
 * underneath it.
 *
 * The effect is a pure function of its spec and was measured byte-identical
 * across two renders (docs/VERIFIED-FACTS.md), so every differing pixel is
 * content and nothing else is.
 */
function withoutContent(key: KeySpec): KeySpec {
  return { ...key, lines: undefined, lineColors: undefined, emoji: undefined }
}

/**
 * Whether row `y` of `key` carries any CONTENT ink between `x0` and `x1`,
 * ignoring whatever the ambient effect painted underneath.
 *
 * This replaces comparing pixels against `key.bg`. That comparison stopped
 * describing the whole background the moment a key could carry an animated
 * effect (task 42) — every one of these proofs would have failed for the right
 * reason and the wrong cause. Loosening them instead would have left the
 * page's real geometry unproven, which is lesson 22's exact shape. The
 * property under test never changed: content must stay inside its own band.
 */
function contentInkOnRow(key: KeySpec, y: number, x0 = 9, x1 = 90): boolean {
  const withContent = renderKey(key)
  const layerOnly = renderKey(withoutContent(key))
  for (let x = x0; x < x1; x++) {
    // Tolerance 1, not near3's default 12: both buffers share an identical
    // layer, so any real difference here is a glyph, not anti-aliasing noise.
    if (!near3(probe(withContent, x, y), probe(layerOnly, x, y), 1)) return true
  }
  return false
}

/** The eight condition emoji this page ever picks a tint for — the same
 * keys `CONDITION_TINTS` covers in weather-page.ts. Kept here rather than
 * exported from the page, since the page's own tests already exercise each
 * one individually via `conditionTint`; this list just drives `it.each`. */
const ALL_CONDITION_EMOJI = ['⛈', '🌨', '🌧', '🌫', '💨', '☁️', '⛅', '☀️']

function periodDetail(over: Partial<PeriodDetail> = {}): PeriodDetail {
  return {
    emoji: '☀️',
    temperature: 90,
    precipPercent: 20,
    shortForecast: 'Sunny',
    detailedForecast: 'Sunny, with a high near 90.',
    windSpeed: '8 mph',
    windDirection: 'NE',
    ...over,
  }
}

function day(label: string, over: Partial<DayForecast> = {}): DayForecast {
  return {
    label,
    // Defaults to the label itself: every real LABELS entry is already
    // distinct, so this keeps the existing fixtures usable as stable
    // identities (I1/C1) without every call site having to invent a fake
    // `date:half` identity. Tests that specifically exercise the
    // identity-vs-position fix, or the C1 collision, pass an explicit `id`
    // override instead.
    id: label,
    emoji: '☀️',
    high: 90,
    low: 70,
    precipPercent: 20,
    shortForecast: 'Sunny',
    day: null,
    night: null,
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
  updatedAt: number
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    days: sevenDays(),
    conditions: { windSpeed: '8 mph', temperature: 91, shortForecast: 'Sunny' },
    status: 'ok',
    place: 'Brooklyn FL',
    stale: false,
    updatedAt: NOW - 3600,
    ...over,
  }
  const calls: string[] = []
  const source = {
    getDays: () => f.days,
    getConditions: () => f.conditions,
    getStatus: () => f.status,
    getLastUpdatedAt: () => f.updatedAt,
    getPlace: () => f.place,
    isStale: () => f.stale,
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
  }
  return { page: new WeatherPage(source as never), calls, f }
}

describe('WeatherPage layout', () => {
  it('returns 8 keys: 7 day tiles plus a conditions tile', () => {
    const { page } = build()
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys).toHaveLength(8)
  })

  it('labels the day tiles in order', () => {
    const { page } = build()
    const keys = page.render(NOW, FX_NOW_MS).keys
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

  it('gives a day slot with no data yet the SAME four-band layout as a populated tile', () => {
    // A2/A4: a partial forecast (the source keeps whatever periods it
    // parsed) used to leave this slot on the old, un-redesigned layout —
    // left-aligned dashes with no lineSizes/lineY/bg at all — beside
    // tiles either side of it that HAD the new centred, banded layout.
    // Rendering the real dayKey output (not hand-written constants) is
    // what would have caught that the first time.
    const days = sevenDays().slice(0, 3)
    const { page } = build({ days })
    const key = page.render(NOW).keys[5]!
    expect(key.dim).toBe(true)
    expect(key.align).toBe('center')
    expect(key.lineY).toHaveLength(3)
    expect(key.bg).toBeDefined()
    expect(key.lines).toEqual(['--', '--', '--'])
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

describe('wrapText (I3)', () => {
  it('returns the text as one line when it already fits', () => {
    expect(wrapText('Sunny', 12, 3)).toEqual(['Sunny'])
  })

  it('wraps on word boundaries, never splitting a word that fits', () => {
    expect(wrapText('Showers And Thunderstorms', 12, 3)).toEqual(['Showers And', 'Thunderstorms'])
  })

  it('lets a single word longer than maxChars stand alone, unbroken, when it is not the final kept line', () => {
    // `Thunderstorms` (13 characters) exceeds the 12-character budget by
    // itself. This function does not hyphenate it — the renderer's own
    // per-line `shrinkToFit` is what protects the key's margin for that
    // one line, exactly as it already does for any other overlong string.
    const out = wrapText('Thunderstorms then Sun', 12, 3)
    expect(out).toContain('Thunderstorms')
  })

  it('folds remaining words onto the last line and truncates with an ellipsis once every line is full', () => {
    const out = wrapText('Slight Chance Showers And Thunderstorms then Partly Cloudy', 12, 3)
    expect(out).toHaveLength(3)
    for (const line of out) expect(line.length).toBeLessThanOrEqual(12)
    expect(out[2]!.endsWith('…')).toBe(true)
  })

  it('returns an empty array for empty or all-whitespace text', () => {
    expect(wrapText('', 12, 3)).toEqual([])
    expect(wrapText('   ', 12, 3)).toEqual([])
  })

  it('returns an empty array for a non-positive maxChars or maxLines, rather than throwing', () => {
    expect(wrapText('Sunny', 0, 3)).toEqual([])
    expect(wrapText('Sunny', 12, 0)).toEqual([])
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

  it('keeps a below-freezing high/low pair within the usable key width', () => {
    // Per M2: TEMP_SIZE used to be a fixed 16 px with no fitting at all.
    // `-10°/-25°` measures over budget at 16 px (86.7 px, see the review),
    // so the renderer must drop to a smaller candidate. Measured with a
    // real pixel probe: no ink at or past the right margin.
    //
    // Test quality (I2 scan): a single-column probe at x=90 alone cannot
    // fail against ink one column further right. This probes the whole
    // margin band, x=90 to the key's last column, instead.
    const days = sevenDays()
    days[0] = day('NOW', { high: -10, low: -25 })
    const { page } = build({ days })
    const key = page.render(NOW, FX_NOW_MS).keys[0]!
    // Content ink only: the ambient effect legitimately paints into the margin,
    // the temperature text must not.
    for (let y = 0; y < KEY_SIZE; y++) {
      expect(contentInkOnRow(key, y, 90, KEY_SIZE)).toBe(false)
    }
  })

  it('gives the conditions tile a bigger size for the fixed-width ZIP line only', () => {
    const { page } = build()
    const key = page.render(NOW).keys[7]!
    // Line 1 (the wind reading) can run to 12 variable-length characters, so
    // it passes a one-candidate ARRAY (M3) — measured and shrunk if needed,
    // never drawn unchecked — rather than a bare number. Line 2 (the ZIP
    // code) is always exactly 5 digits, so it is safe to enlarge unmeasured.
    expect(key.lineSizes?.[1]).toEqual([11])
    expect(key.lineSizes?.[2]).toBeGreaterThan(11)
  })

  it('measures the WIND line rather than trusting it fits, for the widest real windSpeed value (M3)', () => {
    // Measured (see docs/VERIFIED-FACTS.md's "Weather" section): "10 to 15
    // mph" (12 characters) is 79.5 px at 11 px, inside the 81 px budget with
    // only 1.5 px to spare. A `renderKey` pixel probe is what actually
    // proves this, not the arithmetic, per docs/LESSONS.md #17 — and this
    // string is deliberately right at the documented ceiling, not padded
    // with slack, so a regression that removed the measuring path (M3)
    // would show up here.
    const { page } = build({ conditions: { windSpeed: '10 to 15 mph', temperature: 90, shortForecast: 'Sunny' } })
    const key = page.render(NOW).keys[7]!
    const buf = renderKey(key)
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 90; x < KEY_SIZE; x++) {
        expect(near3(probe(buf, x, y), theme.bg)).toBe(true)
      }
    }
  })
})

describe('WeatherPage day tile: rendered band geometry has no overlap, for every condition', () => {
  // T3/T4 from the review: the old version of this proof hand-wrote
  // lineSizes/lineY constants in tests/render/canvas.test.ts, decoupled from
  // the page, and checked only one emoji (the tightest-fitting one, by
  // luck rather than design). This renders the REAL `WeatherPage.dayKey`
  // output for every one of the eight condition tints and rasterizes it
  // through the real `renderKey`, so a future change to either the page's
  // constants or the emoji band cannot drift out of sync with this proof
  // the way it did for the empty-tile case (finding A4).
  it.each(ALL_CONDITION_EMOJI)('keeps every band clear of the others, for %s', (emoji) => {
    const days = sevenDays()
    days[0] = day('NOW', { emoji, high: 95, low: 77 })
    const { page } = build({ days })
    const key = page.render(NOW, FX_NOW_MS).keys[0]!
    // The effect IS running for this proof. A version of this test that
    // silently ran without one would prove the geometry of a key the page
    // never ships.
    expect(key.fx).toBeDefined()

    // Content ink inside each of the three text bands (label ~4-12,
    // temperature ~55-67, rain chance ~77-90 — measured for every emoji in
    // this set by the review, see review-A-render-pages.md's "verified
    // claims" #2).
    expect(contentInkOnRow(key, 10)).toBe(true)
    expect(contentInkOnRow(key, 60)).toBe(true)
    expect(contentInkOnRow(key, 80)).toBe(true)
    // No content ink in the gaps: between the label and the emoji band,
    // between the emoji band and the temperature line, and between the
    // temperature line and the rain chance. The ambient effect paints freely
    // through all three gaps; only content is forbidden there.
    expect(contentInkOnRow(key, 16)).toBe(false)
    expect(contentInkOnRow(key, 52)).toBe(false)
    expect(contentInkOnRow(key, 72)).toBe(false)
  })

  it('holds for the empty-tile placeholder layout too (finding A4), matching the populated tiles', () => {
    const days = sevenDays().slice(0, 0) // every slot absent
    const { page } = build({ days })
    const key = page.render(NOW, FX_NOW_MS).keys[0]!
    // An absent tile carries no effect: a placeholder reports no condition,
    // so there is nothing for one to mean.
    expect(key.fx).toBeUndefined()
    // A '--' dash is a much thinner glyph than real letters, so its ink
    // sits at different (measured) rows than the populated tiles' — but it
    // must still land inside each band and stay clear of the gaps.
    expect(contentInkOnRow(key, 8)).toBe(true) // the '--' label
    expect(contentInkOnRow(key, 62)).toBe(true) // the '--' temperature
    expect(contentInkOnRow(key, 85)).toBe(true) // the '--' precip
    expect(contentInkOnRow(key, 16)).toBe(false)
    expect(contentInkOnRow(key, 52)).toBe(false)
    expect(contentInkOnRow(key, 72)).toBe(false)
  })
})

describe('WeatherPage staleness', () => {
  it('dims every key when the source reports stale', () => {
    const { page } = build({ stale: true })
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys.every((k) => k.dim === true)).toBe(true)
  })

  it('dims every key when the status is not ok', () => {
    const { page } = build({ status: 'offline' })
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys.every((k) => k.dim === true)).toBe(true)
  })

  it('dims every key when there is no data yet', () => {
    const { page } = build({ status: 'empty', days: [] })
    const keys = page.render(NOW, FX_NOW_MS).keys
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

  it('shows the last successful fetch time, not the current render time, in Eastern time with AM/PM', () => {
    // NOW - 3600 is 2026-08-12 14:46 UTC, which is 10:46 AM EDT — a summer
    // instant, per the project's one timestamp convention (AGENTS.md).
    // Fixed epoch and exact string, not "now": a test that formats the real
    // clock breaks in November when the zone flips, and on any machine in
    // another timezone (docs/LESSONS.md #17).
    const updatedAt = NOW - 3600
    const { page } = build({ updatedAt })
    expect(page.render(NOW).strip.lines[1]).toBe('updated 10:46 AM EDT')
  })

  it('shows an unknown update time before the first successful fetch', () => {
    const { page } = build({ status: 'empty', days: [], updatedAt: 0 })
    expect(page.render(NOW).strip.lines[1]).toBe('updated --')
  })

  it('keeps both strip lines within 30 characters', () => {
    const { page } = build({ place: 'A Very Long Place Name Indeed FL', conditions: { windSpeed: '8 mph', temperature: 90, shortForecast: 'Chance Showers And Thunderstorms Likely' } })
    const strip = page.render(NOW).strip
    expect(strip.lines[0]!.length).toBeLessThanOrEqual(30)
    expect(strip.lines[1]!.length).toBeLessThanOrEqual(30)
  })

  it('never draws strip text past the strip edge for the "updated" timestamp', () => {
    // Measured: `updated 4:05 PM EDT` is 148.7 px against the strip's 236 px
    // usable width — verified by pixel probe, not arithmetic, per
    // docs/LESSONS.md #17.
    //
    // Test quality (I2 scan): this grid strip carries no right-aligned
    // field, so there is no second run of text it could overlap — unlike
    // the detail strip below (see the `right`-vs-line-2 overlap test),
    // there is nothing here for a real ink-vs-ink check to compare against.
    // The renderer's own `shrinkToFit` (tested in tests/render/canvas.ts,
    // outside this page's ownership) is what actually keeps text off the
    // margin; probing a single column at the true edge cannot fail for ANY
    // input, per the review, so this now uses near-maximal content (the
    // same long place/forecast strings as the character-count test above)
    // and probes the whole margin band, not one column, as the strongest
    // proof available from this page's own public surface.
    const { page } = build({
      place: 'A Very Long Place Name Indeed FL',
      conditions: { windSpeed: '8 mph', temperature: 90, shortForecast: 'Chance Showers And Thunderstorms Likely' },
    })
    const buffer = renderStrip(page.render(NOW).strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      for (let x = STRIP_WIDTH - 6; x < STRIP_WIDTH; x++) {
        expect(probe(buffer, x, y, STRIP_WIDTH)).toEqual(theme.bg)
      }
    }
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

// ---------------------------------------------------------------------------
// Detail view (task 34): pressing a day tile drills into it, same pattern
// as StocksPage — a mode of the page, BACK on key 7, onLeave resets to grid.
// ---------------------------------------------------------------------------

/** A day with both halves populated, real-shaped values for the detail view. */
function fullDay(label: string, over: Partial<DayForecast> = {}): DayForecast {
  return day(label, {
    day: periodDetail({ emoji: '⛈', temperature: 95, precipPercent: 40, shortForecast: 'Showers And Thunderstorms', detailedForecast: 'Showers and storms after 2pm.', windSpeed: '8 mph', windDirection: 'NE' }),
    night: periodDetail({ emoji: '☀️', temperature: 77, precipPercent: 10, shortForecast: 'Clear', detailedForecast: 'Clear skies overnight.', windSpeed: '5 to 8 mph', windDirection: 'SW' }),
    ...over,
  })
}

describe('WeatherPage presses report the real outcome, keys 0 to 7', () => {
  it('reports handled for every day tile (0-6) on the grid, since every slot has a forecast', () => {
    // A fresh page per key: pressing one key enters detail mode, which would
    // change what every OTHER key reports — see the next test below.
    for (let i = 0; i <= 6; i++) {
      const { page } = build()
      expect(page.onKeyPress(i)).toBe('handled')
    }
  })

  it('reports ignored for key 7 on the grid — the conditions tile has no drill-down', () => {
    const { page } = build()
    expect(page.onKeyPress(7)).toBe('ignored')
  })

  it('reports ignored on the grid for a day tile with no forecast behind it yet', () => {
    const { page } = build({ days: sevenDays().slice(0, 3) })
    expect(page.onKeyPress(5)).toBe('ignored')
  })

  it('reports handled for BACK (key 7), and ignored for every other key, once a day is selected', () => {
    const { page } = build()
    expect(page.onKeyPress(2)).toBe('handled') // enters detail mode
    for (let i = 0; i <= 6; i++) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
    expect(page.onKeyPress(7)).toBe('handled') // BACK
  })
})

describe('WeatherPage presses: entering and leaving detail mode', () => {
  it('selecting a day tile with a forecast enters detail mode for that day', () => {
    const { page } = build()
    page.onKeyPress(2)
    const key0 = page.render(NOW).keys[0]!
    expect(key0.lines![0]).toBe(LABELS[2])
  })

  it('BACK (key 7) returns to the grid', () => {
    const { page } = build()
    page.onKeyPress(2)
    page.onKeyPress(7)
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys).toHaveLength(8)
    LABELS.forEach((label, i) => expect(keys[i]!.lines![0]).toBe(label))
  })

  it('does nothing when pressing a day tile with no forecast behind it at all', () => {
    const { page } = build({ days: sevenDays().slice(0, 3) })
    page.onKeyPress(5)
    const keys = page.render(NOW, FX_NOW_MS).keys
    // Still the grid, not detail.
    expect(keys).toHaveLength(8)
    expect(keys[5]!.lines).toEqual(['--', '--', '--'])
  })

  it('keys 0 to 6 do nothing while a day is selected', () => {
    const { page } = build()
    page.onKeyPress(1)
    const before = page.render(NOW)
    page.onKeyPress(3)
    const after = page.render(NOW)
    expect(after).toEqual(before)
  })

  it('leaving the page clears the selection, so it always reopens on the grid', () => {
    const { page } = build()
    page.onKeyPress(1)
    page.onLeave!()
    const keys = page.render(NOW, FX_NOW_MS).keys
    LABELS.forEach((label, i) => expect(keys[i]!.lines![0]).toBe(label))
  })

  it('falls back to the grid, without throwing, if the selected day vanishes from a shorter forecast', () => {
    const { page, f } = build()
    page.onKeyPress(6) // selects the 7th day
    f.days = sevenDays().slice(0, 3) // a later refresh shrinks the array
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys).toHaveLength(8)
    expect(keys[0]!.lines![0]).toBe(LABELS[0])
  })
})

describe('WeatherPage identity (I1 / lesson 19): selection follows the day, never the array position', () => {
  it('keeps showing the SAME day after a poll shifts every later day one slot to the left', () => {
    // Reproduces the review's exact measured scenario: at 23:55 the array is
    // [NOW(Fri night), SAT, SUN...]. The user opens SAT (index 1). Once the
    // Friday-night period expires, the next poll rebuilds the array as
    // [NOW(Sat), SUN...] — SAT's own data now sits at index 0, not index 1.
    // A page keyed on the array position would silently show SUN's data
    // under whatever heading index 1 now carries. This page must keep
    // showing SAT's numbers (90°/75°), found by id, wherever they moved.
    const days = [
      day('NOW', { id: '2026-08-14:day', high: 70, low: 60 }),
      day('SAT', { id: '2026-08-15:day', high: 90, low: 75 }),
      day('SUN', { id: '2026-08-16:day', high: 88, low: 74 }),
    ]
    const { page, f } = build({ days })
    page.onKeyPress(1) // selects SAT, id 2026-08-15:day

    // The next poll: the Friday-night period drops out of the source's own
    // periods, SAT becomes NOW, and SUN slides from index 2 to index 1.
    f.days = [
      day('NOW', { id: '2026-08-15:day', high: 90, low: 75 }),
      day('SUN', { id: '2026-08-16:day', high: 88, low: 74 }),
    ]
    const key0 = page.render(NOW).keys[0]!
    expect(key0.lines![1]).toBe('90°/75°') // still the originally-selected day
    expect(key0.lines![1]).not.toBe('88°/74°') // never SUN's data
  })

  it('falls back to the grid, honestly, once the selected day is truly gone — never shows another day under the old heading', () => {
    const days = [
      day('NOW', { id: '2026-08-14:day' }),
      day('SAT', { id: '2026-08-15:day', high: 90, low: 75 }),
    ]
    const { page, f } = build({ days })
    page.onKeyPress(1) // selects SAT, id 2026-08-15:day
    f.days = [day('NOW', { id: '2026-08-16:day' })] // 2026-08-15:day is gone entirely
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys).toHaveLength(8) // the grid, not a mislabelled detail view
    expect(keys[0]!.lines![0]).toBe('NOW')
    expect(keys[1]!.lines).toEqual(['--', '--', '--']) // no SAT day anymore — dashed, not fabricated
  })

  it('re-selecting the same identity after a fallback still works (onKeyPress and render agree on what is selected)', () => {
    const days = [day('NOW', { id: '2026-08-14:day' }), day('SAT', { id: '2026-08-15:day' })]
    const { page, f } = build({ days })
    page.onKeyPress(1) // selects SAT
    f.days = [day('NOW', { id: '2026-08-16:day' })] // SAT vanishes
    page.render(NOW) // falls back to the grid (without mutating `selected`, per M3)
    expect(page.onKeyPress(0)).toBe('handled') // the grid still responds normally
    const key0 = page.render(NOW).keys[0]!
    expect(key0.lines![0]).toBe('NOW')
  })

  it('C1: a bare calendar date is not unique — an overnight-only tile and the next day tile that shares its calendar date must resolve to DIFFERENT identities', () => {
    // The review's exact measured shape: between midnight and 06:00, NOW is
    // an overnight-only tile whose date equals THU's own date. `id` must
    // carry the day/night half too, or `activeDay` collapses the two tiles
    // into one and opens the wrong data.
    const days = [
      day('NOW', { id: '2026-08-14:night', high: 72, low: 72, precipPercent: 20 }),
      day('THU', { id: '2026-08-14:day', high: 95, low: 70, precipPercent: 10 }),
    ]
    const { page } = build({ days })
    expect(page.onKeyPress(1)).toBe('handled')
    const key0 = page.render(NOW).keys[0]!
    // Opens THU's own data, not NOW's overnight tile.
    expect(key0.lines).toEqual(['THU', '95°/70°', '10%'])
  })

  it('C1: a day tile with no usable startTime (empty id) can never be selected, and pressing it is ignored', () => {
    const days = [day('NOW', { id: '' }), day('THU', { id: '2026-08-14:day' })]
    const { page } = build({ days })
    expect(page.onKeyPress(0)).toBe('ignored')
    // Still the grid — no detail view opened for the identity-less tile.
    expect(page.render(NOW).keys).toHaveLength(8)
  })
})

describe('WeatherPage detail view layout', () => {
  function detailKeys() {
    const days = sevenDays()
    days[2] = fullDay(LABELS[2]!, { high: 95, low: 77, precipPercent: 40, emoji: '⛈' })
    const { page } = build({ days })
    page.onKeyPress(2)
    return page.render(NOW).keys
  }

  it('key 0 shows the same day tile as the grid: label, emoji, combined high/low, combined rain chance', () => {
    const key = detailKeys()[0]!
    expect(key.lines).toEqual([LABELS[2], '95°/77°', '40%'])
    expect(key.emoji).toBe('⛈')
  })

  it('key 1 shows the DAY half alone: high only, day-only rain chance', () => {
    const key = detailKeys()[1]!
    expect(key.lines).toEqual(['DAY', '95°', '40%'])
    expect(key.emoji).toBe('⛈')
  })

  it('key 2 shows the NIGHT half alone: low only, night-only rain chance', () => {
    const key = detailKeys()[2]!
    expect(key.lines).toEqual(['NIGHT', '77°', '10%'])
    expect(key.emoji).toBe('☀️')
  })

  it('key 3 shows WIND, the day and night readings prefixed D/N, with the redundant "mph" dropped (I2)', () => {
    // Per I2: "mph" and "to" together are what pushed a real range-plus-
    // direction reading past the 81 px budget at every candidate size. The
    // WIND tile's own header already says these are speeds.
    const key = detailKeys()[3]!
    expect(key.lines).toEqual(['WIND', 'D 8 NE', 'N 5-8 SW'])
  })

  it('key 4 shows the DAY half short forecast text, wrapped across the tile\'s remaining lines (I3)', () => {
    // Per I3: the old single line gave only 11 characters of a forecast
    // that can run to 58. This text (25 characters) now spreads across two
    // wrapped lines instead of one truncated one.
    const key = detailKeys()[4]!
    expect(key.lines).toEqual(['DAY', 'Showers And', 'Thunderstorms'])
  })

  it('key 5 shows the NIGHT half short forecast text', () => {
    const key = detailKeys()[5]!
    expect(key.lines).toEqual(['NIGHT', 'Clear'])
  })

  it('shows different text for two forecasts sharing an 11-character prefix (I3): the old single truncated line could not tell them apart', () => {
    const days = sevenDays()
    days[0] = fullDay('NOW', {
      day: periodDetail({ shortForecast: 'Chance Rain Showers then Sunny' }),
      night: periodDetail({ shortForecast: 'Chance Rain Showers then Cloudy' }),
    })
    const { page } = build({ days })
    page.onKeyPress(0)
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys[4]!.lines).toEqual(['DAY', 'Chance Rain', 'Showers then', 'Sunny'])
    expect(keys[5]!.lines).toEqual(['NIGHT', 'Chance Rain', 'Showers then', 'Cloudy'])
    expect(keys[4]!.lines).not.toEqual(keys[5]!.lines)
    // Both used to render identically as "Chance Rain…" (11 characters):
    // the old single-line truncation never reached the word that differs.
  })

  it('key 6 shows RAIN, the day and night percentages prefixed D/N', () => {
    const key = detailKeys()[6]!
    expect(key.lines).toEqual(['RAIN', 'D 40%', 'N 10%'])
  })

  it('key 7 shows BACK with a gray border', () => {
    const key = detailKeys()[7]!
    expect(key.lines!.join('')).toContain('BACK')
    expect(key.border).toEqual(theme.gray)
  })

  it('groups the WIND day/night lines under one candidate array, so they size as a unit', () => {
    const key = detailKeys()[3]!
    expect(Array.isArray(key.lineSizes![1])).toBe(true)
    expect(key.lineSizes![1]).toEqual(key.lineSizes![2])
  })

  it('shows -- for a missing day half, never a fabricated reading', () => {
    const days = sevenDays()
    days[0] = day('NOW', { day: null, night: periodDetail() })
    const { page } = build({ days })
    page.onKeyPress(0)
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys[1]!.lines).toEqual(['DAY', '--', '--'])
    expect(keys[1]!.dim).toBe(true)
    expect(keys[3]!.lines![1]).toBe('D --')
    expect(keys[4]!.lines![1]).toBe('--')
    expect(keys[6]!.lines![1]).toBe('D --')
  })

  it('shows -- for a missing night half, never a fabricated reading', () => {
    const days = sevenDays()
    days[6] = day(LABELS[6]!, { day: periodDetail(), night: null })
    const { page } = build({ days })
    page.onKeyPress(6)
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys[2]!.lines).toEqual(['NIGHT', '--', '--'])
    expect(keys[2]!.dim).toBe(true)
    expect(keys[3]!.lines![2]).toBe('N --')
    expect(keys[5]!.lines![1]).toBe('--')
    expect(keys[6]!.lines![2]).toBe('N --')
  })
})

describe('WeatherPage detail view staleness', () => {
  // Both halves are populated with `fullDay`, so the data tiles' `dim`
  // reflects only the page-wide staleness flag, not the "missing half"
  // placeholder dimming `periodKey`/`textKey`/`windKey`/`rainKey` also carry
  // (proven separately above) — otherwise a fresh render with the default
  // null day/night halves would already read as dimmed for the wrong reason.
  it('dims every detail-view data tile when the forecast is stale, but not BACK', () => {
    const days = sevenDays()
    days[0] = fullDay('NOW')
    const { page } = build({ days, stale: true })
    page.onKeyPress(0)
    const keys = page.render(NOW, FX_NOW_MS).keys
    for (const key of keys.slice(0, 7)) expect(key.dim).toBe(true)
    expect(keys[7]!.dim).not.toBe(true)
  })

  it('does not dim a fresh detail view for a day with both halves known', () => {
    const days = sevenDays()
    days[0] = fullDay('NOW')
    const { page } = build({ days })
    page.onKeyPress(0)
    const keys = page.render(NOW, FX_NOW_MS).keys
    for (const key of keys.slice(0, 7)) expect(key.dim).not.toBe(true)
  })
})

describe('WeatherPage detail view strip', () => {
  it('shows the day half detailedForecast on line 1, truncated, and the night half on line 2', () => {
    const days = sevenDays()
    days[0] = fullDay('NOW', {
      day: periodDetail({ detailedForecast: 'A slight chance of showers and thunderstorms before 9pm. Partly cloudy.' }),
      night: periodDetail({ detailedForecast: 'Clear skies overnight, with a low around 77.' }),
    })
    const { page } = build({ days })
    page.onKeyPress(0)
    const strip = page.render(NOW).strip
    // truncate(s, 30) keeps the first 29 characters plus an ellipsis.
    expect(strip.lines[0]).toBe('A slight chance of showers an…')
    expect(strip.lines[0]!.length).toBe(30)
    expect(strip.lines[1]).toBe('Clear skies overnight, with a…')
  })

  it('shows -- on a strip line for a missing half', () => {
    const days = sevenDays()
    days[0] = day('NOW', { day: null, night: periodDetail() })
    const { page } = build({ days })
    page.onKeyPress(0)
    const strip = page.render(NOW).strip
    expect(strip.lines[0]).toBe('--')
  })

  it('never draws detail-strip text past the strip edge for the longest real detailedForecast text', () => {
    // Measured live from api.weather.gov/gridpoints/OKX/33,37/forecast on
    // 2026-08-13 (Brooklyn FL, this deck's fixed ZIP): the longest
    // detailedForecast in that response, 290 characters.
    const longest =
      'A slight chance of showers and thunderstorms before 9pm. Partly cloudy. Low around 77, with temperatures rising to around 78 overnight. Heat index values as high as 103. Southwest wind around 7 mph. Chance of precipitation is 20%. New rainfall amounts less than a tenth of an inch possible.'
    const days = sevenDays()
    days[0] = fullDay('NOW', {
      day: periodDetail({ detailedForecast: longest }),
      night: periodDetail({ detailedForecast: longest }),
    })
    const { page } = build({ days })
    page.onKeyPress(0)
    const buffer = renderStrip(page.render(NOW).strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      for (let x = STRIP_WIDTH - 6; x < STRIP_WIDTH; x++) {
        expect(probe(buffer, x, y, STRIP_WIDTH)).toEqual(theme.bg)
      }
    }
  })

  it('never overlaps line 2 (the night forecast) with the right-hand update time, even at the longest real forecast text (I2)', () => {
    // This is the exact shape I2 called out: the detail strip is the one
    // place in this page where page text (line 2, the wrapped/truncated
    // night forecast) and a right-aligned indicator (`right`, the update
    // time) share one line. Probing only the strip's true edge cannot see
    // an overlap between the two, because the edge itself is unreachable by
    // either one on its own (see the tests above) — this instead compares
    // the SAME strip rendered with line 2 blanked out, over the exact
    // footprint `right` occupies, following the same technique
    // tests/pages/spotify-page.test.ts already uses for its own I5 finding.
    const longest =
      'A slight chance of showers and thunderstorms before 9pm. Partly cloudy. Low around 77, with temperatures rising to around 78 overnight. Heat index values as high as 103. Southwest wind around 7 mph. Chance of precipitation is 20%. New rainfall amounts less than a tenth of an inch possible.'
    const days = sevenDays()
    days[0] = fullDay('NOW', {
      day: periodDetail({ detailedForecast: longest }),
      night: periodDetail({ detailedForecast: longest }),
    })
    const { page } = build({ days, updatedAt: NOW - 3600 }) // right: 'updated 10:46 AM EDT'
    page.onKeyPress(0)
    const strip = page.render(NOW).strip
    expect(strip.right).toBe('updated 10:46 AM EDT')

    // Measure `right`'s own rendered width with the SAME font the renderer
    // draws it with, per lesson 17 — not a guess.
    const ctx = createCanvas(1, 1).getContext('2d')
    ctx.font = `13px ${FONT}`
    const rightWidth = ctx.measureText(strip.right!).width
    const rightStart = Math.floor(STRIP_WIDTH - 6 - rightWidth) // 6 = the strip's own PAD

    const withLine2 = renderStrip(strip)
    // A reference render of the SAME strip with line 2 blanked. If line 2's
    // real (truncated) content painted anything inside `right`'s own
    // footprint, the two buffers diverge there — identical pixels in that
    // whole region is the only way this passes.
    const withoutLine2 = renderStrip({ ...strip, lines: [strip.lines[0]!, ''] })

    let comparedAnyColumn = false
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      for (let x = rightStart; x < STRIP_WIDTH; x++) {
        comparedAnyColumn = true
        expect(probe(withLine2, x, y, STRIP_WIDTH)).toEqual(probe(withoutLine2, x, y, STRIP_WIDTH))
      }
    }
    expect(comparedAnyColumn).toBe(true)
  })

  // M2: the grid strip's `updated …`/`offline` honesty signal used to
  // disappear entirely in the detail view — both lines were already spent
  // on the two forecast paragraphs, with nothing left to say the data might
  // be old. This reuses `StripSpec.right`, the same mechanism other pages
  // already use to share line 2 without dropping either half.
  it('carries the updated time as `right` on the detail strip, with the "updated" label, same as the grid (M2, this review)', () => {
    // Per this round's M2: a bare timestamp here read as part of the
    // forecast paragraph beside it, losing the `updated` word the grid
    // strip keeps.
    const { page } = build({ updatedAt: NOW - 3600 }) // 10:46 AM EDT, per the grid strip test
    page.onKeyPress(0)
    expect(page.render(NOW).strip.right).toBe('updated 10:46 AM EDT')
  })

  it('carries "offline" as `right` on the detail strip when the source is offline, instead of dropping the signal', () => {
    const { page } = build({ status: 'offline' })
    page.onKeyPress(0)
    expect(page.render(NOW).strip.right).toBe('offline')
  })

  it('carries -- as `right` before the first successful fetch', () => {
    // "empty" status normally has no day tiles, but a day can still be
    // selected already (for example, this page reopened on a page switch
    // while the source had a day from a stale prior success and then lost
    // it) — the strip's honesty signal must still degrade to `--`, not throw
    // or fabricate a time.
    const days = [day('NOW')]
    const { page } = build({ status: 'empty', days, updatedAt: 0 })
    page.onKeyPress(0)
    expect(page.render(NOW).strip.right).toBe('--')
  })

  it('never draws the `right` update indicator past the detail strip edge', () => {
    const { page } = build({ updatedAt: NOW - 3600 })
    page.onKeyPress(0)
    const buffer = renderStrip(page.render(NOW).strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      for (let x = STRIP_WIDTH - 6; x < STRIP_WIDTH; x++) {
        expect(probe(buffer, x, y, STRIP_WIDTH)).toEqual(theme.bg)
      }
    }
  })
})

describe('WeatherPage detail view text fits the usable key width', () => {
  // Same proof shape as tests/pages/stocks-page.test.ts's own "text fits the
  // usable key width" block: `lineSizes` declares candidate sizes, and
  // `renderKey` resolves and, if necessary, truncates them at draw time — so
  // the proof has to render real pixels and probe them, not read the
  // declared candidates as if they were already final.
  const RIGHT_EDGE_X = 90 // BORDER(3) + PAD(6) + usable width(81)
  const RIGHT_EDGE_BAND_END = 95 // KEY_SIZE(96) - 1: probe the whole margin, not one column

  // The emoji tiles (keys 0 to 2) carry their own condition tint as `bg`,
  // not `theme.bg` — probing against the wrong background would flag every
  // pixel of the tint itself as "ink". Callers pass the key's own `bg` when
  // it has one; the plain info tiles (WIND, the text tiles, RAIN, BACK)
  // carry no `bg` at all, so the default covers them.
  //
  // Test quality: a single-column probe at x=90 alone cannot fail against
  // ink one column further right — a prior review found exactly that shape
  // of gap (ink at x=95 on a 96 px key survives a probe that only checks
  // x=90). This probes the whole band from the usable-width edge to the
  // key's last column instead.
  /**
   * Now a content-ink diff rather than a comparison against a flat
   * background, for the same reason `contentInkOnRow` is: a detail-view tile
   * can carry an ambient effect, and that effect paints into the right margin
   * by design. Text must not.
   */
  function noContentInkAtOrPastRightEdge(key: KeySpec): boolean {
    const withContent = renderKey(key)
    const layerOnly = renderKey(withoutContent(key))
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = RIGHT_EDGE_X; x <= RIGHT_EDGE_BAND_END; x++) {
        if (!near3(probe(withContent, x, y), probe(layerOnly, x, y), 1)) return false
      }
    }
    return true
  }

  it('keeps the WIND tile clear of the right margin for the longest real wind reading', () => {
    // Measured live from the same forecast response: the longest real
    // windSpeed value was "5 to 9 mph" (10 characters); paired with a
    // 3-letter direction ("WNW"), the field's own documented range, that is
    // longer still. `D 5 to 9 mph WNW` measures well past the 81 px budget
    // even at the smallest candidate size, so this proves the renderer's
    // truncation, not this page's guess.
    const days = sevenDays()
    days[0] = fullDay('NOW', {
      day: periodDetail({ windSpeed: '5 to 9 mph', windDirection: 'WNW' }),
      night: periodDetail({ windSpeed: '10 to 15 mph', windDirection: 'ENE' }),
    })
    const { page } = build({ days })
    page.onKeyPress(0)
    const key = page.render(NOW).keys[3]!
    expect(noContentInkAtOrPastRightEdge(key)).toBe(true)
  })

  it('keeps the DAY/NIGHT text tiles clear of the right margin for the longest real shortForecast', () => {
    // Measured live from the same forecast response: the longest real
    // shortForecast was 58 characters.
    const longest = 'Slight Chance Showers And Thunderstorms then Partly Cloudy'
    const days = sevenDays()
    days[0] = fullDay('NOW', {
      day: periodDetail({ shortForecast: longest }),
      night: periodDetail({ shortForecast: longest }),
    })
    const { page } = build({ days })
    page.onKeyPress(0)
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(noContentInkAtOrPastRightEdge(keys[4]!)).toBe(true)
    expect(noContentInkAtOrPastRightEdge(keys[5]!)).toBe(true)
  })

  it('keeps every detail-view tile clear of the right margin across every day label', () => {
    for (const label of LABELS) {
      const days = sevenDays()
      const idx = LABELS.indexOf(label)
      days[idx] = fullDay(label)
      const { page } = build({ days })
      page.onKeyPress(idx)
      const keys = page.render(NOW, FX_NOW_MS).keys
      for (const key of keys) {
        expect(noContentInkAtOrPastRightEdge(key)).toBe(true)
      }
    }
  })
})

/**
 * Task 42: each tile draws a live effect behind its numbers, chosen by the same
 * emoji lookup that already picked its icon and its background wash.
 */
describe('WeatherPage condition effects: the mapping', () => {
  it('gives every emoji weatherEmoji can produce a variant, driven from the real classifier', () => {
    // Built from `weatherEmoji`'s OWN output for real forecast strings, not a
    // hand-written emoji list. A new rule added to the source cannot leave a
    // condition with no effect without failing here (lesson 22: assert the
    // property, not the instance). The last entry is deliberately unmapped, to
    // prove the fallback rather than assume it.
    const forecasts = [
      'Scattered Thunderstorms',
      'Snow Showers',
      'Chance Light Rain',
      'Patchy Fog',
      'Breezy',
      'Mostly Cloudy',
      'Partly Sunny',
      'Sunny',
      'Sharknado',
    ]
    for (const f of forecasts) {
      const fx = conditionFx(weatherEmoji(f), 40, 1000, 0)
      expect(fx.variant).toBeTruthy()
      expect(fx.intensity).toBeGreaterThan(0)
      expect(fx.intensity).toBeLessThanOrEqual(1)
      expect(fx.nowMs).toBe(1000)
    }
  })

  it('keeps the tint and the effect on ONE lookup, so they cannot disagree', () => {
    // Both read the same row of the same table, keyed by the same emoji. This
    // is the property that replaced two drifting keyword lists.
    for (const emoji of ALL_CONDITION_EMOJI) {
      expect(conditionTint(emoji)).toBeDefined()
      expect(conditionFx(emoji, null, 0, 0).variant).toBeDefined()
    }
  })

  it('gives thunder, snow and rain their own distinct variants', () => {
    expect(conditionFx('⛈', 50, 0, 0).variant).toBe('storm')
    expect(conditionFx('🌨', 50, 0, 0).variant).toBe('snow')
    expect(conditionFx('🌧', 50, 0, 0).variant).toBe('rain')
    expect(conditionFx('☀️', 50, 0, 0).variant).toBe('sun')
  })

  it('draws partly cloudy more faintly than overcast, using the same variant', () => {
    const partly = conditionFx('⛅', null, 0, 0)
    const overcast = conditionFx('☁️', null, 0, 0)
    expect(partly.variant).toBe(overcast.variant)
    expect(partly.intensity).toBeLessThan(overcast.intensity)
  })

  it('scales a precip-driven effect with the real percentage', () => {
    expect(precipIntensity(100)).toBeGreaterThan(precipIntensity(50))
    expect(precipIntensity(50)).toBeGreaterThan(precipIntensity(10))
    expect(precipIntensity(100)).toBeLessThanOrEqual(1)
    expect(conditionFx('🌧', 90, 0, 0).intensity)
      .toBeGreaterThan(conditionFx('🌧', 10, 0, 0).intensity)
  })

  it('treats an unknown precip percent as the floor, never as zero', () => {
    // Missing data is UNKNOWN, not a reading of zero. An inert tile beside six
    // moving ones would read as a broken page.
    expect(precipIntensity(null)).toBe(FX_INTENSITY_MIN)
    expect(precipIntensity(Number.NaN)).toBe(FX_INTENSITY_MIN)
    expect(precipIntensity(0)).toBe(FX_INTENSITY_MIN)
  })

  it('clamps an out-of-range percent instead of trusting it', () => {
    expect(precipIntensity(500)).toBeLessThanOrEqual(1)
    expect(precipIntensity(-20)).toBeGreaterThanOrEqual(FX_INTENSITY_MIN)
  })

  it('ignores precip for a variant whose intensity is fixed', () => {
    expect(conditionFx('☀️', 0, 0, 0).intensity).toBe(conditionFx('☀️', 100, 0, 0).intensity)
    expect(conditionFx('🌫', 0, 0, 0).intensity).toBe(conditionFx('🌫', 100, 0, 0).intensity)
  })

  it('passes the seed straight through, so two tiles never share a phase', () => {
    expect(conditionFx('🌧', 50, 1000, 0).seed).not.toBe(conditionFx('🌧', 50, 1000, 3).seed)
  })
})

describe('WeatherPage condition effects: which keys carry them', () => {
  it('gives every populated day tile an effect', () => {
    const { page } = build()
    const keys = page.render(NOW, FX_NOW_MS).keys
    for (let i = 0; i < 7; i++) expect(keys[i]!.fx).toBeDefined()
  })

  it('gives each tile its own seed, so neighbours do not animate in lockstep', () => {
    const { page } = build()
    const keys = page.render(NOW, FX_NOW_MS).keys
    const seeds = new Set(keys.slice(0, 7).map((k) => k.fx!.seed))
    expect(seeds.size).toBe(7)
  })

  it('uses the injected clock, never the wall clock', () => {
    const { page } = build()
    expect(page.render(NOW, 5000).keys[0]!.fx!.nowMs).toBe(5000)
    // Absent nowMs, the seconds clock still yields a usable millisecond value.
    expect(page.render(NOW).keys[0]!.fx!.nowMs).toBe(NOW * 1000)
  })

  it('advances the effect clock between two renders, so nothing freezes', () => {
    const { page } = build()
    const a = page.render(NOW, FX_NOW_MS).keys[0]!.fx!.nowMs
    const b = page.render(NOW, FX_NOW_MS + 100).keys[0]!.fx!.nowMs
    expect(b).toBeGreaterThan(a)
  })

  it('leaves the conditions tile with no effect, since it reports no condition', () => {
    const { page } = build()
    expect(page.render(NOW, FX_NOW_MS).keys[7]!.fx).toBeUndefined()
  })

  it('gives an absent day tile no effect, since a placeholder is not a condition', () => {
    const days = sevenDays()
    days.length = 3
    const { page } = build({ days })
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys[0]!.fx).toBeDefined()
    expect(keys[4]!.fx).toBeUndefined()
  })

  it('drives each tile from its OWN condition, not the first tile\'s', () => {
    const days = sevenDays()
    days[0] = day('NOW', { emoji: '🌧', precipPercent: 90 })
    days[1] = day('THU', { emoji: '☀️', precipPercent: 0 })
    days[2] = day('FRI', { emoji: '🌨', precipPercent: 70 })
    const { page } = build({ days })
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys[0]!.fx!.variant).toBe('rain')
    expect(keys[1]!.fx!.variant).toBe('sun')
    expect(keys[2]!.fx!.variant).toBe('snow')
  })

  it('gives the detail view its own effects, one per period', () => {
    const days = sevenDays()
    days[0] = day('NOW', {
      emoji: '🌧',
      day: periodDetail({ emoji: '⛈', precipPercent: 80 }),
      night: periodDetail({ emoji: '🌨', precipPercent: 60 }),
    })
    const { page } = build({ days })
    page.onKeyPress(0)
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys[0]!.fx!.variant).toBe('rain') // the combined tile
    expect(keys[1]!.fx!.variant).toBe('storm') // the DAY half
    expect(keys[2]!.fx!.variant).toBe('snow') // the NIGHT half
    // The tiles that report no condition carry no effect.
    expect(keys[3]!.fx).toBeUndefined() // WIND
    expect(keys[7]!.fx).toBeUndefined() // BACK
  })

  it('gives the detail view\'s three animated tiles three distinct seeds', () => {
    const days = sevenDays()
    days[0] = day('NOW', { day: periodDetail(), night: periodDetail() })
    const { page } = build({ days })
    page.onKeyPress(0)
    const keys = page.render(NOW, FX_NOW_MS).keys
    const seeds = [keys[0]!.fx!.seed, keys[1]!.fx!.seed, keys[2]!.fx!.seed]
    expect(new Set(seeds).size).toBe(3)
  })
})

describe('WeatherPage condition effects: staleness stops the motion', () => {
  it('freezes every effect when the forecast is stale', () => {
    const { page } = build({ stale: true })
    expect(page.render(NOW, FX_NOW_MS).keys.every((k) => k.fx === undefined)).toBe(true)
  })

  it('freezes every effect when the status is not ok', () => {
    const { page } = build({ status: 'offline' })
    expect(page.render(NOW, FX_NOW_MS).keys.every((k) => k.fx === undefined)).toBe(true)
  })

  it('freezes every effect when there is no data yet', () => {
    const { page } = build({ status: 'empty', days: [] })
    expect(page.render(NOW, FX_NOW_MS).keys.every((k) => k.fx === undefined)).toBe(true)
  })

  it('freezes the detail view\'s effects too, not just the grid\'s', () => {
    const days = sevenDays()
    days[0] = day('NOW', { day: periodDetail(), night: periodDetail() })
    const { page } = build({ days, stale: true })
    page.onKeyPress(0)
    expect(page.render(NOW, FX_NOW_MS).keys.every((k) => k.fx === undefined)).toBe(true)
  })

  it('runs the effects again once the forecast is fresh', () => {
    const { page } = build()
    expect(page.render(NOW, FX_NOW_MS).keys[0]!.fx).toBeDefined()
  })
})

describe('WeatherPage condition effects: legibility on the real tiles', () => {
  it('keeps the text brighter than the effect behind it, for every condition', () => {
    // The cap in render/canvas.ts bounds the layer in the abstract. This proves
    // the result on the REAL shipped tiles, at the heaviest intensity the data
    // can ask for: the brightest effect pixel must stay clearly below the text,
    // or the numbers stop reading at a glance — which is the whole point of the
    // page.
    const lum = (p: readonly number[]) => p[0]! + p[1]! + p[2]!
    for (const emoji of ALL_CONDITION_EMOJI) {
      const days = sevenDays()
      days[0] = day('NOW', { emoji, high: 95, low: 77, precipPercent: 100 })
      const { page } = build({ days })
      const key = page.render(NOW, FX_NOW_MS).keys[0]!
      expect(key.fx).toBeDefined()
      const withContent = renderKey(key)
      const layerOnly = renderKey(withoutContent(key))
      let brightestLayer = 0
      let brightestContent = 0
      for (let y = 0; y < KEY_SIZE; y++) {
        for (let x = 0; x < KEY_SIZE; x++) {
          const under = probe(layerOnly, x, y)
          const over = probe(withContent, x, y)
          brightestLayer = Math.max(brightestLayer, lum(under))
          if (!near3(over, under, 1)) brightestContent = Math.max(brightestContent, lum(over))
        }
      }
      expect(brightestContent).toBeGreaterThan(brightestLayer * 1.5)
    }
  })

  it('leaves the content undisturbed by whatever the effect does underneath it', () => {
    // Two different effect clocks, same tile. Opaque content pixels must barely
    // move between them, which is what "the layer is composited UNDER the
    // content" looks like in pixels.
    //
    // A pixel counts as opaque content when it sits more than
    // `OPAQUE_CONTENT_LUM` brighter than what the layer alone painted at that
    // position, measured from the FIRST clock only — so the selection never
    // depends on the comparison it feeds.
    //
    // Two earlier versions of this proof were wrong, and both were caught by
    // measuring rather than reasoning (lesson 17):
    //
    // - Selecting pixels that match `theme.text` found only 57 of them, because
    //   this tile colours its temperature line by heat and its rain line by
    //   chance. Only the label is `theme.text`.
    // - Demanding byte-exact equality failed on 13 to 55 pixels per condition.
    //   A glyph edge is anti-aliased by design, so its final value blends with
    //   whatever sits underneath; that is physics, not a bug.
    //
    // Measured on 2026-08-18, across all eight conditions: the worst channel
    // shift on any opaque-content pixel is 26, on the snow tile, and the
    // smallest selected set is 537 pixels, on the sunny tile. A layer drawn
    // OVER the content instead would both collapse the selected set and push
    // the shift far past this bound.
    const OPAQUE_CONTENT_LUM = 250
    const MIN_OPAQUE_PIXELS = 400
    const MAX_CONTENT_SHIFT = 32
    const lum = (p: readonly number[]) => p[0]! + p[1]! + p[2]!

    for (const emoji of ALL_CONDITION_EMOJI) {
      const days = sevenDays()
      days[0] = day('NOW', { emoji, high: 95, low: 77, precipPercent: 100 })
      const { page } = build({ days })
      const keyA = page.render(NOW, FX_NOW_MS).keys[0]!
      const keyB = page.render(NOW, FX_NOW_MS + 3000).keys[0]!
      // The two frames must really differ underneath, or this proves nothing.
      expect(keyA.fx!.nowMs).not.toBe(keyB.fx!.nowMs)

      const a = renderKey(keyA)
      const b = renderKey(keyB)
      const layerA = renderKey(withoutContent(keyA))

      let compared = 0
      for (let y = 0; y < KEY_SIZE; y++) {
        for (let x = 0; x < KEY_SIZE; x++) {
          const pa = probe(a, x, y)
          if (lum(pa) - lum(probe(layerA, x, y)) <= OPAQUE_CONTENT_LUM) continue
          compared++
          const pb = probe(b, x, y)
          for (let i = 0; i < 3; i++) {
            expect(Math.abs(pa[i]! - pb[i]!)).toBeLessThanOrEqual(MAX_CONTENT_SHIFT)
          }
        }
      }
      expect(compared).toBeGreaterThan(MIN_OPAQUE_PIXELS)
    }
  })
})
