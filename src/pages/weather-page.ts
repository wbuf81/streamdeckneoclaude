import type { DeckFrame, KeySpec, Rgb, StripSpec } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate } from '../render/text.js'
import type { Page } from './types.js'
import type { Conditions, DayForecast, WeatherStatus } from '../sources/weather.js'
import { ZIP } from '../sources/weather.js'

/** Measured limit for one strip line. See `render/canvas.ts`. */
const STRIP_CHARS = 30
/** Matches `PROJECT_CHARS` on the Claude page: a short label fits an 11 px
 * Menlo line on a 96 px key with room to spare. */
const PLACE_CHARS = 10
/** Rain at or above this percent gets the emphasis colour. */
const PRECIP_HOT_THRESHOLD = 50
const DAY_TILE_COUNT = 7

/**
 * The four bands of a day tile, measured so none can collide (see the task
 * brief for the geometry). Band 2, the emoji, is drawn by `canvas.ts` itself
 * at a fixed size and position — every emoji key on this page uses the same
 * band, so it needs no per-key field. Bands 1, 3 and 4 are these text lines,
 * placed with `lineY` so they land in the free space around the emoji
 * instead of stepping through it.
 */
const DAY_LABEL_SIZE = 12
const DAY_LABEL_Y = 3
const TEMP_SIZE = 16
const TEMP_Y = 54
const PRECIP_SIZE = 20
const PRECIP_Y = 74

/** Heat colour bands for the high temperature (or the low, when there is no
 * high). A null temperature — nothing to grade — stays neutral. */
const HEAT_HOT = 90
const HEAT_WARM = 80
const HEAT_MILD = 70

/**
 * Dark background washes, one per forecast condition, keyed by the SAME
 * emoji the forecast already picked (`weatherEmoji` in `sources/weather.ts`).
 * Keying on the emoji rather than re-matching the forecast text means the
 * tint and the icon can never disagree — there is only one lookup, not two
 * keyword lists drifting apart. Every value stays dark, because the key's
 * white text must stay crisp on top of it.
 */
const CONDITION_TINTS: Readonly<Record<string, Rgb>> = {
  '⛈': [28, 24, 48], // thunder: deep blue-violet
  '🌨': [26, 32, 40], // snow, sleet, ice: dark slate
  '🌧': [18, 28, 44], // rain, showers, drizzle: dark blue
  '🌫': [28, 28, 30], // fog, haze, mist: flat dark grey
  '💨': [20, 26, 32], // wind: dark cool grey-blue
  '☁️': [22, 24, 28], // cloudy, overcast: neutral dark
  '⛅': [28, 26, 24], // partly cloudy: slightly warm dark
  '☀️': [34, 27, 18], // sunny, clear: warm dark amber-brown
}
/** Falls back to the cloudy tint — the same default `weatherEmoji` itself uses. */
const DEFAULT_TINT: Rgb = CONDITION_TINTS['☁️']!

/** Looks up the background wash for `emoji`. Exported so a test can prove it
 * agrees with `weatherEmoji`'s own output for the same forecast string. */
export function conditionTint(emoji: string): Rgb {
  return CONDITION_TINTS[emoji] ?? DEFAULT_TINT
}

/** Grades the high temperature (or the low, when there is no high) into one
 * of four heat colours. A null temperature — nothing to grade — stays
 * neutral, the same colour as the 70-to-79 band. */
export function heatColor(high: number | null, low: number | null): Rgb {
  const t = high ?? low
  if (t === null) return theme.text
  if (t >= HEAT_HOT) return theme.red
  if (t >= HEAT_WARM) return theme.amber
  if (t >= HEAT_MILD) return theme.text
  return theme.blue
}

/** The part of `WeatherSource` this page needs. */
export interface WeatherReader {
  getDays(): DayForecast[]
  getConditions(): Conditions | null
  getStatus(): WeatherStatus
  getPlace(): string
  isStale(): boolean
  setVisible(visible: boolean): void
}

/** `95` and `77` become `95°/77°`. A null high shows only the low, as `77°`,
 * per the user's decision — never a fabricated `--/77°`. */
function formatTemps(high: number | null, low: number | null): string {
  if (high === null && low === null) return '--'
  if (high === null) return `${Math.round(low!)}°`
  if (low === null) return `${Math.round(high)}°`
  return `${Math.round(high)}°/${Math.round(low)}°`
}

