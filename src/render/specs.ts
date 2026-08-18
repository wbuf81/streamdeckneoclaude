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

/**
 * The three cyberpunk idle animations task 39 built to replace the old green
 * equaliser (see `IdleSpec` below). `spotify-page.ts`'s `IDLE_VARIANT`
 * constant is the one switch between them — the user picks, not the agent.
 */
export type IdleVariant = 'grid' | 'rain' | 'glitch'

export interface IdleSpec {
  /** Which animation `render/canvas.ts` draws. */
  variant: IdleVariant
  /**
   * The render clock, forwarded unchanged from the page's own `nowMs` — never
   * `Date.now()`, so the renderer can compute the whole animation from one
   * deterministic value. The Spotify page recomputes this on every `render`
   * call, so two renders at different clocks carry different values here;
   * that is what lets time actually move the animation instead of freezing
   * after the first frame (lesson 11 in docs/LESSONS.md — the exact defect
   * this field's predecessor, `PulseSpec.phase`, existed to avoid).
   */
  nowMs: number
  /**
   * This key's position in the album-art block: `col` 0 is leftmost, `row` 0 is
   * top. Each key renders its own cell of one design deterministically from
   * `nowMs` plus this position — no two keys share both values, so `keyHash`
   * (which includes this whole object) always tells them apart.
   *
   * `col` allows a THIRD column because task 44 grew the Spotify art block from
   * 2x2 to 3x2. Only the `rain` variant is independent per key and therefore
   * correct at that width; `grid` and `glitch` draw one scene sized to a 2x2
   * block and clamp `col` to at most 1 internally, so switching `IDLE_VARIANT`
   * degrades to a repeated column rather than a torn scene.
   */
  col: 0 | 1 | 2
  row: 0 | 1
}

/**
 * The seven ambient effects a key can draw BEHIND its own content. Task 42
 * built them for the weather page, where each forecast condition picks one,
 * so the forecast reads across the room before the digits do. A later
 * standalone animation page reuses the same layer.
 */
export type FxVariant = 'rain' | 'snow' | 'storm' | 'fog' | 'wind' | 'sun' | 'cloud' | 'drift'

