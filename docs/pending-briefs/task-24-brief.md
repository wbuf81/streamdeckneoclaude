### Task 24: Fix the weather tiles — no overlap, bigger text, more character

**Depends on Task 23**, which adds `lineSizes` to `KeySpec` and variable line advance to
the renderer. Do not start until that has landed, and use its field rather than inventing
a second mechanism.

**Files:**
- Modify: `src/render/canvas.ts` — emoji size and placement, and emoji dimming
- Modify: `src/render/specs.ts` — only if an emoji size field is genuinely needed
- Modify: `src/pages/weather-page.ts` — the new layout, heat colours, condition tint
- Test: extend `tests/render/canvas.test.ts`, `tests/pages/weather-page.test.ts`

## The user's complaint, in their words

> "a little small text and the icons are in the middle of the thing and overlap"

and

> "make that weather screen more fun"

They approved the design below.

## The overlap is real, and my brief caused it

Measured from the current code:

- The emoji is drawn at 40 px with `textBaseline: 'middle'` at y 44, so it occupies
  roughly **y 24 to 64**.
- Text lines are 11 px starting at y 6 with a 14 px step, so line 1 sits at y 20 and
  line 2 at y 34 — **both inside the emoji band**.

The existing comment in `canvas.ts` says an overlapping number "stays on top and legible".
That was my instruction and it was wrong. Overlapping text on a 96 px key is not a
trade-off, it is a mess. Remove that comment along with the behaviour.

## The new layout, with measured bands

A key is 96 px tall and 81 px of usable width. Four bands that cannot collide:

| Band | y range | Content | Font |
| --- | --- | --- | --- |
| 1 | 3 to 15 | day label, for example `THU` | 12 px |
| 2 | 17 to 51 | the emoji, centred | 34 px |
| 3 | 54 to 70 | temperatures, for example `95°/77°` | 16 px |
| 4 | 74 to 88 | rain chance, for example `47%` | 20 px, coloured |

Width checks, measured, at 81 px usable:

- `95°/77°` at 16 px is 77 px. It fits. **At 17 px it is 82 px and does NOT fit**, so 16 px
  is the ceiling for the temperature line.
- `47%` at 20 px is about 36 px. Comfortable.
- `THU` at 12 px is about 22 px. Comfortable.
- `100%` at 20 px is about 48 px. Still fits.

The emoji must move from a centred y 44 to a centred **y 34**, and shrink from 40 px to
34 px, so it stays inside band 2.

Reserving a band for the emoji means the text lines can no longer start at the top and
step uniformly. Use Task 23's `lineSizes` for the per-line fonts, and give the weather
page explicit control of where its lines sit. If that needs a small addition — for example
an optional per-line y offset, or an emoji band height the text loop skips — add the
minimal one, document why, and make sure `keyHash` covers it. **Do not reintroduce
overlap to avoid adding a field.**

## More character, without hurting legibility

**1. A condition tint on the key background.** `KeySpec` already has a `bg` field, so no
new field is needed. Keep every tint DARK, because white text must stay crisp — these are
washes, not fills. Suggested values, adjust if any proves too light:

| Condition | Tint |
| --- | --- |
| thunder | deep blue-violet, about `rgb(28, 24, 48)` |
| rain, showers, drizzle | dark blue, about `rgb(18, 28, 44)` |
| snow, sleet, ice | dark slate, about `rgb(26, 32, 40)` |
| fog, haze, mist | flat dark grey, about `rgb(28, 28, 30)` |
| cloudy, overcast | neutral dark, about `rgb(22, 24, 28)` |
| partly cloudy | slightly warm dark, about `rgb(28, 26, 24)` |
| sunny, clear | warm dark amber-brown, about `rgb(34, 27, 18)` |

Derive the tint from the SAME keyword match that picks the emoji, so the two can never
disagree. Export one function that returns both, or have the tint function call the emoji
matcher — do not write a second keyword list. Two lists drift apart.

**2. Temperature coloured by heat**, applied to band 3 via `lineColors`:

| High temperature | Colour |
| --- | --- |
| 90 °F and above | `theme.red` |
| 80 to 89 | `theme.amber` |
| 70 to 79 | `theme.text`, neutral |
| below 70 | `theme.blue` |

Use the HIGH when present, otherwise the low. A null temperature stays neutral.

Keep the existing rain-chance colour rule unchanged: `theme.blue` at 50 percent or more,
`theme.textDim` below.

That is three coloured elements on this page — tint, temperature, rain chance. That is one
more than the stock tiles carry, and it is justified because the tint is a background wash
rather than text. If it reads as noise on the real device, the tint is the first thing to
drop.

## Also fix: the emoji does not dim

A review found this and it belongs here. `canvas.ts` draws the emoji without honouring
`dim`, because colour emoji are bitmap glyphs and ignore `fillStyle`. So on a stale key
the text and border dim correctly while the emoji stays at full brightness, which
undercuts the staleness signal.

Fix by setting `ctx.globalAlpha` while dim before drawing the emoji, then restoring it.
Restore it in a way that cannot leak if the draw throws. Add a test proving a dimmed
emoji key differs from an undimmed one.

## What must not change

- The eighth key stays the wind and place tile. Its content is unchanged, though it should
  adopt the new font sizes where they help.
- The strip is unchanged.
- Presses still do nothing on this page.
- The percent-chance-only decision stands. **Do not add rainfall amounts.** The user was
  explicit.
- The other three pages must render identically. Their tests must pass untouched.

## Constraints

- ESM only. No CommonJS. Never write `require(` in `src/`, `bin/`, or `scripts/`.
- TypeScript strict with `noUncheckedIndexedAccess`. Imports use `.js`.
- **A log call must never throw**, and `log.once` guards anything repeating.
- **No test may open the device, perform real network I/O, or touch any path under `~`.**
- Prose in ASD-STE100 Simplified Technical English.
- Commit with a `feat:` prefix.

## Tests to write

- **No overlap.** For a key with a label, an emoji, temperatures and a rain chance, probe
  a pixel row inside each gap between bands and assert it is the key background. This is
  the test the user's complaint demands, so make it real: assert on the actual gaps at
  roughly y 16, y 52 and y 72.
- Each band renders ink where it should: probe inside bands 1, 3 and 4 and assert
  non-background pixels.
- The emoji sits inside band 2: probe near y 34 and assert ink, and probe near y 60 and
  assert no emoji ink there.
- A dimmed emoji key differs from an undimmed one.
- The condition tint comes from the same matcher as the emoji: for several forecast
  strings, assert the emoji and the tint agree, including a `then` string where severity
  wins.
- Heat colours at the boundaries: 90, 89, 80, 79, 70, 69, and a null temperature.
- The rain-chance colour still flips at exactly 50.
- `95°/77°` at 16 px fits within the usable width — assert the measured width is at most
  81 px so a future font change cannot silently clip it.
