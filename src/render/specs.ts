import type { Image } from '@napi-rs/canvas'
import { canonicalKeySpec, canonicalStripSpec } from './motion.js'

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
export type FxVariant =
  | 'rain' | 'snow' | 'storm' | 'fog' | 'wind' | 'sun' | 'cloud' | 'drift' | 'pulse'

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
  /**
   * Replaces the variant's own base hue, so motion can carry a page's meaning —
   * a session's `stateColor`, a team's crest colour, a budget's `barColor`.
   *
   * Deliberately absent until task 46. With one consumer it would have been
   * speculative; with three it pays for itself.
   *
   * `sun` and `storm` IGNORE it. Their palettes are semantic rather than
   * decorative: the sun is amber because it is the sun, and lightning is white
   * because it is lightning. Every other variant honours it.
   */
  color?: Rgb
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
  /**
   * `'bar'` (the default, and the only style before the glow-up) draws one
   * vertical bar per value. `'line'` draws a 1.8 px polyline with a soft
   * area fill beneath it and an emphasised dot on the last point. Both
   * styles honour `slice`, `fullHeight`, `labelBand`, `label`, `baseline`
   * and `minHalfRange` the same way.
   */
  style?: 'bar' | 'line'
  /**
   * A reference value, in the series' own units — the previous close, for a
   * stock. A dotted horizontal rule marks it, the vertical scale always
   * includes it, and the `'line'` style fills its area toward it rather than
   * toward the band floor. Absent, no rule draws.
   */
  baseline?: number
  /**
   * The smallest half-range the vertical scale may use, in the series' own
   * units, centred on `baseline` (or on the series midpoint when `baseline`
   * is absent). A 0.1 percent day plotted against a 1 percent half-range
   * looks nearly flat, which is the truth; without it, any wiggle stretches
   * to fill the band. Absent or non-positive, the scale is the series'
   * own min and max, exactly as before this field existed.
   */
  minHalfRange?: number
  /**
   * `'line'` only: draws the emphasised endpoint dot (a 2.4 px core with a
   * soft halo). Default `true`. Ignored by `'bar'`.
   */
  endDot?: boolean
}

/**
 * A horizontal range gauge: a rounded track from `lo` to `hi` with a marker
 * at `value` — a day range, or a 52-week range. Values outside `lo..hi`
 * clamp to the nearest end; `lo >= hi` puts the marker at the centre.
 */
export interface RangeSpec {
  lo: number
  hi: number
  value: number
  /** Top edge of the track, in key px. Default 44. */
  y?: number
  /** Track height in px. Default 8. */
  height?: number
  /** Track colour when `gradient` is absent. Default `[42,46,56]`. */
  track?: Rgb
  /** Paints the track as a left-to-right gradient, `lo` colour to `hi`
   * colour, at 55 percent strength. The mockup uses red to green. */
  gradient?: readonly [Rgb, Rgb]
  /** Marker colour. Default white. */
  color?: Rgb
  /** `'arrow'` (default) is a downward triangle above the track; `'tick'` is
   * a 3 px bar that crosses it. */
  marker?: 'arrow' | 'tick'
}

/**
 * A one-shot effect: it starts at `startedAtMs`, runs for its variant's fixed
 * duration, then draws nothing. Both clocks are unix milliseconds; the page
 * passes its own `nowMs`, never `Date.now()`.
 *
 * Durations (`ONE_SHOT_DURATION_MS` in `render/motion.ts`): `burst` 1500,
 * `brick` 1000, `sweep` 500, `hearts` 1500.
 *
 * Cost: `keyHash` drops an effect that has not started or has finished, and
 * rebases a running one to its elapsed time quantised to 40 ms. So a page can
 * leave a finished effect in its spec forever and the key is never rewritten
 * for it. While it runs, the key rewrites at most once per 40 ms.
 */
