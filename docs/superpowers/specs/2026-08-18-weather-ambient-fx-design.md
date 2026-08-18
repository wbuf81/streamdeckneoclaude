# Weather ambient effects — design

Date: 2026-08-18. Status: approved direction, not yet implemented.

## Goal

Each weather day tile shows a live effect behind its numbers, chosen by the
same forecast the tile already reports. Rain falls on a rainy tile. Snow
drifts on a snowy one. A storm tile flickers. The forecast becomes readable
across the room, before the digits are readable at all.

The effect must carry information. Motion for its own sake is not the goal,
and it must never cost legibility.

## Scope

This design covers the weather page and one renderer field. It builds the
shared effect layer that a later standalone animation page will reuse. It
changes no other page.

## The renderer field

`KeySpec` gains one optional field:

```ts
export type FxVariant = 'rain' | 'snow' | 'storm' | 'fog' | 'wind' | 'sun' | 'cloud'

export interface FxSpec {
  variant: FxVariant
  /** Injected clock, unix milliseconds. Never `Date.now()` inside a page. */
  nowMs: number
  /** 0 to 1. Scales density, rate, or brightness, by variant. */
  intensity: number
  /** Decorrelates neighbouring tiles. The key index is enough. */
  seed: number
}
```

`renderKey` draws the layer immediately after the background fill and before
the image, border, glyph, emoji, and text. Content always lands on top.

`fx` is **opt-in per key**. Its absence takes the exact legacy path, byte for
byte, exactly as `lineSizes` and `SparkSpec.slice` already do. That invariant
is what keeps every existing pixel proof on every other page valid.

`fx` is a plain field, so `keyHash`'s spread already covers it. Lesson 11
requires a test that proves this rather than trusting the spread.

## Legibility, enforced in one place

Every effect draws through one clamp: no fx pixel may exceed `FX_MAX_ALPHA`.
The clamp lives in the renderer, not in each effect, so a new variant cannot
opt out of it. A test asserts the cap by measuring the brightest pixel of an
fx-only render at full intensity.

`dim` applies to the layer through `globalAlpha`, the same way the image and
emoji paths already handle it (lesson 15).

## Condition mapping — one lookup, not two

`weather-page.ts` already keys its background wash on the emoji that
`weatherEmoji` produced, so the wash and the icon cannot disagree. The effect
joins that same table:

| Emoji | Condition | Variant | Intensity from |
| --- | --- | --- | --- |
| `⛈` | thunder | `storm` | precip percent |
| `🌨` | snow, sleet, ice | `snow` | precip percent |
| `🌧` | rain, showers, drizzle | `rain` | precip percent |
| `🌫` | fog, haze, mist | `fog` | fixed |
| `💨` | wind | `wind` | fixed |
| `☁️` | cloudy, overcast | `cloud` | fixed |
| `⛅` | partly cloudy | `cloud` | fixed, lower |
| `☀️` | sunny, clear | `sun` | fixed |

`CONDITION_TINTS` becomes `CONDITION_STYLES`, one row per emoji carrying both
the tint and the effect. `conditionTint` stays exported and keeps reading that
table, so its existing agreement test with `weatherEmoji` still holds.

Precip-driven intensity maps 0 to 100 percent onto `FX_INTENSITY_MIN` to 1. A
null precip percent — unknown, not zero — takes `FX_INTENSITY_MIN`. The page
never fabricates a reading.

## Which keys animate

- The seven day tiles on the grid view.
- The day tile and the two period tiles inside the detail view. Each period
  carries its own emoji and its own precip percent, so each drives its own
  effect.
- No effect on the wind and conditions tiles, the text tiles, or BACK. They
  report no condition.

A tile with no forecast data draws no effect. Placeholder dashes are not a
condition.

## Staleness stops the motion

When the source reports stale data, or a tile has no day, the page omits
`fx`. The tiles already dim in that case; now they also freeze. A stopped
animation is a stronger staleness signal than dimming alone, and it follows
the project's rule that a missing signal is never rendered as a real state.

## Render rate

`WeatherPage.tickMs` becomes a getter. It returns `FX_TICK_MS` when the frame
it is about to build would carry at least one effect, and `undefined`
otherwise. This matches `SpotifyPage`, which raises its rate only while its
idle animation actually shows.

`FX_TICK_MS` is 100 ms, the same value the Spotify idle already uses. Eight
animated keys at that rate is about 80 key-writes per second against a
measured ceiling of 362 (`docs/VERIFIED-FACTS.md`). The wire has ample room.

`tests/pages/tick-rate.test.ts` currently asserts that `WeatherPage` declares
no `tickMs` at all. That assertion becomes conditional: no effect, no raised
rate. The test keeps its teeth for the empty, offline, and stale cases.

## Determinism

Each effect is a pure function of its `FxSpec`. A page never reads the wall
clock; it uses the `nowMs` the daemon injects, so a test passes an explicit
clock and gets an identical frame.

Following the `rainColumnSpan` precedent, each effect with looping geometry
exports a small pure function describing that geometry, so a test proves the
loop instead of trusting a comment. The rain and snow loops must enter from
above the tile and leave below it, with every particle off-key at the wrap
instant.

## Testing, and why the existing proofs survive

The weather page's current pixel proofs assert that a tile's margins and band
gaps match `key.bg`. An effect layer paints into exactly those regions, so
those assertions would fail for the right reason and the wrong cause. Deleting
or loosening them would leave the page's real geometry unproven — lesson 22's
exact failure shape.

The fix is to separate content ink from the layer beneath it. A test helper
renders the shipped key twice: once as the page built it, and once with its
text and emoji removed but the same `fx`. Every pixel that differs is content
ink. The margin and band-gap proofs then assert **no content ink** in those
regions, which is the property they always meant to assert, and they now hold
with the effect running.

New tests:

1. Content-ink margin and band-gap proofs, on the real shipped keys, with
   effects on.
2. The `FX_MAX_ALPHA` cap, measured on the brightest fx-only pixel at full
   intensity.
3. Text stays brighter than the layer beneath it, by a measured margin.
4. Loop geometry for the falling variants, at the wrap instant.
5. `keyHash` changes when `fx` changes, including `nowMs` alone.
6. Absent `fx` renders byte-identical output to the pre-change renderer.
7. Every emoji in the condition table maps to a variant, driven from
   `weatherEmoji`'s real output rather than a hand-written emoji list.
8. Stale and empty states omit `fx` and leave `tickMs` undefined.

Every new test gets the break-the-fix check: break the code, watch the test
fail, restore it.

## Sibling sweep

`fx` is opt-in, so no other page changes behaviour. The sweep still checks the
three other pages that set `bg` for an assumption that the background fill is
the last thing drawn beneath their content, and confirms no page reuses a
`KeySpec` object across frames, which a per-frame `nowMs` would otherwise make
visible.

## Out of scope

- The standalone animation page. It reuses this layer later.
- Wind speed as an intensity source. `PeriodDetail.windSpeed` is a free-text
  string such as `"5 to 9 mph"`. Parsing it is a separate decision, and the
  wind variant uses a fixed intensity until then.
- Any change to the strip, the round buttons, or page transitions.
