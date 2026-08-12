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

export interface SparkSpec {
  /** Oldest first. Fewer than 2 points draws nothing. */
  values: number[]
  color: Rgb
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
   * Font size per line, in pixels, aligned by index with `lines`. A missing
   * entry, or an index past the end of this array, uses the default size.
   * Absent altogether, every line keeps the original 11 px size and the
   * original fixed line advance, so a page that never sets this field
   * renders exactly as it did before this field existed.
   */
  lineSizes?: number[]
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
