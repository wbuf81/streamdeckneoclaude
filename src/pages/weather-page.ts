import type { DeckFrame, FxSpec, FxVariant, IconSpec, KeySpec, Rgb, StripSpec } from '../render/specs.js'
import { FX_INTENSITY_MIN } from '../render/canvas.js'
import { blend, theme } from '../render/theme.js'
import { truncate, formatEasternTime } from '../render/text.js'
import type { Page, PressOutcome } from './types.js'
import type { Conditions, DayForecast, PeriodDetail, WeatherStatus } from '../sources/weather.js'

/** Measured limit for one strip line. See `render/canvas.ts`. */
const STRIP_CHARS = 30
/** Rain at or above this percent gets the emphasis colour. */
const PRECIP_HOT_THRESHOLD = 50
const DAY_TILE_COUNT = 7
/**
 * How often to render while a condition effect is showing. The same value the
 * Spotify page's idle animation uses (`IDLE_TICK_MS`), for the same reason: the
 * device's own render interval is the only throughput constraint, and eight
 * animated keys at this rate is about 80 key-writes per second against a
 * measured ceiling of 362 (docs/VERIFIED-FACTS.md). The effect layer itself was
 * measured at 0.37 ms per eight-key frame, against this 100 ms budget.
 */
const FX_TICK_MS = 100

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
/**
 * The high and the low share one row: the high large, bold and warm, the low
 * smaller and grey beside it. The low sits 4 px lower so the two read as one
 * baseline. Each line is padded with spaces to a symmetric string (see
 * `tempPair`), so the renderer measures the whole padded width — if the
 * padded string fits, the visible half fits too.
 */
const HIGH_SIZES = [17, 14, 12]
const LOW_SIZES = [13, 11]
const LOW_Y = TEMP_Y + 4
const PRECIP_SIZE = 16
const PRECIP_Y = 76

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

/**
 * The high's warm scale. On this deck red means a loss, so a solid-red high
 * read as an alarm. The scale runs cool blue-white, through warm gold, to a
 * soft orange — and never reaches `theme.red`. Between two stops the colour
 * blends linearly; outside them it holds the end colour.
 */
const HEAT_COOL: Rgb = [150, 195, 255]
const HEAT_GOLD: Rgb = [255, 196, 92]
const HEAT_ORANGE: Rgb = [255, 140, 72]
const HEAT_COOL_AT = 58
const HEAT_GOLD_AT = 74
const HEAT_ORANGE_AT = 88
/** The low is secondary information: quiet grey. */
const LOW_COLOR: Rgb = theme.textDim

/** The wind compass key: the speed sits under the compass ink (y 4..72). */
const WIND_SPEED_SIZES = [16, 13, 11]
const WIND_SPEED_Y = 77
/** With no direction there is no compass, so the key shows a label and the
 * speed, larger, in the space the compass would use. */
const WIND_LABEL_Y = 18
const WIND_ONLY_SIZES = [22, 18, 14, 11]
const WIND_ONLY_Y = 42

/** NWS `windDirection` values (1 to 3 letters, docs/VERIFIED-FACTS.md), in
 * clockwise order from north, 22.5 degrees apart. */
const COMPASS_POINTS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
] as const

/**
 * One row per forecast condition, keyed by the SAME emoji the forecast already
 * picked (`weatherEmoji` in `sources/weather.ts`). The row carries BOTH the
 * dark background wash and the ambient effect drawn over it, so the icon, the
 * tint, and the motion behind the numbers all come from a single lookup —
 * there is no second keyword list to drift apart from the first (lesson 21 in
 * docs/LESSONS.md: one decision, one function).
 *
 * Every `tint` stays dark, because the key's white text must stay crisp on top
 * of it. These are the same eight values the earlier `CONDITION_TINTS` held,
 * unchanged.
 *
 * `intensity` is either the literal `'precip'`, meaning the tile's own real
 * chance-of-rain drives how heavy the effect looks, or a fixed fraction for a
 * condition that carries no such reading.
 */
