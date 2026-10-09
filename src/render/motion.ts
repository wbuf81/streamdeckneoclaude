/**
 * The clocks of the glow-up primitives, and the pure helpers pages call to
 * build them. Nothing here touches a canvas, so `specs.ts` (and therefore
 * `keyHash`) can use it, and pages can import it without breaking purity.
 *
 * The cost rule (docs/VERIFIED-FACTS.md, "The daemon's cost is USB WRITES"):
 * the daemon rewrites a key whenever its `keyHash` changes, and the device
 * takes about 362 key-writes a second in total. So every clock a spec
 * carries is reduced HERE to the coarsest value that still animates
 * smoothly, and `keyHash` and `renderKey` both read the reduced value.
 * Equal hashes therefore always mean equal pixels, and a finished effect
 * costs nothing — by construction, not by each page remembering to remove
 * it (lesson 21: prefer impossible to unreachable).
 */
import type {
  EdgeProgressSpec,
  EdgeRun,
  KeySpec,
  OneShotSpec,
  OneShotVariant,
  Rgb,
  StripSpec,
} from './specs.js'

/** How long each one-shot effect runs, in ms. After this it draws nothing
 * and drops out of the hash. */
export const ONE_SHOT_DURATION_MS: Readonly<Record<OneShotVariant, number>> = {
  burst: 1500,
  brick: 1000,
  sweep: 500,
  hearts: 1500,
}

/** How long a line or banner scale-pop runs, in ms. */
export const LINE_POP_DURATION_MS = 1000

/** A running one-shot's clock resolution. 40 ms is the fastest page tick,
 * so a running effect animates at the page's own rate and no faster. */
export const ONE_SHOT_QUANTUM_MS = 40

/** The mascot and icon clock resolution: at most 10 rewrites a second. */
export const MASCOT_QUANTUM_MS = 100
export const ICON_QUANTUM_MS = 100

/** Edge-progress fractions snap to this many steps per edge: half a pixel on
 * a 96 px key. */
export const EDGE_STEPS = 192

/** `breathe` changes its output at most once per this many ms. */
export const BREATHE_QUANTUM_MS = 100

function finite(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

function quantise(ms: number, step: number): number {
  return Math.floor(ms / step) * step
}

/**
 * Elapsed time of a one-shot clock, quantised to `ONE_SHOT_QUANTUM_MS`, or
 * `null` when it has not started, has finished, or either clock is not a
 * finite number. The one decision both the hash and the renderer use.
 */
export function oneShotElapsed(
  startedAtMs: number, nowMs: number, durationMs: number,
): number | null {
  if (typeof startedAtMs !== 'number' || typeof nowMs !== 'number') return null
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return null
  const elapsed = nowMs - startedAtMs
  if (!(elapsed >= 0) || elapsed >= durationMs) return null
  return quantise(elapsed, ONE_SHOT_QUANTUM_MS)
}

/**
 * The scale of a popping line at `elapsedMs`: a damped bounce from 1.45 back
 * to 1, the mockup's `1 + .45 * exp(-4t) * |cos(9t)|`. Exactly 1 outside the
 * pop's duration.
 */
export function linePopScale(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= LINE_POP_DURATION_MS) return 1
  const t = elapsedMs / 1000
  // Faded to exactly 1 at the end, so the last frame matches the resting one.
  const tail = 1 - elapsedMs / LINE_POP_DURATION_MS
  return 1 + 0.45 * Math.exp(-t * 4) * Math.abs(Math.cos(t * 9)) * Math.min(1, tail * 4)
}

function canonicalEffects(effects: readonly OneShotSpec[]): OneShotSpec[] {
  const out: OneShotSpec[] = []
  for (const fx of effects) {
    if (!fx || typeof fx !== 'object') continue
    const duration = ONE_SHOT_DURATION_MS[fx.variant]
    if (duration === undefined) continue
    const elapsed = oneShotElapsed(fx.startedAtMs, fx.nowMs, duration)
    if (elapsed === null) continue
    out.push({ ...fx, startedAtMs: 0, nowMs: elapsed })
  }
  return out
}

function snapEdge(n: number): number {
  const v = Math.min(1, Math.max(0, finite(n, 0)))
  return Math.round(v * EDGE_STEPS) / EDGE_STEPS
}

function canonicalEdges(spec: EdgeProgressSpec): EdgeProgressSpec | undefined {
  if (!spec || !Array.isArray(spec.runs)) return undefined
  const runs: EdgeRun[] = []
  for (const run of spec.runs) {
    if (!run || !['top', 'right', 'bottom', 'left'].includes(run.edge)) continue
    const from = snapEdge(run.from)
    const to = snapEdge(run.to)
    if (to <= from) continue
    runs.push({ edge: run.edge, from, to })
  }
  if (runs.length === 0) return undefined
  return spec.color ? { runs, color: spec.color } : { runs }
}

/**
 * The form of a key spec that both `keyHash` and `renderKey` read.
 *
 * - Every one-shot (`effects`, `linePop`) that is not running is removed;
 *   a running one is rebased to `startedAtMs: 0, nowMs: <elapsed>`, with
 *   the elapsed time quantised to `ONE_SHOT_QUANTUM_MS`.
 * - `mascot.nowMs` and `icon.nowMs` are quantised to 100 ms.
 * - `edgeProgress` fractions snap to half a pixel; empty runs drop out.
 *
 * Returns a shallow copy; the caller's spec is never mutated.
 */
