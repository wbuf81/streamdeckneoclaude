import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { CodexPage, formatTokenCount, formatResetIn, limitLabel } from '../../src/pages/codex-page.js'
import type { CodexSnapshot, CodexTask } from '../../src/sources/codex.js'
import { theme } from '../../src/render/theme.js'
import { renderKey, renderStrip, probe, FONT, STRIP_WIDTH, STRIP_HEIGHT } from '../../src/render/canvas.js'

/** The strip's own left/right inset, matching `render/canvas.ts`'s private
 * `PAD` — documented in docs/VERIFIED-FACTS.md as "usable width 236 px" =
 * 248 (`STRIP_WIDTH`) - 2 * 6. Not exported, so measured tests hardcode the
 * same documented value rather than reasoning about it fresh. */
const STRIP_PAD = 6

/** I6 (round 3) / I5 (this round) — the furthest column a LEFT-ALIGNED key
 * line can ever legitimately reach: `render/canvas.ts`'s private `BORDER`
 * (3) + `PAD` (6) + `TEXT_MAX_WIDTH` (81, itself `KEY_SIZE - BORDER -
 * PAD * 2`). `KEY_TEXT_RIGHT_BAND_END` is the key's own last column
 * (`KEY_SIZE - 1` = 95). A probe past the band (the round-3 test used 95
 * alone, five pixels beyond `KEY_TEXT_RIGHT_EDGE`) can never fail, however
 * badly a line overflows — `shrinkToFit` guarantees every measured line
 * stops at or before `KEY_TEXT_RIGHT_EDGE` BY CONSTRUCTION.
 *
 * I5 — a SINGLE column at `KEY_TEXT_RIGHT_EDGE` is not enough either, for
 * CENTRED text: measured, sweeping candidate sizes 11-28 and lengths 4-24
 * against exactly the pair of columns the round-3 test checked (90 and its
 * mirror, 6) turned up 90 combinations that overflow the key while BOTH
 * probed columns stay background — narrow glyphs put the outermost columns
 * inside the inter-glyph gap. Every probe below now sweeps the whole band,
 * `KEY_TEXT_RIGHT_EDGE` to `KEY_TEXT_RIGHT_BAND_END`, matching the pattern
 * stocks-page.test.ts and weather-page.test.ts already use. */
const KEY_TEXT_RIGHT_EDGE = 90
const KEY_TEXT_RIGHT_BAND_END = 95

/** True when no pixel in the row `y`, columns `KEY_TEXT_RIGHT_EDGE` to
 * `KEY_TEXT_RIGHT_BAND_END`, differs from the background — the left-aligned
 * right-margin band every task tile's text must never reach into (I5). */
function rightBandIsBackground(buf: Buffer, y: number): boolean {
  for (let x = KEY_TEXT_RIGHT_EDGE; x <= KEY_TEXT_RIGHT_BAND_END; x++) {
    if (!colorsEqual(probe(buf, x, y), theme.bg)) return false
  }
  return true
}

/** `render/canvas.ts`'s private `BORDER`: every key with a `border` colour
 * fills a solid strip across columns `0` to `BORDER - 1` down the LEFT edge
 * ONLY (`ctx.fillRect(0, 0, BORDER, KEY_SIZE)`) — not a full rectangle, and
 * not on the right edge at all, per AGENTS.md's "Press feedback" history
 * ("An earlier version recoloured only the key's left-edge border strip").
 * That strip is legitimate, permanent ink with nothing to do with text
 * overflow, so the left mirror band below starts just past it. */
const LEFT_BORDER_WIDTH = 3

/** The mirror band on the LEFT edge, for centred text (I5): the same
 * distance from the true left edge that `rightBandIsBackground` checks from
 * the true right edge, clamped to start just past `LEFT_BORDER_WIDTH` — the
 * border strip's own solid ink is not text and must not be mistaken for an
 * overflow. */
function leftBandIsBackground(buf: Buffer, y: number): boolean {
  const start = Math.max(LEFT_BORDER_WIDTH, 95 - KEY_TEXT_RIGHT_BAND_END)
  const end = 95 - KEY_TEXT_RIGHT_EDGE
  for (let x = start; x <= end; x++) {
    if (!colorsEqual(probe(buf, x, y), theme.bg)) return false
  }
  return true
}

