import type { Image } from '@napi-rs/canvas'

export type Rgb = readonly [number, number, number]

export interface BarSpec {
  /** Fill fraction, 0 to 1. Values outside the range clamp. */
  value: number
  color: Rgb
  bg?: Rgb
}

export type KeyKind = 'blank' | 'session' | 'gauge' | 'control' | 'image'

export interface ImageCrop {
  /** Source rectangle, in fractions of the image, 0 to 1. */
  sx: number
  sy: number
  sw: number
  sh: number
}

export interface PulseSpec {
  /**
   * Radians, already advanced by both the render clock and this key's own
   * offset. The Spotify page computes this fresh on every `render(now,
   * nowMs)` call from `nowMs` plus a fixed per-key offset, so two renders at
   * different clocks — or two of the four idle art keys at the SAME clock —
   * carry different values here. That is what lets the four keys
   * phase-shift against each other and lets time actually move the bars; a
   * static spec would freeze after the first frame.
   */
  phase: number
  /** Number of vertical bars drawn across the key. */
  bars: number
  color: Rgb
}

export interface SparkSpec {
  /** Oldest first. Fewer than 2 points draws nothing. */
  values: number[]
  color: Rgb
  /**
   * Draws one horizontal slice of a chart that spans `count` keys, instead
   * of the whole series on one key. `index` (0-based) picks which slice this
   * key draws. Absent, the series draws whole on one key, exactly as before
   * this field existed — the stocks grid depends on that being
   * byte-identical, see `renderKey`'s `drawSpark`.
   */
  slice?: { index: number; count: number }
  /**
   * Draws the bars across the whole key height instead of the default lower
   * band. Only correct for a key that carries no text lines — the stocks
   * detail chart's three keys are chart-only, so the chart may as well own
   * the full tile instead of wasting the top half. Absent, the spark keeps
   * its original band, exactly as before this field existed.
   */
  fullHeight?: boolean
  /**
   * Reserves a short text band at the top of a `fullHeight` chart, so the
   * bars start lower and never grow tall enough to reach it. Set this the
   * SAME on every key of one `slice` group, even the ones that draw no
   * `label` themselves — otherwise their bar geometry (`bandY`/`bandH` in
   * `render/canvas.ts`) would differ from the labelled key's, and the chart
   * would show a visible step where the bars change height at the seam
   * between two keys. Ignored when `fullHeight` is absent, because the
   * default band already leaves the top half free.
   */
  labelBand?: boolean
  /**
   * A short caption drawn inside the band `labelBand` reserves, left-aligned
   * at this key's own top edge — for example `52 WK` or `1D`, so the stocks
   * detail chart tells the user which range it is showing. Meant for ONE key
   * of a `slice` group (the stocks page uses index 0); the other keys still
   * set `labelBand: true` to match the reserved space but leave `label`
   * unset, so nothing draws there.
   */
  label?: string
}