/** `96` becomes `96%`. `null` (unknown) becomes `--`, never `0%`. */
function formatPrecip(pct: number | null): string {
  return typeof pct === 'number' ? `${Math.round(pct)}%` : '--'
}

function precipColor(pct: number | null): readonly [number, number, number] {
  return typeof pct === 'number' && pct >= PRECIP_HOT_THRESHOLD ? theme.blue : theme.textDim
}

/** `17:20` in the local time zone. Never throws: a formatting failure is not
 * worth losing the whole strip line over. */
function formatUpdated(epochSeconds: number): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(epochSeconds * 1000))
  } catch {
    return ''
  }
}

/**
 * Seven day tiles plus a conditions tile, for the National Weather Service
 * forecast at a fixed ZIP code. A key dims when the shared forecast is stale
 * or when no data has arrived yet for that slot, so a stale or missing
 * forecast never presents as current.
 */
export class WeatherPage implements Page {
  readonly name = 'weather'

  constructor(private readonly source: WeatherReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.source.setVisible(false)
  }

  render(now: number): DeckFrame {
    const days = this.source.getDays()
    const status = this.source.getStatus()
    const stale = this.source.isStale()
    const absent = status !== 'ok' || days.length === 0

    const keys: KeySpec[] = []
    for (let i = 0; i < DAY_TILE_COUNT; i++) {
      keys.push(this.dayKey(days[i], stale || absent))
    }
    keys.push(this.conditionsKey(stale || absent))

    return {
      keys,
      strip: this.strip(now),
      buttons: [theme.gray, theme.gray],
    }
  }

  private dayKey(day: DayForecast | undefined, dim: boolean): KeySpec {
    if (!day) {
      return { kind: 'gauge', lines: ['--', '--', '--'], dim: true }
    }

    const key: KeySpec = {
      kind: 'gauge',
      // Bands 1, 3 and 4. Band 2 (the emoji) sits between the label and the
      // temperature line, drawn separately by `canvas.ts` from `emoji`.
      lines: [day.label, formatTemps(day.high, day.low), formatPrecip(day.precipPercent)],
      lineSizes: [DAY_LABEL_SIZE, TEMP_SIZE, PRECIP_SIZE],
      lineY: [DAY_LABEL_Y, TEMP_Y, PRECIP_Y],
      // The temperature line is graded by heat; the precip line keeps the
      // user's existing rain-chance rule. Per the user's decision, this page
      // shows percent chance of rain only, never an amount.
      lineColors: [undefined, heatColor(day.high, day.low), precipColor(day.precipPercent)],
      align: 'center',
      emoji: day.emoji,
      // Same keyword match that picked the emoji, so the two can never
      // disagree with each other.
      bg: conditionTint(day.emoji),
    }
    if (dim) key.dim = true
    return key
  }

  private conditionsKey(dim: boolean): KeySpec {
    const conditions = this.source.getConditions()
    const wind = conditions?.windSpeed || '--'
    const place = truncate(this.source.getPlace(), PLACE_CHARS) || '--'

    const key: KeySpec = {
      kind: 'gauge',
      lines: ['WIND', wind, ZIP, place],
      // Only the label and the ZIP line get a bigger size. ZIP is always
      // exactly 5 digits; the wind reading can run up to a 12-character
      // range (for example "10 to 15 mph"), which already fills the 11 px
      // budget — a bigger font there would clip it. See VERIFIED-FACTS.md's
      // text budget table.
      lineSizes: [12, 11, 16, 11],
    }
    if (dim) key.dim = true
    return key
  }

  private strip(now: number): StripSpec {
    const place = this.source.getPlace()
    const conditions = this.source.getConditions()
    const status = this.source.getStatus()

    let line1: string
    if (status === 'empty') {
      line1 = 'weather: no forecast yet'
    } else {
      const parts = [place || `ZIP ${ZIP}`, conditions?.shortForecast].filter(Boolean)
      line1 = parts.join(' · ')
    }

    const line2 = status === 'offline' ? 'offline' : `updated ${formatUpdated(now)}`

    return { lines: [truncate(line1, STRIP_CHARS), truncate(line2, STRIP_CHARS)] }
  }

  onKeyPress(_index: number): void {
    // Read-only. No refresh-on-press.
  }
}
