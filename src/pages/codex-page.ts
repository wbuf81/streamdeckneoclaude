import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
import { barColor, theme } from '../render/theme.js'
import { formatDuration, truncate } from '../render/text.js'
import type { CodexLimit, CodexSnapshot } from '../sources/codex.js'
import type { Page, PressOutcome } from './types.js'

const TASK_SLOTS = 3
/** Measured limit for one strip line, same constant every other page uses.
 * See `render/canvas.ts`. The strip has no measuring or shrink-to-fit of its
 * own — unlike a key's `lineSizes` array, `renderStrip` always draws at a
 * fixed 13 px — so the PAGE must stay inside this budget itself. */
const STRIP_CHARS = 30
/**
 * Candidate sizes for the task tile's project, title, and model lines,
 * largest first. All three are private-schema, unbounded-length strings —
 * `cwd`'s basename, Codex's own thread title, and its model identifier — so
 * none of them may be sized with a fixed number the page just assumes fits
 * (that was the review's I5/I7: `truncate(project, 11)` at 13 px measured
 * 86.1 px against the key's 81 px usable width, and `task.model` was never
 * truncated at all — a real 17-character model name measured 102.3 px).
 * Each line instead declares intent and lets `renderKey` measure with the
 * real canvas and shrink as far as `shrinkToFit`'s ellipsis needs to, per
 * `KeySpec.lineSizes`'s doc comment — the same tool `planKey` below already
 * uses. The three arrays are deliberately different (by VALUE, not just by
 * variable name), because `resolveLineSpecs` groups consecutive lines that
 * pass an IDENTICAL candidate array into one shared size — grouping the
 * project with the title would force a short project name down to whatever
 * size the much longer title needs.
 */
const PROJECT_SIZES = [13, 11]
const TITLE_SIZES = [11, 10]
const MODEL_SIZES = [10, 9]
/** Candidate sizes for the limit percentage and token-count value lines. */
const PERCENT_SIZES = [28, 24, 20, 16]
const TOKENS_SIZES = [24, 20, 16]
/** Candidate sizes for the reset countdown value line. `ELAPSED` (7 chars)
 * measures 101.1 px at 24 px and 67.4 px at 16 px, against the 81 px usable
 * width — so 24 alone, the old fixed size, would have clipped it. */
const RESET_SIZES = [24, 20, 16, 11]