function colorsEqual(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/** Measures with the SAME font and size `renderStrip` draws line 1 and 2
 * with, independently of the page. */
function measureStrip(text: string): number {
  const ctx = createCanvas(1, 1).getContext('2d')
  ctx.font = `13px ${FONT}`
  return ctx.measureText(text).width
}

const NOW = 1786622400

function task(over: Partial<CodexTask> = {}): CodexTask {
  return {
    threadId: 'thread-1', title: 'Improve the Stream Deck integration', project: 'deckd',
    model: 'gpt-5.6-sol', updatedAt: NOW, tokensUsed: 1_250_000,
    ...over,
  }
}

function snapshot(over: Partial<CodexSnapshot> = {}): CodexSnapshot {
  return {
    tasks: [task()],
    usage: {
      limits: [{ usedPct: 27, windowMinutes: 10080, resetsAt: NOW + 86400 }],
      totalTokens: 1_250_000, plan: 'team', ts: NOW,
    },
    ...over,
  }
}

function build(
  data = snapshot(),
  available = true,
  stale = false,
  // Either a single boolean applied to every limit index (the shape every
  // existing test uses), or a per-index function for I5's test: the
  // secondary tile must ask about ITS OWN index, not reuse the primary's
  // answer, so a fake that ignores the argument entirely could not tell
  // those two call sites apart.
  usageUnknown: boolean | ((limitIndex?: number) => boolean) = false,
  // I3 — `null` (the default) matches every existing test's assumption:
  // "stale" without a further age to report. Tests that care about the
  // printed age pass a number explicitly.
  staleForSeconds: number | null = null,
  // I3 — a genuinely degraded (immutable fallback) read, distinct from a
  // merely OLD primary read even though both make `isStale()` true. Default
  // `false` matches every pre-existing test's assumption (a normal, aged
  // staleness, not a fallback one).
  degraded = false,
) {
  const isUsageUnknown = typeof usageUnknown === 'function' ? usageUnknown : () => usageUnknown
  return new CodexPage({
    getSnapshot: () => data,
    isAvailable: () => available,
    isStale: () => stale,
    isUsageUnknown,
    staleForSeconds: () => staleForSeconds,
    isDegraded: () => degraded,
    setVisible: () => {},
  })
}

describe('CodexPage', () => {
  it('renders exactly eight keys', () => {
    expect(build().render(NOW).keys).toHaveLength(8)
  })

  it('puts active tasks in the first three tiles', () => {
    const key = build().render(NOW).keys[0]!
    expect(key.lines).toEqual(['RUNNING', 'deckd', 'Improve the Stream Deck integration', 'gpt-5.6-sol'])
    expect(key.border).toEqual(theme.green)
    expect(key.dim).toBe(false)
  })

  it('leaves unused task slots blank', () => {
    const keys = build().render(NOW).keys
    expect(keys[1]!.kind).toBe('blank')
    expect(keys[2]!.kind).toBe('blank')
  })

  it('keeps a permanent OpenAI Codex identity tile at key 3', () => {
    expect(build().render(NOW).keys[3]!.lines).toEqual(['OPENAI', 'CODEX', '1 ACTIVE'])
  })

  it('shows the account limit percentage and reset countdown', () => {
    const keys = build().render(NOW).keys
    expect(keys[4]!.lines).toEqual(['WEEK CAP', '27%'])
    expect(keys[4]!.bar?.value).toBeCloseTo(0.27)
    expect(keys[7]!.lines?.[1]).toBe('1d0h')
  })

  it('uses key 5 for the plan when there is no second limit', () => {
    expect(build().render(NOW).keys[5]!.lines?.slice(0, 2)).toEqual(['PLAN', 'TEAM'])
  })

  // I7 — the mirror case that stayed correct: a merely lagging sqlite read,
  // with the usage SAMPLE itself still describing the current window, keeps
  // showing the retained plan name under a STALE label. This is the ONE
  // case that should still look like the old behaviour.
  it('still shows the plan name under a STALE label when only the sqlite read is lagging, not the usage sample', () => {
    const key = build(snapshot(), true, true, false).render(NOW).keys[5]!
    expect(key.lines).toEqual(['PLAN', 'TEAM', 'STALE'])
    expect(key.dim).toBe(true)
  })

  // I7 — PLAN used to fold `usageUnknown || readStale` into one flag, which
  // made it the only tile that could print the word STALE for a reason that
  // was not staleness: here `readStale` itself is `false`, and only
  // `isUsageUnknown()` is `true`, yet the OLD code still passed a merged
  // `true` into `planKey` and printed `STALE`. It must render the explicit
  // `--` its neighbours already use for an unknowable figure instead, with
  // no STALE label attached to the wrong reason.
  it('renders -- for PLAN, never a STALE label, once the usage sample no longer describes the current window', () => {
    const key = build(snapshot(), true, false, true).render(NOW).keys[5]!
    expect(key.lines).toEqual(['PLAN', '--'])
    expect(key.dim).toBe(true)
  })

  // I3/I5 — the secondary tile must ask about ITS OWN window, never reuse
  // the primary's unknown-ness. A fresh primary must not force a confident
  // percentage onto a secondary window that has already ended.
  it('renders the secondary limit as unknown independently of the primary, using its own index', () => {
    const data = snapshot({
      usage: {
        limits: [
          { usedPct: 10, windowMinutes: 300, resetsAt: NOW + 3600 }, // primary: fresh.
          { usedPct: 96, windowMinutes: 10080, resetsAt: NOW - 3600 }, // secondary: already ended.
        ],
        totalTokens: 1, plan: 'team', ts: NOW,
      },
    })
    const isUsageUnknown = (limitIndex?: number) => limitIndex === 1
    const keys = build(data, true, false, isUsageUnknown).render(NOW).keys
    expect(keys[4]!.lines).toEqual(['5-HR CAP', '10%']) // primary: known, confident.
    expect(keys[4]!.dim).not.toBe(true)
    expect(keys[5]!.lines).toEqual(['WEEK CAP', '--']) // secondary: unknown, never 96%.
    expect(keys[5]!.dim).toBe(true)
  })

  it('shows task token usage compactly', () => {
    expect(build().render(NOW).keys[6]!.lines?.[1]).toBe('1.3M')
  })

  it('dims unavailable data and explains it on the strip', () => {
    const page = build({ tasks: [], usage: null }, false, true)
    const frame = page.render(NOW)
    expect(frame.keys[3]!.dim).toBe(true)
    expect(frame.strip).toEqual({ lines: ['codex', 'task data unavailable'], dim: true })
  })

  // C2 — the review's exact repro: `isAvailable() -> false`, `isStale() ->
  // false`, `isUsageUnknown() -> false`, with a RETAINED snapshot that still
  // carries a valid percentage, token count and reset time. Before the fix,
  // none of the four accounting tiles ever read `available` at all, so key
  // 4 rendered `WEEK CAP` / `27%` undimmed with a full green bar while the
  // strip said "task data unavailable" on the very same frame — one page
  // contradicting itself. Every accounting tile must instead render the
  // SAME unknown state a caller already gets from `usageUnknown` — never a
  // number, never a bar — because "no current data at all" is the STRONGER
  // of the reasons a tile cannot trust its own retained numbers.
  it('never renders a confident percentage or a bar when the source is unavailable, even with fresh-looking retained data', () => {
    const frame = build(snapshot(), false, false, false).render(NOW)
    expect(frame.strip).toEqual({ lines: ['codex', 'task data unavailable'], dim: true })

    const primaryLimit = frame.keys[4]!
    expect(primaryLimit.lines).toEqual(['WEEK CAP', '--'])
    expect(primaryLimit.bar).toBeUndefined()
    expect(primaryLimit.dim).toBe(true)

    const tokens = frame.keys[6]!
    expect(tokens.lines).toEqual(['TASK TOKENS', '--'])
    expect(tokens.dim).toBe(true)

    const reset = frame.keys[7]!
    expect(reset.lines?.[1]).toBe('--')
    expect(reset.dim).toBe(true)

    // Task tiles and the identity tile dim too — the same audit the review
    // asked for, across every tile on the page, not just the limit gauges.
    expect(frame.keys[0]!.dim).toBe(true)
    expect(frame.keys[3]!.dim).toBe(true)
  })

  // I2 — the review's exact repro: `isAvailable() -> false`, `isStale() ->
  // false`. Before the fix, task tiles kept reading `RUNNING` and the
  // identity tile kept reading `N ACTIVE`, dimmed only, on the very frame
  // the strip called the read unavailable outright — the strongest failure
  // got the weakest cue. Both must now say so in as many words as the
  // accounting tiles already do for the same condition.
  it('renders the task and identity tiles as unknown in words, not just a shade, when the source is unavailable', () => {
    const frame = build(snapshot(), false, false, false).render(NOW)
    expect(frame.keys[0]!.lines?.[0]).toBe('UNKNOWN')
    expect(frame.keys[3]!.lines).toEqual(['OPENAI', 'CODEX', '--'])
  })

  // I7 — PLAN must get the SAME `dataUnavailable` treatment as its
  // neighbours (`tokensKey`, `limitKey`): a plain `--`, never the retained
  // plan name under a STALE label that implies the read is merely lagging.
  it('renders -- for PLAN too when the source is unavailable, never the retained plan name', () => {
    const key = build(snapshot(), false, false, false).render(NOW).keys[5]!
    expect(key.lines).toEqual(['PLAN', '--'])
    expect(key.dim).toBe(true)
  })

  // The secondary limit tile must get the SAME treatment through its own
  // `isUsageUnknown(1)` call site, not just the primary's default index.
  it('never renders a confident secondary percentage when the source is unavailable', () => {
    const data = snapshot({
      usage: {
        limits: [
          { usedPct: 10, windowMinutes: 300, resetsAt: NOW + 3600 },
          { usedPct: 96, windowMinutes: 10080, resetsAt: NOW + 86400 },
        ],
        totalTokens: 1, plan: 'team', ts: NOW,
      },
    })
    const isUsageUnknown = () => false // both windows are otherwise fresh.
    const secondary = build(data, false, false, isUsageUnknown).render(NOW).keys[5]!
    expect(secondary.lines).toEqual(['WEEK CAP', '--'])
    expect(secondary.bar).toBeUndefined()
    expect(secondary.dim).toBe(true)
  })

  it('renders an explicit unknown, not the last known percentage dimmed, once the usage sample no longer describes the current window', () => {
    // Available and read-fresh (not `readStale`), but `isUsageUnknown()`
    // reports the C2 scenario: the sample's own window has ended, so the
    // true figure is unknowable. A dimmed `27%` under a STALE label would
    // still read as data — the same rule commit 185bcb4 set for schema
    // drift — so this must show `--` outright, with no bar.
    const key = build(snapshot(), true, false, true).render(NOW).keys[4]!
    expect(key.lines).toEqual(['WEEK CAP', '--'])
    expect(key.bar).toBeUndefined()
    expect(key.dim).toBe(true)
  })

  it('still shows the dimmed percentage under a STALE label when only the sqlite read is lagging, not the usage sample', () => {
    // The mirror case: `readStale` true, `isUsageUnknown()` false. The
    // number is probably still true, just not freshly confirmed, so it stays
    // visible — this is the ONE case that keeps the old STALE-label
    // behaviour.
    const key = build(snapshot(), true, true, false).render(NOW).keys[4]!
    expect(key.lines).toEqual(['WEEK CAP', '27%', 'STALE'])
    expect(key.bar).toBeUndefined()
    expect(key.dim).toBe(true)
  })

  it('shows -- for task tokens too, once the usage sample no longer describes the current window', () => {
    const key = build(snapshot(), true, false, true).render(NOW).keys[6]!
    expect(key.lines).toEqual(['TASK TOKENS', '--'])
    expect(key.dim).toBe(true)
  })

  it('shows an explicit -- for the reset countdown when unknown, never a real but WRONG duration', () => {
    // `resetsAt` is a full day out — a real, positive duration if trusted —
    // but `isUsageUnknown()` says the sample does not describe the current
    // window, so the countdown itself cannot be trusted either.
    const key = build(snapshot(), true, false, true).render(NOW).keys[7]!
    expect(key.lines?.[1]).toBe('--')
    expect(key.dim).toBe(true)
  })

  it('keeps ELAPSED for the reset countdown when unknown, since that is already an honest signal on its own', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 27, windowMinutes: 10080, resetsAt: NOW - 5 }],
        totalTokens: 1_250_000, plan: 'team', ts: NOW,
      },
    })
    const key = build(data, true, false, true).render(NOW).keys[7]!
    expect(key.lines?.[1]).toBe('ELAPSED')
  })

  it('dims task tiles when the last sqlite read has gone stale, even while available', () => {
    // I3 — a retained snapshot must not read as current forever.
    const key = build(snapshot(), true, true, true).render(NOW).keys[0]!
    expect(key.lines?.[0]).toBe('RUNNING') // still shows the retained data...
    expect(key.dim).toBe(true) // ...but visibly marked historic.
  })

  // I3 — probe-confirmed by the review: task tiles carried NO textual
  // staleness cue at all before this, only dimming — and dimming alone
  // means nothing once "degraded" is Codex's everyday resting state (see
  // `CodexSource.isDegraded`'s doc comment). A task that finished minutes
  // ago must now say so, not just look a shade darker.
  it('adds a bare STALE line to a task tile when stale with no known age', () => {
    const key = build(snapshot(), true, true, false, null).render(NOW).keys[0]!
    expect(key.lines).toEqual([
      'RUNNING', 'deckd', 'Improve the Stream Deck integration', 'gpt-5.6-sol', 'STALE',
    ])
  })

  it('adds a STALE line with the elapsed age to a task tile when the age is known', () => {
    const key = build(snapshot(), true, true, false, 660).render(NOW).keys[0]!
    expect(key.lines?.[4]).toBe('STALE 11m')
  })

  // I3 — the review's exact repro: a genuinely degraded (immutable
  // fallback) read leaves `lastSuccessAt` untouched, so `staleForSeconds`
  // describes an EARLIER primary success, not what is wrong with the
  // CURRENT data. Printing that as `STALE 0m` reads as self-contradictory
  // ("stale by zero minutes") on exactly the path I3 was built for.
  // `PARTIAL` must appear instead, with no borrowed number attached.
  it('shows PARTIAL rather than a self-contradictory STALE 0m on a genuinely degraded read', () => {
    const key = build(snapshot(), true, true, false, 0, true).render(NOW).keys[0]!
    expect(key.lines?.[4]).toBe('PARTIAL')
  })

  it('adds no fifth line to a task tile at all when the read is fresh', () => {
    const key = build(snapshot(), true, false, false, 5).render(NOW).keys[0]!
    expect(key.lines).toHaveLength(4)
  })

  it('never draws a wide STALE age line past the task-tile edge', () => {
    // `formatDuration`'s widest realistic form: several days old.
    const wide = task({
      project: 'a-fairly-long-project-directory-name-for-a-real-repo',
      title: 'W'.repeat(64),
      model: 'a-fairly-long-model-identifier-string-example',
    })
    const threeDaysOld = 3 * 24 * 3600 + 3600 * 2 // "3d2h".
    const key = build(snapshot({ tasks: [wide] }), true, true, false, threeDaysOld).render(NOW).keys[0]!
    expect(key.lines?.[4]).toBe('STALE 3d2h')
    const buffer = renderKey(key)
    for (let y = 0; y < 96; y++) {
      expect(rightBandIsBackground(buffer, y)).toBe(true)
    }
  })

  it('dims task tiles when the source is unavailable', () => {
    const key = build(snapshot(), false, false, false).render(NOW).keys[0]!
    expect(key.dim).toBe(true)
  })

  it('reports overflow on the strip', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => task({
      threadId: String(i), title: `Task ${i}`, updatedAt: NOW - i,
    }))
    expect(build(snapshot({ tasks })).render(NOW).strip.lines[1]).toBe('+2 more')
  })

  it("renders the usage sample's own time on the strip, right-aligned on line 2", () => {
    // NOW (1786622400) is 2026-08-13T12:00:00Z, which is 8:00 AM EDT — a
    // summer instant, so the zone must read EDT. Exact string, per
    // docs/LESSONS.md #17. The sample is from the SAME Eastern day as `now`
    // (both Aug 13), so I2's date prefix must stay absent here.
    expect(build().render(NOW).strip.right).toBe('8:00 AM EDT')
  })

  // I2 — a sample from an earlier Eastern calendar day must carry a date
  // prefix, or a bare time-of-day string can read as being in the FUTURE
  // relative to `now` (the review's exact scenario: yesterday lunchtime next
  // to this morning's clock).
  it('adds a date prefix when the usage sample is from a different Eastern calendar day than now', () => {
    // 2026-08-12T16:00:00Z is 12:00 PM EDT on Aug 12 — the day BEFORE NOW's
    // Aug 13.
    const yesterdayNoon = Math.floor(Date.parse('2026-08-12T16:00:00.000Z') / 1000)
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 27, windowMinutes: 10080, resetsAt: NOW + 86400 }],
        totalTokens: 1, plan: 'team', ts: yesterdayNoon,
      },
    })
    expect(build(data).render(NOW).strip.right).toBe('8/12 12:00 PM EDT')
  })

  it('shows the explicit -- unknown state, not the timestamp, once the usage sample no longer describes the current window', () => {
    // Same C2 rule the key percentages already follow (commit 360508d): a
    // sample can sit unchanged for hours and stay TRUE, but once its window
    // has ended the figure — and the time it was taken — is no longer
    // presented as current.
    const key = build(snapshot(), true, false, true)
    expect(key.render(NOW).strip.right).toBe('--')
  })

  it('shows the -- unknown state with no timestamp when there is no usage sample at all', () => {
    const page = build(snapshot({ usage: null }), true, false, false)
    expect(page.render(NOW).strip.right).toBe('--')
  })

  it('never overlaps the strip timestamp against line 2 text, for the widest realistic values', () => {
    // The widest realistic line-2 left text, `3 active` (achieved with
    // exactly TASK_SLOTS tasks and no overflow — wider than any reachable
    // `+N more` string, since the sqlite query caps at 10 rows and
    // 10 - TASK_SLOTS leaves only 7), beside the widest realistic right
    // label — a sample from a different Eastern day (I2), which now carries
    // a date prefix ahead of `12:00 AM EDT`.
    //
    // The OLD version of this test probed only `x = STRIP_WIDTH - 1` (247):
    // `renderStrip` right-aligns at `STRIP_WIDTH - PAD` = 242, so nothing
    // ever draws past there BY CONSTRUCTION — the probe could not fail
    // however badly the two strings actually collided. This version
    // MEASURES both strings with the real canvas and font `renderStrip`
    // itself uses, and probes a column strictly INSIDE the real gap between
    // them, so a future change that shrinks or removes that gap makes this
    // fail.
    const tasks = Array.from({ length: 3 }, (_, i) => task({
      threadId: String(i), title: `Task ${i}`, updatedAt: NOW - i,
    }))
    // 2026-07-15T04:00:00Z is 12:00 AM EDT, a different Eastern day than
    // NOW's Aug 13 — so the right label carries I2's date prefix too.
    const wideTs = Math.floor(Date.parse('2026-07-15T04:00:00.000Z') / 1000)
    const data = snapshot({
      tasks,
      usage: {
        limits: [{ usedPct: 27, windowMinutes: 10080, resetsAt: NOW + 86400 }],
        totalTokens: 1_250_000, plan: 'team', ts: wideTs,
      },
    })
    const frame = build(data).render(NOW)
    expect(frame.strip.right).toBe('7/15 12:00 AM EDT')
    const line2Text = frame.strip.lines[1]!
    expect(line2Text).toBe('3 active')

    const line2End = STRIP_PAD + measureStrip(line2Text)
    const rightStart = STRIP_WIDTH - STRIP_PAD - measureStrip(frame.strip.right!)
    // A real, positive gap must exist between the two spans — this is the
    // assertion the old test never made at all.
    expect(rightStart).toBeGreaterThan(line2End)

    const probeX = Math.round((line2End + rightStart) / 2)
    const buffer = renderStrip(frame.strip)
    // Line 1 (the project/title text) sits above, roughly y=4 to y=17 at
    // this same 13 px font — starting the scan at y=20 clears its own
    // descenders so this probe checks ONLY line 2's row and the blank
    // space below it, not line 1's independent (and, at this column,
    // irrelevant) ink.
    for (let y = 20; y < STRIP_HEIGHT; y++) {
      expect(probe(buffer, probeX, y, STRIP_WIDTH)).toEqual(theme.bg)
    }
  })

  // C1 — a limit whose window is known but whose percentage field was
  // renamed must render `--`, dimmed, with NO bar — never a measured `0%`
  // with a confident green bar under it.
  it('renders an unknown percentage as -- with no bar, never a measured 0%', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: null, windowMinutes: 10080, resetsAt: NOW + 86400 }],
        totalTokens: null, plan: 'team', ts: NOW,
      },
    })
    const key = build(data).render(NOW).keys[4]!
    expect(key.lines).toEqual(['WEEK CAP', '--'])
    expect(key.bar).toBeUndefined()
    expect(key.dim).toBe(true)
  })

  it('renders unknown task tokens as -- rather than a fabricated 0', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 27, windowMinutes: 10080, resetsAt: NOW + 86400 }],
        totalTokens: null, plan: 'team', ts: NOW,
      },
    })
    const key = build(data).render(NOW).keys[6]!
    expect(key.lines?.[1]).toBe('--')
    expect(key.dim).toBe(true)
  })

  // M1 — an out-of-range percentage must not clip the key.
  it('clamps an out-of-range percentage for display', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 1234.5, windowMinutes: 10080, resetsAt: NOW + 86400 }],
        totalTokens: 1, plan: 'team', ts: NOW,
      },
    })
    const key = build(data).render(NOW).keys[4]!
    expect(key.lines?.[1]).toBe('999%')
  })

  // C2 — an elapsed reset must read as elapsed, not as a permanent `0m`.
  it('reports an elapsed reset time as ELAPSED rather than 0m forever', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 10, windowMinutes: 10080, resetsAt: NOW - 5 }],
        totalTokens: 1, plan: 'team', ts: NOW,
      },
    })
    expect(build(data).render(NOW).keys[7]!.lines?.[1]).toBe('ELAPSED')
  })

  it('reports an unknown reset time as -- rather than 0m', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 10, windowMinutes: 10080, resetsAt: null }],
        totalTokens: 1, plan: 'team', ts: NOW,
      },
    })
    expect(build(data).render(NOW).keys[7]!.lines?.[1]).toBe('--')
  })

  // M4 — a present limit whose own resetsAt is null showed an undimmed `--`
  // while every other unknown tile on the same frame dims. `available`,
  // fresh, and not `usageUnknown` — the ONLY thing wrong is `resetsAt`
  // itself being null.
  it('dims the reset tile when its value is -- even though the read is fresh and usage is not otherwise unknown', () => {
    const data = snapshot({
      usage: {
        limits: [{ usedPct: 10, windowMinutes: 10080, resetsAt: null }],
        totalTokens: 1, plan: 'team', ts: NOW,
      },
    })
    const key = build(data, true, false, false).render(NOW).keys[7]!
    expect(key.lines?.[1]).toBe('--')
    expect(key.dim).toBe(true)
  })

  // I6 (round 3) — the OLD probe sat at x=95, five pixels beyond the
  // furthest column a left-aligned line can ever legitimately reach
  // (`KEY_TEXT_RIGHT_EDGE` = 90; see its own doc comment). Nothing could
  // ever draw that far out, so the probe could not fail however badly the
  // layout broke. I5 (this round) — a single column even AT that boundary
  // is not proof enough in general (see `KEY_TEXT_RIGHT_EDGE`'s own updated
  // comment); this sweeps the whole band instead.
  it('never draws task-tile text past the key edge for the widest realistic values', () => {
    const wide = task({
      project: 'a-fairly-long-project-directory-name-for-a-real-repo',
      title: 'W'.repeat(64), // the SQL layer's own truncation bound (I6).
      model: 'a-fairly-long-model-identifier-string-example',
    })
    const key = build(snapshot({ tasks: [wide] })).render(NOW).keys[0]!
    const buffer = renderKey(key)
    for (let y = 0; y < 96; y++) {
      expect(rightBandIsBackground(buffer, y)).toBe(true)
    }
  })

  // I6 (round 3) — the OLD probe sat at `STRIP_WIDTH - 1` = 247.
  // `renderStrip` right-aligns at `STRIP_WIDTH - PAD` = 242 and shrink-fits
  // both lines to the same budget, so nothing ever draws past 242 either —
  // the probe was five pixels into territory that could never fail. Moved
  // to the real right-aligned boundary.
  it('never draws strip text past the strip edge for the widest realistic values', () => {
    const wide = task({
      project: 'a-fairly-long-project-directory-name-for-a-real-repo',
      title: 'W'.repeat(64),
    })
    const strip = build(snapshot({ tasks: [wide] })).render(NOW).strip
    const buffer = renderStrip(strip)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
      expect(probe(buffer, STRIP_WIDTH - STRIP_PAD, y, STRIP_WIDTH)).toEqual(theme.bg)
    }
  })

  // I6 (round 3) — every BARE (unmeasured, `resolveLineSpecs` skips
  // measuring a plain `number`) label or value line on this page had no
  // probe at all: `TASK TOKENS` / `USAGE CAP` / `RESETS IN` / `PLAN` at 11,
  // `STALE` at 11, `CODEX` at 22, `OPENAI` / `N ACTIVE` at 11. They are
  // fixed, short strings by design, not user-controlled — measured by hand
  // to fit today — but "measured by hand once" is exactly what lesson 17
  // warns against relying on going forward. This locks the claim in with
  // the real canvas. All of them draw centered (`align: 'center'`), so an
  // overflow shows up symmetrically around the key's own horizontal centre
  // (x=48).
  //
  // I5 (this round) — the round-3 version of this test checked only the
  // single mirrored pair of columns (90 and its mirror, 6). Measured:
  // sweeping candidate sizes 11-28 and lengths 4-24 against exactly that
  // pair turned up 90 combinations where the key overflows while BOTH
  // probed columns stay background — narrow glyphs put the outermost
  // columns inside the inter-glyph gap. This sweeps the whole band on both
  // sides instead.
  it('keeps every bare-size centered label and value line within the key edge, for every key that draws one', () => {
    // `usage: null` routes key 4 through `limitKey`'s `!limit` branch
    // (`USAGE CAP` / `--`, bare), key 5 through `planKey` (`PLAN` / `--`,
    // bare), key 6 through `tokensKey`'s unknown branch (`TASK TOKENS`,
    // bare), and key 7 through `resetKey` (`RESETS IN`, bare) — and
    // `readStale: true` puts the bare `STALE` line on keys 5 and 7 too.
    // Key 3's identity tile (`OPENAI` / `CODEX` / `N ACTIVE`, all bare)
    // renders unconditionally.
    const frame = build(snapshot({ usage: null }), true, true, false).render(NOW)
    for (const index of [3, 4, 5, 6, 7]) {
      const buffer = renderKey(frame.keys[index]!)
      for (let y = 0; y < 96; y++) {
        expect(rightBandIsBackground(buffer, y)).toBe(true)
        expect(leftBandIsBackground(buffer, y)).toBe(true)
      }
    }
  })
})

describe('CodexPage presses', () => {
  it('ignores every key, 0 to 7 — task tiles are read-only, with no stable URL or command to focus one', () => {
    const page = build()
    for (let i = 0; i <= 7; i++) {
      expect(page.onKeyPress(i)).toBe('ignored')
    }
  })
})

describe('Codex page formatting', () => {
  it('formats common rate-limit windows', () => {
    expect(limitLabel(300)).toBe('5-HR CAP')
    expect(limitLabel(10080)).toBe('WEEK CAP')
  })

  it('formats token counts compactly', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(12_400)).toBe('12.4K')
    expect(formatTokenCount(15_200_000)).toBe('15M')
  })

  it('formats a reset countdown', () => {
    expect(formatResetIn(NOW + 3600, NOW)).toBe('1h0m')
    expect(formatResetIn(NOW - 1, NOW)).toBe('ELAPSED')
    expect(formatResetIn(NOW, NOW)).toBe('ELAPSED')
    expect(formatResetIn(null, NOW)).toBe('--')
  })
})
