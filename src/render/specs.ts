import type { Image } from '@napi-rs/canvas'

export type Rgb = readonly [number, number, number]

export interface BarSpec {
  /** Fill fraction, 0 to 1. Values outside the range clamp. */
  value: number
  color: Rgb
  bg?: Rgb
}

export type KeyKind = 'blank' | 'session' | 'gauge' | 'control' | 'image'

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
  align?: 'left' | 'center'
  border?: Rgb
  /** True draws the border. False draws it dark. The page owns the phase. */
  pulseOn?: boolean
  bg?: Rgb
  bar?: BarSpec
  /** A large centred symbol, for a transport control. */
  glyph?: string
  /** An asset name, for example `crab`. */
  sprite?: string
  /** An already-decoded image, for example album art. `keyHash` ignores this field. */
  image?: Image
  /** Identity of `image`, for example a track id. `keyHash` uses this. */
  imageKey?: string
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
