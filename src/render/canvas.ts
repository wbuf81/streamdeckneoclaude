import { createCanvas, type Canvas, type SKRSContext2D, type Image } from '@napi-rs/canvas'
import type { KeySpec, StripSpec, Rgb, BarSpec, SparkSpec, ImageCrop, IdleSpec, FxSpec, TapeSpec, TapeSegment } from './specs.js'
import { theme } from './theme.js'

export const KEY_SIZE = 96
export const STRIP_WIDTH = 248
export const STRIP_HEIGHT = 58

/** Exported so `text.ts` can measure with the exact same font the renderer
 * uses. Two different font names would make a measurement meaningless. */
export const FONT = 'Menlo'
const PAD = 6
const BORDER = 3
const BAR_Y = 66
const BAR_H = 8
const SPARK_Y = 48
const SPARK_H = 40
/** A chart-only key (no text lines) can use the whole tile instead of the
 * default lower band. Leaves the same top and bottom margin the default
 * band keeps, just stretched over the full height. */
const SPARK_FULL_Y = 6
const SPARK_FULL_H = 84
/**
 * A `fullHeight` chart with `labelBand` set reserves this many px at its top
 * for the `label` caption instead of letting bars use the whole band. 18 px
 * comfortably fits an 11 px line (VERIFIED-FACTS.md: 11 px gives 12 chars,
 * and the longest caption here, `52 WK`, is 5) with room above and below so
 * the text never touches the bars.
 */
const SPARK_LABEL_BAND_H = 18
/**
 * Shared geometry for the three cyberpunk idle animations (task 39): the
 * scene each of the four album-art keys deterministically draws its own
 * quadrant of. `IDLE_SCENE` is exactly two key widths, so `col`/`row` (0 or
 * 1) place a key's own 96x96 window at one corner of it.
 */
const IDLE_SCENE = KEY_SIZE * 2
/** How many columns the idle block can span. `rain` honours all of them; the
 * scene-based variants clamp through `sceneColumn`. */
const IDLE_MAX_COLS = 3
/**
 * Usable text width of one key: 96 − 3 border − 6 padding each side.
 * Matches docs/VERIFIED-FACTS.md's measured text budget table. Used to
 * resolve a `lineSizes` candidate-array entry to a concrete size that
 * actually fits, at draw time — see `resolveLineSpecs`.
 */
const TEXT_MAX_WIDTH = KEY_SIZE - BORDER - PAD * 2
/** Baseline of the strip's second text line. */
const STRIP_LINE_2_Y = 21
/**
 * Usable text width of the whole strip: 248 − 6 padding each side. Matches
 * docs/VERIFIED-FACTS.md's measured "236 px usable width." Both strip lines
 * are shrunk to fit this by MEASURING with the real canvas (see
 * `renderStrip`), never by trusting a page's own character-count truncation
 * — a fixed character count cannot know how wide THIS string of digits and
 * letters actually measures (lesson 17 in docs/LESSONS.md; I5 and I6 both
 * reached shipped code exactly this way).
 */
const STRIP_TEXT_MAX_WIDTH = STRIP_WIDTH - PAD * 2
/**
 * Breathing room reserved between line 2's own text and the right-aligned
 * clock/time beside it, on top of whatever width the clock itself measures.
 * Without this, a line 2 shrunk to fit would still end flush against the
 * clock's first character — technically non-overlapping, but visually
 * crowded in exactly the way lesson 14 warns against.
 */
const STRIP_RIGHT_GAP = 6
/** Dims a colour, or a colour emoji's `globalAlpha`, to this fraction. One
 * constant so text, border and emoji all dim by the same amount. */
const DIM_FACTOR = 0.45
/**
 * Geometry of the press-feedback flash ring (task 36's `KeySpec.flashRing`).
 *
 * `FLASH_RING_INSET` is how far the ring's outer edge sits from the key's
 * true edge — a ring drawn flush with the edge (inset 0) is indistinguishable
 * from a bezel-to-bezel fill at a glance, so a small gap is what makes it
 * read as a deliberate outline. `FLASH_RING_THICKNESS` is the stroke width;
 * the task's rendered previews (96 px key, scaled 4x) compared 3, 4 and 5 px
 * before picking this value.
 *
 * Measured with `probe` at these settings: a key's own left-edge `border`
 * (`BORDER` = 3 px, columns 0 to 2) loses its two innermost columns (1 and 2)
 * to the ring, which is drawn afterwards and wins the overlap; only column 0
 * — one pixel out of 96 — still shows the border's own colour. That is
 * enough for the ring to read as the dominant signal over, for example, the
 * Claude page's pulsing amber permission border, without this file needing
 * to know that field exists or carve out a special case for it.
 */
export const FLASH_RING_INSET = 1
export const FLASH_RING_THICKNESS = 4
/**
 * Size and vertical centre of the emoji glyph.
 *
 * Measured with `ctx.getImageData` over every weather emoji this app draws
 * (see the brief's band table for the nominal geometry): a colour emoji's
 * real ink does not sit centred on its nominal font-size box the way plain
 * text does. At `34px` centred on `y 34` — the brief's own suggested
 * numbers — several glyphs (for example the rain and snow icons) painted
 * ink as high as `y 12`, one row below where the day label's own ink ends,
 * leaving no background gap at all between band 1 and band 2.
 *
 * `32px` centred on `y 38` was the smallest, lowest combination that kept
 * every weather emoji's ink between `y 17` and `y 48` — clear of the label
 * (ends by `y 12`) above and the temperature line (starts at `y 55`) below.
 */
/** The one colour-emoji font this file draws with, for both the standalone
 * `emoji` field (the weather page) and `glyph` in `'emoji'` mode (the
 * Spotify page, task 38). One named constant so the two paths cannot drift
 * to two different font strings. */
const EMOJI_FONT = 'Apple Color Emoji'
const EMOJI_SIZE = 32
const EMOJI_Y = 38
/**
 * Size and target ink-centre for the Spotify page's four transport-control
 * TEXT glyphs: play/pause, previous, next, and the volume "up" triangle.
 * This is what task 37 shipped first; task 38 replaced it on the actual
 * Spotify page with the EMOJI row below (`EMOJI_GLYPH_SIZE`/`EMOJI_GLYPH_Y`,
 * selected via `glyphFont: 'emoji'` in `render/specs.ts`), per the user's
 * choice. This text path stays in place as the non-emoji option — nothing
 * currently calls it with `glyphFont` absent/`'text'` on a real page, but a
 * future page or a reverted choice can use it with no new measurement.
 *
 * Measured (task 37, `docs/LESSONS.md` #17): `▶`, `▮▮`, `◀◀`, `▶▶` and `▲` —
 * all from the Geometric Shapes block — share IDENTICAL ascent (7.44px) and
 * descent (13.56px) at `GLYPH_SIZE`, both with `getImageData` and with
 * `ctx.measureText().actualBoundingBox*`, so one centring correction
 * (`drawCenteredGlyph`) serves every one of them with no per-glyph special
 * case. The glyph this replaced for pause, `❙❙` (Miscellaneous Symbols
 * block), did NOT share that metric — its own measured ascent/descent
 * (12.44 / 16.56) is exactly why it read heavier and lower than its
 * neighbours on the real device.
 *
 * Task 37's first pass also measured the media-control Unicode block
 * (`⏮ ⏯ ⏭ ⏪ ⏩`) and the speaker emoji (`🔊 🔈`) rendering as an IDENTICAL
 * tofu box and rejected them as unusable. That measurement was taken with
 * `FONT` (Menlo, no emoji coverage) — the SAME font every codepoint falls
 * back to `.notdef` under, hence the identical box regardless of which one
 * was drawn. It was a font-choice bug in the measurement, not a fact about
 * the glyphs: task 38 re-measured the same codepoints with `EMOJI_FONT` and
 * they render correctly (see `EMOJI_GLYPH_SIZE` below). Lesson: an "empty"
 * or "identical" result across several different inputs is itself a signal
 * to check the harness, not just the inputs.
 */
const GLYPH_SIZE = 34
/** Target y for the glyph's ink centre, not the raw draw point —
 * `drawCenteredGlyph` corrects for the gap between the two. Leaves the
 * lower part of the key free for `GLYPH_CAPTION_Y`, reserved on every
 * control key whether or not that particular key uses it. */
const GLYPH_Y = 36
/** Top of the small caption band beneath the glyph (for example the volume
 * key's percentage). Shared by both the text-glyph and emoji-glyph rows, so
 * every control key's caption lands on the same row regardless of which
 * font drew the icon above it — verified by pixel probe for both (task 37's
 * gap test, and task 38's equivalent for the emoji row and its "thump"). */
const GLYPH_CAPTION_Y = 60
const GLYPH_CAPTION_SIZE = 11
/**
 * Size and target ink-centre for the Spotify page's EMOJI-mode transport
 * row (task 38, `glyphFont: 'emoji'`). Measured separately from the text
 * row above: colour emoji are square bitmaps with different metrics (ascent
 * 26.5 / descent 13.5 at this size, versus the text glyphs' 7.44 / 13.56),
 * so `EMOJI_GLYPH_Y` sits higher than `GLYPH_Y` to keep the taller glyph's
 * ink clear of `GLYPH_CAPTION_Y` — confirmed by pixel probe, both at rest
 * and at the "thump" animation's largest frame (`GLYPH_PULSE_AMPLITUDE`).
 * `drawCenteredGlyph`'s runtime correction (from
 * `ctx.measureText().actualBoundingBox*`) needed NO change to handle this
 * font: it measured emoji ink within 0.5px of the requested target with no
 * per-glyph special case, the same as it does for the text row.
 */
const EMOJI_GLYPH_SIZE = 40
const EMOJI_GLYPH_Y = 30
/**
 * How far `glyphPulse` scales the glyph up and down from its resting size,
 * as a fraction — the Spotify volume key's "thump" while a track plays
 * (task 38). At this amplitude the largest frame (`EMOJI_GLYPH_SIZE` up by
 * this fraction) still keeps the emoji's ink clear of `GLYPH_CAPTION_Y`,
 * confirmed by pixel probe; a larger amplitude was not needed to read as
 * motion once it was on-screen at 4x scale.
 */
const GLYPH_PULSE_AMPLITUDE = 0.1

function css(c: Rgb, dim = false): string {
  const f = dim ? DIM_FACTOR : 1
  return `rgb(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)})`
}

/** Same colour rule as `css`, but with an explicit alpha channel — used by
 * the idle animations for translucent scanlines and fading trails, where a
 * fully opaque fill would be too heavy for a background decoration. */
