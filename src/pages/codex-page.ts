import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
import { barColor, theme } from '../render/theme.js'
import { formatDuration, truncate } from '../render/text.js'
import type { CodexLimit, CodexSnapshot } from '../sources/codex.js'
import type { Page } from './types.js'

const TASK_SLOTS = 3

export interface CodexReader {
  getSnapshot(): CodexSnapshot
  isAvailable(): boolean
  isStale(): boolean
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

export class CodexPage implements Page {
  readonly name = 'codex'

  constructor(private readonly source: CodexReader) {}

  render(now: number): DeckFrame {
    const snapshot = this.source.getSnapshot()
    const stale = this.source.isStale()
    const keys: KeySpec[] = []

    for (let i = 0; i < TASK_SLOTS; i++) {
      const task = snapshot.tasks[i]
      keys.push(task ? {
        kind: 'session',
        lines: ['RUNNING', truncate(task.project, 11), truncate(task.title, 14), task.model],
        lineSizes: [11, 13, 11, 10],
        border: theme.green,
      } : { kind: 'blank' })
    }

    keys.push({
      kind: 'session',
      lines: ['OPENAI', 'CODEX', `${snapshot.tasks.length} ACTIVE`],
      lineSizes: [11, 22, 11],
      lineColors: [theme.textDim, theme.green, theme.textDim],
      align: 'center',
      border: theme.green,
      dim: !this.source.isAvailable(),
    })

    const limits = snapshot.usage?.limits ?? []
    keys.push(this.limitKey(limits[0], stale))
    keys.push(limits[1]
      ? this.limitKey(limits[1], stale)
      : this.planKey(snapshot.usage?.plan ?? '', stale))
    keys.push(this.tokensKey(snapshot.usage?.totalTokens ?? 0, !snapshot.usage, stale))
    keys.push(this.resetKey(limits[0], now, stale))

    return {
      keys,
      strip: this.strip(snapshot),
      buttons: [theme.gray, theme.gray],
    }
  }

  private limitKey(limit: CodexLimit | undefined, stale: boolean): KeySpec {
    if (!limit) {
      return {
        kind: 'gauge', lines: ['USAGE CAP', '--'], lineSizes: [11, 28],
        align: 'center', dim: true,
      }
    }
    const value = `${Math.floor(limit.usedPct)}%`
    if (stale) {
      return {
        kind: 'gauge', lines: [limitLabel(limit.windowMinutes), value, 'STALE'],
        lineSizes: [11, 28, 11], align: 'center', dim: true,
      }
    }
    return {
      kind: 'gauge', lines: [limitLabel(limit.windowMinutes), value],
      lineSizes: [11, 28], align: 'center',
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

  private tokensKey(tokens: number, missing: boolean, stale: boolean): KeySpec {
    return {
      kind: 'gauge',
      lines: ['TASK TOKENS', missing ? '--' : formatTokenCount(tokens), stale ? 'STALE' : ''],
      lineSizes: [11, 24, 11],
      align: 'center',
      dim: missing || stale,
    }
  }

  private resetKey(limit: CodexLimit | undefined, now: number, stale: boolean): KeySpec {
    return {
      kind: 'gauge',
      lines: ['RESETS IN', limit?.resetsAt ? formatDuration(limit.resetsAt - now) : '--', stale ? 'STALE' : ''],
      lineSizes: [11, 24, 11],
      align: 'center',
      dim: !limit || stale,
    }
  }

  private strip(snapshot: CodexSnapshot): StripSpec {
    if (!this.source.isAvailable()) return { lines: ['codex', 'task data unavailable'], dim: true }
    if (snapshot.tasks.length === 0) return { lines: ['codex', 'no active tasks'], dim: true }
    const first = snapshot.tasks[0]!
    const overflow = Math.max(0, snapshot.tasks.length - TASK_SLOTS)
    return {
      lines: [truncate(`${first.project} · ${first.title}`, 48), overflow ? `+${overflow} more` : `${snapshot.tasks.length} active`],
    }
  }

  onKeyPress(): void {
    // Codex does not currently expose a stable local URL or CLI command for
    // focusing a task by thread id. Tiles remain intentionally read-only.
  }
}