export interface KeySpec {
  kind: KeyKind
  /** Up to 4 text lines, top to bottom. */
  lines?: string[]
  /**
   * Per-line text colour, aligned by index with `lines`. An absent entry, or
   * an index past the end of this array, uses the default text colour. The
   * stocks page uses this to tint only the change line, never the price.
   */
  lineColors?: (Rgb | undefined)[]
  /**
   * Font size per line, aligned by index with `lines`. A missing entry, or
   * an index past the end of this array, uses the default size. Absent
   * altogether, every line keeps the original 11 px size and the original
   * fixed line advance, so a page that never sets this field renders exactly
   * as it did before this field existed.
   *
   * Each entry is either:
   * - a plain `number`: a fixed size, drawn as given, never measured. Use
   *   this when the page already knows the text always fits (a short fixed
   *   label, for example).
   * - an `array` of candidate sizes, largest first or in any order: the page
   *   declares intent ("try to fit this line at one of these sizes") and
   *   `renderKey` measures with the real canvas and picks the largest
   *   candidate that fits the key's usable width, shrinking further than the
   *   smallest candidate (by truncating the text) rather than ever clipping
   *   past the edge. Pages stay pure — no canvas — because the measuring
   *   happens here, in the renderer, not in the page. Consecutive lines that
   *   pass the SAME candidate array (by value) are sized as one unit: the
   *   renderer picks one size that fits every line in the group, so a pair
   *   like a range's high and low never ends up two different sizes.
   */
  lineSizes?: (number | number[])[]
  /**
   * Explicit top-edge y for one line, aligned by index with `lines`. A
   * missing entry, or an index past the end of this array, keeps the running
   * automatic advance (the position the previous line's advance landed on).
   * Absent altogether, every line keeps its automatic position, exactly as
   * before this field existed.
   *
   * The weather page needs this: the emoji owns a fixed band in the middle
   * of the key, so its label, temperature and rain-chance lines cannot step
   * uniformly from the top — they must land in the three bands the emoji
   * leaves free, skipping over it. Without an explicit y, only a second
   * layout mechanism (or overlapping the emoji, which is exactly the bug
   * this task fixes) could place a line below a gap.
   */
  lineY?: number[]
  align?: 'left' | 'center'
  border?: Rgb
  /** True draws the border. False draws it dark. The page owns the phase. */
  pulseOn?: boolean
  bg?: Rgb
  bar?: BarSpec
  /** A large centred symbol, for a transport control. */
  glyph?: string
  /** Tints `glyph`. An absent value uses the default text colour. Used by the
   * Spotify heart, the one place on that page where colour earns its keep. */
  glyphColor?: Rgb
  /** A single emoji, drawn large and centred. Used by the weather page. */
  emoji?: string
  /** An already-decoded image, for example album art. `keyHash` ignores this field. */
  image?: Image
  /** Identity of `image`, for example a track id. `keyHash` uses this. */
  imageKey?: string
  /**
   * Draws only part of `image`, in fractions of the source, 0 to 1. Used to
   * span one image across several keys, each with a different crop but the
   * SAME `imageKey`. Because the daemon writes a key only when its `keyHash`
   * changes, `imageCrop` must be (and is) part of that hash — otherwise a
   * track change would update only one of the spanned keys.
   */
  imageCrop?: ImageCrop
  /** A small series drawn as vertical bars. Used by the stocks page. */
  spark?: SparkSpec
  /**
   * A slow-breathing equaliser animation, drawn as vertical bars, for a key
   * with nothing else to show. Used by the Spotify page's four album-art
   * keys while nothing is playing. `keyHash` uses this like any other
   * field — `phase` changes on every render call, and without it in the
   * hash the daemon's dirty-key check would see no difference and the
   * animation would freeze after one frame, the exact defect lesson 11 in
   * docs/LESSONS.md describes for the same four keys' `imageCrop`.
   */
  pulse?: PulseSpec
  dim?: boolean
}

export interface StripSpec {
  /** Up to 2 text lines. */
  lines: string[]
  bar?: BarSpec
  /** Right-aligned text on line 2, for example `2:14 / 4:32`. */
  right?: string
  dim?: boolean
}

export interface DeckFrame {
  /** Exactly 8 entries, for key index 0 to 7. */
  keys: KeySpec[]
  strip: StripSpec
  /** Colors for touch button 8 and 9. */
  buttons: [Rgb, Rgb]
}

export function blankKey(): KeySpec {
  return { kind: 'blank' }
}

/**
 * Serializes a key for change detection. It replaces `image` with `imageKey`,
 * because the buffer is large and its identity is enough.
 */
export function keyHash(spec: KeySpec): string {
  const { image, ...rest } = spec
  return JSON.stringify(rest, replacer)
}

export function stripHash(spec: StripSpec): string {
  return JSON.stringify(spec, replacer)
}

/** Sorts object keys, so key order cannot change a hash. */
function replacer(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)) {
    const o = v as Record<string, unknown>
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = o[k]
      return acc
    }, {})
  }
  return v
}
