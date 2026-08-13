import type { DeckFrame, KeySpec, Rgb, StripSpec } from '../render/specs.js'
import { theme } from '../render/theme.js'
import { truncate, formatEasternTime } from '../render/text.js'
import type { Page, PressOutcome } from './types.js'
import type { Conditions, DayForecast, PeriodDetail, WeatherStatus } from '../sources/weather.js'
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
/**
 * Candidate sizes for the temperature line, largest first. `95°/77°` fits at
 * 16 px (measured, see docs/VERIFIED-FACTS.md), so that stays the common
 * case, but a below-freezing pair like `-10°/-25°` does not — the renderer
 * measures and drops to a smaller candidate rather than clipping.
 */
const TEMP_SIZES = [16, 13, 11]
const TEMP_Y = 54
const PRECIP_SIZE = 20
const PRECIP_Y = 74

/**
 * Candidate sizes for the detail view's variable-length text lines: the
 * DAY/NIGHT wind reading and the DAY/NIGHT short-forecast text. Both can run
 * well past the 81 px budget (a real `"5 to 9 mph S"` measures 92.7 px even
 * at the smallest candidate, 11 px, and a real `shortForecast` like
 * `"Slight Chance Showers And Thunderstorms then Partly Cloudy"` measures
 * 384 px) — `renderKey` measures with the real canvas and, per its own
 * `shrinkToFit` fallback, truncates with an ellipsis rather than clipping.
 * This page never reasons about the width itself, per docs/LESSONS.md #17.
 */
const DETAIL_TEXT_SIZES = [13, 11]
/**
 * Character budget for one wrapped forecast line (I3), sized to the smallest
 * `DETAIL_TEXT_SIZES` candidate, 11 px: VERIFIED-FACTS.md measures 6.62 px
 * advance per character at 11 px Menlo, so 81 px / 6.62 px = 12.24, and
 * 12 * 6.62 = 79.44 px stays inside the budget with room to spare. Menlo is
 * monospace, so — unlike reasoning about a proportional font, which
 * docs/LESSONS.md #17 forbids — a character count IS an exact pixel bound
 * here. `renderKey`'s own `shrinkToFit` still catches the rare single word
 * (for example `Thunderstorms`, 13 characters) that alone runs over this
 * budget, so a bad wrap can degrade to an ellipsis but never draw past the
 * key's margin.
 */
const TEXT_WRAP_CHARS = 12
/** The DAY/NIGHT text tiles give line 0 to the header (`DAY`/`NIGHT`) and the
 * rest of `KeySpec`'s 4-line budget to the wrapped forecast text (I3): "the
 * key supports four lines and uses two," per the finding. */
const TEXT_WRAP_LINES = 3
/** Fixed size for the detail view's BACK label, matching the stocks detail view. */
const BACK_SIZE = 16

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
  getLastUpdatedAt(): number
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

/**
 * `"8 mph"` and `"NE"` become `"8 NE"`; a range like `"5 to 9 mph"` becomes
 * `"5-9"`. Per finding I2: a real range-plus-direction reading, `"5 to 9 mph
 * WNW"`, ran the WIND tile's `D `/`N ` line to 106 px at the smallest 11 px
 * candidate — 25 px past the 81 px budget — so the renderer truncated it
 * mid-unit (`"D 5 to 9 mp…"`). The tile's own `WIND` header already says
 * what these numbers mean, so dropping the redundant `mph` and shortening
 * `to` to `-` carries every real reading at 11 px with room to spare
 * (measured: the widest live combination, `"D 10-15 WNW"`, is 72.8 px)
 * without ever cutting a unit in half. A missing direction keeps just the
 * speed. A null period (that half of the day is unknown) becomes `--`,
 * never a fabricated reading.
 */
function formatWind(period: PeriodDetail | null): string {
  if (!period) return '--'
  const speed = (period.windSpeed || '--').replace(' to ', '-').replace(/\s*mph$/i, '')
  return period.windDirection ? `${speed} ${period.windDirection}` : speed
}