export interface OneShotSpec {
  variant: OneShotVariant
  startedAtMs: number
  nowMs: number
  /** `burst` and `hearts`: the origin, in key px. Default (48, 40) for
   * `burst`, (48, 34) for `hearts`. */
  x?: number
  y?: number
  /** `burst`: the confetti colours, cycled. Default green, amber, white,
   * cyan, pink. `hearts`: alternating heart colours. */
  colors?: readonly Rgb[]
  /** `burst`: piece count, default 34, at most 80. `hearts`: heart count,
   * default 1, at most 8. */
  count?: number
  /** `sweep`: the flash colour. Default mint `[125,255,176]`. */
  color?: Rgb
  /** Decorrelates two keys bursting at once. Default 0. */
  seed?: number
}

export type OneShotVariant = 'burst' | 'brick' | 'sweep' | 'hearts'

/**
 * A pixel-art mascot that owns the middle of a key. `bull` hops; `bear`
 * sleeps under a drifting "z". Both draw a soft glow behind themselves —
 * green for the bull, red for the bear. The label ("BULLISH") is the page's
 * own text line; leave the band below y 80 for it.
 *
 * `nowMs` is quantised to 100 ms by both `keyHash` and the renderer, so a
 * mascot key rewrites at most 10 times a second.
 */
export interface MascotSpec {
  kind: 'bull' | 'bear'
  nowMs: number
}

/**
 * A drawn glyph, for a picture the emoji font draws badly.
 *
 * - `fog`: four stacked rounded bars in the emoji band (y 23..48), drifting
 *   gently. Use instead of `🌫`, which renders as a pale grey block.
 * - `compass`: a ring with N/E/S/W and a cyan arrow. It is larger than the
 *   emoji band — centre y 38, ring radius 22, letters at radius 30 (ink
 *   y 4..72) — so it suits a key whose only other content is one line at
 *   the bottom (top edge y 76 or lower).
 *
 * `nowMs` (optional) drives the fog drift and the compass wobble. It is
 * quantised to 100 ms. Absent, the glyph is static and the key never
 * rewrites for it.
 */
export type IconSpec =
  | { kind: 'fog'; nowMs?: number; color?: Rgb }
  | {
      kind: 'compass'
      /** The direction the arrow POINTS, in degrees clockwise from north
       * (0 = up, 90 = right). For wind reported "from" a bearing, pass
       * `from + 180` to show where the wind goes. */
      bearingDeg: number
      nowMs?: number
      /** Arrow colour. Default `theme.cyan`. */
      color?: Rgb
    }

/** One lit run along one edge of a key. `from` and `to` are fractions, 0 to
 * 1, along that edge in CLOCKWISE order: top runs left to right, right runs
 * top to bottom, bottom runs right to left, left runs bottom to top. */
export interface EdgeRun {
  edge: 'top' | 'right' | 'bottom' | 'left'
  from: number
  to: number
}

/**
 * A thin glowing line along some edges of a key — a progress line around a
 * multi-key block. Build it with `blockPerimeterProgress` in
 * `render/motion.ts` rather than by hand.
 *
 * Fractions are quantised to 1/192 of an edge (half a pixel), by both
 * `keyHash` and the renderer.
 */
export interface EdgeProgressSpec {
  runs: readonly EdgeRun[]
  /**
   * How hard the line throbs right now, 0 (resting) to 1 (peak). It widens
   * the glow, raises its strength, thickens the core line, and warms it toward
   * white. Quantised to `EDGE_PULSE_LEVELS` steps by both `keyHash` and the
   * renderer, so a pulsing line rewrites its keys only when the level steps.
   * Absent, zero or non-finite is a resting line.
   */
  pulse?: number
  /** Default `[255,217,196]`, a warm white. */
  color?: Rgb
}

/**
 * Moves and turns `image` — the crab's hop and spin. Applied about the key
 * centre, after the crop, inside the key's own bounds.
 */
export interface ImageTransform {
  /** Vertical offset in px; negative moves up. Default 0. */
  dy?: number
  /** Clockwise rotation in degrees. Default 0. */
  rotateDeg?: number
  /** Uniform scale. Default 1. Clamped to 0.25..3. */
  scale?: number
}