interface ConditionStyle {
  tint: Rgb
  fx: FxVariant
  intensity: 'precip' | number
}

const CONDITION_STYLES: Readonly<Record<string, ConditionStyle>> = {
  // thunder: deep blue-violet
  '⛈': { tint: [28, 24, 48], fx: 'storm', intensity: 'precip' },
  // snow, sleet, ice: dark slate
  '🌨': { tint: [26, 32, 40], fx: 'snow', intensity: 'precip' },
  // rain, showers, drizzle: dark blue
  '🌧': { tint: [18, 28, 44], fx: 'rain', intensity: 'precip' },
  // fog, haze, mist: flat dark grey
  '🌫': { tint: [28, 28, 30], fx: 'fog', intensity: 0.7 },
  // wind: dark cool grey-blue
  '💨': { tint: [20, 26, 32], fx: 'wind', intensity: 0.7 },
  // cloudy, overcast: neutral dark
  '☁️': { tint: [22, 24, 28], fx: 'cloud', intensity: 0.75 },
  // partly cloudy: slightly warm dark. The SAME variant as overcast, at a
  // lower intensity — partly cloudy is cloudy, with less of it.
  '⛅': { tint: [28, 26, 24], fx: 'cloud', intensity: 0.4 },
  // sunny, clear: warm dark amber-brown
  '☀️': { tint: [34, 27, 18], fx: 'sun', intensity: 0.8 },
}

/** Falls back to the cloudy row — the same default `weatherEmoji` itself uses. */
const DEFAULT_STYLE: ConditionStyle = CONDITION_STYLES['☁️']!

/** Looks up the background wash for `emoji`. Exported so a test can prove it
 * agrees with `weatherEmoji`'s own output for the same forecast string. */
export function conditionTint(emoji: string): Rgb {
  return (CONDITION_STYLES[emoji] ?? DEFAULT_STYLE).tint
}

/**
 * Maps a real chance-of-rain percentage onto an effect intensity.
 *
 * A null or non-finite reading is UNKNOWN, not zero (see AGENTS.md: never
 * infer a state from missing data), so it takes the floor rather than
 * switching the effect off — an inert tile beside six moving ones reads as a
 * broken page, not as missing data. A real 0 percent takes the same floor,
 * which is honest: the digits on the tile still say `0%`.
 */
export function precipIntensity(pct: number | null): number {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return FX_INTENSITY_MIN
  const frac = Math.min(100, Math.max(0, pct)) / 100
  return FX_INTENSITY_MIN + frac * (1 - FX_INTENSITY_MIN)
}

/**
 * Builds the ambient effect for one tile, from the same emoji that already
 * chose the tile's icon and wash. `seed` decorrelates neighbouring tiles; the
 * key index is enough, and without it seven tiles of the same condition
 * animate in lockstep and read as one block rather than seven days.
 */
export function conditionFx(
  emoji: string, precipPercent: number | null, nowMs: number, seed: number,
): FxSpec {
  const style = CONDITION_STYLES[emoji] ?? DEFAULT_STYLE
  const intensity =
    style.intensity === 'precip' ? precipIntensity(precipPercent) : style.intensity
  return { variant: style.fx, nowMs, intensity, seed }
}

/**
 * Grades one temperature on the warm scale: cool blue-white at 58°F and
 * below, warm gold at 74°F, soft orange at 88°F and above. The input is
 * rounded first, so the colour changes only when the printed number does.
 * A null or non-finite temperature — nothing to grade — stays neutral text.
 */