function cssAlpha(c: Rgb, alpha: number, dim = false): string {
  const f = dim ? DIM_FACTOR : 1
  return `rgba(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)},${alpha})`
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Returns `n` when it is a finite number, otherwise `fallback`. `NaN` and
 * `+/-Infinity` are both valid `number`s at the type level, so this is a
 * runtime check, not something the type system can rule out for us. */
function finiteOr(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback
}

/**
 * The one boundary a hostile `KeySpec` passes through before any drawing
 * primitive sees it (C1 in `.superpowers/sdd/2026-08-12-streamdeck-neo-claude-
 * deck-part2/e2e-render.md`). Coerces every numeric field to a finite value,
 * so a spec built from bad upstream data — or a deliberately hostile one —
 * degrades to a plain, safely-rendered key instead of reaching a drawing
 * primitive with `NaN`/`Infinity`.
 *
 * This matters most for `idle.nowMs`: `@napi-rs/canvas`'s `ctx.arc` (the
 * `grid` variant's sun) panics in Rust on a non-finite argument and aborts
 * the whole process — not a catchable `throw`, so the render loop's own
 * `try`/`catch` cannot stop it. `lineSizes` and `glyphPulse.phase` reach a
 * font string built from their own value (`` `${size}px ...` ``), and
 * `NaN`/`Infinity` there throws `is not valid font style`.
 *
 * One choke point, not a guard at each call site (lesson 21 in
 * docs/LESSONS.md): a future numeric field is safe only if it is added here
 * too. `bar.value` and `imageCrop` already had their own narrower `clamp01`
 * guard before this function existed; that guard stays as a second belt —
 * this function is the one that covers everything else, including the
 * fields `clamp01` never touched.
 */
/** Coerces an idle column to one of the three the layout allows. */
function idleColumn(n: number): 0 | 1 | 2 {
  if (n >= 2) return 2
  if (n >= 1) return 1
  return 0
}

function sanitizeKeySpec(spec: KeySpec): KeySpec {
  const out: KeySpec = { ...spec }

  if (out.lineSizes) {
    out.lineSizes = out.lineSizes.map((entry) =>
      Array.isArray(entry) ? entry.map((n) => finiteOr(n, 11)) : finiteOr(entry, 11),
    )
  }
  if (out.lineY) {
    out.lineY = out.lineY.map((n) => finiteOr(n, 0))
  }
  if (out.bar) {
    out.bar = { ...out.bar, value: finiteOr(out.bar.value, 0) }
  }
  if (out.glyphPulse) {
    out.glyphPulse = { phase: finiteOr(out.glyphPulse.phase, 0) }
  }
  if (out.imageCrop) {
    out.imageCrop = {
      sx: finiteOr(out.imageCrop.sx, 0),
      sy: finiteOr(out.imageCrop.sy, 0),
      sw: finiteOr(out.imageCrop.sw, 0),
      sh: finiteOr(out.imageCrop.sh, 0),
    }
  }
  if (out.spark) {
    out.spark = { ...out.spark, values: out.spark.values.map((v) => finiteOr(v, 0)) }
  }
  if (out.idle) {
    out.idle = {
      ...out.idle,
      nowMs: finiteOr(out.idle.nowMs, 0),
      col: idleColumn(finiteOr(out.idle.col, 0)),
      row: finiteOr(out.idle.row, 0) === 1 ? 1 : 0,
    }
  }
  if (out.fx) {
    // `drawFxSun`, `drawFxSnow` and `drawFxCloud` all reach `ctx.arc`, which
    // PANICS in Rust on a non-finite argument and aborts the whole process —
    // not a catchable throw, so the render loop's own try/catch cannot save
    // it. The gradient variants reach `createLinearGradient` and
    // `createRadialGradient`, which need finite coordinates too. This is the
    // one boundary that keeps all of that unreachable.
    out.fx = {
      ...out.fx,
      nowMs: finiteOr(out.fx.nowMs, 0),
      intensity: clamp01(finiteOr(out.fx.intensity, 0)),
      seed: finiteOr(out.fx.seed, 0),
      // Coerced to one of the two values, so a bogus string cannot reach the
      // drawing code and silently pick a direction by falling through.
      direction: out.fx.direction === 'down' ? 'down' : 'up',
    }
  }
  return out
}

/** Same boundary as `sanitizeKeySpec`, for `renderStrip`'s own numeric fields. */
function sanitizeStripSpec(spec: StripSpec): StripSpec {
  const out: StripSpec = { ...spec }
  if (out.bar) out.bar = { ...out.bar, value: finiteOr(out.bar.value, 0) }
  if (out.tape) {
    // A non-finite offset reaches `fillText`'s x and the clip rectangle. Neither
    // is survivable, and the render loop's own try/catch cannot help with the
    // ones that panic in Rust.
    out.tape = { ...out.tape, offsetPx: finiteOr(out.tape.offsetPx, 0) }
  }
  return out
}

/**
 * Deterministic pseudo-random value in [0, 1) from an integer seed. No
 * internal state and never `Math.random()` — the same seed always returns
 * the same value, which is what lets two renders at the same `nowMs`
 * produce byte-identical frames (lesson 11 in docs/LESSONS.md). Used by the
 * idle animations to pick stable-looking "random" positions and characters
 * from plain arithmetic on `nowMs`, a column index, or a key's position.
 */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

function drawBar(
  ctx: SKRSContext2D,
  bar: BarSpec,
  x: number,
  y: number,
  w: number,
  h: number,
  dim: boolean,
): void {
  ctx.fillStyle = css(bar.bg ?? theme.barTrack, dim)
  ctx.fillRect(x, y, w, h)
  const fill = Math.round(w * clamp01(bar.value))
  if (fill > 0) {
    ctx.fillStyle = css(bar.color, dim)
    ctx.fillRect(x, y, fill, h)
  }
}

/**
 * Draws one series as vertical bars, one per value, filling the width from
 * `BORDER + PAD` to `KEY_SIZE - PAD`. Normalises between the series minimum
 * and maximum. A flat series (`range === 0`) draws every bar at half height,
 * which reads as a centred horizontal line, rather than dividing by zero.
 * Fewer than 2 values draws nothing at all.
 *
 * With `slice`, the series lays out across `slice.count` key widths instead
 * of one, and this call draws only the portion belonging to `slice.index`.
 * The min and max still come from the WHOLE series (never just the visible
 * slice), so the three keys of one chart share one scale and a bar's height
 * means the same thing on every one of them. A bar that straddles a slice
 * boundary is clipped to this key's own margin rather than bleeding into the
 * border — the physical gap between two real keys already loses that sliver,
 * this only keeps the maths from painting over the padding.
 *
 * Absent `slice`, `sliceStart` is 0 and `virtualWidth` equals the plain
 * single-key `width`, so every computed position matches the pre-`slice`
 * code exactly — the grid's single-key sparkline depends on that being
 * byte-identical.
 *
 * `labelBand` (only meaningful with `fullHeight`) reserves `SPARK_LABEL_BAND_H`
 * px at the top of THIS key's band, so a `label` drawn there never touches a
 * bar. It must be set the same on every key of a `slice` group even when
 * only one of them carries `label` text — otherwise the bars on the
 * labelled key would use a shorter band than its neighbours and visibly step
 * at the seam between keys.
 */
function drawSpark(ctx: SKRSContext2D, spark: SparkSpec, dim: boolean): void {
  const { values, color, slice, fullHeight, labelBand, label } = spark
  if (values.length < 2) return

  const x0 = BORDER + PAD
  const x1 = KEY_SIZE - PAD
  const width = x1 - x0
  const reserve = fullHeight && labelBand ? SPARK_LABEL_BAND_H : 0
  const bandY = (fullHeight ? SPARK_FULL_Y : SPARK_Y) + reserve
  const bandH = (fullHeight ? SPARK_FULL_H : SPARK_H) - reserve

  const count = slice && slice.count > 0 ? slice.count : 1
  const index = slice?.index ?? 0
  const virtualWidth = width * count
  const barW = virtualWidth / values.length
  const sliceStart = index * width
  const sliceEnd = sliceStart + width

  // A loop, not `Math.min(...values)`/`Math.max(...values)`: argument spread
  // has an engine call-stack limit (measured: throws past ~125,000 points,
  // I4) and `sanitizeKeySpec` already guarantees every entry here is finite,
  // so no `NaN`-poisoning behaviour needs preserving.
  let min = values[0]!
  let max = values[0]!
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min

  ctx.fillStyle = css(color, dim)
  for (let i = 0; i < values.length; i++) {
    const virtualX = i * barW
    // Entirely outside this slice's span: nothing of this bar lands here.
    if (virtualX + barW <= sliceStart || virtualX >= sliceEnd) continue

    const v = values[i]!
    const frac = range === 0 ? 0.5 : (v - min) / range
    const h = frac * bandH
    if (h <= 0) continue

    let x = x0 + (virtualX - sliceStart)
    let w = Math.max(1, barW - 1)
    if (x < x0) {
      w -= x0 - x
      x = x0
    }
    if (w <= 0) continue
    if (x >= x1) continue
    // Clip a bar that runs past this key's own margin — but never below the
    // 1 px floor above. Above 81 values `barW < 1`, so a strict clip would
    // shrink the last bar to a sub-pixel sliver that renders as nothing,
    // where the pre-slice code always drew at least 1 px. A few values run
    // slightly into the padding instead: a visible bar beats an invisible
    // one, and the padding itself has nothing else drawn in it.
    if (x + w > x1) {
      const clipped = x1 - x
      if (clipped >= 1) w = clipped
    }

    const y = bandY + (bandH - h)
    ctx.fillRect(x, y, w, h)
  }

  // Drawn last, so it sits on top of any bar that (despite the reserved
  // band above) painted this far up — it never should, but text winning a
  // pixel fight beats a silently lost caption.
  if (label) {
    ctx.fillStyle = css(theme.text, dim)
    ctx.font = `11px ${FONT}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(label, x0, fullHeight ? SPARK_FULL_Y : SPARK_Y)
  }
}

// --- Task 39: cyberpunk idle animations (Spotify page, nothing playing) ---
//
// Three variants replace the old green equaliser. Each key draws its own
// 96x96 window of one shared `IDLE_SCENE`x`IDLE_SCENE` (192x192) design,
// picked out by `idle.col`/`idle.row` — `ctx.translate` shifts the whole
// scene so this key's own corner lands at (0, 0), and the canvas's own
// bounds crop away the rest, so no explicit clipping is needed. `grid` and
// `glitch` use this virtual-scene approach; `rain` instead gives each key
// its own independent columns, seeded by its position — both are valid
// choices per the task brief, and each variant says which it took above its
// own function.
//
// All three are driven only by `idle.nowMs` (never `Date.now()`) and by
// `idle.col`/`idle.row`, so two renders at the same `nowMs` are always
// byte-identical and the four keys always draw distinguishably from one
// another — the same determinism `PulseSpec.phase` guaranteed for the
// animation this replaces.

/** Vertical centre, at rest, of the synthwave sun in `drawIdleGrid`'s scene
 * coordinates — high enough that its lower slats sit near the horizon. */
const GRID_SUN_BASE_Y = 74
const GRID_SUN_RADIUS = 46
/** How far, and how often, the sun bobs up and down. Small and slow: this is
 * what keeps the two SKY keys (row 0) animating too, since nothing else in
 * that half of the scene moves. */
const GRID_SUN_BOB_AMPLITUDE = 4
const GRID_SUN_BOB_PERIOD_MS = 9000
/** Background-coloured slats cut across the sun's lower half, classic
 * synthwave style — gaps grow wider toward the bottom via the `1.6` power
 * curve below, rather than being evenly spaced. */
const GRID_SUN_SLAT_COUNT = 5
/** Boundary between the sky (row 0 keys) and the grid floor (row 1 keys) —
 * exactly the middle of the 192px scene, so it falls precisely on the seam
 * between the two key rows. */
const GRID_HORIZON_Y = KEY_SIZE
/** One full cycle of the floor scrolling toward the viewer, in milliseconds.
 * Slow, so the grid reads as gliding rather than racing. */
const GRID_SCROLL_PERIOD_MS = 6000
const GRID_HLINE_COUNT = 7
const GRID_VLINE_COUNT = 6

/**
 * Neon grid horizon. Virtual-192x192-scene variant: a synthwave sun made of
 * horizontal slats sits on a horizon line spanning the top two keys, and a
 * perspective floor of converging lines scrolls toward the viewer across the
 * bottom two.
 */
/**
 * The `grid` and `glitch` variants draw ONE scene sized to a 2x2 block
 * (`IDLE_SCENE`), so a third column has no scene to show. They clamp instead of
 * tearing: a page using three columns with either variant repeats the right-hand
 * column rather than drawing a broken scene. `rain` is independent per key and
 * needs no clamp. Making the bad outcome impossible beats documenting it
 * (lesson 21).
 */
function sceneColumn(col: 0 | 1 | 2): 0 | 1 {
  return col >= 1 ? 1 : 0
}

function drawIdleGrid(ctx: SKRSContext2D, idle: IdleSpec, dim: boolean): void {
  const originX = sceneColumn(idle.col) * KEY_SIZE
  const originY = idle.row * KEY_SIZE
  ctx.save()
  ctx.translate(-originX, -originY)

  const cx = IDLE_SCENE / 2
  const bob = GRID_SUN_BOB_AMPLITUDE * Math.sin((idle.nowMs / GRID_SUN_BOB_PERIOD_MS) * 2 * Math.PI)
  const sunY = GRID_SUN_BASE_Y + bob

  ctx.fillStyle = css(theme.neonMagenta, dim)
  ctx.beginPath()
  // Belt-and-braces (see `sanitizeKeySpec`, the boundary guard that already
  // makes `idle.nowMs` finite before this function ever runs): `ctx.arc` is
  // the one drawing primitive in this file that does not merely misrender on
  // a non-finite argument — `@napi-rs/canvas` panics in Rust and aborts the
  // whole process (C1), a failure no `try`/`catch` around the render loop
  // can see. Checked again here, at the call site, rather than trusted from
  // upstream — this is the one place in the file where that trust must be
  // verified, not assumed.
  if (Number.isFinite(cx) && Number.isFinite(sunY)) {
    ctx.arc(cx, sunY, GRID_SUN_RADIUS, 0, Math.PI * 2)
    ctx.fill()
  }

  // Slats are background-coloured, so they read as gaps regardless of `dim`
  // — the background itself is what shows through, never a separate colour
  // that would need its own dimming.
  ctx.fillStyle = css(theme.bg)
  for (let i = 0; i < GRID_SUN_SLAT_COUNT; i++) {
    const frac = Math.pow((i + 1) / (GRID_SUN_SLAT_COUNT + 1), 1.6)
    const bandY = sunY + frac * GRID_SUN_RADIUS
    const bandH = 2 + i * 1.4
    ctx.fillRect(cx - GRID_SUN_RADIUS - 2, bandY, GRID_SUN_RADIUS * 2 + 4, bandH)
  }

  ctx.fillStyle = css(theme.cyan, dim)
  ctx.fillRect(0, GRID_HORIZON_Y - 1, IDLE_SCENE, 2)

  // Perspective floor, below the horizon only. Lines bunch up near the
  // horizon and spread out toward the viewer; `scrollFrac` advances them
  // over time and loops, so the floor appears to travel toward the camera.
  const depth = IDLE_SCENE - GRID_HORIZON_Y
  const scrollFrac = (idle.nowMs % GRID_SCROLL_PERIOD_MS) / GRID_SCROLL_PERIOD_MS
  ctx.fillStyle = css(theme.cyan, dim)
  for (let i = 0; i < GRID_HLINE_COUNT; i++) {
    const t = (i + scrollFrac) / GRID_HLINE_COUNT
    if (t <= 0 || t >= 1) continue
    const y = GRID_HORIZON_Y + depth * t * t
    ctx.fillRect(0, Math.round(y), IDLE_SCENE, 1)
  }

  ctx.strokeStyle = css(theme.cyan, dim)
  ctx.lineWidth = 1
  for (let i = 0; i <= GRID_VLINE_COUNT; i++) {
    const bottomX = (i / GRID_VLINE_COUNT) * IDLE_SCENE
    ctx.beginPath()
    ctx.moveTo(cx, GRID_HORIZON_Y)
    ctx.lineTo(bottomX, IDLE_SCENE)
    ctx.stroke()
  }

  ctx.restore()
}

/** Columns per key. Spread across the same usable width `drawSpark` uses. */
const RAIN_COLS = 6
/** Characters kept trailing behind each column's lead glyph. */
const RAIN_TRAIL = 6
const RAIN_CHAR_H = 13
const RAIN_FONT_SIZE = 12
/**
 * Plain ASCII only — no emoji, no Unicode block that risks a `.notdef` tofu
 * box on a font that does not cover it (task 37's lesson in
 * `render/canvas.ts`'s own `GLYPH_SIZE` comment). Menlo, this file's one
 * text font, covers all of these.
 */
const RAIN_CHARSET = ['0', '1', '$', '%', '#', '@', '&', '+', '=', '-', '/', '\\', '<', '>', '*']
/** How long one column takes to fall its FULL travel (see `rainColumnSpan`:
 * the trail's length above the top, the key, and the trail's length below
 * the bottom), before its per-column random variation and its own
 * per-column offset. Slow and ambient, never a fast scroll.
 *
 * These were 3800/2600 when the travel was 174 px; the user's smoothness fix
 * grew the travel to 252 px, and both constants were scaled by the same
 * 252/174 so the on-glass velocity in px/ms is unchanged — only the loop got
 * longer. Do not "restore" the shorter numbers without also restoring the
 * shorter travel, or the rain visibly speeds up. */
const RAIN_SPEED_BASE_MS = 5500
const RAIN_SPEED_VARIANCE_MS = 3800

/**
 * Glyph rain. Per-key variant (each key owns its own independent columns,
 * seeded from its `col`/`row` position rather than from a shared scene) —
 * cyan and near-white rather than the Matrix's green, sparse enough to read
 * as atmosphere behind the deck rather than dense noise.
 */
/**
 * The glyph-centre positions of one rain column at one instant: `head` is
 * the lead glyph's y, `tail` is the last trail glyph's y (always above the
 * head). Exported so a test can prove the loop geometry rather than trust
 * this comment.
 *
 * The head starts one full trail-length ABOVE the top (so the column slides
 * in) and travels to one full trail-length BELOW the bottom before it loops
 * (so the column slides out, tail last). At the wrap instant every glyph is
 * therefore off-key, and the loop is invisible.
 *
 * The first shipped version's travel stopped at `KEY_SIZE`: the head
 * touched the bottom edge and wrapped while five of the six trail glyphs
 * were still mid-key, so the whole strand vanished in one frame. Its
 * comment CLAIMED the trail exited first — the code did half of what the
 * comment said. The user saw it on the glass within minutes: "as soon as
 * one strand touches the bottom ... the whole strand vanishes". This
 * function exists so the claim is now tested, not narrated.
 */
export function rainColumnSpan(
  keyIndex: number, col: number, nowMs: number,
): { head: number; tail: number } {
  const seed = keyIndex * 97 + col * 13
  const speed = RAIN_SPEED_BASE_MS + pseudoRandom(seed) * RAIN_SPEED_VARIANCE_MS
  const phase = pseudoRandom(seed + 1) * speed
  const t = ((nowMs + phase) % speed) / speed
  const travel = KEY_SIZE + 2 * RAIN_TRAIL * RAIN_CHAR_H
  const head = -RAIN_TRAIL * RAIN_CHAR_H + t * travel
  return { head, tail: head - (RAIN_TRAIL - 1) * RAIN_CHAR_H }
}

function drawIdleRain(ctx: SKRSContext2D, idle: IdleSpec, dim: boolean): void {
  // Spans THREE columns since task 44 grew the Spotify art block to 3x2, so the
  // stride is 3 rather than 2. Every key gets a distinct index, and therefore its
  // own column seeds — without the wider stride, key (0,2) and key (1,0) would
  // both index 2 and two tiles would rain identically.
  const keyIndex = idle.row * IDLE_MAX_COLS + idle.col
  const x0 = BORDER + PAD
  const x1 = KEY_SIZE - PAD
  const colSpacing = (x1 - x0) / RAIN_COLS

  ctx.font = `${RAIN_FONT_SIZE}px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (let c = 0; c < RAIN_COLS; c++) {
    const seed = keyIndex * 97 + c * 13
    const headY = rainColumnSpan(keyIndex, c, idle.nowMs).head
    const x = x0 + c * colSpacing + colSpacing / 2

    for (let i = 0; i < RAIN_TRAIL; i++) {
      const y = headY - i * RAIN_CHAR_H
      if (y < -RAIN_CHAR_H || y > KEY_SIZE + RAIN_CHAR_H) continue
      const glyphIndex = Math.floor(pseudoRandom(seed * 31 + i * 7) * RAIN_CHARSET.length)
      const glyph = RAIN_CHARSET[glyphIndex]!
      // The lead glyph reads brightest, near-white; the trail fades toward
      // the background in cyan, so the column reads as one deliberate
      // colour rather than two unrelated hues.
      const brightness = i === 0 ? 1 : Math.max(0.12, 1 - i / RAIN_TRAIL)
      const color = i === 0 ? theme.text : theme.cyan
      ctx.fillStyle = cssAlpha(color, brightness, dim)
      ctx.fillText(glyph, x, y)
    }
  }
}

const GLITCH_SCANLINE_SPACING = 6
const GLITCH_SCROLL_PERIOD_MS = 5000
/** One "signal slip" band's full cycle, and how long within that cycle it is
 * actually visible — occasional, not constant. */
const GLITCH_BAND_PERIOD_MS = 5200
const GLITCH_BAND_DURATION_MS = 220
const GLITCH_BAND_HEIGHT = 6
const GLITCH_TEXT = 'OFFLINE'
const GLITCH_TEXT_SIZE = 14
/** The neon text's slow breathing cycle — never a fast blink, which would
 * strobe. It also dips sharply, but briefly, exactly when this key's own
 * glitch band fires, so the flicker reads as connected to the glitch rather
 * than as two unrelated animations. */
const GLITCH_TEXT_BREATHE_MS = 3200
const GLITCH_TEXT_DROPOUT_MS = 90
/**
 * Guaranteed minimum gap, in px, between any two quadrants' scanline phase —
 * the I1 fix. The old scheme picked each key's phase from `pseudoRandom`
 * alone, a weak sine-based hash whose nearby integer seeds can return nearly
 * identical outputs by chance: keys 1 and 5 landed 0.12 px apart, and
 * `Math.round` collapsed that gap to zero at 46 of 60 sampled clocks — the
 * four quadrants were byte-identical most of the time, contradicting this
 * file's own stated invariant. A quarter of the scanline spacing, spread
 * DETERMINISTICALLY across the four `keyIndex` values (0, 1.5, 3, 4.5 px),
 * guarantees every pair is at least this far apart before any jitter is
 * added — no amount of hash bad luck can close that gap the way it did
 * before, because the guarantee no longer depends on the hash at all.
 */
const GLITCH_QUADRANT_PHASE_SPREAD = GLITCH_SCANLINE_SPACING / 4
/**
 * Small per-key jitter layered on top of the guaranteed spread above, so the
 * four quadrants still look organically offset rather than mechanically
 * even. Bounded well under the guaranteed spread (at most a fifth of it on
 * either side of a key's own base phase) so jitter alone can never pull two
 * adjacent keys' phases back down into the old bug's territory — the worst
 * case (adjacent keys, jitter pulling them toward each other) still leaves a
 * 1.1 px gap, measured, comfortably far from the 0.12 px that caused I1.
 */
const GLITCH_QUADRANT_PHASE_JITTER = 0.4

/**
 * Glitch scanline. Per-key variant: scanlines and the occasional slip band
 * are independent per key, each on its own phase (seeded from `col`/`row`)
 * so the four keys never glitch in lockstep — a synchronised flash across
 * the whole 2x2 block would read as a strobe. Only the top-left key (`col`
 * 0, `row` 0) carries the flickering "OFFLINE" text.
 */
function drawIdleGlitch(ctx: SKRSContext2D, idle: IdleSpec, dim: boolean): void {
  const keyIndex = idle.row * 2 + sceneColumn(idle.col)
  // Offset away from 0 (M7): `pseudoRandom(0)` is exactly 0, which locked key
  // 0's slip band below to nowMs epoch boundaries instead of a phase of its
  // own, the same weak-hash-at-small-seeds failure mode as I1. `+ 1000`
  // keeps every key's seed, including key 0's, away from that degenerate
  // point.
  const seed = keyIndex * 211 + 1000

  // Each key's scanlines start from their own offset, so two quadrants with
  // no glitch band active at a given instant still never render identically
  // — the four keys of the block should always be tellable apart, the same
  // invariant `imageCrop` and `pulse.phase` had to protect in earlier tasks.
  // See `GLITCH_QUADRANT_PHASE_SPREAD`'s comment for why this is a
  // guaranteed-by-construction spread rather than a hash-derived one.
  const scanPhase =
    keyIndex * GLITCH_QUADRANT_PHASE_SPREAD +
    (pseudoRandom(seed + 500) - 0.5) * GLITCH_QUADRANT_PHASE_JITTER
  const rawOffset = scanPhase + (idle.nowMs / GLITCH_SCROLL_PERIOD_MS) * GLITCH_SCANLINE_SPACING
  // Normalised into [0, GLITCH_SCANLINE_SPACING) explicitly — JS `%` keeps
  // the sign of its left operand, so a negative `rawOffset` (reachable from
  // a hostile negative `nowMs`, which `sanitizeKeySpec` allows through
  // unchanged since a negative finite clock is not itself unsafe) would
  // otherwise leave `scrollOffset` negative too.
  const scrollOffset =
    ((rawOffset % GLITCH_SCANLINE_SPACING) + GLITCH_SCANLINE_SPACING) % GLITCH_SCANLINE_SPACING
  // I2: scanline positions used to jump in whole-pixel steps only once every
  // ~860 ms, so three of the four quadrants held byte-identical pixels for
  // up to 8 consecutive 100 ms ticks even though `idle.nowMs` (correctly)
  // changed `keyHash` on every one of them — wasted key-writes for content
  // that had not visibly changed. The top-left key (`col` 0, `row` 0)
  // already "escapes" this: its OFFLINE text's breathing alpha changes every
  // tick regardless. So only the OTHER three keys need the fix — a
  // fractional, unrounded `y` lets `fillRect` anti-alias across the row
  // boundary, so their pixels now actually change on every tick, matching
  // what the hash already claims. Key 0 keeps the rounded, discrete-jump
  // rendering: it does not need the fix, and giving it continuous scanline
  // motion too would add sub-pixel noise inside the exact region the text's
  // OWN slow-breathe animation is measured over, for no benefit.
  const isTextKey = sceneColumn(idle.col) === 0 && idle.row === 0
  for (let y = -GLITCH_SCANLINE_SPACING; y < KEY_SIZE + GLITCH_SCANLINE_SPACING; y += GLITCH_SCANLINE_SPACING) {
    const yy = isTextKey ? Math.round(y + scrollOffset) : y + scrollOffset
    if (isTextKey ? yy < 0 || yy >= KEY_SIZE : yy < -1 || yy > KEY_SIZE) continue
    ctx.fillStyle = cssAlpha(theme.cyan, 0.18, dim)
    ctx.fillRect(0, yy, KEY_SIZE, 1)
  }

  const bandPhase = pseudoRandom(seed) * GLITCH_BAND_PERIOD_MS
  const cycleIndex = Math.floor((idle.nowMs + bandPhase) / GLITCH_BAND_PERIOD_MS)
  const bandT = (idle.nowMs + bandPhase) % GLITCH_BAND_PERIOD_MS
  const bandActive = bandT < GLITCH_BAND_DURATION_MS
  if (bandActive) {
    const bandY = Math.round(pseudoRandom(seed + cycleIndex) * (KEY_SIZE - GLITCH_BAND_HEIGHT))
    ctx.fillStyle = cssAlpha(theme.neonMagenta, 0.3, dim)
    ctx.fillRect(0, bandY, KEY_SIZE, GLITCH_BAND_HEIGHT)
    ctx.fillStyle = cssAlpha(theme.cyan, 0.45, dim)
    for (let i = 0; i < 4; i++) {
      const tickX = Math.round(pseudoRandom(seed + cycleIndex * 7 + i) * KEY_SIZE)
      const tickW = 5 + Math.round(pseudoRandom(seed + cycleIndex * 11 + i) * 10)
      ctx.fillRect(tickX, bandY, tickW, GLITCH_BAND_HEIGHT)
    }
  }

  if (sceneColumn(idle.col) === 0 && idle.row === 0) {
    const breathe = 0.55 + 0.45 * Math.sin((idle.nowMs / GLITCH_TEXT_BREATHE_MS) * 2 * Math.PI)
    const alpha = bandActive && bandT < GLITCH_TEXT_DROPOUT_MS ? 0.08 : breathe
    ctx.fillStyle = cssAlpha(theme.cyan, alpha, dim)
    ctx.font = `${GLITCH_TEXT_SIZE}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(GLITCH_TEXT, KEY_SIZE / 2, KEY_SIZE / 2)
  }
}

/** Dispatches to the one of the three functions above named by
 * `idle.variant` — the only place this file needs to know all three exist. */
function drawIdle(ctx: SKRSContext2D, idle: IdleSpec, dim: boolean): void {
  switch (idle.variant) {
    case 'grid':
      drawIdleGrid(ctx, idle, dim)
      break
    case 'rain':
      drawIdleRain(ctx, idle, dim)
      break
    case 'glitch':
      drawIdleGlitch(ctx, idle, dim)
      break
  }
}

/* ---------------------------------------------------------------------------
 * Ambient effects (task 42)
 *
 * One effect draws BEHIND a key's own content, chosen by whatever the key is
 * reporting — the weather page maps each forecast condition to one, so the
 * forecast reads across the room before the digits do.
 *
 * These are deliberately separate from the three `IdleSpec` animations above.
 * An idle animation OWNS its key: nothing is drawn over it, so it can use the
 * whole brightness range. An effect is a LAYER: text lands on top of it, so it
 * lives under a hard brightness cap. Merging the two would mean one of them
 * losing the property that makes it work.
 * ------------------------------------------------------------------------- */

/**
 * The hard ceiling on how bright any ambient effect can get.
 *
 * Enforced ONCE, at the composite in `drawFx`, and never trusted to each
 * variant: a variant draws at full strength onto its own scratch canvas, and
 * that whole canvas lands on the key at this alpha. So a variant CANNOT exceed
 * the budget, whatever it does to its own context — the harm is impossible by
 * construction rather than merely unreached (lesson 21 in docs/LESSONS.md).
 *
 * Measured on 2026-08-18: a scratch layer filled solid white at alpha 1
 * composited over the rain tint `(18,28,44)` to `(84,91,103)`. Text renders at
 * 235, so content always wins. See docs/VERIFIED-FACTS.md.
 */
export const FX_MAX_ALPHA = 0.28

/**
 * The floor for a data-driven intensity. A 0-percent chance of rain is a real
 * reading, not missing data, so its tile still shows a trace of the effect
 * rather than going inert and looking like a broken page.
 */
export const FX_INTENSITY_MIN = 0.25

/**
 * One reused scratch canvas for every effect, created on first use.
 *
 * Safe as module state because `renderKey` is synchronous, single-threaded and
 * never re-entrant, and because `clearRect` was measured to reset the surface
 * completely, alpha included (2026-08-18). A fresh canvas per key per frame
 * would allocate 80 canvases a second for no benefit.
 */
let fxScratch: Canvas | null = null

function fxScratchContext(): { canvas: Canvas; ctx: SKRSContext2D } {
  if (!fxScratch) fxScratch = createCanvas(KEY_SIZE, KEY_SIZE)
  const ctx = fxScratch.getContext('2d')
  ctx.clearRect(0, 0, KEY_SIZE, KEY_SIZE)
  // Reset every piece of context state a variant may have left behind, since
  // this surface is reused across keys and frames.
  ctx.globalAlpha = 1
  ctx.lineWidth = 1
  ctx.lineCap = 'butt'
  return { canvas: fxScratch, ctx }
}

/**
 * An effect's own per-particle opacity. Never the cap — that is applied once,
 * at the composite, so this value is free to run all the way to 1.
 */
function fxCss(c: Rgb, alpha: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${clamp01(alpha)})`
}

/**
 * Draws one ambient effect beneath a key's content. The variant paints at full
 * strength onto the scratch canvas; this function composites it at
 * `FX_MAX_ALPHA`, reduced again by `DIM_FACTOR` when the key is dim, so a
 * stale key's layer darkens by the same fraction as its text.
 *
 * `dim` has to act through `globalAlpha` here: a composited surface ignores
 * `fillStyle`, exactly like a bitmap colour emoji does (lesson 15).
 */
function drawFx(ctx: SKRSContext2D, fx: FxSpec, dim: boolean): void {
  const { canvas, ctx: layer } = fxScratchContext()
  const intensity = clamp01(fx.intensity)

  switch (fx.variant) {
    case 'rain':
      drawFxRain(layer, fx, intensity, false)
      break
    case 'storm':
      drawFxStorm(layer, fx, intensity)
      break
    case 'snow':
      drawFxSnow(layer, fx, intensity)
      break
    case 'fog':
      drawFxFog(layer, fx, intensity)
      break
    case 'wind':
      drawFxWind(layer, fx, intensity)
      break
    case 'sun':
      drawFxSun(layer, fx, intensity)
      break
    case 'cloud':
      drawFxCloud(layer, fx, intensity)
      break
    case 'drift':
      drawFxDrift(layer, fx, intensity)
      break
  }

  const prev = ctx.globalAlpha
  ctx.globalAlpha = prev * FX_MAX_ALPHA * (dim ? DIM_FACTOR : 1)
  ctx.drawImage(canvas, 0, 0)
  ctx.globalAlpha = prev
}

const FX_RAIN_MAX_DROPS = 16
const FX_RAIN_LEN = 12
const FX_RAIN_SLANT = 2
const FX_RAIN_WIDTH = 1.4
const FX_RAIN_PERIOD_BASE_MS = 820
const FX_RAIN_PERIOD_VAR_MS = 420
/**
 * How much `intensity` stretches a streak and how much it brightens one.
 *
 * The drop COUNT alone was not enough. On a real storm-and-rain week the tiles
 * ran from 40 to 90 percent, which is 10 streaks against 15 — a difference
 * nobody can see on a 96 px key at a glance. Length and opacity scale with
 * intensity too, so a 90 percent tile reads as heavier rain rather than as
 * slightly more of the same rain.
 */
const FX_RAIN_LEN_INTENSITY_GAIN = 0.6
const FX_RAIN_ALPHA_FLOOR = 0.35

/**
 * The storm variant drives the same streaks harder: faster, longer, and leaning
 * much further over. At 5 px of slant over a 12 px streak, storm rain was
 * indistinguishable from plain rain on the glass — only the background tint and
 * the emoji told them apart, which is not what a "storm" tile should rely on.
 */
const FX_STORM_PERIOD_SCALE = 0.55
const FX_STORM_SLANT = 11
const FX_STORM_LEN_SCALE = 1.5

/**
 * One rain streak's vertical extent at one instant. `head` is the leading
 * (lowest) end, `tail` the trailing end above it. Exported so a test proves
 * the loop geometry instead of trusting this comment.
 *
 * The head enters one full streak-length ABOVE the key and travels one full
 * length BELOW it before wrapping, so at the wrap instant the whole streak is
 * off-key and the loop is invisible. The matrix rain shipped once with travel
 * that stopped at `KEY_SIZE`, and whole strands vanished mid-key while their
 * comment claimed otherwise — see `rainColumnSpan`. Do not shorten the travel.
 */
export function fxRainDropSpan(
  seed: number, index: number, nowMs: number, periodScale = 1,
): { head: number; tail: number } {
  const s = seed * 131 + index * 17
  const period =
    (FX_RAIN_PERIOD_BASE_MS + pseudoRandom(s) * FX_RAIN_PERIOD_VAR_MS) * periodScale
  const phase = pseudoRandom(s + 1) * period
  const t = ((nowMs + phase) % period) / period
  const travel = KEY_SIZE + 2 * FX_RAIN_LEN
  const head = -FX_RAIN_LEN + t * travel
  return { head, tail: head - FX_RAIN_LEN }
}

function drawFxRain(
  ctx: SKRSContext2D, fx: FxSpec, intensity: number, storm: boolean, recede = 0,
): void {
  const count = Math.max(2, Math.round(intensity * FX_RAIN_MAX_DROPS))
  const slant = storm ? FX_STORM_SLANT : FX_RAIN_SLANT
  const scale = storm ? FX_STORM_PERIOD_SCALE : 1
  const lengthScale =
    (storm ? FX_STORM_LEN_SCALE : 1) * (1 - FX_RAIN_LEN_INTENSITY_GAIN + FX_RAIN_LEN_INTENSITY_GAIN * intensity * 2)
  ctx.lineWidth = storm ? FX_RAIN_WIDTH * 1.2 : FX_RAIN_WIDTH
  ctx.lineCap = 'round'
  for (let i = 0; i < count; i++) {
    const s = fx.seed * 131 + i * 17
    const x = pseudoRandom(s + 2) * KEY_SIZE
    const { head, tail } = fxRainDropSpan(fx.seed, i, fx.nowMs, scale)
    // The span carries the LOOP geometry, which the tests prove. Length scaling
    // shortens the drawn streak from the head backwards, so a lighter shower
    // still enters and leaves on exactly the same proven travel.
    const drawnTail = head - (head - tail) * lengthScale
    const alpha =
      (FX_RAIN_ALPHA_FLOOR +
        (1 - FX_RAIN_ALPHA_FLOOR) * intensity * (0.6 + 0.4 * pseudoRandom(s + 3))) *
      (1 - recede)
    ctx.strokeStyle = fxCss(storm ? theme.cyan : theme.blue, alpha)
    ctx.beginPath()
    ctx.moveTo(x, drawnTail)
    ctx.lineTo(x + slant, head)
    ctx.stroke()
  }
}

const FX_SNOW_MAX_FLAKES = 20
export const FX_SNOW_R = 1.7
const FX_SNOW_PERIOD_BASE_MS = 5200
const FX_SNOW_PERIOD_VAR_MS = 3200
const FX_SNOW_SWAY_PX = 7
const FX_SNOW_SWAY_PERIOD_MS = 3100

/**
 * One snowflake's vertical position, and the travel it loops over. Snow falls
 * far more slowly than rain and sways sideways, so it needs its own geometry
 * rather than a reskinned rain streak. Same slide-in and slide-out rule as
 * `fxRainDropSpan`: a flake is fully off-key at the wrap instant.
 */
export function fxSnowFlakeY(
  seed: number, index: number, nowMs: number,
): { y: number; travel: number } {
  const s = seed * 211 + index * 29
  const period = FX_SNOW_PERIOD_BASE_MS + pseudoRandom(s) * FX_SNOW_PERIOD_VAR_MS
  const phase = pseudoRandom(s + 1) * period
  const t = ((nowMs + phase) % period) / period
  const travel = KEY_SIZE + 4 * FX_SNOW_R
  return { y: -2 * FX_SNOW_R + t * travel, travel }
}

function drawFxSnow(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  const count = Math.max(3, Math.round(intensity * FX_SNOW_MAX_FLAKES))
  for (let i = 0; i < count; i++) {
    // The SAME seed expression `fxSnowFlakeY` uses, so the drawn flake and the
    // tested geometry cannot drift apart.
    const s = fx.seed * 211 + i * 29
    const baseX = pseudoRandom(s + 2) * KEY_SIZE
    const { y } = fxSnowFlakeY(fx.seed, i, fx.nowMs)
    const sway =
      FX_SNOW_SWAY_PX *
      Math.sin(
        (fx.nowMs / FX_SNOW_SWAY_PERIOD_MS) * 2 * Math.PI + pseudoRandom(s + 3) * 2 * Math.PI,
      )
    const r = FX_SNOW_R * (0.7 + 0.6 * pseudoRandom(s + 4))
    ctx.fillStyle = fxCss(theme.white, 0.5 + 0.5 * pseudoRandom(s + 5))
    ctx.beginPath()
    ctx.arc(baseX + sway, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * The strike period. Two properties matter, and the first version had neither.
 *
 * It must NOT be a whole number of render ticks. The first version used a flat
 * 4300 ms, which is exactly 43 ticks at the page's 100 ms rate, so every tile
 * sampled one single phase value forever: a tile either always caught its
 * flash or NEVER DID. Measured across seven tiles, seed 4 never lit once in 860
 * consecutive frames. A base that is not a tick multiple, plus a per-seed
 * variance, makes the phase sweep instead, so every strike is reachable.
 *
 * And the lit window must be at least two render frames wide, so catching a
 * strike is not a coin toss against the tick.
 */
const FX_STORM_PERIOD_BASE_MS = 3370
const FX_STORM_PERIOD_VAR_MS = 2630
const FX_STORM_STRIKE_MS = 240

const FX_BOLT_SEGMENTS = 5
const FX_BOLT_JITTER = 10
const FX_BOLT_WIDTH = 3.4
const FX_BOLT_GLOW_WIDTH = 9
const FX_BOLT_SKY_ALPHA = 0.24
/**
 * How far the rain recedes while the bolt is lit.
 *
 * The cap is a hard, deliberate ceiling on the whole layer, so a bolt cannot
 * simply be drawn brighter than everything else — nothing can exceed the cap.
 * The only honest way to make it stand out is RELATIVE contrast inside the
 * layer: real lightning outshines the rain in front of it, so the streaks dim
 * while it flashes and the bolt becomes the brightest thing on the tile.
 *
 * Rendered and checked: at the first attempt the bolt was 2.2 px of white at the
 * same alpha as the cyan storm streaks, and it read as one more streak rather
 * than as lightning.
 */
const FX_BOLT_RAIN_RECEDE = 0.55

/**
 * The storm's current lightning strike, or null between strikes.
 *
 * `index` counts strikes, so the bolt's shape can be derived from it and stay
 * still for the whole strike — a bolt re-jittered every frame reads as noise,
 * not as lightning. `progress` runs 0 to 1 through the lit window and drives
 * the brightness envelope.
 *
 * Exported so a test finds real strike instants from the predicate rather than
 * guessing timestamps, proves strikes stay rare, and proves that EVERY seed
 * actually catches them at the real 100 ms tick.
 */
export function fxStormStrikePeriodMs(seed: number): number {
  return FX_STORM_PERIOD_BASE_MS + pseudoRandom(seed * 313 + 7) * FX_STORM_PERIOD_VAR_MS
}

/** How long one strike stays lit. Exported so a test can compare it against the
 * page's real render interval rather than hard-coding a duplicate. */
export const FX_STORM_STRIKE_DURATION_MS = FX_STORM_STRIKE_MS

export function fxStormStrike(
  seed: number, nowMs: number,
): { index: number; progress: number } | null {
  const period = fxStormStrikePeriodMs(seed)
  const offset = pseudoRandom(seed * 313 + 11) * period
  const t = nowMs + offset
  const phase = t % period
  if (phase >= FX_STORM_STRIKE_MS) return null
  return { index: Math.floor(t / period), progress: phase / FX_STORM_STRIKE_MS }
}

/**
 * Brightness through one strike: a hard first flash, a dip, a second flash, then
 * a decay. Real lightning flickers, and a single square pulse read as the key
 * being switched on and off.
 */
function boltEnvelope(progress: number): number {
  if (progress < 0.22) return 1
  if (progress < 0.36) return 0.2
  if (progress < 0.56) return 0.8
  return Math.max(0, (1 - progress) / 0.44) * 0.45
}

/**
 * Draws one jagged bolt from the top edge downward, with a soft glow behind it,
 * plus a short branch. The path is derived from the strike `index`, so it holds
 * still for the strike's whole duration and a new strike gets a new shape.
 */
function drawBolt(ctx: SKRSContext2D, seed: number, index: number, alpha: number): void {
  const s = seed * 977 + index * 131
  const startX = 14 + pseudoRandom(s) * (KEY_SIZE - 28)
  const endY = KEY_SIZE * (0.55 + 0.4 * pseudoRandom(s + 1))

  const points: { x: number; y: number }[] = [{ x: startX, y: 0 }]
  for (let i = 1; i <= FX_BOLT_SEGMENTS; i++) {
    const t = i / FX_BOLT_SEGMENTS
    points.push({
      x: startX + (pseudoRandom(s + i * 7) - 0.5) * 2 * FX_BOLT_JITTER + (t - 0.5) * 10,
      y: endY * t,
    })
  }

  const trace = (): void => {
    ctx.beginPath()
    ctx.moveTo(points[0]!.x, points[0]!.y)
    for (const pt of points.slice(1)) ctx.lineTo(pt.x, pt.y)
    ctx.stroke()
  }

  // The glow first, then the core over it, so the bolt has a bright centre.
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = FX_BOLT_GLOW_WIDTH
  ctx.strokeStyle = fxCss(theme.cyan, alpha * 0.5)
  trace()
  ctx.lineWidth = FX_BOLT_WIDTH
  ctx.strokeStyle = fxCss(theme.white, alpha)
  trace()

  // One short branch, off a middle joint.
  const from = points[Math.max(1, Math.floor(FX_BOLT_SEGMENTS / 2))]!
  ctx.lineWidth = FX_BOLT_WIDTH * 0.6
  ctx.strokeStyle = fxCss(theme.white, alpha * 0.8)
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(
    from.x + (pseudoRandom(s + 71) - 0.5) * 30,
    from.y + 14 + pseudoRandom(s + 73) * 14,
  )
  ctx.stroke()
}

function drawFxStorm(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  const strike = fxStormStrike(fx.seed, fx.nowMs)
  const alpha = strike ? boltEnvelope(strike.progress) : 0

  drawFxRain(ctx, fx, intensity, true, FX_BOLT_RAIN_RECEDE * alpha)

  if (!strike || alpha <= 0) return

  // A modest sky glow, NOT the old full-strength white wash. That wash lit the
  // whole key evenly, which read as the tile being greyed out rather than as
  // lightning — and it collided with the page's own staleness signal, where a
  // flat, washed-out key means "this data is old".
  ctx.fillStyle = fxCss(theme.white, FX_BOLT_SKY_ALPHA * alpha)
  ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE)
  drawBolt(ctx, fx.seed, strike.index, alpha)
}

const FX_FOG_BANDS = 3
const FX_FOG_BAND_H = 26
const FX_FOG_WIDTH = 108
const FX_FOG_PEAK_ALPHA = 0.62
const FX_FOG_PERIOD_BASE_MS = 11000
const FX_FOG_PERIOD_VAR_MS = 6000

/**
 * Slow horizontal haze: a few wide, soft blobs drifting sideways, each drawn
 * twice so the wrap seam never shows.
 *
 * Softness runs in BOTH directions. A horizontal gradient fades each end, and
 * the band is built from single-pixel rows whose alpha follows a vertical bell,
 * so the top and bottom edges fade too.
 *
 * The first version drew four 70 px bands as plain `fillRect`s with only a
 * horizontal gradient. Their flat top and bottom edges made each band read as a
 * rectangle rather than as haze, which is why the vertical falloff exists.
 *
 * A note on how that was found, because the first diagnosis was WRONG: the
 * contact sheet showed a pale block behind the fog tile's numbers, and the
 * obvious conclusion was that these bands had piled up in the middle of the
 * key. Rendering the emoji and the layer separately disproved it — the block is
 * Apple's `🌫` glyph itself, a hazy grey square, and it predates this layer
 * entirely. The peak alpha had already been cut on that false premise before
 * the isolation render corrected it. Measure the parts, do not reason about the
 * composite (lesson 17).
 */
function drawFxFog(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  for (let b = 0; b < FX_FOG_BANDS; b++) {
    const s = fx.seed * 419 + b * 37
    const centreY = ((b + 0.5) / FX_FOG_BANDS) * KEY_SIZE + pseudoRandom(s) * 8 - 4
    const period = FX_FOG_PERIOD_BASE_MS + pseudoRandom(s + 1) * FX_FOG_PERIOD_VAR_MS
    const dir = pseudoRandom(s + 2) < 0.5 ? -1 : 1
    const t = ((fx.nowMs + pseudoRandom(s + 3) * period) % period) / period
    const span = KEY_SIZE + FX_FOG_WIDTH
    const x = dir > 0 ? -FX_FOG_WIDTH + t * span : KEY_SIZE - t * span
    const peak = intensity * FX_FOG_PEAK_ALPHA * (0.7 + 0.3 * pseudoRandom(s + 4))
    const half = FX_FOG_BAND_H / 2

    for (const ox of [x, x + (dir > 0 ? -span : span)]) {
      for (let dy = -half; dy <= half; dy++) {
        // A raised cosine: 1 at the band's centre line, 0 at both edges.
        const falloff = 0.5 * (1 + Math.cos((dy / half) * Math.PI))
        if (falloff <= 0) continue
        const grad = ctx.createLinearGradient(ox, 0, ox + FX_FOG_WIDTH, 0)
        grad.addColorStop(0, fxCss(theme.gray, 0))
        grad.addColorStop(0.5, fxCss(theme.gray, peak * falloff))
        grad.addColorStop(1, fxCss(theme.gray, 0))
        ctx.fillStyle = grad
        ctx.fillRect(ox, centreY + dy, FX_FOG_WIDTH, 1)
      }
    }
  }
}

const FX_WIND_MAX_STREAKS = 10
const FX_WIND_LEN = 28
const FX_WIND_WIDTH = 1.2
const FX_WIND_PERIOD_BASE_MS = 1300
const FX_WIND_PERIOD_VAR_MS = 800

/**
 * One wind streak's horizontal extent. `lead` is the right-hand end, `trail`
 * the left. Same fully-in, fully-out rule as the falling variants, rotated
 * ninety degrees.
 */
export function fxWindStreakSpan(
  seed: number, index: number, nowMs: number,
): { lead: number; trail: number } {
  const s = seed * 523 + index * 41
  const period = FX_WIND_PERIOD_BASE_MS + pseudoRandom(s) * FX_WIND_PERIOD_VAR_MS
  const phase = pseudoRandom(s + 1) * period
  const t = ((nowMs + phase) % period) / period
  const travel = KEY_SIZE + 2 * FX_WIND_LEN
  const lead = -FX_WIND_LEN + t * travel
  return { lead, trail: lead - FX_WIND_LEN }
}

function drawFxWind(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  const count = Math.max(2, Math.round(intensity * FX_WIND_MAX_STREAKS))
  ctx.lineWidth = FX_WIND_WIDTH
  ctx.lineCap = 'round'
  for (let i = 0; i < count; i++) {
    const s = fx.seed * 523 + i * 41
    const y = pseudoRandom(s + 2) * KEY_SIZE
    const { lead, trail } = fxWindStreakSpan(fx.seed, i, fx.nowMs)
    // Fades in from the trailing end, so each streak reads as moving right
    // even in a still frame.
    const grad = ctx.createLinearGradient(trail, y, lead, y)
    grad.addColorStop(0, fxCss(theme.cyan, 0))
    grad.addColorStop(1, fxCss(theme.cyan, 0.5 + 0.5 * pseudoRandom(s + 3)))
    ctx.strokeStyle = grad
    ctx.beginPath()
    ctx.moveTo(trail, y)
    ctx.lineTo(lead, y)
    ctx.stroke()
  }
}

const FX_SUN_RAYS = 12
const FX_SUN_ROTATE_PERIOD_MS = 26000
const FX_SUN_GLOW_R = 52
const FX_SUN_RAY_HALF_ANGLE = 0.05
const FX_SUN_PULSE_PERIOD_MS = 5400
const FX_SUN_PULSE_AMPLITUDE = 0.12

/**
 * A warm central glow with slowly turning rays. Both breathe on one slow
 * pulse, so a clear-sky tile still moves without anything crossing it — a
 * falling or drifting particle would contradict what the tile reports.
 */
function drawFxSun(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  const cx = KEY_SIZE / 2
  const cy = KEY_SIZE / 2
  // Per-key phase offsets. Without these the sun was the ONE variant that
  // ignored `seed`, so a whole week of clear days pulsed and turned in perfect
  // lockstep — read as one throbbing block rather than seven tiles. Every
  // other variant gets its decorrelation for free, because it seeds per
  // particle; this one has no particles, so it needs the offset explicitly.
  // Caught by the seed test, not by eye.
  const phase = pseudoRandom(fx.seed * 733 + 3) * 2 * Math.PI
  const spinPhase = pseudoRandom(fx.seed * 733 + 11) * 2 * Math.PI
  const pulse =
    1 +
    FX_SUN_PULSE_AMPLITUDE *
      Math.sin((fx.nowMs / FX_SUN_PULSE_PERIOD_MS) * 2 * Math.PI + phase)
  const r = FX_SUN_GLOW_R * pulse

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
  grad.addColorStop(0, fxCss(theme.amber, intensity * 0.72))
  grad.addColorStop(1, fxCss(theme.amber, 0))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE)

  const spin = (fx.nowMs / FX_SUN_ROTATE_PERIOD_MS) * 2 * Math.PI + spinPhase
  ctx.fillStyle = fxCss(theme.amber, intensity * 0.32)
  for (let i = 0; i < FX_SUN_RAYS; i++) {
    const a = spin + (i / FX_SUN_RAYS) * 2 * Math.PI
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, r * 1.15, a - FX_SUN_RAY_HALF_ANGLE, a + FX_SUN_RAY_HALF_ANGLE)
    ctx.closePath()
    ctx.fill()
  }
}

const FX_CLOUD_BLOBS = 3
const FX_CLOUD_RADII = [23, 16, 28] as const
const FX_CLOUD_PERIOD_BASE_MS = 14000
const FX_CLOUD_PERIOD_VAR_MS = 9000

/**
 * Slow drifting blobs, wrapping horizontally, each drawn twice so the wrap
 * seam never shows. `⛅` uses this same variant at a lower intensity rather
 * than a variant of its own — partly cloudy IS cloudy, with less of it.
 */
function drawFxCloud(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  for (let b = 0; b < FX_CLOUD_BLOBS; b++) {
    const s = fx.seed * 617 + b * 53
    const r = (FX_CLOUD_RADII[b] ?? FX_CLOUD_RADII[0]) * (0.8 + 0.4 * pseudoRandom(s))
    const y = pseudoRandom(s + 1) * KEY_SIZE
    const period = FX_CLOUD_PERIOD_BASE_MS + pseudoRandom(s + 2) * FX_CLOUD_PERIOD_VAR_MS
    const t = ((fx.nowMs + pseudoRandom(s + 3) * period) % period) / period
    const span = KEY_SIZE + 2 * r
    const x = -r + t * span
    // Measured against the contact sheet: at the original 0.5-to-0.9 range over
    // the neutral overcast tint, the blobs were very nearly invisible — a
    // grey layer over a grey wash. These are brighter so overcast reads as
    // moving cloud rather than as a still key.
    ctx.fillStyle = fxCss(theme.white, intensity * (0.28 + 0.22 * pseudoRandom(s + 4)))
    for (const ox of [x, x - span]) {
      ctx.beginPath()
      ctx.arc(ox, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

/**
 * Particle geometry, sized from a measurement rather than a guess.
 *
 * The first attempt used 18 particles, 9 px long and 1.6 px wide, with the taper
 * fading across the WHOLE length. Rendered against a real tile that touched only
 * **2.7 percent** of the key at a peak luminance delta of 67 out of 765 — which
 * is to say invisible, especially with the sparkline and three text lines already
 * occupying the tile. Nothing about it was wrong; it was simply too small to see.
 *
 * These are longer, wider, and hold full brightness over the leading half rather
 * than fading the whole way, which raises the average alpha as well as the area.
 */
const FX_DRIFT_MAX_PARTICLES = 20
const FX_DRIFT_LEN = 22
const FX_DRIFT_WIDTH = 2.4
/** Where the taper starts, as a fraction from the trailing end. Everything from
 * here to the lead is at full brightness, so the streak reads as a solid spark
 * with a fading tail rather than as a uniform smear. */
const FX_DRIFT_TAPER_START = 0.45
const FX_DRIFT_SWAY_PX = 4
const FX_DRIFT_SWAY_PERIOD_MS = 2600
/** Slowest and fastest a particle travels one full loop, in milliseconds. A
 * bigger move drifts faster, so magnitude reads as urgency. */
const FX_DRIFT_PERIOD_SLOW_MS = 4200
const FX_DRIFT_PERIOD_FAST_MS = 1500

/**
 * One drift particle's vertical extent at one instant. `lead` is the end the
 * particle is travelling toward, `trail` the end behind it — so for `'up'` the
 * lead is the SMALLER y, and for `'down'` the larger.
 *
 * Exported so a test proves the loop geometry rather than trusting this comment,
 * the same way `fxRainDropSpan` and `fxWindStreakSpan` are. The particle enters
 * one full length beyond one edge and leaves one full length beyond the other,
 * so nothing is ever visible at the wrap instant.
 */
export function fxDriftParticleSpan(
  seed: number, index: number, nowMs: number, intensity: number, direction: 'up' | 'down',
): { lead: number; trail: number; x: number } {
  const s = seed * 811 + index * 43
  const span = FX_DRIFT_PERIOD_SLOW_MS - FX_DRIFT_PERIOD_FAST_MS
  const period =
    FX_DRIFT_PERIOD_SLOW_MS - span * clamp01(intensity) + pseudoRandom(s) * 900
  const phase = pseudoRandom(s + 1) * period
  const t = ((nowMs + phase) % period) / period
  const travel = KEY_SIZE + 2 * FX_DRIFT_LEN
  // `x` is returned as well as the vertical span, so a test can probe the exact
  // column a particle occupies and compare its leading end against its trailing
  // one. Without it, a taper test can only measure whole-key asymmetry — which
  // the up and down GEOMETRY produces on its own, so such a test passes even
  // with the taper removed entirely. Found by breaking the fix.
  const sway =
    FX_DRIFT_SWAY_PX *
    Math.sin((nowMs / FX_DRIFT_SWAY_PERIOD_MS) * 2 * Math.PI + pseudoRandom(s + 3) * 2 * Math.PI)
  const x = pseudoRandom(s + 2) * KEY_SIZE + sway
  if (direction === 'up') {
    // Rising: the lead end starts one length BELOW the key and climbs past the
    // top.
    const lead = KEY_SIZE + FX_DRIFT_LEN - t * travel
    return { lead, trail: lead + FX_DRIFT_LEN, x }
  }
  const lead = -FX_DRIFT_LEN + t * travel
  return { lead, trail: lead - FX_DRIFT_LEN, x }
}

/**
 * Sparks drifting in the direction a stock moved: rising green on a gainer,
 * sinking red on a loser (task 43).
 *
 * Each particle is a TAPERED streak, bright at the leading end and fading
 * behind. A symmetrical dot cannot say which way it is going, so a still frame
 * would lose the one thing this variant exists to show.
 */
function drawFxDrift(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  const direction = fx.direction === 'down' ? 'down' : 'up'
  const color = direction === 'up' ? theme.green : theme.red
  const count = Math.max(3, Math.round(intensity * FX_DRIFT_MAX_PARTICLES))
  ctx.lineWidth = FX_DRIFT_WIDTH
  ctx.lineCap = 'round'

  for (let i = 0; i < count; i++) {
    const s = fx.seed * 811 + i * 43
    // Position AND span from one function, so what a test probes is exactly what
    // this loop draws.
    const { lead, trail, x } = fxDriftParticleSpan(fx.seed, i, fx.nowMs, intensity, direction)
    // Bright at the lead, transparent at the trail: the taper IS the direction.
    const peak = 0.8 + 0.2 * pseudoRandom(s + 4)
    const grad = ctx.createLinearGradient(x, trail, x, lead)
    grad.addColorStop(0, fxCss(color, 0))
    grad.addColorStop(FX_DRIFT_TAPER_START, fxCss(color, peak))
    grad.addColorStop(1, fxCss(color, peak))
    ctx.strokeStyle = grad
    ctx.beginPath()
    ctx.moveTo(x, trail)
    ctx.lineTo(x, lead)
    ctx.stroke()
  }
}

/**
 * Draws `img` onto the whole key. With no `crop`, this scales the entire
 * image edge to edge, exactly as before `imageCrop` existed. With a `crop`,
 * it draws only that source rectangle — fractions of `img`'s own size, so
 * the caller never needs to know the natural pixel dimensions.
 *
 * Fractions clamp into 0 to 1 first. A crop whose clamped width or height is
 * zero or negative draws nothing, so a bad crop cannot throw inside the
 * render loop.
 */
function drawCroppedImage(ctx: SKRSContext2D, img: Image, crop?: ImageCrop): void {
  if (!crop) {
    ctx.drawImage(img, 0, 0, KEY_SIZE, KEY_SIZE)
    return
  }
  const sx = clamp01(crop.sx)
  const sy = clamp01(crop.sy)
  const sw = clamp01(crop.sw)
  const sh = clamp01(crop.sh)
  if (sw <= 0 || sh <= 0) return
  ctx.drawImage(
    img,
    sx * img.width,
    sy * img.height,
    sw * img.width,
    sh * img.height,
    0,
    0,
    KEY_SIZE,
    KEY_SIZE,
  )
}

/** Shrinks `text` one character at a time, replacing the tail with an
 * ellipsis, until it measures at or under `maxWidth` at the context's
 * CURRENT font. Used only as the last resort, when even the smallest
 * `lineSizes` candidate does not fit — truncating is a smaller defect than
 * drawing past the key's edge.
 *
 * The last-resort return used to be an unconditional `'…'` (M4 from the r3
 * review), which can itself measure wider than `maxWidth` when `maxWidth` is
 * very small — reachable on the strip only when `right` measures wider than
 * about 228 px, well past any real value (the widest, `120:00 / 120:00`,
 * measures 117.4 px), but the function itself should not depend on every
 * caller staying inside that margin. `maxWidth <= 0` (the strip's own
 * `Math.max(0, …)` clamp can produce exactly this) returns empty outright,
 * and the loop's own fallback now measures the ellipsis before returning it,
 * so nothing this function returns can ever measure past `maxWidth`. */
function shrinkToFit(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  for (let n = text.length - 1; n > 0; n--) {
    const candidate = text.slice(0, n) + '…'
    if (ctx.measureText(candidate).width <= maxWidth) return candidate
  }
  return ctx.measureText('…').width <= maxWidth ? '…' : ''
}

function sameSizeCandidates(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Resolves each line's `lineSizes` entry to a concrete size and the exact
 * text to draw. A plain `number` is used as given, unmeasured — the legacy
 * path, and the path for any page that already knows its text fits. An
 * `array` is a set of candidates: this measures with the SAME context and
 * font `renderKey` draws with, and picks the largest one that fits
 * `maxWidth`. Consecutive lines that pass the identical candidate array (by
 * value) are resolved as ONE group, sized to whichever member of the group
 * needs the smallest size to fit — so a range's high and low, which always
 * pass the same candidate list, end up the same size instead of the low
 * rendering bigger than the high above it.
 *
 * `lineSizes` entirely absent returns every line at the fixed legacy size,
 * 11, with no measuring at all — byte-identical to before this function
 * existed, for the pages that have never set it.
 */
function resolveLineSpecs(
  ctx: SKRSContext2D,
  lines: string[],
  lineSizes: (number | number[])[] | undefined,
  maxWidth: number,
): { size: number; text: string }[] {
  if (!lineSizes) return lines.map((text) => ({ size: 11, text }))

  const out: { size: number; text: string }[] = []
  let i = 0
  while (i < lines.length) {
    const spec = lineSizes[i]
    if (Array.isArray(spec)) {
      let j = i + 1
      while (j < lines.length) {
        const next = lineSizes[j]
        if (!Array.isArray(next) || !sameSizeCandidates(next, spec)) break
        j++
      }
      const groupTexts = lines.slice(i, j)
      const sorted = [...spec].sort((a, b) => b - a)
      let chosen: number | null = null
      for (const size of sorted) {
        ctx.font = `${size}px ${FONT}`
        if (groupTexts.every((t) => ctx.measureText(t).width <= maxWidth)) {
          chosen = size
          break
        }
      }
      const size = chosen ?? sorted[sorted.length - 1] ?? 11
      ctx.font = `${size}px ${FONT}`
      for (let k = i; k < j; k++) {
        out.push({ size, text: shrinkToFit(ctx, lines[k]!, maxWidth) })
      }
      i = j
    } else {
      out.push({ size: typeof spec === 'number' ? spec : 11, text: lines[i]! })
      i++
    }
  }
  return out
}

/**
 * Draws `glyph` centred on its own INK at `(cx, cy)`, not on the arithmetic
 * middle of its advance box. Per the Canvas 2D spec (confirmed here against
 * @napi-rs/canvas), `ctx.measureText` reports
 * `actualBoundingBox{Left,Right,Ascent,Descent}` — the real ink extent,
 * measured from wherever the text is ABOUT to be drawn — so correcting for
 * it is a plain average, not a pixel scan: the ink's centre sits
 * `(right - left) / 2` to the right of the draw point horizontally, and
 * `(descent - ascent) / 2` below it vertically (this file's own textBaseline
 * is always `'middle'`). Solving for the draw point that lands the ink
 * centre exactly on `(cx, cy)` is just the same offset applied in reverse.
 *
 * Falls back to drawing at `(cx, cy)` unchanged if a metric ever comes back
 * non-finite (an environment or a future glyph this measurement cannot
 * read), so a bad measurement degrades to the old arithmetic centring
 * instead of throwing inside the render loop.
 *
 * `fontFamily` defaults to this file's plain-text `FONT` (Menlo). Task 38
 * passes `EMOJI_FONT` instead for `glyphFont: 'emoji'` — verified (not
 * assumed) against the actual colour-emoji font: it measured every emoji
 * this page uses within 0.5px of its requested target, the same as it does
 * for text glyphs, with no separate correction needed for the different
 * font's metrics.
 */
function drawCenteredGlyph(
  ctx: SKRSContext2D,
  glyph: string,
  size: number,
  cx: number,
  cy: number,
  fontFamily: string = FONT,
): void {
  ctx.font = `${size}px "${fontFamily}"`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const m = ctx.measureText(glyph)
  const dx = (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2
  const dy = (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2
  const drawX = Number.isFinite(dx) ? cx - dx : cx
  const drawY = Number.isFinite(dy) ? cy - dy : cy
  ctx.fillText(glyph, drawX, drawY)
}

/**
 * Draws a thin unfilled frame around the whole key perimeter, inset by
 * `FLASH_RING_INSET` from the true edge and `FLASH_RING_THICKNESS` px thick
 * on every side. Built from four `fillRect` strips rather than
 * `ctx.strokeRect`, so the exact pixel band is the same simple math the rest
 * of this file already uses (`drawBar`, `drawSpark`) — no reasoning about
 * how a stroke's width straddles its path. The top and bottom strips span
 * the full inset-to-inset width; the left and right strips fill only the
 * remaining height between them, so the frame is one unbroken outline with
 * no doubled paint at the corners.
 *
 * Called LAST in `renderKey`, after every other element, and never touches
 * any pixel outside its own band — the interior (and whatever the key
 * itself drew there) is untouched.
 */
function drawFlashRing(ctx: SKRSContext2D, color: Rgb): void {
  const inset = FLASH_RING_INSET
  const t = FLASH_RING_THICKNESS
  const span = KEY_SIZE - inset * 2
  ctx.fillStyle = css(color)
  ctx.fillRect(inset, inset, span, t)
  ctx.fillRect(inset, KEY_SIZE - inset - t, span, t)
  ctx.fillRect(inset, inset + t, t, span - t * 2)
  ctx.fillRect(KEY_SIZE - inset - t, inset + t, t, span - t * 2)
}

/**
 * Copies the canvas out as raw RGBA. The device takes raw pixel buffers and
 * has no PNG support, so the renderer never encodes an image format.
 */
function toRgba(ctx: SKRSContext2D, w: number, h: number): Buffer {
  return Buffer.from(ctx.getImageData(0, 0, w, h).data.buffer)
}

/** Renders one 96 by 96 key. The result is a raw RGBA buffer. */
export function renderKey(rawSpec: KeySpec): Buffer {
  const spec = sanitizeKeySpec(rawSpec)
  const canvas = createCanvas(KEY_SIZE, KEY_SIZE)
  const ctx = canvas.getContext('2d')
  const dim = spec.dim === true

  ctx.fillStyle = css(spec.bg ?? theme.bg)
  ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE)

  // Beneath everything else: the background wash, then this ambient layer,
  // then the key's own content on top. Opt-in — absent `fx`, this whole path
  // is skipped and the render is byte-identical to before the field existed.
  if (spec.fx) drawFx(ctx, spec.fx, dim)

  if (spec.image) {
    // The producer already decoded this. With no crop, it scales to the key,
    // edge to edge, exactly as before `imageCrop` existed.
    //
    // A decoded bitmap ignores `fillStyle`, exactly like a colour emoji does
    // (lesson 15), so `dim` has to act through `globalAlpha` here. Without
    // this the image path was the ONE drawing path that silently ignored
    // `dim`: Spotify's album art stayed at full brightness while the same
    // key's text and border dimmed, for as long as that page has shipped.
    // Found by the football page's reviewer, in code it did not own.
    // `DIM_FACTOR` is the same fraction `css` applies to a colour, so a
    // dimmed image and the dimmed text beside it darken by equal amounts.
    const prevAlpha = ctx.globalAlpha
    if (dim) ctx.globalAlpha = prevAlpha * DIM_FACTOR
    drawCroppedImage(ctx, spec.image, spec.imageCrop)
    ctx.globalAlpha = prevAlpha
  }

  if (spec.border) {
    const on = spec.pulseOn !== false
    ctx.fillStyle = on ? css(spec.border, dim) : css(spec.border, true)
    ctx.fillRect(0, 0, BORDER, KEY_SIZE)
  }

  if (spec.glyph) {
    // `glyphPulse` re-derives the effective size EVERY frame and hands it
    // straight to `drawCenteredGlyph`, which re-measures ink bounds at
    // THAT size — so the "thump" never needs its own separate centring
    // correction; it reuses the exact same measurement this file already
    // does for the glyph's resting size. Absent, `scale` is 1 and this is
    // byte-identical to before `glyphPulse` existed.
    const scale = spec.glyphPulse ? 1 + GLYPH_PULSE_AMPLITUDE * Math.sin(spec.glyphPulse.phase) : 1
    if (spec.glyphFont === 'emoji') {
      // Colour emoji are bitmap glyphs and ignore `fillStyle` (lesson 15 in
      // docs/LESSONS.md) — `glyphColor` is meaningless here, so it is never
      // read in this branch. Dimming uses `globalAlpha` instead, restored
      // in `finally` so a throw here cannot leave a later draw call on this
      // context dimmed, matching the standalone `spec.emoji` path below.
      const prevAlpha = ctx.globalAlpha
      try {
        if (dim) ctx.globalAlpha = DIM_FACTOR
        drawCenteredGlyph(ctx, spec.glyph, EMOJI_GLYPH_SIZE * scale, KEY_SIZE / 2, EMOJI_GLYPH_Y, EMOJI_FONT)
      } finally {
        ctx.globalAlpha = prevAlpha
      }
    } else {
      ctx.fillStyle = css(spec.glyphColor ?? theme.text, dim)
      drawCenteredGlyph(ctx, spec.glyph, GLYPH_SIZE * scale, KEY_SIZE / 2, GLYPH_Y)
    }
  }

  if (spec.glyph && spec.glyphCaption) {
    // Guarded on `spec.glyph` too, matching this field's own documented
    // contract in `specs.ts` ("Ignored unless `glyph` is also set"). Drawing
    // it unconditionally (M3 from the r3 review) let a caption with no glyph
    // paint 103 ink pixels on a key no page today builds that way — harmless
    // only because no page does it, not because the guard agreed with its
    // own doc comment.
    //
    // Plain short text (a percentage, at most 4 characters) — arithmetic
    // centring is fine here, unlike the single symbol above; there is no
    // per-glyph bearing asymmetry worth correcting for a run of digits.
    ctx.fillStyle = css(theme.text, dim)
    ctx.font = `${GLYPH_CAPTION_SIZE}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(spec.glyphCaption, KEY_SIZE / 2, GLYPH_CAPTION_Y)
  }

  if (spec.emoji) {
    // Colour emoji are bitmap glyphs and ignore `fillStyle`, so dimming
    // needs `globalAlpha` instead. Restored in `finally`, so a throw here
    // (or anywhere else in this function later) cannot leave every
    // subsequent draw call on this context dimmed. A missing emoji font
    // simply draws nothing, which is acceptable degradation — there is no
    // fallback glyph.
    const prevAlpha = ctx.globalAlpha
    try {
      if (dim) ctx.globalAlpha = DIM_FACTOR
      ctx.font = `${EMOJI_SIZE}px "${EMOJI_FONT}"`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(spec.emoji, KEY_SIZE / 2, EMOJI_Y)
    } finally {
      ctx.globalAlpha = prevAlpha
    }
  }

  if (spec.lines?.length) {
    const centered = spec.align === 'center'
    ctx.textAlign = centered ? 'center' : 'left'
    ctx.textBaseline = 'top'
    const x = centered ? KEY_SIZE / 2 : BORDER + PAD
    // Resolved once, up front: a candidate-array entry may need to look at
    // OTHER lines in its group (see `resolveLineSpecs`), which the
    // line-by-line draw loop below cannot do after it has already moved on.
    const resolved = resolveLineSpecs(ctx, spec.lines, spec.lineSizes, TEXT_MAX_WIDTH)
    let y = PAD
    for (let i = 0; i < resolved.length; i++) {
      const { size, text } = resolved[i]!
      // `lineSizes` is opt-in per key. Its absence takes the exact legacy
      // path: 11 px text on a fixed 14 px advance, so every page that has
      // never set it (Spotify, stocks, weather) renders pixel-for-pixel as
      // it did before this field existed. A present array switches to
      // size-driven spacing, because a 28 px line needs more room below it
      // than an 11 px one — a fixed advance would let two lines overlap.
      const advance = spec.lineSizes ? size + 4 : 14
      ctx.font = `${size}px ${FONT}`
      const color = spec.lineColors?.[i] ?? theme.text
      ctx.fillStyle = css(color, dim)
      // `lineY` is opt-in per line, same pattern as `lineSizes`. Its absence
      // (the case for every page except the new weather layout) keeps the
      // running automatic position, so nothing else changes.
      const drawY = spec.lineY?.[i] ?? y
      ctx.fillText(text, x, drawY)
      y = drawY + advance
    }
  }

  if (spec.spark) {
    drawSpark(ctx, spec.spark, dim)
  }

  if (spec.idle) {
    drawIdle(ctx, spec.idle, dim)
  }

  if (spec.bar) {
    drawBar(ctx, spec.bar, BORDER + PAD, BAR_Y, KEY_SIZE - BORDER - PAD * 2, BAR_H, dim)
  }

  // Drawn LAST and unconditionally at full strength (never `dim`): the flash
  // is a fresh, real-time signal about a press that just happened, not part
  // of a page's own content that stale data should dim. Every other element
  // above stays exactly as it would render with no ring at all — only the
  // ring's own thin band changes.
  if (spec.flashRing) {
    drawFlashRing(ctx, spec.flashRing)
  }

  return toRgba(ctx, KEY_SIZE, KEY_SIZE)
}

/** Renders the 248 by 58 info strip as one image. The result is a raw RGBA buffer. */
/* ---------- Album colour extraction (task 44) ---------- */

/** The square the cover is downscaled to before its pixels are counted. Small
 * enough to be cheap, large enough that a small accent colour still registers. */
const DOMINANT_SAMPLE = 28
/** How coarsely colours are bucketed. 5 bits per channel groups near-identical
 * shades together, so one flat region does not split across many buckets. */
const DOMINANT_BUCKET_SHIFT = 3
/** Pixels outside this brightness band are ignored: a cover is usually mostly
 * black or white, and neither makes a usable accent. */
const DOMINANT_MIN_LUM = 40
const DOMINANT_MAX_LUM = 700
/** How far a pixel's channels must spread before it counts as coloured rather
 * than grey. A greyscale sleeve legitimately has no accent colour. */
const DOMINANT_MIN_CHROMA = 24

/**
 * The dominant accent colour of an album cover, or `null` when it has none.
 *
 * An AVERAGE would be wrong: averaging a cover's pixels converges on mud, and
 * on most covers the mud is a dark grey-brown. This instead downscales the
 * cover, buckets the pixels coarsely, and takes the most populated bucket that
 * is neither near-black, near-white, nor nearly grey.
 *
 * `null` is a real answer, not a failure — a greyscale or almost-black sleeve
 * genuinely has no accent, and the caller falls back to the theme rather than
 * inventing a hue.
 *
 * MUST run off the render path. It decodes nothing, but it does allocate a
 * canvas and read pixels, so `SpotifySource` calls it once per track right after
 * `loadImage` resolves and caches the result beside the decoded image.
 */
export function dominantColor(img: Image): Rgb | null {
  const w = Math.max(1, Math.min(DOMINANT_SAMPLE, img.width || DOMINANT_SAMPLE))
  const h = Math.max(1, Math.min(DOMINANT_SAMPLE, img.height || DOMINANT_SAMPLE))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  try {
    ctx.drawImage(img, 0, 0, w, h)
  } catch {
    // A hostile or zero-sized image must not take the source down with it.
    return null
  }
  const data = ctx.getImageData(0, 0, w, h).data

  const counts = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!
    if (a < 128) continue
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    const lum = r + g + b
    if (lum < DOMINANT_MIN_LUM || lum > DOMINANT_MAX_LUM) continue
    if (Math.max(r, g, b) - Math.min(r, g, b) < DOMINANT_MIN_CHROMA) continue
    const key =
      ((r >> DOMINANT_BUCKET_SHIFT) << 10) |
      ((g >> DOMINANT_BUCKET_SHIFT) << 5) |
      (b >> DOMINANT_BUCKET_SHIFT)
    const bucket = counts.get(key)
    if (bucket) {
      bucket.n++
      bucket.r += r
      bucket.g += g
      bucket.b += b
    } else {
      counts.set(key, { n: 1, r, g, b })
    }
  }

  let best: { n: number; r: number; g: number; b: number } | null = null
  for (const bucket of counts.values()) {
    if (!best || bucket.n > best.n) best = bucket
  }
  if (!best) return null
  // The bucket's own mean, so the result is a real colour from the cover rather
  // than the centre of a quantisation cell.
  return [
    Math.round(best.r / best.n),
    Math.round(best.g / best.n),
    Math.round(best.b / best.n),
  ]
}

/** The separator drawn between tape segments, and the band the tape occupies. */
const TAPE_SEPARATOR = '  ·  '

/**
 * The tape's full loop width in pixels — every segment plus its trailing
 * separator, measured in the real font.
 *
 * Exported because only this file can measure it, and two callers need to:
 *
 * - a test, to assert the wrap at the EXACT loop boundary. `measureText`
 *   returns fractional pixels, so no integer offset lands on the boundary and a
 *   test scanning integers can never prove the wrap.
 * - a page, if it ever wants to know how long its tape takes to pass.
 *
 * Returns 0 for a tape with nothing to draw.
 */
export function tapeLoopWidthPx(segments: readonly TapeSegment[]): number {
  const runs = segments.filter((seg) => seg.text.length > 0)
  if (runs.length === 0) return 0
  const canvas = createCanvas(STRIP_WIDTH, STRIP_HEIGHT)
  const ctx = canvas.getContext('2d')
  ctx.font = `13px ${FONT}`
  return runs.reduce((total, seg) => total + ctx.measureText(seg.text + TAPE_SEPARATOR).width, 0)
}
const TAPE_BAND_TOP = STRIP_LINE_2_Y - 3
const TAPE_BAND_HEIGHT = 20

/**
 * Draws a scrolling tape across line 2's band.
 *
 * Everything happens inside a clip rectangle. That is what makes it impossible
 * for the tape to reach line 1, the bar, or the strip's edges, rather than
 * relying on the arithmetic below staying correct forever (lesson 21: prefer
 * impossible to unreachable).
 *
 * The renderer owns the wrap because it owns the font metrics. It measures the
 * real tape width, reduces `offsetPx` modulo that width, and then draws as many
 * copies as the clip needs — so a tape NARROWER than the strip still fills it,
 * and the seam is never visible at any offset.
 */
function drawTape(ctx: SKRSContext2D, tape: TapeSpec, dim: boolean, rightWidth: number): void {
  const segments = tape.segments.filter((seg) => seg.text.length > 0)
  if (segments.length === 0) return

  ctx.font = `13px ${FONT}`

  // Each segment plus the separator that follows it, so the loop is seamless.
  const runs = segments.map((seg) => ({
    text: seg.text + TAPE_SEPARATOR,
    color: seg.color,
  }))
  const widths = runs.map((run) => ctx.measureText(run.text).width)
  const totalWidth = widths.reduce((a, b) => a + b, 0)
  if (totalWidth <= 0) return

  // The clip: line 2's band, minus `right`'s gutter when there is one.
  const clipWidth =
    rightWidth > 0
      ? Math.max(0, STRIP_WIDTH - rightWidth - STRIP_RIGHT_GAP - PAD)
      : STRIP_WIDTH
  if (clipWidth <= 0) return

  ctx.save()
  try {
    ctx.beginPath()
    ctx.rect(0, TAPE_BAND_TOP, clipWidth, TAPE_BAND_HEIGHT)
    ctx.clip()

    // A positive offset scrolls the tape leftward, so the text moves the way a
    // real ticker does: newest content entering from the right.
    const wrapped = ((tape.offsetPx % totalWidth) + totalWidth) % totalWidth
    // Enough copies to cover the clip from the wrap point, plus one so the
    // trailing copy always reaches the right edge.
    const copies = Math.ceil(clipWidth / totalWidth) + 1

    for (let copy = 0; copy < copies; copy++) {
      let x = -wrapped + copy * totalWidth
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i]!
        const width = widths[i]!
        // Skip runs entirely off the clip, so a long tape costs no more than a
        // short one.
        if (x + width >= 0 && x <= clipWidth) {
          ctx.fillStyle = css(run.color ?? theme.text, dim)
          ctx.fillText(run.text, x, STRIP_LINE_2_Y)
        }
        x += width
      }
    }
  } finally {
    ctx.restore()
  }
}

export function renderStrip(rawSpec: StripSpec): Buffer {
  const spec = sanitizeStripSpec(rawSpec)
  const canvas = createCanvas(STRIP_WIDTH, STRIP_HEIGHT)
  const ctx = canvas.getContext('2d')
  const dim = spec.dim === true

  ctx.fillStyle = css(theme.bg)
  ctx.fillRect(0, 0, STRIP_WIDTH, STRIP_HEIGHT)

  ctx.fillStyle = css(theme.text, dim)
  ctx.font = `13px ${FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'

  // `right` sits beside line 2 only (never line 1), and always gets the
  // width it measures at plus its own gap — line 2 is what shrinks to fit
  // whatever is left over. Measuring here, rather than trusting the page's
  // own truncation, is what makes this correct for any actual string: I5
  // measured 22.3 px of real overlap on an 18-character artist beside a
  // two-hour clock, a combination no fixed character count anticipated.
  //
  // `right` itself is shrunk to the strip's own full usable width first (M4
  // from the r3 review): with no bound of its own, a `right` wider than the
  // whole strip draws right-aligned starting at a NEGATIVE x, painting past
  // column 0 into the left padding no other element is ever allowed to
  // touch. No page produces a `right` anywhere near this wide today (the
  // widest real value, `120:00 / 120:00`, measures 117.4 px against a 236 px
  // budget), so this never shrinks a real one.
  let rightWidth = 0
  let right: string | undefined
  if (spec.right) {
    right = shrinkToFit(ctx, spec.right, STRIP_TEXT_MAX_WIDTH)
    rightWidth = ctx.measureText(right).width
  }

  let y = 4
  // A tape OWNS line 2's band, so line 2's own text is not drawn. Line 1 still
  // is, which is what lets a page keep a fixed title above a moving tape.
  const lines = spec.lines.slice(0, spec.tape ? 1 : 2)
  for (let i = 0; i < lines.length; i++) {
    ctx.font = `13px ${FONT}`
    const maxWidth =
      i === 1 && spec.right
        ? Math.max(0, STRIP_TEXT_MAX_WIDTH - rightWidth - STRIP_RIGHT_GAP)
        : STRIP_TEXT_MAX_WIDTH
    // Line 1 has no competing right-hand text, so this is the same fix as
    // I6's clipped Claude strip: a line that was never truncated at all,
    // now bounded to the strip's own measured budget regardless of source.
    ctx.fillText(shrinkToFit(ctx, lines[i]!, maxWidth), PAD, y)
    y += 17
  }

  if (right) {
    // Right-aligned on the SECOND line, beside line 2's text. Line 1 is reserved
    // for the title, which needs the full width.
    ctx.textAlign = 'right'
    ctx.fillStyle = css(theme.textDim, dim)
    ctx.font = `13px ${FONT}`
    ctx.fillText(right, STRIP_WIDTH - PAD, STRIP_LINE_2_Y)
    ctx.textAlign = 'left'
  }

  if (spec.tape) {
    drawTape(ctx, spec.tape, dim, rightWidth)
  }

  if (spec.bar) {
    drawBar(ctx, spec.bar, PAD, 46, STRIP_WIDTH - PAD * 2, 6, dim)
  }

  return toRgba(ctx, STRIP_WIDTH, STRIP_HEIGHT)
}

/**
 * Reads one pixel from a raw RGBA buffer. Tests use it for pixel probes. It
 * needs no decode step, because the buffer already holds raw pixels.
 * Pass `width` as `STRIP_WIDTH` when you probe a strip buffer.
 */
export function probe(rgba: Buffer, x: number, y: number, width = KEY_SIZE): Rgb {
  const at = (y * width + x) * 4
  if (at < 0 || at + 3 > rgba.length) {
    throw new Error(`probe coordinate ${x},${y} is outside the buffer`)
  }
  return [rgba[at]!, rgba[at + 1]!, rgba[at + 2]!]
}