export interface CodexReader {
  getSnapshot(): CodexSnapshot
  isAvailable(): boolean
  /** True when the last successful sqlite read is too old. */
  isStale(): boolean
  /** True when the newest usage SAMPLE no longer describes the CURRENT
   * rate-limit window, or there is no sample yet — independent of
   * `isStale()`. The figure it carries is not merely old; it is unknowable,
   * so a caller must render an explicit unknown, never a dimmed but wrong
   * number. See `CodexSource.isUsageUnknown`. */
  isUsageUnknown(): boolean
  setVisible(visible: boolean): void
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`
  return String(Math.max(0, Math.floor(tokens)))
}

export function limitLabel(minutes: number): string {
  if (minutes === 300) return '5-HR CAP'
  if (minutes === 10080) return 'WEEK CAP'
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440}-DAY CAP`
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}-HR CAP`
  return 'USAGE CAP'
}

/** The reset countdown's value line. `null` means the reset time itself is
 * unknown — absent, or outside `CodexSource`'s own sane range — and renders
 * `--`, never a fabricated countdown. An elapsed time (at or before `now`)
 * renders `ELAPSED` instead of `formatDuration`'s `0m`, which would
 * otherwise repeat forever for a window Codex never advances past its own
 * deadline. */
export function formatResetIn(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '--'
  const remaining = resetsAt - now
  return remaining <= 0 ? 'ELAPSED' : formatDuration(remaining)
}

export class CodexPage implements Page {
  readonly name = 'codex'

  constructor(private readonly source: CodexReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.source.setVisible(false)
  }

  render(now: number): DeckFrame {
    const snapshot = this.source.getSnapshot()
    const available = this.source.isAvailable()
    const readStale = this.source.isStale()
    // Accounting tiles (the limits, the token count, the reset countdown) can
    // be wrong for two DIFFERENT reasons, and each renders differently:
    //  - `readStale`: the sqlite READ itself is lagging. The numbers are
    //    probably still true, so they show dimmed with a STALE label.
    //  - `usageUnknown`: the usage SAMPLE no longer describes the current
    //    rate-limit window (C2). The true figure is unknowable, so these
    //    render an explicit `--` instead — a dimmed but wrong number still
    //    reads as data, the same rule commit 185bcb4 set for schema drift.
    const usageUnknown = this.source.isUsageUnknown()
    // Task tiles carry the retained snapshot from before a failure (lesson
    // 20's "preserve the last safe state"), so they need the SAME dim
    // treatment the accounting tiles already had, or a schema-drift or quit
    // failure leaves `RUNNING` on the glass indefinitely — I3.
    const taskDim = !available || readStale
    const keys: KeySpec[] = []

    for (let i = 0; i < TASK_SLOTS; i++) {
      const task = snapshot.tasks[i]
      keys.push(task ? {
        kind: 'session',
        lines: ['RUNNING', task.project, task.title, task.model],
        lineSizes: [11, PROJECT_SIZES, TITLE_SIZES, MODEL_SIZES],
        border: theme.green,
        dim: taskDim,
      } : { kind: 'blank' })
    }

    keys.push({
      kind: 'session',
      lines: ['OPENAI', 'CODEX', `${snapshot.tasks.length} ACTIVE`],
      lineSizes: [11, 22, 11],
      lineColors: [theme.textDim, theme.green, theme.textDim],
      align: 'center',
      border: theme.green,
      dim: taskDim,
    })

    const limits = snapshot.usage?.limits ?? []
    keys.push(this.limitKey(limits[0], usageUnknown, readStale))
    keys.push(limits[1]
      ? this.limitKey(limits[1], usageUnknown, readStale)
      : this.planKey(snapshot.usage?.plan ?? '', usageUnknown || readStale))
    keys.push(this.tokensKey(snapshot.usage?.totalTokens ?? null, usageUnknown, readStale))
    keys.push(this.resetKey(limits[0], now, usageUnknown, readStale))

    return {
      keys,
      strip: this.strip(snapshot),
      buttons: [theme.gray, theme.gray],
    }
  }

  private limitKey(limit: CodexLimit | undefined, unknown: boolean, readStale: boolean): KeySpec {
    if (!limit) {
      return {
        kind: 'gauge', lines: ['USAGE CAP', '--'], lineSizes: [11, 28],
        align: 'center', dim: true,
      }
    }
    const label = limitLabel(limit.windowMinutes)
    if (limit.usedPct === null || unknown) {
      // Either the percentage field itself is absent or renamed (C1), or the
      // sample no longer describes the current window (C2) — both leave the
      // true figure unknowable, so both render the same explicit `--`, never
      // a measured (or stale-but-dimmed) percentage with a confident bar.
      return {
        kind: 'gauge', lines: [label, '--'], lineSizes: [11, 28],
        align: 'center', dim: true,
      }
    }
    // Clamped for DISPLAY only, so an out-of-range accounting value (a
    // schema surprise, not a real percentage) cannot draw past the key —
    // `1234%` measured 84 px at a fixed 28 px against the 81 px budget. The
    // bar's own fill fraction clamps separately in `drawBar`.
    const pct = Math.min(999, Math.max(0, Math.floor(limit.usedPct)))
    const value = `${pct}%`
    if (readStale) {
      return {
        kind: 'gauge', lines: [label, value, 'STALE'],
        lineSizes: [11, PERCENT_SIZES, 11], align: 'center', dim: true,
      }
    }
    return {
      kind: 'gauge', lines: [label, value],
      lineSizes: [11, PERCENT_SIZES], align: 'center',
      bar: { value: limit.usedPct / 100, color: barColor(limit.usedPct / 100) },
    }
  }

  private planKey(plan: string, stale: boolean): KeySpec {
    return {
      kind: 'gauge',
      lines: ['PLAN', plan ? plan.toUpperCase() : '--', stale ? 'STALE' : ''],
      lineSizes: [11, [20, 16, 13], 11],
      align: 'center',
      dim: !plan || stale,
    }
  }

  private tokensKey(tokens: number | null, unknown: boolean, readStale: boolean): KeySpec {
    if (tokens === null || unknown) {
      // Same rule as `limitKey`: an unknowable figure renders `--` outright,
      // never the last known count dimmed under a STALE label.
      return {
        kind: 'gauge',
        lines: ['TASK TOKENS', '--'],
        lineSizes: [11, TOKENS_SIZES],
        align: 'center',
        dim: true,
      }
    }
    return {
      kind: 'gauge',
      lines: ['TASK TOKENS', formatTokenCount(tokens), readStale ? 'STALE' : ''],
      lineSizes: [11, TOKENS_SIZES, 11],
      align: 'center',
      dim: readStale,
    }
  }

  private resetKey(limit: CodexLimit | undefined, now: number, unknown: boolean, readStale: boolean): KeySpec {
    let value = formatResetIn(limit?.resetsAt ?? null, now)
    // `unknown` covers two shapes: the countdown already reads `ELAPSED` (an
    // honest signal on its own, so it stays), or `resetsAt` describes a
    // window that — from `now`'s own perspective — has not started yet. That
    // second shape is a REAL but WRONG countdown, and must not render as if
    // it were current data.
    if (unknown && value !== '--' && value !== 'ELAPSED') value = '--'
    return {
      kind: 'gauge',
      lines: ['RESETS IN', value, readStale && !unknown ? 'STALE' : ''],
      lineSizes: [11, RESET_SIZES, 11],
      align: 'center',
      dim: !limit || unknown || readStale,
    }
  }

  private strip(snapshot: CodexSnapshot): StripSpec {
    if (!this.source.isAvailable()) return { lines: ['codex', 'task data unavailable'], dim: true }
    if (snapshot.tasks.length === 0) return { lines: ['codex', 'no active tasks'], dim: true }
    const first = snapshot.tasks[0]!
    const overflow = Math.max(0, snapshot.tasks.length - TASK_SLOTS)
    return {
      lines: [
        truncate(`${first.project} · ${first.title}`, STRIP_CHARS),
        overflow ? `+${overflow} more` : `${snapshot.tasks.length} active`,
      ],
    }
  }

  onKeyPress(_index: number): PressOutcome {
    // Codex does not currently expose a stable local URL or CLI command for
    // focusing a task by thread id. Tiles remain intentionally read-only, so
    // every key, 0 to 7, ignores a press.
    return 'ignored'
  }
}