export function heatColor(temp: number | null): Rgb {
  if (typeof temp !== 'number' || !Number.isFinite(temp)) return theme.text
  const t = Math.round(temp)
  if (t <= HEAT_GOLD_AT) {
    return blend(HEAT_COOL, HEAT_GOLD, (t - HEAT_COOL_AT) / (HEAT_GOLD_AT - HEAT_COOL_AT))
  }
  return blend(HEAT_GOLD, HEAT_ORANGE, (t - HEAT_GOLD_AT) / (HEAT_ORANGE_AT - HEAT_GOLD_AT))
}

/**
 * Converts an NWS compass point (`"WNW"`) to degrees clockwise from north.
 * Anything else — empty, lower case junk, a number — is unknown and returns
 * null. A page must never draw an arrow for an unknown direction: a default
 * of 0 would show a fake north wind.
 */
export function compassBearing(direction: string): number | null {
  const i = COMPASS_POINTS.indexOf(direction.trim().toUpperCase() as (typeof COMPASS_POINTS)[number])
  return i < 0 ? null : i * 22.5
}

/** `"5 to 9 mph"` becomes `"5-9 mph"`. Keeps the unit: on the compass key the
 * unit is the only thing that says this number is a wind speed. */
function compactSpeed(windSpeed: string): string {
  return windSpeed.trim().replace(/\s+to\s+/i, '-')
}

/** Whether a wind reading is calm (`"0 mph"`). A calm wind has no direction
 * worth an arrow, whatever the direction field says. */
function isCalm(windSpeed: string): boolean {
  return /^0+\s*mph$/i.test(windSpeed.trim())
}

/**
 * The high and the low as two strings for one shared row, centre-aligned.
 *
 * The key font (Menlo) is monospace, so a space is exactly one character
 * advance. The high gets trailing spaces and the low gets leading spaces,
 * one more than its own length. Centred, the high's visible text then ends
 * half a character left of the key's centre and the low's starts half a
 * character right of it — a small gap, with the pair centred on the key.
 * `renderKey` measures the padded string, so a pair that fits padded fits
 * on screen.
 */
export function tempPair(high: number, low: number): [string, string] {
  const hi = `${Math.round(high)}°`
  const lo = `${Math.round(low)}°`
  return [hi + ' '.repeat(hi.length + 1), ' '.repeat(lo.length + 1) + lo]
}

/**
 * The emoji band's picture for one condition. Fog is a drawn icon, because
 * the emoji font draws `🌫` as a pale grey block. Every other condition
 * keeps its emoji. `fxMs` drives the fog drift; null (stale or absent data)
 * keeps the icon still.
 */
function conditionGlyph(emoji: string, fxMs: number | null): Pick<KeySpec, 'emoji' | 'icon'> {
  if (emoji === '🌫') {
    const icon: IconSpec = fxMs === null ? { kind: 'fog' } : { kind: 'fog', nowMs: fxMs }
    return { icon }
  }
  return { emoji }
}

/** The part of `WeatherSource` this page needs. */
export interface WeatherReader {
  /** The configured ZIP code. The strip prints it when the place name is
   * unknown. Read from the source rather than a module constant, because it
   * is configuration. */
  getZip(): string
  getDays(): DayForecast[]
  getConditions(): Conditions | null
  getStatus(): WeatherStatus
  getLastUpdatedAt(): number
  getPlace(): string
  isStale(): boolean
  setVisible(visible: boolean): void
}

