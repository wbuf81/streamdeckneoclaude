import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
import { barColor, theme } from '../render/theme.js'
import { formatDuration, formatEasternTime, truncate } from '../render/text.js'
import type { CodexLimit, CodexSnapshot, CodexUsage } from '../sources/codex.js'
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
/** Candidate sizes for the limit tile's label line (`5-HR CAP`, `WEEK CAP`,
 * or a derived `N-HR CAP` / `N-DAY CAP` from `limitLabel`). The old code drew
 * this at a bare fixed `11`, never measured — I4/I6's exact repro: a
 * schema-drift `window_minutes` (the same value read as milliseconds)
 * produced `420000-DAY CAP`, measured 92.7 px against the key's 81 px
 * budget, overrunning the edge, because a plain number in `lineSizes` skips
 * `resolveLineSpecs`'s measurement entirely. `codex.ts`'s `WINDOW_MAX_MINUTES`
 * now bounds that input, but this line is measured regardless — the same
 * defence every other schema-drift-exposed line on this tile already has. */
const LABEL_SIZES = [11, 10, 9, 8]
/** Candidate sizes for the reset countdown value line. `ELAPSED` (7 chars)
 * measures 101.1 px at 24 px and 67.4 px at 16 px, against the 81 px usable
 * width — so 24 alone, the old fixed size, would have clipped it. */
const RESET_SIZES = [24, 20, 16, 11]
/** Candidate sizes for a task tile's I3 stale-age line (`STALE`, or
 * `STALE 11m` / `STALE 3d2h` once `formatDuration` adds an age). Measured
 * rather than assumed (lesson 17) — a candidate array, not a bare number,
 * so a future genuinely-degraded spell lasting DAYS (`formatDuration`'s
 * widest form, `999d23h`) still shrinks to fit instead of overrunning the
 * key. */
const STALE_AGE_SIZES = [11, 10, 9, 8]

export interface CodexReader {
  getSnapshot(): CodexSnapshot
  isAvailable(): boolean
  /** True when the last successful, primary sqlite read is too old, OR the
   * most recent read used the `immutable=1` fallback rather than the
   * primary `mode=ro` open. That second case (see `CodexSource.isDegraded`)
   * is why this page's own dimming logic never needs a separate "degraded"
   * branch of its own — a fallback read is real data, shown rather than an
   * empty page, but it must never look as current as a primary read, and
   * folding it into this one check is what makes that hold everywhere this
   * page already dims for staleness. */
  isStale(): boolean
  /** True when `limits[limitIndex]` (default the primary window, index 0)
   * no longer describes the CURRENT rate-limit window, or there is no
   * sample yet — independent of `isStale()`. The figure it carries is not
   * merely old; it is unknowable, so a caller must render an explicit
   * unknown, never a dimmed but wrong number. Evaluated per limit (I3/I5):
   * the primary and secondary windows carry independent `resetsAt` values,
   * so the secondary tile must pass its OWN index rather than reusing the
   * primary's answer. See `CodexSource.isUsageUnknown`. */
  isUsageUnknown(limitIndex?: number): boolean
  /** Seconds since the last EXACT read — a primary open, or a fallback
   * (`immutable=1`) read whose own `-wal` sidecar was absent or empty at
   * read time — or `null` when there has never been one. I3: task tiles
   * used to carry no textual staleness cue at all, only dimming, so a task
   * Codex finished minutes ago kept reading `RUNNING` with nothing but a
   * shade — and that shade is Codex's PERMANENT resting state, since it
   * normally has the database open, making a genuinely degraded fallback
   * (see `CodexSource.isDegraded`) the everyday path rather than a rare
   * one. This lets the page print a real number alongside the word
   * `STALE`, which stays meaningful now that "degraded" itself is the
   * rarer case. */
  staleForSeconds(): number | null
  /** True when the MOST RECENT read came back via the `immutable=1`
   * fallback rather than a primary `mode=ro` open (`CodexSource.isDegraded`,
   * already exposed there for exactly this). I3: `staleForSeconds()` alone
   * cannot tell a genuinely OLD primary read from a fallback read that
   * happened moments ago but could not see the `-wal` — a degraded read
   * leaves `lastSuccessAt` untouched, so its age describes an EARLIER
   * primary success, not what is actually wrong with the current data. This
   * lets `staleAgeLine` print `PARTIAL` for the fallback case instead of the
   * self-contradictory `STALE 0m` a small, coincidentally-recent
   * `lastSuccessAt` used to produce. */
  isDegraded(): boolean
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

/** The Eastern-zone identifier `formatEasternTime` itself uses privately in
 * `render/text.ts`. Duplicated as a literal (not a formatter — see below)
 * because this page needs to ask a DIFFERENT question that helper was never
 * asked: whether two instants fall on the same Eastern calendar day. */
const EASTERN_ZONE = 'America/New_York'

/** M2 — module-scope, not built fresh inside `easternDatePrefix` on every
 * call: `render(now)` calls that function on every frame (the render loop
 * runs at 1 Hz or faster), and an `Intl.DateTimeFormat` carries real
 * construction cost that a plain string comparison does not need to pay
 * repeatedly. Both formatters are pure functions of their `Date` argument,
 * so sharing one instance across calls changes nothing about what they
 * print. */
const EASTERN_DAY_KEY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_ZONE, year: 'numeric', month: 'numeric', day: 'numeric',
})
const EASTERN_SHORT_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_ZONE, month: 'numeric', day: 'numeric',
})

