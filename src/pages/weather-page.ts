import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
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
      lines: [day.label, formatTemps(day.high, day.low), formatPrecip(day.precipPercent)],
      // Only the precip line carries the rain-chance colour, per the user's
      // decision to show percent chance of rain only, never an amount.
      lineColors: [undefined, undefined, precipColor(day.precipPercent)],
      emoji: day.emoji,
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