/** `95` becomes `95°`. Null (unknown) becomes `--`, never a fabricated value. */
function formatTemp(temp: number | null): string {
  return temp === null ? '--' : `${Math.round(temp)}°`
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
 * forecast at the configured ZIP code. A key dims when the shared forecast is stale
 * or when no data has arrived yet for that slot, so a stale or missing
 * forecast never presents as current. Pressing a day tile enters a detail
 * mode for that one day, spread across all eight keys, with BACK on key 7 —
 * the same mode-of-the-page pattern the stocks page uses for its own
 * drill-down, per the task brief.
 */
export class WeatherPage implements Page {
  readonly name = 'weather'

  /**
   * The selected day's stable identity (`DayForecast.id`), or null on the
   * grid. `onLeave` always clears this, so the page reopens on the grid
   * every time it becomes visible again.
   *
   * Per finding I1 (docs/LESSONS.md lesson 19): this used to be the array
   * INDEX the user pressed. `WeatherSource.getDays()` rebuilds its array from
   * scratch on every poll, and a day's position in it shifts as periods
   * expire — the day that was at index 1 can become index 0 on the very next
   * poll. Keying on the array position meant the open detail view silently
   * followed whatever day slid into that index next, not the day the user
   * actually opened. `id` never changes for the same real day-half, so this
   * keys on that instead — the same stable-identity fix the stocks page
   * already gets for free by keying on the symbol.
   *
   * Per finding C1: a bare calendar date is NOT unique (an overnight period
   * and the next day's daytime period can share one), so `id` is never
   * empty for a real, selectable tile — see `activeDay` and `onKeyPress`,
   * which both refuse to select a tile whose `id` is `''`.
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
   * Raised only while a condition effect is actually showing. A stale,
   * offline, or empty forecast freezes every effect (see `render`), so a
   * faster clock would buy nothing there — the same rule
   * `SpotifyPage.tickMs` follows for its idle animation.
   *
   * Reads `isDimmed`, the one function `render` uses too, so the declared
   * rate can never disagree with what the frame actually draws.
   */
  get tickMs(): number | undefined {
    const days = this.source.getDays()
    return this.isDimmed(days, this.source.getStatus()) ? undefined : FX_TICK_MS
  }

  /**
   * Whether the whole page must present as not-current: the forecast is
   * stale, the source is not ok, or no data has arrived at all.
   *
   * ONE function, read by both `render` and `tickMs`. Two callers reasoning
   * about this separately would diverge — lesson 21's "one decision, one
   * function", and the reason the render rate and the drawn frame cannot
   * disagree about whether anything is animating.
   */
  private isDimmed(days: DayForecast[], status: WeatherStatus): boolean {
    return this.source.isStale() || status !== 'ok' || days.length === 0
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
    return days.find((d) => d.id !== '' && d.id === this.selected) ?? null
  }

  render(now: number, nowMs?: number): DeckFrame {
    const days = this.source.getDays()
    const status = this.source.getStatus()
    const dim = this.isDimmed(days, status)
    // A page never reads the wall clock. The daemon injects both, and the
    // seconds value is the documented fallback for the millisecond one.
    const ms = nowMs ?? now * 1000
    // A stale or absent forecast draws no effect at all. The tiles already
    // dim; now the motion stops too. That is a stronger staleness signal than
    // dimming alone, and it keeps the page from animating data it does not
    // have — the same rule as never inferring a state from missing data.
    const fxMs = dim ? null : ms

    const day = this.activeDay(days)
    if (day) return this.detailFrame(day, dim, fxMs)

    const keys: KeySpec[] = []
    for (let i = 0; i < DAY_TILE_COUNT; i++) {
      // `i` is the seed: each tile animates on its own phase, so seven days of
      // the same weather read as seven tiles rather than one block.
      keys.push(this.dayKey(days[i], dim, fxMs, i))
    }
    keys.push(this.conditionsKey(dim, fxMs))

    return {
      keys,
      strip: this.strip(),
      buttons: [theme.gray, theme.gray],
    }
  }

  private dayKey(
    day: DayForecast | undefined, dim: boolean, fxMs: number | null, seed: number,
  ): KeySpec {
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
        bg: DEFAULT_STYLE.tint,
        dim: true,
      }
    }

    const key: KeySpec = {
      kind: 'gauge',
      // Bands 1, 3 and 4. Band 2 (the emoji, or the drawn fog icon) sits
      // between the label and the temperature row. Lines 1 and 2 are the
      // high and the low, on ONE row (see `tempRow`); line 3 is the rain
      // chance. Per the user's decision, this page shows percent chance of
      // rain only, never an amount.
      ...this.tempRow(day.high, day.low, day.label, formatPrecip(day.precipPercent), day.precipPercent),
      align: 'center',
      ...conditionGlyph(day.emoji, fxMs),
      // Same keyword match that picked the emoji, so the two can never
      // disagree with each other.
      bg: conditionTint(day.emoji),
    }
    // The ambient effect, from that same single lookup. Null `fxMs` means the
    // forecast is stale, absent, or offline, so nothing animates.
    if (fxMs !== null) key.fx = conditionFx(day.emoji, day.precipPercent, fxMs, seed)
    if (dim) key.dim = true
    return key
  }

  /**
   * The text fields of a day tile: label, high, low, rain chance.
   *
   * With both temperatures, the high is bold and warm-graded and the low is
   * smaller and grey, side by side on one row. With only one, it stands
   * alone and centred in the high's slot: a lone high keeps its warm colour,
   * a lone low stays grey so it still reads as a low. With neither, `--`.
   * The empty second slot keeps the line indexes the same in every case.
   */
  private tempRow(
    high: number | null, low: number | null, label: string, precip: string, precipPct: number | null,
  ): Pick<KeySpec, 'lines' | 'lineSizes' | 'lineY' | 'lineColors' | 'lineWeights'> {
    let first: string
    let second = ''
    let firstColor: Rgb = theme.text
    if (high !== null && low !== null) {
      ;[first, second] = tempPair(high, low)
      firstColor = heatColor(high)
    } else if (high !== null) {
      first = `${Math.round(high)}°`
      firstColor = heatColor(high)
    } else if (low !== null) {
      first = `${Math.round(low)}°`
      firstColor = LOW_COLOR
    } else {
      first = '--'
    }
    return {
      lines: [label, first, second, precip],
      lineSizes: [DAY_LABEL_SIZE, HIGH_SIZES, LOW_SIZES, PRECIP_SIZE],
      lineY: [DAY_LABEL_Y, TEMP_Y, LOW_Y, PRECIP_Y],
      lineColors: [undefined, firstColor, LOW_COLOR, precipColor(precipPct)],
      lineWeights: [undefined, 'bold', undefined, undefined],
    }
  }

  /**
   * Key 7: a wind compass. The NWS reports the direction the wind blows
   * FROM; the arrow points where it blows TO (`from + 180`), the way a
   * weather map draws it. The speed sits under the compass.
   *
   * An unknown direction, or a calm wind, draws no compass at all — a
   * default bearing would show a fake north wind. The key then shows `WIND`
   * and the speed alone. Unknown conditions show `--`.
   */
  private conditionsKey(dim: boolean, fxMs: number | null): KeySpec {
    const conditions = this.source.getConditions()
    const speed = conditions?.windSpeed ? compactSpeed(conditions.windSpeed) : '--'
    const from = conditions && !isCalm(conditions.windSpeed)
      ? compassBearing(conditions.windDirection ?? '')
      : null

    let key: KeySpec
    if (from === null) {
      key = {
        kind: 'gauge',
        lines: ['WIND', speed],
        lineSizes: [DAY_LABEL_SIZE, WIND_ONLY_SIZES],
        lineY: [WIND_LABEL_Y, WIND_ONLY_Y],
        lineColors: [theme.textDim, undefined],
        lineWeights: [undefined, 'bold'],
        align: 'center',
      }
    } else {
      const bearingDeg = (from + 180) % 360
      // The wobble runs only while the rest of the page animates. Stale or
      // absent data keeps the arrow still, so the key never rewrites.
      const icon: IconSpec = fxMs === null
        ? { kind: 'compass', bearingDeg }
        : { kind: 'compass', bearingDeg, nowMs: fxMs }
      key = {
        kind: 'gauge',
        icon,
        // A candidate array, so the renderer measures the speed and shrinks
        // it rather than drawing a long range past the margin.
        lines: [speed],
        lineSizes: [WIND_SPEED_SIZES],
        lineY: [WIND_SPEED_Y],
        lineWeights: ['bold'],
        align: 'center',
      }
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
  private detailFrame(day: DayForecast, dim: boolean, fxMs: number | null): DeckFrame {
    const keys: KeySpec[] = [
      // Three distinct seeds, so the combined tile and its two halves each
      // animate on their own phase rather than in lockstep.
      this.dayKey(day, dim, fxMs, 0),
      this.periodKey('DAY', day.day, dim, fxMs, 1),
      this.periodKey('NIGHT', day.night, dim, fxMs, 2),
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
  private periodKey(
    label: string, period: PeriodDetail | null, dim: boolean,
    fxMs: number | null, seed: number,
  ): KeySpec {
    if (!period) {
      return {
        kind: 'gauge',
        lines: [label, '--', '--'],
        lineSizes: [DAY_LABEL_SIZE, TEMP_SIZES, PRECIP_SIZE],
        lineY: [DAY_LABEL_Y, TEMP_Y, PRECIP_Y],
        align: 'center',
        bg: DEFAULT_STYLE.tint,
        dim: true,
      }
    }

    const key: KeySpec = {
      kind: 'gauge',
      lines: [label, formatTemp(period.temperature), formatPrecip(period.precipPercent)],
      lineSizes: [DAY_LABEL_SIZE, TEMP_SIZES, PRECIP_SIZE],
      lineY: [DAY_LABEL_Y, TEMP_Y, PRECIP_Y],
      // The one temperature on this tile is its hero, so it takes the warm
      // scale whichever half it belongs to.
      lineColors: [undefined, heatColor(period.temperature), precipColor(period.precipPercent)],
      lineWeights: [undefined, 'bold', undefined],
      align: 'center',
      ...conditionGlyph(period.emoji, fxMs),
      bg: conditionTint(period.emoji),
    }
    // Each half carries its OWN condition and its own rain chance, so a rainy
    // day with a clear night shows each on its own tile.
    if (fxMs !== null) key.fx = conditionFx(period.emoji, period.precipPercent, fxMs, seed)
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
   * Per M2 (this round): the grid strip's `updated …`/`offline` honesty
   * signal used to disappear entirely in detail mode — a stale or offline
   * forecast still showed two forecast paragraphs with nothing to say they
   * might be old. Both lines are already spoken for by the two forecast
   * paragraphs, so this reuses `right` (the same field the stocks detail
   * strip's own `renderStrip` mechanism is built for) rather than dropping
   * either paragraph, matching the stocks page's own drill-down, which
   * keeps its status text on the strip too.
   *
   * Per THIS review's M2: a bare timestamp here (`10:46 AM EDT`, with no
   * `updated` label) reads as part of the forecast paragraph beside it —
   * unlike the grid strip, which keeps the `updated ` word. `offline` and
   * `--` already read as status words on their own and keep no prefix.
   */
  private detailStrip(day: DayForecast): StripSpec {
    const dayText = day.day?.detailedForecast || '--'
    const nightText = day.night?.detailedForecast || '--'
    const status = this.source.getStatus()
    const updatedAt = this.source.getLastUpdatedAt()
    const right =
      status === 'offline' ? 'offline' : updatedAt > 0 ? `updated ${formatUpdated(updatedAt)}` : '--'
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
      const parts = [place || `ZIP ${this.source.getZip()}`, conditions?.shortForecast].filter(Boolean)
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
      // Per C1: a day with no usable `startTime` has no identity (`id` is
      // `''`) and must never be selectable — there is no stable way to find
      // it again on the next poll, and re-using the empty string would risk
      // colliding with another identity-less tile.
      if (day.id === '') return 'ignored'
      this.selected = day.id
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