/** A short `M/D ` prefix (with a trailing space), or `''` when `sampleMs`
 * falls on the SAME Eastern calendar day as `nowMs` (I2). This answers only
 * "does a date need to go in front of the time", never how to format the
 * time itself — that stays the one shared `formatEasternTime` helper's job,
 * per AGENTS.md's "Product conventions": one formatter for every wall-clock
 * display, never a second one. Without this, a sample from yesterday
 * lunchtime and one from an hour ago can print the identical time-of-day
 * text, and the yesterday one can even read as being in the FUTURE relative
 * to `now`. */
function easternDatePrefix(sampleMs: number, nowMs: number): string {
  if (EASTERN_DAY_KEY_FORMAT.format(new Date(sampleMs)) === EASTERN_DAY_KEY_FORMAT.format(new Date(nowMs))) return ''
  return `${EASTERN_SHORT_DATE_FORMAT.format(new Date(sampleMs))} `
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
    // C2 (round 3) — the accounting tiles never consulted `available` at
    // all, which is reachable: after a read FAILURE, `CodexSource` sets
    // `available = false` but leaves `lastSuccessAt` untouched, so
    // `isStale()` stays `false` for up to `STALE_CODEX_SECONDS` — measured,
    // a live 60-second window where the strip says "task data unavailable"
    // while key 4 rendered a confident `27%` under a full green bar, one
    // frame contradicting itself. Folded into `usageUnknown` itself (rather
    // than threaded through as a fifth parameter everywhere) so every tile
    // downstream that already treats an unknown usage sample as "show `--`,
    // never a number, never a bar" gets the same treatment for real for
    // "there is no current data at all" — the STRONGER of the two reasons a
    // tile cannot trust its own retained numbers.
    const dataUnavailable = !available
    // Accounting tiles (the limits, the token count, the reset countdown) can
    // be wrong for three DIFFERENT reasons, and each renders differently:
    //  - `dataUnavailable`: the source has no current data at all (a read
    //    failed outright). Folded into `usageUnknown` below — see above.
    //  - `readStale`: the sqlite READ itself is lagging, OR the most recent
    //    read came from the `immutable=1` fallback rather than a primary
    //    open (`CodexSource.isDegraded`, folded into `isStale()` itself).
    //    Either way the numbers are probably still true, so they show
    //    dimmed with a STALE label rather than an empty tile.
    //  - `usageUnknown`: the usage SAMPLE no longer describes the current
    //    rate-limit window (C2, round 2). The true figure is unknowable, so
    //    these render an explicit `--` instead — a dimmed but wrong number
    //    still reads as data, the same rule commit 185bcb4 set for schema
    //    drift.
    const usageUnknown = this.source.isUsageUnknown() || dataUnavailable
    // Task tiles carry the retained snapshot from before a failure (lesson
    // 20's "preserve the last safe state"), so they need the SAME dim
    // treatment the accounting tiles already had, or a schema-drift or quit
    // failure leaves `RUNNING` on the glass indefinitely.
    const taskDim = dataUnavailable || readStale
    // I2 — an unavailable read is the STRONGER of the two failures, and a
    // task tile must say so in words, not just a shade darker: `RUNNING`
    // and `${count} ACTIVE`, dimmed only, used to read as confident data on
    // the exact frame the strip called the read unavailable outright. Both
    // words fall back to the same explicit-unknown convention the
    // accounting tiles already use for `dataUnavailable` (a plain `--`),
    // rather than asserting a fact — "running", "N active" — the page can
    // no longer see.
    const taskWord = dataUnavailable ? 'UNKNOWN' : 'RUNNING'
    const activeWord = dataUnavailable ? '--' : `${snapshot.tasks.length} ACTIVE`
    // I3 — dimming alone used to be the ONLY staleness cue a task tile
    // carried, and dimming cannot say anything when it is the PERMANENT
    // resting state: Codex normally has the database open, so a genuinely
    // degraded fallback read is the everyday path, not a rare one, and a
    // task that finished minutes ago kept reading `RUNNING` with no textual
    // tell at all. `null` when the read is not stale, so a fresh tile draws
    // its normal four lines with no fifth line reserved.
    //
    // I2 — `UNAVAILABLE` wins over every other word: "no current data at
    // all" is the strongest of the reasons a task tile's data cannot be
    // trusted, the same priority `usageUnknown` already gives
    // `dataUnavailable` over `readStale` for the accounting tiles.
    //
    // I3 — the mirror case, degraded but still available: `staleForSeconds`
    // measures the age of the last EXACT read, but a genuinely degraded
    // fallback read leaves `lastSuccessAt` untouched (see `isDegraded`'s own
    // doc comment on the reader interface), so its age describes an EARLIER
    // primary success, not what is wrong with the CURRENT data — printing
    // it as `STALE 0m` read as self-contradictory (stale by zero minutes)
    // and, worse, as a measurement of the wrong thing entirely. `PARTIAL`
    // names the real condition instead, with no borrowed number attached.
    const degraded = this.source.isDegraded()
    const staleLine = dataUnavailable
      ? 'UNAVAILABLE'
      : readStale
        ? (degraded ? 'PARTIAL' : this.staleAgeLine())
        : null
    const keys: KeySpec[] = []

    for (let i = 0; i < TASK_SLOTS; i++) {
      const task = snapshot.tasks[i]
      keys.push(task ? {
        kind: 'session',
        lines: staleLine
          ? [taskWord, task.project, task.title, task.model, staleLine]
          : [taskWord, task.project, task.title, task.model],
        lineSizes: [11, PROJECT_SIZES, TITLE_SIZES, MODEL_SIZES, STALE_AGE_SIZES],
        border: theme.green,
        dim: taskDim,
      } : { kind: 'blank' })
    }

    keys.push({
      kind: 'session',
      lines: ['OPENAI', 'CODEX', activeWord],
      lineSizes: [11, 22, 11],
      lineColors: [theme.textDim, theme.green, theme.textDim],
      align: 'center',
      border: theme.green,
      dim: taskDim,
    })

    const limits = snapshot.usage?.limits ?? []
    keys.push(this.limitKey(limits[0], usageUnknown, readStale))
    // I3/I5 — the secondary tile asks about ITS OWN window (index 1), never
    // the primary's `usageUnknown`. A secondary window can end while the
    // primary is still live; the two `resetsAt` values are independent.
    // `dataUnavailable` still applies to both alike — an unavailable source
    // has no current data for either window.
    keys.push(limits[1]
      ? this.limitKey(limits[1], this.source.isUsageUnknown(1) || dataUnavailable, readStale)
      // I7 — `usageUnknown` alone, not `usageUnknown || readStale`: PLAN
      // used to be the only tile that folded staleness INTO its own idea of
      // "unknown", which made it print a retained value under a `STALE`
      // label in the exact `dataUnavailable` frame where its neighbours
      // (`tokensKey`, this same `limitKey`) render a plain `--` instead —
      // one frame, two different answers to "what does unknown look like".
      // It was also the only tile that could print the word `STALE` when
      // `readStale` was actually `false`, because that word came from the
      // MERGED flag rather than from `readStale` itself.
      : this.planKey(snapshot.usage?.plan ?? '', usageUnknown, readStale))
    keys.push(this.tokensKey(snapshot.usage?.totalTokens ?? null, usageUnknown, readStale))
    keys.push(this.resetKey(limits[0], now, usageUnknown, readStale))

    return {
      keys,
      strip: this.strip(snapshot, usageUnknown, now),
      buttons: [theme.gray, theme.gray],
    }
  }

  /** I3 — the textual staleness cue a task tile shows ALONGSIDE dimming,
   * within the tile's own tiny width budget. `STALE` alone when
   * `staleForSeconds()` cannot say how old (no successful read yet, so
   * there is no "since" to measure from); `STALE 11m` once it can.
   * `formatDuration` is the one shared duration formatter (AGENTS.md's
   * "Product conventions" — never a second, hand-rolled one). */
  private staleAgeLine(): string {
    const age = this.source.staleForSeconds()
    return age === null ? 'STALE' : `STALE ${formatDuration(age)}`
  }

  private limitKey(limit: CodexLimit | null | undefined, unknown: boolean, readStale: boolean): KeySpec {
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
        kind: 'gauge', lines: [label, '--'], lineSizes: [LABEL_SIZES, 28],
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
        lineSizes: [LABEL_SIZES, PERCENT_SIZES, 11], align: 'center', dim: true,
      }
    }
    return {
      kind: 'gauge', lines: [label, value],
      lineSizes: [LABEL_SIZES, PERCENT_SIZES], align: 'center',
      bar: { value: limit.usedPct / 100, color: barColor(limit.usedPct / 100) },
    }
  }

  private planKey(plan: string, unknown: boolean, readStale: boolean): KeySpec {
    if (unknown) {
      // I7 — the same explicit `--` `tokensKey` and `limitKey` already
      // render for an unknowable figure, never the last retained plan name
      // dimmed under a STALE label pretending the read is merely lagging.
      return {
        kind: 'gauge',
        lines: ['PLAN', '--'],
        lineSizes: [11, [20, 16, 13]],
        align: 'center',
        dim: true,
      }
    }
    return {
      kind: 'gauge',
      lines: ['PLAN', plan ? plan.toUpperCase() : '--', readStale ? 'STALE' : ''],
      lineSizes: [11, [20, 16, 13], 11],
      align: 'center',
      dim: !plan || readStale,
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

  private resetKey(limit: CodexLimit | null | undefined, now: number, unknown: boolean, readStale: boolean): KeySpec {
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
      // M4 — a bare `--` (a present limit whose `resetsAt` itself is null)
      // must dim like every other unknown tile. Without `value === '--'`
      // here, that specific case fell through every other condition false
      // and rendered undimmed, the one tile that disagreed with its
      // neighbours about what "unknown" looks like.
      dim: !limit || unknown || readStale || value === '--',
    }
  }

  private strip(snapshot: CodexSnapshot, usageUnknown: boolean, now: number): StripSpec {
    if (!this.source.isAvailable()) return { lines: ['codex', 'task data unavailable'], dim: true }
    // The usage sample's own time, right-aligned on line 2 — the same slot
    // and helper the Spotify page's idle clock uses. It goes on the strip,
    // not a key: `12:00 AM EDT` measures 93.9 px at 13 px, and a limit key's
    // usable width is only 81 px — beside a percentage there is no room.
    // With I2's date prefix (widest case `12/31 12:00 AM EDT`, 18 chars),
    // the widest realistic right label and the widest realistic line-2 left
    // text (`3 active`) still leave a real, measured gap between them — see
    // the "never overlaps" test in codex-page.test.ts, which measures this
    // with the real canvas rather than assuming it.
    const usageTime = this.usageTimeLabel(snapshot.usage, usageUnknown, now)
    if (snapshot.tasks.length === 0) return { lines: ['codex', 'no active tasks'], right: usageTime, dim: true }
    const first = snapshot.tasks[0]!
    const overflow = Math.max(0, snapshot.tasks.length - TASK_SLOTS)
    return {
      lines: [
        truncate(`${first.project} · ${first.title}`, STRIP_CHARS),
        overflow ? `+${overflow} more` : `${snapshot.tasks.length} active`,
      ],
      right: usageTime,
    }
  }

  /** The usage sample's own timestamp, formatted for display, or the same
   * explicit `--` a key shows when the figure itself is unknown (absent, or
   * describing a window that has ended). A dimmed old timestamp presented
   * as current would misinform exactly like a dimmed old percentage would —
   * commit 360508d's rule, applied here too. `CodexUsage.ts` is epoch
   * SECONDS (see `parseRolloutTail`), so it is converted to epoch
   * milliseconds before reaching `formatEasternTime`.
   *
   * I2 — a sample from an earlier Eastern calendar day gets an `easternDate`
   * prefix ahead of the time-of-day text, because a bare time-of-day string
   * from yesterday lunchtime can read as HOURS IN THE FUTURE next to `now`.
   * The time-of-day text itself always comes from the one shared
   * `formatEasternTime` helper (AGENTS.md's "Product conventions"); this
   * only decides whether a date needs to go in front of it, which that
   * helper was never asked to answer. */
  private usageTimeLabel(usage: CodexUsage | null, usageUnknown: boolean, now: number): string {
    if (!usage || usageUnknown || usage.ts === null) return '--'
    const sampleMs = usage.ts * 1000
    const datePrefix = easternDatePrefix(sampleMs, now * 1000)
    return `${datePrefix}${formatEasternTime(sampleMs)}`
  }

  onKeyPress(_index: number): PressOutcome {
    // Codex does not currently expose a stable local URL or CLI command for
    // focusing a task by thread id. Tiles remain intentionally read-only, so
    // every key, 0 to 7, ignores a press.
    return 'ignored'
  }
}