/**
 * Greedily wraps `text` into up to `maxLines` lines of at most `maxChars`
 * characters, breaking only between words (never inside one) — except that
 * text still left over once every line is full is folded onto the LAST line
 * and cut there with an ellipsis, via the shared `truncate` helper: the same
 * fallback `renderKey`'s own `shrinkToFit` uses when even the smallest
 * candidate size does not fit (see `render/canvas.ts`). Per finding I3: the
 * old code gave the forecast text one line and let the renderer truncate it
 * to 11 characters of up to 58 — two different forecasts sharing a long
 * common prefix rendered identically. Spreading the same text across up to
 * `maxLines` lines instead shows several times as much before any
 * truncation is needed. A single word longer than `maxChars` (for example
 * `Thunderstorms`) is not itself broken here; it becomes its own overlong
 * line, and the renderer's own per-line `shrinkToFit` — not this function —
 * is what keeps that one line from drawing past the key's margin.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  if (maxLines <= 0 || maxChars <= 0) return []
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []

  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      if (current) lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)

  if (lines.length <= maxLines) return lines

  const kept = lines.slice(0, maxLines - 1)
  const rest = lines.slice(maxLines - 1).join(' ')
  kept.push(truncate(rest, maxChars))
  return kept
}

/** `4:05 PM EDT`, in US Eastern time — the project's one timestamp
 * formatter, per `AGENTS.md`'s "Product conventions". Measured at 148.7 px
 * for `updated 4:05 PM EDT`, well inside the strip's 236 px usable width, so
 * the zone abbreviation stays on. */
function formatUpdated(epochSeconds: number): string {
  return formatEasternTime(epochSeconds * 1000)
}

/**
 * Seven day tiles plus a conditions tile, for the National Weather Service
 * forecast at a fixed ZIP code. A key dims when the shared forecast is stale
 * or when no data has arrived yet for that slot, so a stale or missing
 * forecast never presents as current. Pressing a day tile enters a detail
 * mode for that one day, spread across all eight keys, with BACK on key 7 —
 * the same mode-of-the-page pattern the stocks page uses for its own
 * drill-down, per the task brief.
 */
export class WeatherPage implements Page {
  readonly name = 'weather'

  /**
   * The selected day's stable identity (`DayForecast.date`), or null on the
   * grid. `onLeave` always clears this, so the page reopens on the grid
   * every time it becomes visible again.
   *
   * Per finding I1 (docs/LESSONS.md lesson 19): this used to be the array
   * INDEX the user pressed. `WeatherSource.getDays()` rebuilds its array from
   * scratch on every poll, and a day's position in it shifts as periods
   * expire — the day that was at index 1 can become index 0 on the very next
   * poll. Keying on the array position meant the open detail view silently
   * followed whatever day slid into that index next, not the day the user
   * actually opened. `date` never changes for the same real day, so this
   * keys on that instead — the same stable-identity fix the stocks page
   * already gets for free by keying on the symbol.
   */
  private selected: string | null = null

  constructor(private readonly source: WeatherReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.selected = null
    this.source.setVisible(false)
  }

  /**
   * The day matching `this.selected`'s identity, or null when nothing is
   * selected OR the selected day is no longer in `days` (per I1, this must
   * never fall back to "whatever day is now at the old index" — it is
   * either the SAME day, found by its stable identity, or nothing). Computed
   * fresh from `days` every call rather than cached, so `render` never needs
   * to mutate `this.selected` to fall back to the grid (M3: a page must not
   * mutate its own state inside `render`) — `onKeyPress` calls this too, so
   * the two stay consistent about whether a day is really selected.
   */
  private activeDay(days: DayForecast[]): DayForecast | null {
    if (this.selected === null) return null
    return days.find((d) => d.date === this.selected) ?? null
  }

  render(_now: number): DeckFrame {
    const days = this.source.getDays()
    const status = this.source.getStatus()
    const stale = this.source.isStale()
    const absent = status !== 'ok' || days.length === 0
    const dim = stale || absent

    const day = this.activeDay(days)
    if (day) return this.detailFrame(day, dim)

    const keys: KeySpec[] = []
    for (let i = 0; i < DAY_TILE_COUNT; i++) {
      keys.push(this.dayKey(days[i], dim))
    }
    keys.push(this.conditionsKey(dim))

    return {
      keys,
      strip: this.strip(),
      buttons: [theme.gray, theme.gray],
    }
  }