/**
 * Scales one text line up and back, around its own centre, for 1 s — the
 * "scale-pop" on a hero number. Same one-shot clock rules as `OneShotSpec`:
 * absent from the hash once finished.
 */
export interface LinePopSpec {
  /** Index into `lines`. */
  line: number
  startedAtMs: number
  nowMs: number
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
  /**
   * Per-line alignment, aligned by index with `lines`, overriding `align`
   * for that line. `'right'` anchors at the key's right padding (x 90). Two
   * lines with the same `lineY` and opposite alignments share one row — a
   * symbol on the left and a price on the right. An absent entry uses
   * `align`.
   */
  lineAligns?: ('left' | 'center' | 'right' | undefined)[]
  /** Per-line weight, aligned by index with `lines`. `'bold'` draws Menlo
   * Bold. An absent entry is regular. Candidate-size fitting measures in the
   * line's own weight. */
  lineWeights?: ('normal' | 'bold' | undefined)[]
  /** A one-shot scale-pop on one line. See `LinePopSpec`. */
  linePop?: LinePopSpec
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
  /** A horizontal range gauge. See `RangeSpec`. */
  range?: RangeSpec
  /** A drawn glyph. See `IconSpec`. */
  icon?: IconSpec
  /** A pixel-art mascot. See `MascotSpec`. */
  mascot?: MascotSpec
  /** Hop, spin and scale for `image`. See `ImageTransform`. */
  imageTransform?: ImageTransform
  /**
   * One-shot effects, drawn over the key's content (a `brick` also shakes
   * the content). Several may run at once. See `OneShotSpec`.
   */
  effects?: readonly OneShotSpec[]
  /** A glowing progress line along some edges. See `EdgeProgressSpec`. */
  edgeProgress?: EdgeProgressSpec
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
  /**
   * One large centred line that owns the strip's text area — a page name
   * during a transition, or "OPENING BELL". When set, `lines`, `right` and
   * `tape` do not draw; `bar` still does. See `StripBanner`.
   */
  banner?: StripBanner
  /**
   * A small pixel sprite walking across the strip, drawn over everything
   * else on a dark backing plate so the text under it cannot show through.
   */
  sprite?: StripSprite
}

export interface StripBanner {
  text: string
  /** Default `theme.text`. */
  color?: Rgb
  /** Font size in px, default 20. The banner shrinks (to 11 px at the least,
   * then truncates) until it fits the strip's 236 px. Bold Menlo, with the
   * colour-emoji font as a fallback, so `🔔 OPENING BELL` renders. */
  size?: number
  /** An optional small line beneath, 12 px, centred. With `sub`, the banner
   * line sits higher (centre y 22) to make room. */
  sub?: string
  /** Default `theme.textDim`. */
  subColor?: Rgb
  /** A one-shot scale-pop on the banner line, 1 s. Same clock rules as
   * `LinePopSpec`. */
  pop?: { startedAtMs: number; nowMs: number }
}

export interface StripSprite {
  /** The only sprite today: the two-frame pixel crab, 48 x 28 px. */
  kind: 'crab'
  /** Left edge in strip px. May be negative or past the right edge, so a
   * walk can enter and leave; the sprite is clipped to the strip. Rounded to
   * a whole pixel. */
  x: number
  /** Walk frame, 0 or 1. The page alternates it (for example every 125 ms). */
  frame: 0 | 1
  /** Vertical offset in px, negative is up, for a step bob. Default 0. The
   * crab's resting top edge is y 26. */
  dy?: number
  /** A short speech line drawn right of the crab, 12 px bold. */
  say?: string
  /** Default `[255,177,153]`. */
  sayColor?: Rgb
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
  // Canonical first: a finished one-shot effect drops out and a running
  // one rebases to its quantised elapsed time, so an idle key hashes the
  // same on every frame and the daemon never rewrites it. The renderer
  // draws from the SAME canonical spec, so equal hashes mean equal pixels.
  const { image, ...rest } = canonicalKeySpec(spec)
  return JSON.stringify(rest, replacer)
}

export function stripHash(spec: StripSpec): string {
  return JSON.stringify(canonicalStripSpec(spec), replacer)
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
