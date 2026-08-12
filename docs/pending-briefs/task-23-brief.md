### Task 23: Make the Claude gauge row readable

**Goal:** the bottom row of the Claude page is cryptic and uniformly small. Give it a
small label, a large value, and a pace reading that says which way is good.

**Files:**
- Modify: `src/render/specs.ts` — add per-line font sizes
- Modify: `src/render/canvas.ts` — honour them, with variable line advance
- Modify: `src/pages/claude-page.ts` — the new gauge content
- Test: extend `tests/render/specs.test.ts`, `tests/render/canvas.test.ts`,
  `tests/pages/claude-page.test.ts`

## The user's complaint, in their words

> "make the text on the Claude bottom row of buttons more intuitive and easier to read"

They approved the design below.

## What it looks like today

```
┌──────────┐┌──────────┐┌──────────┐┌──────────┐
│ 5h  20%  ││ 7d  67%  ││ PACE ⇡   ││ RESET    │
│  ██░░░   ││  ████░   ││  fast    ││  2h11m   │
└──────────┘└──────────┘└──────────┘└──────────┘
```

Three problems. Every line is 11 px, so nothing stands out. `5h` and `7d` need decoding.
And `PACE ⇡ fast` never says whether fast is good or bad.

## What it becomes

```
┌──────────┐┌──────────┐┌──────────┐┌──────────┐
│ 5-HR CAP ││ WEEK CAP ││BURN RATE ││RESETS IN │   11px label
│   20%    ││   67%    ││  UNDER   ││  2h11m   │   28 / 28 / 16 / 24 px
│ ██░░░░░  ││ █████░░  ││20% of 44%││   5-hr   │   bar, or 11px context
└──────────┘└──────────┘└──────────┘└──────────┘
```

## Measured widths — these are not estimates

A key is 96 px wide. Border 3, padding 6 each side, so **81 px is usable**.

| Font | Advance | Chars that fit |
| --- | --- | --- |
| 11 px | 6.62 px | 12 |
| 16 px | 9.63 px | 8 |
| 24 px | 14.45 px | 5 |
| 28 px | 16.86 px | 4 |

Confirmed to fit: `5-HR CAP` 53 px, `WEEK CAP` 53 px, `BURN RATE` 60 px, `RESETS IN`
60 px, `20% of 44%` 66 px, `UNDER` at 16 px, `20%` at 28 px is 51 px, `100%` at 28 px is
67 px, `2h11m` at 24 px is 72 px.

`2h11m` at 28 px is 84 px and does NOT fit. That is why the reset time is 24 px.

## Part 1: per-line font sizes

In `src/render/specs.ts`, add a field parallel to the existing `lineColors`:

```ts
  /** Font size per line, in pixels. A missing entry uses the default. */
  lineSizes?: number[]
```

`keyHash` already spreads every field except `image`, so this is covered — but add a test
proving two different `lineSizes` give different hashes. The daemon writes a key only when
its hash changes, so a size outside the hash would leave stale pixels.

In `src/render/canvas.ts`, the text loop currently uses one font and a fixed 14 px
advance. Change it to:

- Font per line: `lineSizes?.[i] ?? 11`.
- **Advance by that line's size plus 4**, not a constant. A 28 px line needs more room
  than a 11 px one, and a fixed advance would overlap them.
- Start at the existing top padding.

That advance rule makes every layout below fit. Verify the arithmetic yourself rather
than trusting it:

| Key | Lines | y positions | Bar? |
| --- | --- | --- | --- |
| 4 and 5 | 11, 28 | 6, then 21 to 49 | yes, at the existing bar row |
| 6 | 11, 16, 11 | 6, 21, 41 | no |
| 7 | 11, 24, 11 | 6, 21, 49 | no |

The existing bar row sits at y 66. Keys 4 and 5 have only two text lines, so nothing
reaches it. Keys 6 and 7 have three lines and no bar.

## Part 2: the gauge content

**Key 4** — the five hour window. Label `5-HR CAP`. Value the whole percent at 28 px.
Bar as today, with the existing colour thresholds: green below 60, amber 60 to 85, red
above 85.

**Key 5** — the seven day window. Label `WEEK CAP`. Same treatment.

**Key 6** — the pace, restated so the direction is obvious. Label `BURN RATE`. The value
is one word at 16 px:

| Condition | Word | Colour |
| --- | --- | --- |
| used percent is more than 5 points BELOW elapsed percent | `UNDER` | `theme.green` |
| within 5 points either way | `ON PACE` | `theme.amber` |
| used percent is more than 5 points ABOVE elapsed percent | `OVER` | `theme.red` |

`ON PACE` is 7 characters and fits at 16 px, which allows 8.

The third line is the evidence: `<used>% of <elapsed>%` at 11 px, for example
`20% of 44%`. Round both to whole numbers. That line makes the verdict checkable instead
of a black box, which is the point of the change.

The existing `computePace` in `src/sources/usage.ts` already computes this comparison with
a 5 point dead band. **Reuse it — do not reimplement the arithmetic.** You will also need
the elapsed percentage for the third line; derive it the same way `computePace` does, and
if that means exporting a small helper from `usage.ts`, do that rather than duplicating
the formula. Duplicated arithmetic drifts.

**Key 7** — the reset countdown. Label `RESETS IN`. Value the duration at 24 px. Third
line `5-hr` at 11 px, so it is clear WHICH window resets.

## Staleness and unknown values

These rules already exist and must be preserved. Do not weaken them — presenting an old
percentage as current is the one thing this page must never do.

- No usage cache at all: every gauge shows `--` as its value and the key is dimmed.
- Cache older than 15 minutes: the key is dimmed and shows `STALE`. With the new layout,
  put `STALE` on the THIRD line and **suppress the bar** on keys 4 and 5, so it cannot
  collide with the bar row. On keys 6 and 7 it replaces the third line.
- A null percentage renders `--`, never `NaN`, and never `0%`.

## Constraints

- ESM only. No CommonJS. Never write `require(` in `src/`, `bin/`, or `scripts/`.
- TypeScript strict with `noUncheckedIndexedAccess`. Imports use `.js`.
- **A log call must never throw**, and `log.once` guards anything repeating. This page
  renders once per second, so a plain `log.warn` on a render path is a defect.
- The three other pages — Spotify, stocks, weather — must render **identically** after
  this change. `lineSizes` is optional and absent by default, so their output must not
  shift by a pixel. Their existing tests must pass untouched.
- **No test may open the device, perform real network I/O, or touch any path under `~`.**
- Prose in ASD-STE100 Simplified Technical English.
- Commit with a `feat:` prefix.

## Tests to write

- Two different `lineSizes` give different `keyHash` values.
- A line rendered at 28 px produces different pixels than the same line at 11 px.
- Variable advance: three lines at 11, 24 and 11 do not overlap. Probe a pixel row
  between lines and assert it is background, and probe within each line and assert ink.
- A missing `lineSizes` entry falls back to the default size.
- Key 4 and 5: label, whole-percent value, bar present, correct bar colour at the 60 and
  85 thresholds.
- Key 6: `UNDER` green, `ON PACE` amber, `OVER` red, at and around the 5 point dead band
  boundary, plus the `N% of M%` third line rounding.
- Key 7: `RESETS IN`, the duration, and the `5-hr` third line.
- Stale: all four keys dim, `STALE` on the third line, and NO bar on keys 4 and 5.
- No cache: `--` values and dimmed keys.
- The Spotify, stocks and weather pages render byte-identically to before — assert at
  least one of them explicitly, by rendering a key and comparing to a snapshot taken
  without `lineSizes`.