export interface FxSpec {
  variant: FxVariant
  /**
   * The daemon's injected clock, in unix milliseconds. A page must never call
   * `Date.now()` — the same rule `IdleSpec.nowMs` follows, so a test passes an
   * explicit clock and gets a byte-identical frame.
   */
  nowMs: number
  /** 0 to 1. Scales density, rate, or brightness, depending on the variant. */
  intensity: number
  /**
   * Decorrelates neighbouring keys. Two tiles with the same variant and the
   * same seed animate in lockstep, which reads as one wide effect rather than
   * seven separate tiles; the key index is enough to break it.
   */
  seed: number
  /**
   * Which way the `drift` variant travels. Ignored by every other variant.
   *
   * The renderer picks the colour from this — green rising, red sinking —
   * exactly as every other variant hardcodes its own palette (rain is blue,
   * snow is white, sun is amber). There is deliberately no `color` field:
   * nothing needs one yet.
   *
   * Absent defaults to `'up'`, and `sanitizeKeySpec` coerces any other value to
   * one of the two, the same way it already coerces `IdleSpec.col` and `row`.
   */
  direction?: 'up' | 'down'
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
  /**
   * A large symbol, for a transport control, drawn centred on its own INK
   * rather than the arithmetic middle of the key — see `drawCenteredGlyph`
   * in `render/canvas.ts`. Every key that sets this uses the SAME size and
   * the SAME target position, so a row of controls (play/pause, previous,
   * next, volume) reads as one set instead of each key inventing its own
   * layout — task 37 fixed exactly that inconsistency on the Spotify page.
   */
  glyph?: string
  /** Tints `glyph`. An absent value uses the default text colour. Used by the
   * Spotify heart, the one place on that page where colour earns its keep. */
  glyphColor?: Rgb
  /**
   * A short caption drawn beneath `glyph`, centred, in the small band every
   * control key reserves there — for example a volume percentage. Ignored
   * unless `glyph` is also set. The band is reserved on every control key
   * regardless of whether THIS key uses it, so a key with no caption still
   * positions its glyph identically to a neighbour that has one; leaving the
   * caption unset simply leaves that band as background.
   */
  glyphCaption?: string
  /**
   * Selects the font family `glyph` draws with. Absent (or `'text'`) is the
   * ORIGINAL path — the plain-text `FONT` (Menlo), tintable via
   * `glyphColor`, dimmed via `fillStyle` — byte-identical to before this
   * field existed. `'emoji'` draws `glyph` with the colour-emoji font
   * instead (the same font the standalone `emoji` field below already uses)
   * and dims it via `globalAlpha` rather than `fillStyle`: colour emoji are
   * bitmap glyphs that ignore `fillStyle` (lesson 15 in docs/LESSONS.md,
   * task 24's original bug on THIS project). `glyphColor` is ignored in
   * `'emoji'` mode — a bitmap glyph cannot be tinted. Task 38 (Spotify).
   */
  glyphFont?: 'text' | 'emoji'
  /**
   * Grows and shrinks `glyph` by a small fraction around its own optical
   * centre, one sine cycle per `2π` of `phase` — the Spotify volume key's
   * "thump" while a track plays (task 38). Re-measures the glyph's ink
   * bounds at the ACTUAL size drawn on every frame (see `drawCenteredGlyph`
   * in `render/canvas.ts`), so the glyph stays optically centred throughout
   * the pulse rather than assuming the resting size's correction still
   * applies at a different size. Absent, `glyph` draws at its fixed default
   * size, exactly as before this field existed.
   */
  glyphPulse?: { phase: number }
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
   * A slow, ambient cyberpunk animation for a key with nothing else to show —
   * used by the Spotify page's four album-art keys while nothing is playing
   * (task 39, replacing the earlier green equaliser). `keyHash` uses this
   * like any other field — `nowMs` changes on every render call, and without
   * it in the hash the daemon's dirty-key check would see no difference and
   * the animation would freeze after one frame, the exact defect lesson 11 in
   * docs/LESSONS.md describes for the same four keys' `imageCrop`.
   */
  idle?: IdleSpec
  /**
   * An ambient effect drawn BENEATH this key's own content — the background
   * wash first, then this layer, then the image, border, glyph, emoji and
   * text. Opt-in per key: absent, the render path is byte-identical to
   * before this field existed, exactly as `lineSizes` and `SparkSpec.slice`
   * are. That is what keeps every other page's pixel proof valid.
   *
   * `nowMs` changes every frame, so a key carrying `fx` rewrites every frame
   * by design. `keyHash` covers this field and must keep covering it, or the
   * daemon's dirty-key check sees no difference and the effect freezes after
   * one frame — lesson 11 in docs/LESSONS.md.
   */
  fx?: FxSpec
  dim?: boolean
  /**
   * A thin outline drawn around the whole key perimeter, on top of every
   * other element — used only for the daemon's transient press-feedback
   * flash (task 36). Unlike `border`, which this theme draws as a left-edge
   * strip only (see `render/canvas.ts`), this ring wraps all four sides, so
   * it stays visible regardless of where on the key a page already draws
   * its own border. It never touches the interior: the key's own content
   * (text, image, spark, and so on) stays exactly as it would render
   * without this field, so the ring reads as an overlay, not a fill. Task
   * 32's flash replaced the whole key with a solid colour; that read as too
   * bright and jarring on real hardware, which is why this field exists
   * instead of a `bg` fill.
   */
  flashRing?: Rgb
}

export interface StripSpec {
  /** Up to 2 text lines. */
  lines: string[]
  bar?: BarSpec
  /** Right-aligned text on line 2, for example `2:14 / 4:32`. */
  right?: string
  dim?: boolean
  /**
   * A tape scrolling horizontally across LINE 2's band. When set, line 2's own
   * text is not drawn; `lines[0]` still draws normally, so a page can keep a
   * fixed title above a moving tape.
   *
   * Opt-in: absent, `renderStrip` is byte-identical to before this field
   * existed, exactly as `KeySpec.fx` is. That is what keeps every other page's
   * strip proof valid.
   *
   * The tape draws inside a clip rectangle, so it CANNOT paint over line 1, over
   * the bar, or outside the strip — and when `right` is also set the clip
   * excludes its gutter, so the two coexist instead of one overwriting the
   * other.
   *
   * `offsetPx` changes every frame, so a strip carrying a tape rewrites every
   * frame by design. `stripHash` covers this field and must keep covering it.
   */
  tape?: TapeSpec
}

/**
 * One coloured run of text inside a scrolling tape. Task 43's stocks ticker.
 */
export interface TapeSegment {
  text: string
  /** Absent takes the strip's default text colour. */
  color?: Rgb
}

export interface TapeSpec {
  segments: readonly TapeSegment[]
  /**
   * How far the tape has scrolled, in pixels, increasing without bound.
   *
   * The RENDERER wraps this, because only the renderer can measure the tape's
   * real width in the real font — so a page can scroll a tape without ever
   * touching font metrics, which it is not allowed to do anyway (lesson 17).
   */
  offsetPx: number
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