export function canonicalKeySpec(spec: KeySpec): KeySpec {
  const out: KeySpec = { ...spec }
  if (out.effects !== undefined) {
    const effects = Array.isArray(out.effects) ? canonicalEffects(out.effects) : []
    if (effects.length > 0) out.effects = effects
    else delete out.effects
  }
  if (out.linePop !== undefined) {
    const pop = out.linePop
    const elapsed = pop ? oneShotElapsed(pop.startedAtMs, pop.nowMs, LINE_POP_DURATION_MS) : null
    if (elapsed === null || !pop) delete out.linePop
    else out.linePop = { line: pop.line, startedAtMs: 0, nowMs: elapsed }
  }
  if (out.mascot) {
    out.mascot = { ...out.mascot, nowMs: quantise(finite(out.mascot.nowMs, 0), MASCOT_QUANTUM_MS) }
  }
  if (out.icon && out.icon.nowMs !== undefined) {
    out.icon = { ...out.icon, nowMs: quantise(finite(out.icon.nowMs, 0), ICON_QUANTUM_MS) }
  }
  if (out.edgeProgress !== undefined) {
    const edges = canonicalEdges(out.edgeProgress)
    if (edges) out.edgeProgress = edges
    else delete out.edgeProgress
  }
  return out
}

/** The strip's equivalent of `canonicalKeySpec`: a finished banner pop drops
 * out, a running one rebases, and the sprite's x rounds to a whole pixel. */
export function canonicalStripSpec(spec: StripSpec): StripSpec {
  const out: StripSpec = { ...spec }
  if (out.banner?.pop) {
    const { pop, ...rest } = out.banner
    const elapsed = oneShotElapsed(pop.startedAtMs, pop.nowMs, LINE_POP_DURATION_MS)
    out.banner = elapsed === null ? rest : { ...rest, pop: { startedAtMs: 0, nowMs: elapsed } }
  }
  if (out.sprite) {
    out.sprite = { ...out.sprite, x: Math.round(finite(out.sprite.x, 0)) }
  }
  return out
}

/**
 * A colour dimmed on a slow breathing cycle, for a touch button.
 *
 * At the top of the cycle it returns `color` unchanged; at the bottom it is
 * `color * (1 - depth)`. The clock is quantised to `BREATHE_QUANTUM_MS`, so
 * the result changes at most 10 times a second however fast the page
 * ticks. `periodMs` is floored at 200 ms; `depth` clamps to 0..1; a
 * non-finite clock reads as 0.
 */
export function breathe(color: Rgb, nowMs: number, periodMs: number, depth: number): Rgb {
  const period = Math.max(200, finite(periodMs, 2000))
  const d = Math.min(1, Math.max(0, finite(depth, 0)))
  const t = quantise(finite(nowMs, 0), BREATHE_QUANTUM_MS)
  const phase = (((t % period) + period) % period) / period
  const level = 1 - d * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI))
  return [
    Math.round(finite(color[0], 0) * level),
    Math.round(finite(color[1], 0) * level),
    Math.round(finite(color[2], 0) * level),
  ]
}

/**
 * Splits one progress fraction across the outer edge of a block of keys.
 *
 * The line starts at the block's top-left corner and runs CLOCKWISE: along
 * the top row left to right, down the right column, along the bottom row
 * right to left, and up the left column. Each key edge counts as one equal
 * unit, so the perimeter is `2 * (cols + rows)` units.
 *
 * Returns `cells[row][col]`: the `edgeProgress` for that key, or `undefined`
 * when none of its edges is lit. Interior keys are always `undefined`. A key
 * on a corner can carry two runs. The page maps (row, col) to its own key
 * index — for the Spotify art block, `[[0, 1, 2], [4, 5, 6]]`.
 *
 * `fraction` clamps to 0..1; non-finite reads as 0.
 */
export function blockPerimeterProgress(
  cols: number, rows: number, fraction: number, color?: Rgb,
): (EdgeProgressSpec | undefined)[][] {
  const c = Math.max(1, Math.floor(finite(cols, 1)))
  const r = Math.max(1, Math.floor(finite(rows, 1)))
  const total = 2 * (c + r)
  const lit = Math.min(1, Math.max(0, finite(fraction, 0))) * total

  const runs: EdgeRun[][][] = Array.from({ length: r }, () => Array.from({ length: c }, () => []))
  // Each unit: which cell, which edge, and where along the perimeter it starts.
  const units: { row: number; col: number; edge: EdgeRun['edge'] }[] = []
  for (let k = 0; k < c; k++) units.push({ row: 0, col: k, edge: 'top' })
  for (let k = 0; k < r; k++) units.push({ row: k, col: c - 1, edge: 'right' })
  for (let k = 0; k < c; k++) units.push({ row: r - 1, col: c - 1 - k, edge: 'bottom' })
  for (let k = 0; k < r; k++) units.push({ row: r - 1 - k, col: 0, edge: 'left' })

  units.forEach((u, start) => {
    const amount = Math.min(1, Math.max(0, lit - start))
    if (amount <= 0) return
    runs[u.row]![u.col]!.push({ edge: u.edge, from: 0, to: amount })
  })

  return runs.map((row) =>
    row.map((cellRuns) => {
      if (cellRuns.length === 0) return undefined
      return color ? { runs: cellRuns, color } : { runs: cellRuns }
    }),
  )
}