  private dayKey(day: DayForecast | undefined, dim: boolean): KeySpec {
    if (!day) {
      // Same four-band layout and centred alignment as a populated tile —
      // just with placeholder text and no emoji. Without this, a partial
      // forecast (the source keeps whatever periods it parsed) rendered
      // this slot on the OLD legacy left-aligned layout, three tiny dashes
      // hugging the top-left corner beside the redesigned tiles either side
      // of it.
      return {
        kind: 'gauge',
        lines: ['--', '--', '--'],
        lineSizes: [DAY_LABEL_SIZE, TEMP_SIZES, PRECIP_SIZE],
        lineY: [DAY_LABEL_Y, TEMP_Y, PRECIP_Y],
        align: 'center',
        bg: DEFAULT_TINT,
        dim: true,
      }
    }

    const key: KeySpec = {
      kind: 'gauge',
      // Bands 1, 3 and 4. Band 2 (the emoji) sits between the label and the
      // temperature line, drawn separately by `canvas.ts` from `emoji`.
      lines: [day.label, formatTemps(day.high, day.low), formatPrecip(day.precipPercent)],
      lineSizes: [DAY_LABEL_SIZE, TEMP_SIZES, PRECIP_SIZE],
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

  /**
   * The detail view for one day, spread across all eight keys:
   *
   * - Key 0: the same day tile shown on the grid — label, emoji, combined
   *   high/low, combined rain chance — so the tile the user just pressed
   *   stays recognisable inside the detail view.
   * - Key 1: the DAY half alone (emoji, high only, day-only rain chance).
   * - Key 2: the NIGHT half alone (emoji, low only, night-only rain chance).
   * - Key 3: WIND, the day and night readings.
   * - Key 4: the DAY half's short forecast text.
   * - Key 5: the NIGHT half's short forecast text.
   * - Key 6: RAIN, the day and night percentages side by side.
   * - Key 7: BACK.
   */
  private detailFrame(day: DayForecast, dim: boolean): DeckFrame {
    const keys: KeySpec[] = [
      this.dayKey(day, dim),
      this.periodKey('DAY', day.day, dim),
      this.periodKey('NIGHT', day.night, dim),
      this.windKey(day, dim),
      this.textKey('DAY', day.day, dim),
      this.textKey('NIGHT', day.night, dim),
      this.rainKey(day, dim),
      this.backKey(),
    ]

    return {
      keys,
      strip: this.detailStrip(day),
      buttons: [theme.gray, theme.gray],
    }
  }

  /**
   * Keys 1 and 2: one half of the day alone, in the SAME four-band layout
   * `dayKey` uses — label, emoji band, a single temperature, rain chance —
   * just fed one period's fields instead of the combined pair. A missing
   * half (see `PeriodDetail`'s doc comment) gets the same dashed placeholder
   * `dayKey` uses for a day with no data at all, always dimmed, since there
   * is nothing behind it to show.
   */
  private periodKey(label: string, period: PeriodDetail | null, dim: boolean): KeySpec {
    if (!period) {
      return {
        kind: 'gauge',
        lines: [label, '--', '--'],
        lineSizes: [DAY_LABEL_SIZE, TEMP_SIZES, PRECIP_SIZE],
        lineY: [DAY_LABEL_Y, TEMP_Y, PRECIP_Y],
        align: 'center',
        bg: DEFAULT_TINT,
        dim: true,
      }
    }

    const key: KeySpec = {
      kind: 'gauge',
      // formatTemps's high-only branch and its low-only branch both render a
      // single value the same way, `${round}°`, so passing the one known
      // reading as the "high" slot reuses that helper for either half
      // without a second formatter.
      lines: [label, formatTemps(period.temperature, null), formatPrecip(period.precipPercent)],
      lineSizes: [DAY_LABEL_SIZE, TEMP_SIZES, PRECIP_SIZE],
      lineY: [DAY_LABEL_Y, TEMP_Y, PRECIP_Y],
      lineColors: [undefined, heatColor(period.temperature, null), precipColor(period.precipPercent)],
      align: 'center',
      emoji: period.emoji,
      bg: conditionTint(period.emoji),
    }
    if (dim) key.dim = true
    return key
  }

  /** Key 3: WIND, the day and night readings, each prefixed `D`/`N` since
   * the tile carries one shared label for both halves. The two lines pass
   * the SAME candidate array, so a long reading on one side does not render
   * bigger than a short one on the other (the same grouped-sizing rule the
   * stocks detail view's range tiles rely on). */
  private windKey(day: DayForecast, dim: boolean): KeySpec {
    const key: KeySpec = {
      kind: 'gauge',
      lines: ['WIND', `D ${formatWind(day.day)}`, `N ${formatWind(day.night)}`],
      lineSizes: [DAY_LABEL_SIZE, DETAIL_TEXT_SIZES, DETAIL_TEXT_SIZES],
    }
    if (dim) key.dim = true
    return key
  }

  /** Keys 4 and 5: one half's short forecast text, for example `Slight
   * Chance Showers And Thunderstorms then Partly Cloudy`. Per I3, this wraps
   * the text across the tile's remaining 3 lines instead of giving it one —
   * still not always the WHOLE string (a 58-character forecast can run past
   * even 3 wrapped lines), but several times as much of it, and two
   * different forecasts sharing a long prefix now diverge sooner. Real
   * strings, or a single overlong word, can still run past the usable width
   * even at the smallest candidate size, so `renderKey` truncates THAT line
   * with an ellipsis — measured, not guessed, per docs/LESSONS.md #17. A
   * missing half shows `--`. */
  private textKey(label: string, period: PeriodDetail | null, dim: boolean): KeySpec {
    const wrapped = wrapText(period?.shortForecast || '--', TEXT_WRAP_CHARS, TEXT_WRAP_LINES)
    const key: KeySpec = {
      kind: 'gauge',
      lines: [label, ...wrapped],
      lineSizes: [DAY_LABEL_SIZE, ...wrapped.map(() => DETAIL_TEXT_SIZES)],
    }
    if (dim) key.dim = true
    return key
  }

  /** Key 6: RAIN, the day and night percentages side by side, each prefixed
   * `D`/`N`. Bounded length (`D 100%` is the longest real value, `D --` the
   * shortest), so — like the grid tile's own precip line — this stays a
   * fixed size rather than a measured candidate array. */
  private rainKey(day: DayForecast, dim: boolean): KeySpec {
    const dayPct = day.day?.precipPercent ?? null
    const nightPct = day.night?.precipPercent ?? null
    const key: KeySpec = {
      kind: 'gauge',
      lines: ['RAIN', `D ${formatPrecip(dayPct)}`, `N ${formatPrecip(nightPct)}`],
      lineSizes: [DAY_LABEL_SIZE, PRECIP_SIZE, PRECIP_SIZE],
      lineColors: [undefined, precipColor(dayPct), precipColor(nightPct)],
    }
    if (dim) key.dim = true
    return key
  }

  /** Key 7: BACK. A gray border and no fill colour, on purpose, so it never
   * reads as one more data tile — the same look the stocks detail view
   * uses for its own BACK key. Centred vertically as well as horizontally,
   * since it carries no other line to share the tile with. */
  private backKey(): KeySpec {
    return {
      kind: 'control',
      lines: ['◀ BACK'],
      lineSizes: [BACK_SIZE],
      lineY: [40],
      align: 'center',
      border: theme.gray,
    }
  }

  /**
   * The detail view's strip shows the day's actual forecast paragraph
   * instead of the grid's place-and-update-time summary: line 1 is the day
   * half's `detailedForecast`, line 2 the night half's, each truncated to
   * the strip's usable width. A missing half shows `--`.
   *
   * Per M2: the grid strip's `updated …`/`offline` honesty signal used to
   * disappear entirely in detail mode — a stale or offline forecast still
   * showed two forecast paragraphs with nothing to say they might be old.
   * Both lines are already spoken for by the two forecast paragraphs, so
   * this reuses `right` (the same field the stocks detail strip's own
   * `renderStrip` mechanism is built for) rather than dropping either
   * paragraph, matching the stocks page's own drill-down, which keeps its
   * status text on the strip too.
   */
  private detailStrip(day: DayForecast): StripSpec {
    const dayText = day.day?.detailedForecast || '--'
    const nightText = day.night?.detailedForecast || '--'
    const status = this.source.getStatus()
    const updatedAt = this.source.getLastUpdatedAt()
    const right = status === 'offline' ? 'offline' : updatedAt > 0 ? formatUpdated(updatedAt) : '--'
    return {
      lines: [truncate(dayText, STRIP_CHARS), truncate(nightText, STRIP_CHARS)],
      right,
    }
  }

  private strip(): StripSpec {
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

    const updatedAt = this.source.getLastUpdatedAt()
    const line2 = status === 'offline'
      ? 'offline'
      : updatedAt > 0
        ? `updated ${formatUpdated(updatedAt)}`
        : 'updated --'

    return { lines: [truncate(line1, STRIP_CHARS), truncate(line2, STRIP_CHARS)] }
  }

  onKeyPress(index: number): PressOutcome {
    const days = this.source.getDays()
    if (this.activeDay(days) === null) {
      // Key 7 is the conditions tile, never a day — it has no drill-down.
      if (index >= DAY_TILE_COUNT) return 'ignored'
      // No forecast at all for this slot yet: nothing to show a detail view
      // for. A partial forecast can leave a day tile empty before the first
      // full refresh, and an empty key must not open detail for a day that
      // does not exist.
      const day = days[index]
      if (!day) return 'ignored'
      this.selected = day.date
      return 'handled'
    }

    if (index === 7) {
      this.selected = null
      return 'handled'
    }
    // Keys 0 to 6 do nothing while a day is selected. Read-only: no
    // refresh-on-press, no browser.
    return 'ignored'
  }
}
