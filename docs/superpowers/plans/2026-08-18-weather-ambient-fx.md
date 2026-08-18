# Weather Ambient Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each weather day tile draws a live effect behind its numbers, chosen by the forecast the tile already reports, so the forecast reads across the room.

**Architecture:** One new opt-in `KeySpec.fx` field. `renderKey` draws each variant at full strength onto a reused module-level scratch canvas, then composites that canvas onto the key at a single capped `globalAlpha`. The cap is therefore enforced by construction: no variant can exceed it. The weather page picks the variant from the same emoji lookup its background wash already uses, so the icon, the wash, and the effect can never disagree.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), ESM with `.js` import suffixes, `@napi-rs/canvas` 0.1.100, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-18-weather-ambient-fx-design.md`.
- Prose in ASD-STE100 Simplified Technical English: short sentences, active voice, one idea per sentence. Applies to comments, docs, and commit messages.
- ESM with `.js` import suffixes. Strict TypeScript and `noUncheckedIndexedAccess` stay clean.
- Pages stay pure. A page never touches canvas, HID, the network, or the wall clock. It uses the injected `now`/`nowMs`.
- `fx` is **opt-in per key**. Absent `fx` must render byte-identical output to the current renderer.
- Every numeric field on a spec must pass through `sanitizeKeySpec`. `ctx.arc` panics in Rust on a non-finite argument and aborts the whole process — this is not a catchable throw.
- Every new `KeySpec` field must affect `keyHash` (lesson 11). Prove it with a test.
- Every new test gets the break-the-fix check: break the code, watch the test fail, restore. Probe regions, never single pixel columns (lesson 22).
- `log.once` on any repeating failure path, never `log.warn` (lesson 5).
- Commit with the pathspec form: `git commit -m "..." -- <paths>` (lesson 12). Check `git diff --cached --name-only` first.
- Required validation before deployment: `npm test`, `npm run typecheck`, `npm run build`, `/bin/sh -n src/install/statusline-wrapper.sh`, `git diff --check`.

### Measured facts this plan depends on

Measured on this Mac on 2026-08-18, with `@napi-rs/canvas` 0.1.100:

- A canvas composites onto another canvas through `ctx.drawImage(canvas, 0, 0)`. `rgba(90,150,255,1)` at `globalAlpha` 0.28 over `rgb(18,28,44)` produced exactly `(38,62,103)`, the arithmetic blend.
- `clearRect` fully resets a reused scratch canvas, alpha included. One module-level scratch canvas is therefore safe.
- A hostile layer filled solid white at `globalAlpha` 1 still composited to `(84,91,103)`. The cap holds whatever a variant does.
- Two identical renders are byte-identical.
- Cost is 0.37 ms per 8-key frame, against a 100 ms tick budget.

## File Structure

- Modify `src/render/specs.ts` — add `FxVariant`, `FxSpec`, and `KeySpec.fx`. One responsibility: the description vocabulary.
- Modify `src/render/canvas.ts` — add the scratch-canvas compositing path, the seven variant draw functions, and their exported geometry helpers. This file is already large; the effects go in one clearly delimited section beside the existing idle animations, following that established pattern rather than restructuring the file.
- Modify `src/pages/weather-page.ts` — `CONDITION_STYLES`, `precipIntensity`, `conditionFx`, the `isDimmed` extraction, the `nowMs` thread-through, and the `tickMs` getter.
- Modify `tests/render/canvas.test.ts` — variant, cap, determinism, sanitizer, and geometry proofs.
- Modify `tests/render/specs.test.ts` — `keyHash` covers `fx`.
- Modify `tests/pages/weather-page.test.ts` — content-ink conversion of the existing pixel proofs, plus the mapping and staleness proofs.
- Modify `tests/pages/tick-rate.test.ts` — weather raises its rate only while an effect shows.
- Modify `docs/VERIFIED-FACTS.md` and `docs/PROJECT-STATE.md` — record the measurements and the new invariants.

---

### Task 1: The `fx` field, the capped compositing path, and the rain variant

**Files:**
- Modify: `src/render/specs.ts`
- Modify: `src/render/canvas.ts`
- Test: `tests/render/specs.test.ts`, `tests/render/canvas.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FxVariant`, `FxSpec`, `KeySpec.fx`, `FX_MAX_ALPHA`, `FX_INTENSITY_MIN`, and `fxRainDropSpan(seed: number, index: number, nowMs: number): { head: number; tail: number }`.

- [ ] **Step 1: Write the failing tests**

In `tests/render/specs.test.ts`:

```ts
it('keyHash covers fx, including nowMs alone', () => {
  const base: KeySpec = { kind: 'gauge', fx: { variant: 'rain', nowMs: 1000, intensity: 0.5, seed: 0 } }
  const later: KeySpec = { ...base, fx: { ...base.fx!, nowMs: 1100 } }
  const other: KeySpec = { ...base, fx: { ...base.fx!, variant: 'snow' } }
  expect(keyHash(later)).not.toBe(keyHash(base))
  expect(keyHash(other)).not.toBe(keyHash(base))
})
```

In `tests/render/canvas.test.ts`:

```ts
describe('fx layer', () => {
  const bg: Rgb = [18, 28, 44]

  it('paints into the key, and only through fx', () => {
    const plain = renderKey({ kind: 'gauge', bg })
    const rained = renderKey({ kind: 'gauge', bg, fx: { variant: 'rain', nowMs: 4200, intensity: 1, seed: 3 } })
    expect(rained.equals(plain)).toBe(false)
  })

  it('renders byte-identical output when fx is absent', () => {
    const a = renderKey({ kind: 'gauge', bg, lines: ['NOW', '95°/77°'] })
    const b = renderKey({ kind: 'gauge', bg, lines: ['NOW', '95°/77°'] })
    expect(a.equals(b)).toBe(true)
  })

  it('never exceeds the alpha cap, even for a variant at full intensity', () => {
    // The cap bounds how far any fx pixel can move the background toward a
    // bright colour. Probes the whole key, not one pixel.
    const buf = renderKey({ kind: 'gauge', bg, fx: { variant: 'rain', nowMs: 4200, intensity: 1, seed: 3 } })
    const ceiling = bg.map((c) => c + (255 - c) * FX_MAX_ALPHA + 2)
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        const px = probe(buf, x, y)
        for (let i = 0; i < 3; i++) expect(px[i]!).toBeLessThanOrEqual(ceiling[i]!)
      }
    }
  })

  it('is deterministic for one nowMs, and moves between two', () => {
    const at = (nowMs: number) => renderKey({ kind: 'gauge', bg, fx: { variant: 'rain', nowMs, intensity: 1, seed: 3 } })
    expect(at(4200).equals(at(4200))).toBe(true)
    expect(at(4200).equals(at(4500))).toBe(false)
  })

  it('survives a non-finite fx without aborting the process', () => {
    const buf = renderKey({
      kind: 'gauge', bg,
      fx: { variant: 'rain', nowMs: Number.NaN, intensity: Number.POSITIVE_INFINITY, seed: Number.NaN },
    })
    expect(buf.length).toBe(KEY_SIZE * KEY_SIZE * 4)
  })

  it('slides a rain streak fully in from above and fully out below before it wraps', () => {
    // At the wrap instant every part of the streak must be off-key, or the
    // whole strand vanishes mid-key — the exact defect the matrix rain
    // shipped with once (see rainColumnSpan).
    const spans = Array.from({ length: 400 }, (_, i) => fxRainDropSpan(3, 0, i * 25))
    const entering = spans.filter((s) => s.tail < 0 && s.head > 0)
    const leaving = spans.filter((s) => s.tail < KEY_SIZE && s.head > KEY_SIZE)
    expect(entering.length).toBeGreaterThan(0)
    expect(leaving.length).toBeGreaterThan(0)
    for (const s of spans) {
      expect(s.head).toBeGreaterThan(s.tail)
      expect(s.tail).toBeLessThanOrEqual(KEY_SIZE)
      expect(s.head).toBeGreaterThanOrEqual(-KEY_SIZE)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/render/specs.test.ts tests/render/canvas.test.ts`
Expected: FAIL — `fx` is not a `KeySpec` property, and `FX_MAX_ALPHA` and `fxRainDropSpan` do not exist.

- [ ] **Step 3: Add the spec vocabulary**

In `src/render/specs.ts`, beside `IdleSpec`:

```ts
/**
 * The seven ambient effects a key can draw BEHIND its own content. Task 42
 * built them for the weather page, where each forecast condition picks one,
 * and a later standalone animation page reuses the same layer.
 */
export type FxVariant = 'rain' | 'snow' | 'storm' | 'fog' | 'wind' | 'sun' | 'cloud'

export interface FxSpec {
  variant: FxVariant
  /**
   * The daemon's injected clock, in unix milliseconds. A page must never call
   * `Date.now()` — the same rule `IdleSpec.nowMs` follows, so a test passes
   * an explicit clock and gets a byte-identical frame.
   */
  nowMs: number
  /** 0 to 1. Scales density, rate, or brightness, depending on the variant. */
  intensity: number
  /**
   * Decorrelates neighbouring keys. Two tiles with the same variant and the
   * same seed animate in lockstep, which reads as a single wide effect
   * rather than seven separate tiles; the key index is enough to break it.
   */
  seed: number
}
```

Add to `KeySpec`:

```ts
  /**
   * An ambient effect drawn BENEATH this key's own content — background
   * wash first, then this layer, then the image, border, glyph, emoji and
   * text. Opt-in per key: absent, the render path is byte-identical to
   * before this field existed, exactly as `lineSizes` and `SparkSpec.slice`
   * are. That is what keeps every other page's pixel proof valid.
   *
   * `nowMs` changes every frame, so a key carrying `fx` rewrites every
   * frame by design — `keyHash` covers `fx` and must keep covering it
   * (lesson 11).
   */
  fx?: FxSpec
```

- [ ] **Step 4: Add the compositing path and the rain variant**

In `src/render/canvas.ts`, import `Canvas` and `FxSpec`/`FxVariant`:

```ts
import { createCanvas, type Canvas, type SKRSContext2D, type Image } from '@napi-rs/canvas'
import type { KeySpec, StripSpec, Rgb, BarSpec, SparkSpec, ImageCrop, IdleSpec, FxSpec } from './specs.js'
```

Add the effects section after the idle animations:

```ts
/* ---------- Ambient effects (task 42) ---------- */

/**
 * The hard ceiling on how bright any ambient effect can get. Enforced ONCE,
 * at the composite in `drawFx`, rather than trusted to each variant: a
 * variant draws at full strength onto its own scratch canvas, and that
 * canvas lands on the key at this alpha. So a variant CANNOT exceed the
 * budget, whatever it does to its own context — the harm is impossible by
 * construction rather than merely unreached (lesson 21).
 *
 * Measured on 2026-08-18: a scratch layer filled solid white at alpha 1
 * composited over the rain tint `(18,28,44)` to `(84,91,103)`. Text renders
 * at 235, so content always wins.
 */
export const FX_MAX_ALPHA = 0.28

/**
 * The floor for a data-driven intensity. A 0-percent chance of rain is a
 * real reading, not missing data, so its tile still shows a trace of the
 * effect rather than going inert and looking broken.
 */
export const FX_INTENSITY_MIN = 0.25

/**
 * One reused scratch canvas for every effect, created on first use. Safe as
 * module state because `renderKey` is synchronous, single-threaded, and
 * never re-entrant, and because `clearRect` was measured to reset the
 * surface completely, alpha included (2026-08-18). A fresh canvas per key
 * per frame would allocate 80 canvases a second for nothing.
 */
let fxScratch: Canvas | null = null

function fxScratchContext(): { canvas: Canvas; ctx: SKRSContext2D } {
  if (!fxScratch) fxScratch = createCanvas(KEY_SIZE, KEY_SIZE)
  const ctx = fxScratch.getContext('2d')
  ctx.clearRect(0, 0, KEY_SIZE, KEY_SIZE)
  ctx.globalAlpha = 1
  return { canvas: fxScratch, ctx }
}

/** Scales an effect's own per-particle opacity. Never the cap — that is
 * applied once at the composite. */
function fxCss(c: Rgb, alpha: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${clamp01(alpha)})`
}

/**
 * Draws one ambient effect beneath a key's content. The variant paints at
 * full strength onto the scratch canvas; this function composites it at
 * `FX_MAX_ALPHA`, halved again by `DIM_FACTOR` when the key is dim, so a
 * stale key's layer darkens by the same fraction as its text (lesson 15 —
 * a composited surface ignores `fillStyle`, exactly like a bitmap emoji).
 */
function drawFx(ctx: SKRSContext2D, fx: FxSpec, dim: boolean): void {
  const { canvas, ctx: layer } = fxScratchContext()
  const intensity = clamp01(fx.intensity)

  switch (fx.variant) {
    case 'rain': drawFxRain(layer, fx, intensity, false); break
    case 'storm': drawFxStorm(layer, fx, intensity); break
    case 'snow': drawFxSnow(layer, fx, intensity); break
    case 'fog': drawFxFog(layer, fx, intensity); break
    case 'wind': drawFxWind(layer, fx, intensity); break
    case 'sun': drawFxSun(layer, fx, intensity); break
    case 'cloud': drawFxCloud(layer, fx, intensity); break
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
/** The storm variant drives the same streaks harder and leans them further. */
const FX_STORM_PERIOD_SCALE = 0.66
const FX_STORM_SLANT = 5

/**
 * One rain streak's vertical extent at one instant. `head` is the leading
 * (lowest) end, `tail` the trailing end above it. Exported so a test proves
 * the loop geometry instead of trusting this comment.
 *
 * The head enters one full streak-length ABOVE the key and travels one full
 * length BELOW it before wrapping, so at the wrap instant the whole streak
 * is off-key and the loop is invisible. The matrix rain shipped once with
 * travel that stopped at `KEY_SIZE`, and whole strands vanished mid-key —
 * see `rainColumnSpan`. Do not shorten the travel.
 */
export function fxRainDropSpan(
  seed: number, index: number, nowMs: number, periodScale = 1,
): { head: number; tail: number } {
  const s = seed * 131 + index * 17
  const period = (FX_RAIN_PERIOD_BASE_MS + pseudoRandom(s) * FX_RAIN_PERIOD_VAR_MS) * periodScale
  const phase = pseudoRandom(s + 1) * period
  const t = ((nowMs + phase) % period) / period
  const travel = KEY_SIZE + 2 * FX_RAIN_LEN
  const head = -FX_RAIN_LEN + t * travel
  return { head, tail: head - FX_RAIN_LEN }
}

function drawFxRain(
  ctx: SKRSContext2D, fx: FxSpec, intensity: number, storm: boolean,
): void {
  const count = Math.max(2, Math.round(intensity * FX_RAIN_MAX_DROPS))
  const slant = storm ? FX_STORM_SLANT : FX_RAIN_SLANT
  const scale = storm ? FX_STORM_PERIOD_SCALE : 1
  ctx.lineWidth = FX_RAIN_WIDTH
  ctx.lineCap = 'round'
  for (let i = 0; i < count; i++) {
    const s = fx.seed * 131 + i * 17
    const x = pseudoRandom(s + 2) * KEY_SIZE
    const { head, tail } = fxRainDropSpan(fx.seed, i, fx.nowMs, scale)
    ctx.strokeStyle = fxCss(theme.blue, 0.55 + 0.45 * pseudoRandom(s + 3))
    ctx.beginPath()
    ctx.moveTo(x, tail)
    ctx.lineTo(x + slant, head)
    ctx.stroke()
  }
}
```

- [ ] **Step 5: Wire `fx` into `renderKey` and the sanitizer**

In `sanitizeKeySpec`, beside the `idle` block:

```ts
  if (out.fx) {
    // `drawFxSun` and `drawFxSnow` reach `ctx.arc`, which PANICS in Rust on
    // a non-finite argument and aborts the whole process — not a catchable
    // throw, so the render loop's own try/catch cannot save it. This is the
    // one boundary that keeps that unreachable.
    out.fx = {
      ...out.fx,
      nowMs: finiteOr(out.fx.nowMs, 0),
      intensity: clamp01(finiteOr(out.fx.intensity, 0)),
      seed: finiteOr(out.fx.seed, 0),
    }
  }
```

In `renderKey`, immediately after the background fill and before the `spec.image` block:

```ts
  // Beneath everything else: the wash, then this layer, then content.
  if (spec.fx) drawFx(ctx, spec.fx, dim)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/render/specs.test.ts tests/render/canvas.test.ts`
Expected: PASS.

- [ ] **Step 7: Break the fix and watch each new test fail**

Do all four, restoring after each:
1. Set `FX_MAX_ALPHA = 1` — the cap test must fail.
2. Change `travel` to `KEY_SIZE` — the slide-in/slide-out test must fail.
3. Delete the `out.fx` sanitizer block — the non-finite test must fail or abort.
4. Remove `fx` from the `keyHash` spread by destructuring it out — the hash test must fail.

- [ ] **Step 8: Commit**

```bash
git diff --cached --name-only
git commit -m "feat: add an opt-in fx layer to KeySpec, with the rain variant" -- src/render/specs.ts src/render/canvas.ts tests/render/specs.test.ts tests/render/canvas.test.ts
```

---

### Task 2: The snow and storm variants

**Files:**
- Modify: `src/render/canvas.ts`
- Test: `tests/render/canvas.test.ts`

**Interfaces:**
- Consumes: `FxSpec`, `fxRainDropSpan`, `pseudoRandom`, `fxCss`, `FX_MAX_ALPHA` from Task 1.
- Produces: `fxSnowFlakeY(seed: number, index: number, nowMs: number): { y: number; travel: number }` and `fxStormFlashOn(seed: number, nowMs: number): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
it('drifts a snowflake fully in from above and fully out below before it wraps', () => {
  const samples = Array.from({ length: 600 }, (_, i) => fxSnowFlakeY(5, 0, i * 40))
  expect(samples.some((s) => s.y < 0)).toBe(true)
  expect(samples.some((s) => s.y > KEY_SIZE)).toBe(true)
  for (const s of samples) {
    expect(s.y).toBeGreaterThanOrEqual(-FX_SNOW_R * 2 - 1)
    expect(s.y).toBeLessThanOrEqual(KEY_SIZE + FX_SNOW_R * 2 + 1)
  }
})

it('flashes the storm variant on sometimes and off most of the time', () => {
  const on = Array.from({ length: 1000 }, (_, i) => fxStormFlashOn(2, i * 10)).filter(Boolean)
  // A lightning flash is rare and brief: present, but well under a fifth of
  // the time. A stuck-on flash would be a bright key, not a storm.
  expect(on.length).toBeGreaterThan(0)
  expect(on.length).toBeLessThan(200)
})

it('makes the storm variant brighter than plain rain at the same instant', () => {
  const bg: Rgb = [28, 24, 48]
  const lum = (buf: Buffer) => {
    let total = 0
    for (let y = 0; y < KEY_SIZE; y++) for (let x = 0; x < KEY_SIZE; x++) {
      const p = probe(buf, x, y); total += p[0]! + p[1]! + p[2]!
    }
    return total
  }
  // A flash instant, found from the pure predicate rather than guessed.
  const flashMs = Array.from({ length: 2000 }, (_, i) => i * 5).find((ms) => fxStormFlashOn(2, ms))!
  const storm = renderKey({ kind: 'gauge', bg, fx: { variant: 'storm', nowMs: flashMs, intensity: 1, seed: 2 } })
  const rain = renderKey({ kind: 'gauge', bg, fx: { variant: 'rain', nowMs: flashMs, intensity: 1, seed: 2 } })
  expect(lum(storm)).toBeGreaterThan(lum(rain))
})

it('keeps the storm flash under the alpha cap', () => {
  const bg: Rgb = [28, 24, 48]
  const flashMs = Array.from({ length: 2000 }, (_, i) => i * 5).find((ms) => fxStormFlashOn(2, ms))!
  const buf = renderKey({ kind: 'gauge', bg, fx: { variant: 'storm', nowMs: flashMs, intensity: 1, seed: 2 } })
  const ceiling = bg.map((c) => c + (255 - c) * FX_MAX_ALPHA + 2)
  for (let y = 0; y < KEY_SIZE; y++) for (let x = 0; x < KEY_SIZE; x++) {
    const px = probe(buf, x, y)
    for (let i = 0; i < 3; i++) expect(px[i]!).toBeLessThanOrEqual(ceiling[i]!)
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/render/canvas.test.ts`
Expected: FAIL — `fxSnowFlakeY` and `fxStormFlashOn` do not exist.

- [ ] **Step 3: Implement both variants**

```ts
const FX_SNOW_MAX_FLAKES = 20
export const FX_SNOW_R = 1.7
const FX_SNOW_PERIOD_BASE_MS = 5200
const FX_SNOW_PERIOD_VAR_MS = 3200
const FX_SNOW_SWAY_PX = 7
const FX_SNOW_SWAY_PERIOD_MS = 3100

/**
 * One snowflake's vertical position, and the travel it loops over. Snow
 * falls far more slowly than rain and sways sideways, so it needs its own
 * geometry rather than a reskinned rain streak. Same slide-in and slide-out
 * rule as `fxRainDropSpan`: a flake is fully off-key at the wrap instant.
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
    const s = fx.seed * 211 + index0(i) * 29
    const baseX = pseudoRandom(s + 2) * KEY_SIZE
    const { y } = fxSnowFlakeY(fx.seed, i, fx.nowMs)
    const sway = FX_SNOW_SWAY_PX * Math.sin((fx.nowMs / FX_SNOW_SWAY_PERIOD_MS) * 2 * Math.PI + pseudoRandom(s + 3) * 6.283)
    const r = FX_SNOW_R * (0.7 + 0.6 * pseudoRandom(s + 4))
    ctx.fillStyle = fxCss(theme.white, 0.5 + 0.5 * pseudoRandom(s + 5))
    ctx.beginPath()
    ctx.arc(baseX + sway, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

const FX_STORM_FLASH_PERIOD_MS = 4300
const FX_STORM_FLASH_MS = 90
const FX_STORM_SECOND_FLASH_AT_MS = 210
const FX_STORM_SECOND_FLASH_MS = 60

/**
 * Whether the storm's lightning is lit at this instant. Two short windows
 * inside one long period, so a strike reads as the real double flash rather
 * than a single blink. Exported so a test finds a real flash instant from
 * the predicate instead of guessing a timestamp, and so it can prove the
 * flash is rare rather than stuck on.
 */
export function fxStormFlashOn(seed: number, nowMs: number): boolean {
  const offset = pseudoRandom(seed * 313 + 7) * FX_STORM_FLASH_PERIOD_MS
  const phase = (nowMs + offset) % FX_STORM_FLASH_PERIOD_MS
  if (phase < FX_STORM_FLASH_MS) return true
  const second = phase - FX_STORM_SECOND_FLASH_AT_MS
  return second >= 0 && second < FX_STORM_SECOND_FLASH_MS
}

function drawFxStorm(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  drawFxRain(ctx, fx, intensity, true)
  if (!fxStormFlashOn(fx.seed, fx.nowMs)) return
  // A full-key wash at full strength on the scratch layer. The composite's
  // own cap is what keeps it from becoming a white key.
  ctx.fillStyle = fxCss(theme.white, 1)
  ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE)
}
```

Replace the `index0(i)` placeholder above with `i` when implementing — it exists only to make the seed expression readable in this plan. The seed must be `fx.seed * 211 + i * 29`, matching `fxSnowFlakeY` exactly so the drawn flake and the tested geometry cannot drift apart.

Update `drawFx`'s `rain` case to `drawFxRain(layer, fx, intensity, false)` (already correct in Task 1).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/render/canvas.test.ts`
Expected: PASS.

- [ ] **Step 5: Break the fix and watch the tests fail**

1. Make `fxStormFlashOn` return `true` always — the rarity test must fail, and the cap test must still pass.
2. Change the snow `travel` to `KEY_SIZE` — the slide test must fail.
3. Remove the flash from `drawFxStorm` — the brighter-than-rain test must fail.

- [ ] **Step 6: Commit**

```bash
git diff --cached --name-only
git commit -m "feat: add the snow and storm fx variants" -- src/render/canvas.ts tests/render/canvas.test.ts
```

---

### Task 3: The fog, wind, sun and cloud variants

**Files:**
- Modify: `src/render/canvas.ts`
- Test: `tests/render/canvas.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: `fxWindStreakSpan(seed: number, index: number, nowMs: number): { lead: number; trail: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('slides a wind streak fully in from the left and out to the right before it wraps', () => {
  const spans = Array.from({ length: 500 }, (_, i) => fxWindStreakSpan(4, 0, i * 15))
  expect(spans.some((s) => s.trail < 0 && s.lead > 0)).toBe(true)
  expect(spans.some((s) => s.trail < KEY_SIZE && s.lead > KEY_SIZE)).toBe(true)
  for (const s of spans) expect(s.lead).toBeGreaterThan(s.trail)
})

it.each(['fog', 'wind', 'sun', 'cloud'] as const)('paints something, and stays under the cap, for %s', (variant) => {
  const bg: Rgb = [22, 24, 28]
  const plain = renderKey({ kind: 'gauge', bg })
  const buf = renderKey({ kind: 'gauge', bg, fx: { variant, nowMs: 7700, intensity: 1, seed: 1 } })
  expect(buf.equals(plain)).toBe(false)
  const ceiling = bg.map((c) => c + (255 - c) * FX_MAX_ALPHA + 2)
  for (let y = 0; y < KEY_SIZE; y++) for (let x = 0; x < KEY_SIZE; x++) {
    const px = probe(buf, x, y)
    for (let i = 0; i < 3; i++) expect(px[i]!).toBeLessThanOrEqual(ceiling[i]!)
  }
})

it.each(['rain', 'snow', 'storm', 'fog', 'wind', 'sun', 'cloud'] as const)('animates over time for %s', (variant) => {
  const bg: Rgb = [22, 24, 28]
  const at = (nowMs: number) => renderKey({ kind: 'gauge', bg, fx: { variant, nowMs, intensity: 1, seed: 1 } })
  // A whole period apart for the slowest variant, so no effect can pass by
  // being frozen — the property is "it moves", not "it moves within 300ms".
  expect(at(0).equals(at(3000))).toBe(false)
})

it.each(['rain', 'snow', 'storm', 'fog', 'wind', 'sun', 'cloud'] as const)('dims %s along with the rest of the key', (variant) => {
  const bg: Rgb = [22, 24, 28]
  const fx = { variant, nowMs: 7700, intensity: 1, seed: 1 } as const
  const bright = renderKey({ kind: 'gauge', bg, fx })
  const dimmed = renderKey({ kind: 'gauge', bg, fx, dim: true })
  expect(bright.equals(dimmed)).toBe(false)
})

it.each(['rain', 'snow', 'fog', 'cloud'] as const)('draws %s more faintly or sparsely at low intensity', (variant) => {
  const bg: Rgb = [22, 24, 28]
  const ink = (intensity: number) => {
    const buf = renderKey({ kind: 'gauge', bg, fx: { variant, nowMs: 7700, intensity, seed: 1 } })
    let n = 0
    for (let y = 0; y < KEY_SIZE; y++) for (let x = 0; x < KEY_SIZE; x++) {
      const p = probe(buf, x, y)
      if (Math.abs(p[0]! - bg[0]) > 1 || Math.abs(p[1]! - bg[1]) > 1 || Math.abs(p[2]! - bg[2]) > 1) n++
    }
    return n
  }
  expect(ink(1)).toBeGreaterThan(ink(FX_INTENSITY_MIN))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/render/canvas.test.ts`
Expected: FAIL — `fxWindStreakSpan` does not exist and the four variants draw nothing.

- [ ] **Step 3: Implement the four variants**

```ts
const FX_FOG_BANDS = 4
const FX_FOG_BAND_H = 11
const FX_FOG_WIDTH = 70
const FX_FOG_PERIOD_BASE_MS = 11000
const FX_FOG_PERIOD_VAR_MS = 6000

/**
 * Slow horizontal haze. Each band is a soft-edged block that drifts
 * sideways and wraps, drawn twice so the wrap seam is never visible. A
 * linear gradient gives the soft edges; `createLinearGradient` needs finite
 * coordinates, which `sanitizeKeySpec` guarantees.
 */
function drawFxFog(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  for (let b = 0; b < FX_FOG_BANDS; b++) {
    const s = fx.seed * 419 + b * 37
    const y = ((b + 0.5) / FX_FOG_BANDS) * KEY_SIZE - FX_FOG_BAND_H / 2 + pseudoRandom(s) * 6 - 3
    const period = FX_FOG_PERIOD_BASE_MS + pseudoRandom(s + 1) * FX_FOG_PERIOD_VAR_MS
    const dir = pseudoRandom(s + 2) < 0.5 ? -1 : 1
    const t = ((fx.nowMs + pseudoRandom(s + 3) * period) % period) / period
    const span = KEY_SIZE + FX_FOG_WIDTH
    const x = dir > 0 ? -FX_FOG_WIDTH + t * span : KEY_SIZE - t * span
    const alpha = intensity * (0.45 + 0.4 * pseudoRandom(s + 4))
    for (const ox of [x, x + (dir > 0 ? -span : span)]) {
      const grad = ctx.createLinearGradient(ox, 0, ox + FX_FOG_WIDTH, 0)
      grad.addColorStop(0, fxCss(theme.gray, 0))
      grad.addColorStop(0.5, fxCss(theme.gray, alpha))
      grad.addColorStop(1, fxCss(theme.gray, 0))
      ctx.fillStyle = grad
      ctx.fillRect(ox, y, FX_FOG_WIDTH, FX_FOG_BAND_H)
    }
  }
}

const FX_WIND_MAX_STREAKS = 10
const FX_WIND_LEN = 28
const FX_WIND_PERIOD_BASE_MS = 1300
const FX_WIND_PERIOD_VAR_MS = 800

/**
 * One wind streak's horizontal extent. `lead` is the right-hand end,
 * `trail` the left. Same fully-in, fully-out rule as the falling variants,
 * rotated ninety degrees.
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
  ctx.lineWidth = 1.2
  ctx.lineCap = 'round'
  for (let i = 0; i < count; i++) {
    const s = fx.seed * 523 + i * 41
    const y = pseudoRandom(s + 2) * KEY_SIZE
    const { lead, trail } = fxWindStreakSpan(fx.seed, i, fx.nowMs)
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
const FX_SUN_PULSE_PERIOD_MS = 5400
const FX_SUN_PULSE_AMPLITUDE = 0.12

/**
 * A warm central glow with slowly turning rays. The glow is a radial
 * gradient; the rays are thin wedges from the centre. Both breathe on one
 * slow pulse, so a clear-sky tile still moves without anything crossing it.
 */
function drawFxSun(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  const cx = KEY_SIZE / 2
  const cy = KEY_SIZE / 2
  const pulse = 1 + FX_SUN_PULSE_AMPLITUDE * Math.sin((fx.nowMs / FX_SUN_PULSE_PERIOD_MS) * 2 * Math.PI)
  const r = FX_SUN_GLOW_R * pulse

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
  grad.addColorStop(0, fxCss(theme.amber, intensity * 0.85))
  grad.addColorStop(1, fxCss(theme.amber, 0))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE)

  const spin = (fx.nowMs / FX_SUN_ROTATE_PERIOD_MS) * 2 * Math.PI
  ctx.fillStyle = fxCss(theme.amber, intensity * 0.4)
  for (let i = 0; i < FX_SUN_RAYS; i++) {
    const a = spin + (i / FX_SUN_RAYS) * 2 * Math.PI
    const half = 0.05
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, r * 1.15, a - half, a + half)
    ctx.closePath()
    ctx.fill()
  }
}

const FX_CLOUD_BLOBS = 3
const FX_CLOUD_RADII = [23, 16, 28] as const
const FX_CLOUD_PERIOD_BASE_MS = 14000
const FX_CLOUD_PERIOD_VAR_MS = 9000

/** Slow drifting blobs, wrapping horizontally, each drawn twice so the wrap
 * seam never shows. `⛅` uses the same variant at a lower intensity. */
function drawFxCloud(ctx: SKRSContext2D, fx: FxSpec, intensity: number): void {
  for (let b = 0; b < FX_CLOUD_BLOBS; b++) {
    const s = fx.seed * 617 + b * 53
    const r = FX_CLOUD_RADII[b]! * (0.8 + 0.4 * pseudoRandom(s))
    const y = pseudoRandom(s + 1) * KEY_SIZE
    const period = FX_CLOUD_PERIOD_BASE_MS + pseudoRandom(s + 2) * FX_CLOUD_PERIOD_VAR_MS
    const t = ((fx.nowMs + pseudoRandom(s + 3) * period) % period) / period
    const span = KEY_SIZE + 2 * r
    const x = -r + t * span
    ctx.fillStyle = fxCss(theme.gray, intensity * (0.5 + 0.4 * pseudoRandom(s + 4)))
    for (const ox of [x, x - span]) {
      ctx.beginPath()
      ctx.arc(ox, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/render/canvas.test.ts`
Expected: PASS.

- [ ] **Step 5: Break the fix and watch the tests fail**

1. Change the wind `travel` to `KEY_SIZE` — the wind slide test must fail.
2. Ignore `intensity` in `drawFxCloud` — the low-intensity test must fail for `cloud`.
3. Drop `fx.nowMs` from `drawFxSun`'s pulse and spin — the animates-over-time test must fail for `sun`.

- [ ] **Step 6: Commit**

```bash
git diff --cached --name-only
git commit -m "feat: add the fog, wind, sun and cloud fx variants" -- src/render/canvas.ts tests/render/canvas.test.ts
```

---

### Task 4: Map each forecast condition to its effect

**Files:**
- Modify: `src/pages/weather-page.ts`
- Test: `tests/pages/weather-page.test.ts`

**Interfaces:**
- Consumes: `FxSpec`, `FxVariant`, `FX_INTENSITY_MIN`.
- Produces: `conditionFx(emoji: string, precipPercent: number | null, nowMs: number, seed: number): FxSpec`, `precipIntensity(pct: number | null): number`, and an unchanged `conditionTint(emoji: string): Rgb`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('WeatherPage condition effects', () => {
  it('gives every emoji weatherEmoji can produce a variant, driven from the real classifier', () => {
    // Built from weatherEmoji's own output for real forecast strings, not a
    // hand-written emoji list, so a new rule in the source cannot leave a
    // condition with no effect (lesson 22: assert the property).
    const forecasts = [
      'Scattered Thunderstorms', 'Snow Showers', 'Chance Light Rain', 'Patchy Fog',
      'Breezy', 'Mostly Cloudy', 'Partly Sunny', 'Sunny', 'Something Unmapped',
    ]
    for (const f of forecasts) {
      const fx = conditionFx(weatherEmoji(f), 40, 1000, 0)
      expect(fx.variant).toBeTruthy()
      expect(fx.intensity).toBeGreaterThan(0)
      expect(fx.intensity).toBeLessThanOrEqual(1)
    }
  })

  it('keeps the tint and the effect on one lookup, so they cannot disagree', () => {
    for (const f of ['Thunderstorms', 'Snow', 'Rain', 'Fog', 'Windy', 'Cloudy', 'Partly Sunny', 'Clear']) {
      const emoji = weatherEmoji(f)
      expect(conditionTint(emoji)).toBeDefined()
      expect(conditionFx(emoji, null, 0, 0).variant).toBeDefined()
    }
  })

  it('scales a precip-driven effect with the real percentage', () => {
    expect(precipIntensity(100)).toBeGreaterThan(precipIntensity(10))
    expect(precipIntensity(100)).toBeLessThanOrEqual(1)
  })

  it('treats an unknown precip percent as the floor, never as zero and never as fabricated data', () => {
    expect(precipIntensity(null)).toBe(FX_INTENSITY_MIN)
    expect(precipIntensity(0)).toBe(FX_INTENSITY_MIN)
    expect(precipIntensity(Number.NaN)).toBe(FX_INTENSITY_MIN)
  })

  it('clamps an out-of-range percent instead of trusting it', () => {
    expect(precipIntensity(500)).toBeLessThanOrEqual(1)
    expect(precipIntensity(-20)).toBeGreaterThanOrEqual(FX_INTENSITY_MIN)
  })

  it('ignores precip for a variant whose intensity is fixed', () => {
    const dry = conditionFx('☀️', 0, 0, 0)
    const wet = conditionFx('☀️', 100, 0, 0)
    expect(dry.intensity).toBe(wet.intensity)
  })

  it('decorrelates neighbouring tiles by seed', () => {
    expect(conditionFx('🌧', 50, 1000, 0).seed).not.toBe(conditionFx('🌧', 50, 1000, 3).seed)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/pages/weather-page.test.ts`
Expected: FAIL — `conditionFx` and `precipIntensity` are not exported.

- [ ] **Step 3: Replace `CONDITION_TINTS` with one combined table**

In `src/pages/weather-page.ts`, keep the existing doc comment's reasoning and extend it:

```ts
/**
 * One row per forecast condition, keyed by the SAME emoji the forecast
 * already picked (`weatherEmoji` in `sources/weather.ts`). The row carries
 * BOTH the dark background wash and the ambient effect, so the icon, the
 * tint, and the motion behind the numbers all come from a single lookup —
 * there is no second keyword list to drift apart from the first (lesson 21:
 * one decision, one function).
 *
 * Every `tint` stays dark, because the key's white text must stay crisp on
 * top of it. `intensity` is either the literal `'precip'`, meaning the
 * tile's real chance-of-rain drives the effect, or a fixed fraction for a
 * condition with no such reading.
 */
interface ConditionStyle {
  tint: Rgb
  fx: FxVariant
  intensity: 'precip' | number
}

const CONDITION_STYLES: Readonly<Record<string, ConditionStyle>> = {
  '⛈': { tint: [28, 24, 48], fx: 'storm', intensity: 'precip' }, // thunder: deep blue-violet
  '🌨': { tint: [26, 32, 40], fx: 'snow', intensity: 'precip' }, // snow, sleet, ice: dark slate
  '🌧': { tint: [18, 28, 44], fx: 'rain', intensity: 'precip' }, // rain, showers, drizzle: dark blue
  '🌫': { tint: [28, 28, 30], fx: 'fog', intensity: 0.7 }, // fog, haze, mist: flat dark grey
  '💨': { tint: [20, 26, 32], fx: 'wind', intensity: 0.7 }, // wind: dark cool grey-blue
  '☁️': { tint: [22, 24, 28], fx: 'cloud', intensity: 0.75 }, // cloudy, overcast: neutral dark
  '⛅': { tint: [28, 26, 24], fx: 'cloud', intensity: 0.4 }, // partly cloudy: slightly warm dark
  '☀️': { tint: [34, 27, 18], fx: 'sun', intensity: 0.8 }, // sunny, clear: warm dark amber-brown
}

/** Falls back to the cloudy row — the same default `weatherEmoji` itself uses. */
const DEFAULT_STYLE: ConditionStyle = CONDITION_STYLES['☁️']!

/** Looks up the background wash for `emoji`. Exported so a test can prove it
 * agrees with `weatherEmoji`'s own output for the same forecast string.
 * Unchanged in behaviour: the same eight tints, from the same eight keys. */
export function conditionTint(emoji: string): Rgb {
  return (CONDITION_STYLES[emoji] ?? DEFAULT_STYLE).tint
}

/**
 * Maps a real chance-of-rain percentage onto an effect intensity. A null or
 * non-finite reading is UNKNOWN, not zero (docs/AGENTS.md), so it takes the
 * floor rather than switching the effect off — an inert tile would read as a
 * broken page. A real 0 percent takes the same floor, which is honest: the
 * digits on the tile still say `0%`.
 */
export function precipIntensity(pct: number | null): number {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return FX_INTENSITY_MIN
  const frac = Math.min(100, Math.max(0, pct)) / 100
  return FX_INTENSITY_MIN + frac * (1 - FX_INTENSITY_MIN)
}

/** Builds the effect for one tile. `seed` decorrelates neighbouring tiles;
 * the key index is enough. */
export function conditionFx(
  emoji: string, precipPercent: number | null, nowMs: number, seed: number,
): FxSpec {
  const style = CONDITION_STYLES[emoji] ?? DEFAULT_STYLE
  const intensity = style.intensity === 'precip' ? precipIntensity(precipPercent) : style.intensity
  return { variant: style.fx, nowMs, intensity, seed }
}
```

Add the imports:

```ts
import type { DeckFrame, FxSpec, FxVariant, KeySpec, Rgb, StripSpec } from '../render/specs.js'
import { FX_INTENSITY_MIN } from '../render/canvas.js'
```

Delete the old `CONDITION_TINTS` and `DEFAULT_TINT`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/pages/weather-page.test.ts`
Expected: PASS, and the existing `conditionTint` agreement tests must still pass unchanged.

- [ ] **Step 5: Verify the tints did not change**

Run: `npx vitest run tests/pages/weather-page.test.ts -t 'tint'`
Expected: PASS. The eight tint values were copied verbatim, so no existing tint assertion may change.

- [ ] **Step 6: Commit**

```bash
git diff --cached --name-only
git commit -m "feat: map each forecast condition to an ambient effect" -- src/pages/weather-page.ts tests/pages/weather-page.test.ts
```

---

### Task 5: Attach the effect to the tiles, and stop it when the data is stale

**Files:**
- Modify: `src/pages/weather-page.ts`
- Test: `tests/pages/weather-page.test.ts`

**Interfaces:**
- Consumes: `conditionFx` from Task 4.
- Produces: `WeatherPage.render(now: number, nowMs?: number)` returning day tiles that carry `fx`, and a private `isDimmed()` used by both `render` and `tickMs`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('WeatherPage effect placement', () => {
  const FX_NOW_MS = 1786549560_000

  it('gives every populated day tile an effect', () => {
    const { page } = build()
    const keys = page.render(NOW, FX_NOW_MS).keys
    for (let i = 0; i < 7; i++) expect(keys[i]!.fx).toBeDefined()
  })

  it('gives each tile its own seed, so neighbours do not animate in lockstep', () => {
    const { page } = build()
    const keys = page.render(NOW, FX_NOW_MS).keys
    const seeds = new Set(keys.slice(0, 7).map((k) => k.fx!.seed))
    expect(seeds.size).toBe(7)
  })

  it('uses the injected clock, never the wall clock', () => {
    const { page } = build()
    expect(page.render(NOW, 5000).keys[0]!.fx!.nowMs).toBe(5000)
    // Absent nowMs, the seconds clock still gives a usable millisecond value.
    expect(page.render(NOW).keys[0]!.fx!.nowMs).toBe(NOW * 1000)
  })

  it('leaves the conditions tile with no effect, since it reports no condition', () => {
    const { page } = build()
    expect(page.render(NOW, FX_NOW_MS).keys[7]!.fx).toBeUndefined()
  })

  it('gives an absent day tile no effect, since a placeholder is not a condition', () => {
    const { page } = build({ days: [] })
    expect(page.render(NOW, FX_NOW_MS).keys[0]!.fx).toBeUndefined()
  })

  it('freezes every effect when the forecast is stale', () => {
    const { page } = build({ stale: true })
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys.every((k) => k.fx === undefined)).toBe(true)
  })

  it('freezes every effect when the status is not ok', () => {
    const { page } = build({ status: 'offline' })
    expect(page.render(NOW, FX_NOW_MS).keys.every((k) => k.fx === undefined)).toBe(true)
  })

  it('drives each tile from its OWN condition, not the first tile\'s', () => {
    const days = sevenDays()
    days[0] = day('NOW', { emoji: '🌧', precipPercent: 90 })
    days[1] = day('THU', { emoji: '☀️', precipPercent: 0 })
    const { page } = build({ days })
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys[0]!.fx!.variant).toBe('rain')
    expect(keys[1]!.fx!.variant).toBe('sun')
  })

  it('gives the detail view its own effects, one per period', () => {
    const days = sevenDays()
    days[0] = day('NOW', {
      emoji: '🌧',
      day: periodDetail({ emoji: '⛈', precipPercent: 80 }),
      night: periodDetail({ emoji: '🌨', precipPercent: 60 }),
    })
    const { page } = build({ days })
    page.onKeyPress(0)
    const keys = page.render(NOW, FX_NOW_MS).keys
    expect(keys[0]!.fx!.variant).toBe('rain')
    expect(keys[1]!.fx!.variant).toBe('storm')
    expect(keys[2]!.fx!.variant).toBe('snow')
    expect(keys[7]!.fx).toBeUndefined() // BACK
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/pages/weather-page.test.ts`
Expected: FAIL — `render` takes one argument and no key carries `fx`.

- [ ] **Step 3: Thread the clock and the effect through the page**

Extract the dimming decision so `render` and `tickMs` cannot disagree about it:

```ts
  /**
   * Whether the whole page must present as not-current: the forecast is
   * stale, the source is not ok, or no data has arrived. ONE function, read
   * by both `render` and `tickMs` — two callers reasoning about this
   * separately would diverge, which is lesson 21's "one decision, one
   * function".
   */
  private isDimmed(days: DayForecast[], status: WeatherStatus): boolean {
    return this.source.isStale() || status !== 'ok' || days.length === 0
  }
```

Rewrite `render`:

```ts
  render(now: number, nowMs?: number): DeckFrame {
    const days = this.source.getDays()
    const status = this.source.getStatus()
    const dim = this.isDimmed(days, status)
    // A page never reads the wall clock. The daemon injects both clocks, and
    // the seconds value is the documented fallback for the millisecond one.
    const ms = nowMs ?? now * 1000
    // A stale or absent forecast draws no effect at all. The tiles already
    // dim; now the motion stops too, which is a stronger signal than dimming
    // alone, and it keeps the page from animating data it does not have.
    const fxMs = dim ? null : ms

    const day = this.activeDay(days)
    if (day) return this.detailFrame(day, dim, fxMs)

    const keys: KeySpec[] = []
    for (let i = 0; i < DAY_TILE_COUNT; i++) {
      keys.push(this.dayKey(days[i], dim, fxMs, i))
    }
    keys.push(this.conditionsKey(dim))

    return {
      keys,
      strip: this.strip(),
      buttons: [theme.gray, theme.gray],
    }
  }
```

In `dayKey`, take the two new parameters and attach the effect. The absent-tile branch keeps no effect:

```ts
  private dayKey(
    day: DayForecast | undefined, dim: boolean, fxMs: number | null, seed: number,
  ): KeySpec {
    if (!day) {
      return {
        kind: 'gauge',
        lines: ['--', '--', '--'],
        lineSizes: [DAY_LABEL_SIZE, TEMP_SIZES, PRECIP_SIZE],
        lineY: [DAY_LABEL_Y, TEMP_Y, PRECIP_Y],
        align: 'center',
        bg: DEFAULT_STYLE.tint,
        dim: true,
        // No effect: a placeholder reports no condition, so there is nothing
        // for an effect to mean.
      }
    }
    // ... existing key construction, unchanged ...
    if (fxMs !== null) key.fx = conditionFx(day.emoji, day.precipPercent, fxMs, seed)
    if (dim) key.dim = true
    return key
  }
```

In `periodKey`, do the same from the period's own emoji and precip, with a distinct seed per period so the two halves do not animate in lockstep:

```ts
  private periodKey(
    label: string, period: PeriodDetail | null, dim: boolean, fxMs: number | null, seed: number,
  ): KeySpec {
    // ... existing construction ...
    if (period && fxMs !== null) key.fx = conditionFx(period.emoji, period.precipPercent, fxMs, seed)
    if (dim) key.dim = true
    return key
  }
```

Update `detailFrame(day, dim, fxMs)` to pass `fxMs` and a distinct seed to key 0 (`0`), the DAY period (`1`) and the NIGHT period (`2`). The wind, text, rain and BACK keys take no effect.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/pages/weather-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Break the fix and watch the tests fail**

1. Pass `ms` instead of `fxMs` to `dayKey` — the stale-freeze test must fail.
2. Pass a constant `0` seed for every tile — the distinct-seeds test must fail.
3. Attach `conditionFx(days[0]!.emoji, ...)` to every tile — the own-condition test must fail.

- [ ] **Step 6: Commit**

```bash
git diff --cached --name-only
git commit -m "feat: draw each weather tile's own condition effect, frozen when stale" -- src/pages/weather-page.ts tests/pages/weather-page.test.ts
```

---

### Task 6: Raise the render rate only while an effect shows

**Files:**
- Modify: `src/pages/weather-page.ts`
- Test: `tests/pages/tick-rate.test.ts`

**Interfaces:**
- Consumes: `isDimmed` from Task 5.
- Produces: `WeatherPage.tickMs` as a getter.

- [ ] **Step 1: Rewrite the failing test**

Replace the `WeatherPage declares no tickMs` case in `tests/pages/tick-rate.test.ts`. Update the file's header comment: weather now animates, so the invariant it guards changes from "never raises its rate" to "raises its rate only while an effect actually shows".

```ts
describe('WeatherPage tickMs: fast only while a condition effect shows', () => {
  function fakeReader(over: Partial<WeatherReader>): WeatherReader {
    return {
      getDays: () => [],
      getConditions: () => null,
      getStatus: () => 'ok',
      getLastUpdatedAt: () => 0,
      getPlace: () => 'x',
      isStale: () => false,
      setVisible: () => {},
      ...over,
    } as unknown as WeatherReader
  }

  const aDay = {
    label: 'NOW', id: 'NOW', emoji: '🌧', high: 80, low: 70,
    precipPercent: 60, shortForecast: 'Rain', day: null, night: null,
  } as unknown as DayForecast

  it('raises the rate while a fresh forecast is showing', () => {
    const page: Page = new WeatherPage(fakeReader({ getDays: () => [aDay] }))
    expect(page.tickMs).toBeDefined()
    expect(page.tickMs!).toBeLessThan(1000)
  })

  it('keeps the default 1000 ms tick when no data has arrived', () => {
    const page: Page = new WeatherPage(fakeReader({ getDays: () => [] }))
    expect(page.tickMs).toBeUndefined()
  })

  it('keeps the default 1000 ms tick when the forecast is stale, since the effects freeze', () => {
    const page: Page = new WeatherPage(fakeReader({ getDays: () => [aDay], isStale: () => true }))
    expect(page.tickMs).toBeUndefined()
  })

  it('keeps the default 1000 ms tick when the source is offline', () => {
    const page: Page = new WeatherPage(fakeReader({ getDays: () => [aDay], getStatus: () => 'offline' }))
    expect(page.tickMs).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pages/tick-rate.test.ts`
Expected: FAIL — `tickMs` is undefined for a fresh forecast.

- [ ] **Step 3: Add the getter**

```ts
/**
 * How often to render while a condition effect is showing. The same value
 * the Spotify idle animation uses (`IDLE_TICK_MS`), for the same reason: the
 * device's own render interval is the only throughput constraint, and eight
 * animated keys at this rate is about 80 key-writes per second against a
 * measured ceiling of 362 (docs/VERIFIED-FACTS.md).
 */
const FX_TICK_MS = 100
```

```ts
  /**
   * Raised only while an effect actually shows. A stale, offline, or empty
   * forecast freezes every effect (see `render`), so a faster clock would
   * buy nothing there — the same rule `SpotifyPage.tickMs` follows for its
   * idle animation. Reads `isDimmed`, the one function `render` uses too, so
   * the rate can never disagree with what the frame actually draws.
   */
  get tickMs(): number | undefined {
    const days = this.source.getDays()
    return this.isDimmed(days, this.source.getStatus()) ? undefined : FX_TICK_MS
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/pages/tick-rate.test.ts`
Expected: PASS.

- [ ] **Step 5: Break the fix and watch the test fail**

Return `FX_TICK_MS` unconditionally — the stale, offline and empty cases must fail.

- [ ] **Step 6: Commit**

```bash
git diff --cached --name-only
git commit -m "feat: raise the weather render rate only while an effect shows" -- src/pages/weather-page.ts tests/pages/tick-rate.test.ts
```

---

### Task 7: Keep the tile geometry proven, with the effects running

**Files:**
- Modify: `tests/pages/weather-page.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a `contentInkOnRow` test helper.

This is the task the spec calls out as the risky one. The existing proofs compare pixels against `key.bg`. An effect paints into the same rows, so those assertions would fail for the right reason and the wrong cause. Loosening or deleting them would leave the page's real geometry unproven, which is lesson 22's exact shape. Separate content ink from the layer beneath it instead.

- [ ] **Step 1: Add the helper**

```ts
/**
 * Whether row `y` carries any CONTENT ink — text, emoji, border or image —
 * between `x0` and `x1`, ignoring whatever the ambient effect painted
 * underneath.
 *
 * It renders the key twice: once as the page built it, and once with the
 * text and emoji removed but the SAME `fx`. The effect is a pure function of
 * its spec and was measured byte-identical across two renders
 * (docs/VERIFIED-FACTS.md), so every pixel that differs between the two
 * buffers is content, and nothing else is.
 *
 * This replaces comparing against `key.bg`, which stopped describing the
 * whole background once an effect could paint into the same rows. The
 * property under test never changed: content must stay inside its own band.
 */
function contentInkOnRow(key: KeySpec, y: number, x0 = 9, x1 = 90): boolean {
  const withContent = renderKey(key)
  const layerOnly = renderKey({ ...key, lines: undefined, lineColors: undefined, emoji: undefined })
  for (let x = x0; x < x1; x++) {
    if (!near3(probe(withContent, x, y), probe(layerOnly, x, y), 1)) return true
  }
  return false
}
```

- [ ] **Step 2: Convert the three existing pixel proofs**

Convert `keeps every band clear of the others, for %s`:

```ts
  it.each(ALL_CONDITION_EMOJI)('keeps every band clear of the others, for %s', (emoji) => {
    const days = sevenDays()
    days[0] = day('NOW', { emoji, high: 95, low: 77 })
    const { page } = build({ days })
    const key = page.render(NOW, FX_NOW_MS).keys[0]!
    expect(key.fx).toBeDefined() // the effect IS running for this proof
    expect(contentInkOnRow(key, 10)).toBe(true)
    expect(contentInkOnRow(key, 60)).toBe(true)
    expect(contentInkOnRow(key, 80)).toBe(true)
    expect(contentInkOnRow(key, 16)).toBe(false)
    expect(contentInkOnRow(key, 52)).toBe(false)
    expect(contentInkOnRow(key, 72)).toBe(false)
  })
```

Convert the empty-tile case the same way. That tile carries no effect, so the helper's diff is against a plain background and the proof is unchanged in substance.

Convert `keeps a below-freezing high/low pair within the usable key width` to probe the whole right margin for content ink instead of comparing to `key.bg`:

```ts
    for (let y = 0; y < KEY_SIZE; y++) {
      expect(contentInkOnRow(key, y, 90, KEY_SIZE)).toBe(false)
    }
```

The conditions-tile WIND proof needs no change: that key never carries an effect.

- [ ] **Step 3: Add the legibility proof the effects need**

```ts
it('keeps the text brighter than the effect behind it, for every condition', () => {
  // The cap in render/canvas.ts bounds the layer. This proves the result on
  // the REAL shipped tiles: the brightest effect pixel must stay clearly
  // below the text, or the numbers stop reading at a glance.
  for (const emoji of ALL_CONDITION_EMOJI) {
    const days = sevenDays()
    days[0] = day('NOW', { emoji, high: 95, low: 77, precipPercent: 100 })
    const { page } = build({ days })
    const key = page.render(NOW, FX_NOW_MS).keys[0]!
    const withContent = renderKey(key)
    const layerOnly = renderKey({ ...key, lines: undefined, lineColors: undefined, emoji: undefined })
    const lum = (p: readonly number[]) => p[0]! + p[1]! + p[2]!
    let brightestLayer = 0
    let brightestText = 0
    for (let y = 0; y < KEY_SIZE; y++) {
      for (let x = 0; x < KEY_SIZE; x++) {
        brightestLayer = Math.max(brightestLayer, lum(probe(layerOnly, x, y)))
        if (!near3(probe(withContent, x, y), probe(layerOnly, x, y), 1)) {
          brightestText = Math.max(brightestText, lum(probe(withContent, x, y)))
        }
      }
    }
    expect(brightestText).toBeGreaterThan(brightestLayer * 1.5)
  }
})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/pages/weather-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Break the fix and watch the tests fail**

1. Set `TEMP_Y` to 40 in the page, inside the emoji band — the band-clearance test must fail. This is the proof that the conversion kept its teeth.
2. Set `FX_MAX_ALPHA` to 1 — the legibility test must fail.
3. Set `TEMP_SIZES` to a fixed `[16]` — the below-freezing margin test must fail.

- [ ] **Step 6: Commit**

```bash
git diff --cached --name-only
git commit -m "test: prove weather tile geometry by content-ink diff, with effects running" -- tests/pages/weather-page.test.ts
```

---

### Task 8: Sibling sweep, full validation, and a visual preview

**Files:**
- Create: `scripts/fx-contact-sheet.ts`
- Modify: `docs/VERIFIED-FACTS.md`, `docs/PROJECT-STATE.md`

The user can see the device and no agent can, so a visual judgement needs a rendered preview sent to them (`docs/PROJECT-STATE.md`, working agreements). This is also the sibling sweep, per lesson 21: fixing one page means checking its siblings for the same hole before finishing.

- [ ] **Step 1: Run the sibling sweep**

Check and record the answer to each:
1. Does any other page set `bg` and assume the wash is the last thing drawn beneath its content? Grep for `bg:` across `src/pages/`. `fx` is opt-in, so no other page can be affected — confirm that by running the full suite, which contains those pages' own pixel proofs.
2. Does any page reuse a `KeySpec` object across frames? A per-frame `nowMs` would make that visible as a frozen effect. Grep for cached specs in `src/pages/`.
3. Do the football and Spotify pages, which both carry images, still render identically? Their tests are the proof.
4. Is `fx` handled everywhere `idle` is? Grep for `idle` in `src/render/canvas.ts`, `src/render/specs.ts` and `src/daemon.ts`, and confirm `fx` appears in each place that needs it — the sanitizer, `renderKey`, and `keyHash`.

- [ ] **Step 2: Write the contact-sheet script**

`scripts/fx-contact-sheet.ts` renders every condition tile at several instants into one PNG, so the user can judge the look without the device. Follow `scripts/crab-contact-sheet.ts` for the existing pattern, and resolve the output path by walking up for a landmark, never from `process.cwd()` (lessons 2 and 3).

The sheet has one row per condition emoji and one column per instant (0 ms, 400 ms, 900 ms, 1800 ms, 3600 ms), rendering the real `WeatherPage` output through the real `renderKey`.

- [ ] **Step 3: Run the required validation**

```bash
npm test
npm run typecheck
npm run build
/bin/sh -n src/install/statusline-wrapper.sh
git diff --check
```

Every one must pass before going further. Report the real output; a failure is a stop, not a note.

- [ ] **Step 4: Render the sheet and send it to the user**

```bash
npm run build && node dist/scripts/fx-contact-sheet.js
```

Send the PNG to the user and ask whether the look is right before deploying. A visual judgement is theirs, not the agent's.

- [ ] **Step 5: Record the measurements and the new invariants**

In `docs/VERIFIED-FACTS.md`, add the five compositing measurements from this plan's "Measured facts" section, with the date and the library version.

In `docs/PROJECT-STATE.md`, add to the new-invariants list:
- `KeySpec.fx` is opt-in per key. Absent, the render path is byte-identical.
- The alpha cap is applied once, at the composite in `drawFx`. A variant cannot exceed it.
- `WeatherPage` freezes every effect when the forecast is stale, absent, or offline, and `tickMs` follows the same one `isDimmed` decision.
- The weather tile geometry proofs now assert content ink by diffing two renders. Do not revert them to comparing against `key.bg`; that comparison cannot describe a key with an effect.

- [ ] **Step 6: Commit**

```bash
git diff --cached --name-only
git commit -m "docs: record the fx compositing measurements and invariants" -- docs/VERIFIED-FACTS.md docs/PROJECT-STATE.md scripts/fx-contact-sheet.ts
```

---

### Task 9: Deploy and verify on the real device

**Files:** none.

Follow `docs/DEPLOYMENT.md` exactly. The daemon owns the device, so never open it concurrently.

- [ ] **Step 1: Confirm the tree is clean and reviewed**

```bash
git status --short
```

Expected: clean. Do not deploy an unreviewed working tree.

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Find the exact running process**

```bash
pgrep -fl '/Users/you/Vibecoding/streamdeckneoclaude/dist/bin/deckd.js start'
```

- [ ] **Step 4: Stop only that PID and let launchd restart it**

```bash
kill <PID>
```

Wait about three seconds. Never use a broad process pattern when an exact PID is available.

- [ ] **Step 5: Confirm a new PID and a clean log**

```bash
pgrep -fl '/Users/you/Vibecoding/streamdeckneoclaude/dist/bin/deckd.js start'
tail -n 40 ~/.local/state/deckd/deckd.log
```

Expected: a new PID, plus `deckd starting` and `connected to Stream Deck Neo`. Investigate any new warning or error before calling the deployment complete.

- [ ] **Step 6: Ask the user for the physical check**

Only the user can see the deck. Ask them to:
1. Open the weather page and confirm each tile animates according to its own condition.
2. Confirm every number and label stays crisp and readable over the motion.
3. Press a day tile and confirm the detail view animates too, and that BACK still works.
4. Confirm the white press ring is still visible against the moving background.

Record the measured outcome in `docs/PROJECT-STATE.md`. A hardware behaviour is not verified until the user reports it.

---

## Self-Review

**Spec coverage:** The renderer field is Task 1. Legibility enforcement is Tasks 1 and 7. The condition mapping table is Task 4. Which keys animate is Task 5. Staleness freezing is Task 5. The render rate is Task 6. Determinism is Tasks 1, 2 and 3. The test conversion is Task 7. The sibling sweep, docs and preview are Task 8. Deployment is Task 9. All eight numbered test requirements in the spec appear: the content-ink proofs (7), the alpha cap (1, 2, 3), text brighter than the layer (7), loop geometry (1, 2, 3), `keyHash` (1), byte-identical without `fx` (1), every emoji mapped from the real classifier (4), and stale omission with `tickMs` undefined (5, 6).

**Placeholders:** One deliberate marker exists — the `index0(i)` token in Task 2, Step 3, which Step 3 itself instructs the implementer to replace with `i`. It is called out rather than left silent because the seed expression must match `fxSnowFlakeY` exactly.

**Type consistency:** `FxSpec` and `FxVariant` are defined in Task 1 and used unchanged in Tasks 3, 4 and 5. `FX_MAX_ALPHA` and `FX_INTENSITY_MIN` are exported in Task 1 and imported by the page in Task 4 and the tests in Tasks 1, 2, 3 and 7. `conditionFx`, `precipIntensity` and `conditionTint` keep the same signatures from Task 4 through Task 5. `isDimmed(days, status)` is introduced in Task 5 and read by `tickMs` in Task 6 with the same two arguments. `dayKey(day, dim, fxMs, seed)` and `periodKey(label, period, dim, fxMs, seed)` are consistent between Task 5's definition and its `detailFrame` call sites.
