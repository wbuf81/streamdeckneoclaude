# Stocks directional drift — design

Date: 2026-08-18. Status: approved direction, not yet implemented.

## Goal

Each ticker tile drifts particles in the direction its stock moved: sparks
rising on a gainer, sinking on a loser, with density and speed from the size of
the move. Eight tiles, some rising and some sinking, make the board's shape
readable as motion rather than as text.

## Why motion, when the wash already encodes the same thing

The heat wash encodes direction as **hue** and magnitude as **strength**. Drift
encodes direction as **motion**, which the eye catches in peripheral vision
before it resolves colour. The two are redundant on purpose: that redundancy is
what lets the board be read from across the room, and it costs nothing because
both come from one number.

## The renderer addition

`FxVariant` gains `'drift'`, and `FxSpec` gains one optional field:

```ts
direction?: 'up' | 'down'
```

The renderer picks the colour, green for up and red for down, exactly as every
existing variant hardcodes its own palette — rain is blue, snow is white, sun is
amber. No `color` field: nothing needs one yet.

Absent `direction` defaults to `'up'`, and `sanitizeKeySpec` coerces any other
value to one of the two, the same way it already coerces `IdleSpec.col`/`row`.

Drawing:

- Particles are **tapered streaks**, brightest at the leading end and fading
  behind. Direction has to be unmistakable in a still frame, not only in motion,
  and a symmetrical dot cannot say which way it is going.
- Count and speed both scale with `intensity`.
- The established wrap rule applies: a particle enters one full length beyond one
  edge and leaves one full length beyond the other, so no particle is ever
  visible at the wrap instant. An exported span function makes that testable, as
  it is for rain, snow and wind.

## The contrast ladder

This is the real risk. A ticker tile will now carry FIVE trend-coloured elements:
the heat wash, the drifting particles, the sparkline, the change text and the
border. Same-hue layers turn to mush.

So the tile gets an explicit brightness ordering, tested rather than assumed:

```
heat wash  <  drift particles  <  sparkline  ≈  change text
```

The wash is a background at up to 0.3 blend. The particles sit above it because
the effect layer composites at `FX_MAX_ALPHA` over that wash. The sparkline and
the text draw at full theme strength on top of everything.

Two tests enforce it: the particles must be measurably brighter than the wash
behind them, and the sparkline must stay brighter than the particles. If the
ladder cannot be met, the drift colour changes before the cap does — the cap is
not negotiable.

## When drift runs, and when it does not

Drift is **decoration**: it carries nothing the still tile does not already say.
So it follows the weather rule, not the ticker-tape exception.

| Condition | Drift |
| --- | --- |
| Market open | Full speed |
| Pre-market, after hours | Slower |
| Market closed, or unknown | **None** |
| That symbol's quote is stale | **None** for that tile only |
| Change is flat, unknown, or the price is missing | **None** |

A closed market has no flow, so showing flow would be a claim the data does not
support. `unknown` shares that treatment, while the strip keeps saying
`MARKET UNKNOWN` — the same split the heat wash already uses.

Grid tiles only. The detail view carries no heat wash either, and eight drifting
keys about one symbol would be noise.

## Shared magnitude

The drift's intensity and the heat wash's strength come from **one** exported
function, on the same absolute 3 percent scale. Two functions grading the same
number would eventually disagree, and then a tile's colour and its motion would
tell different stories.

## Rate

No change. The page already renders at 40 ms while the ticker tape scrolls, and
the tape scrolls whenever there are quotes — which is a superset of when drift
runs. One rate serves both.

## Testing

1. Up and down drift differ, and each is deterministic for one clock.
2. Particles slide fully in and fully out before wrapping, both directions.
3. A tapered streak is asymmetric: its leading half is brighter than its
   trailing half, so a still frame shows direction.
4. Intensity raises both count and speed.
5. The contrast ladder: particles brighter than the wash, sparkline brighter
   than the particles, on the real shipped tile.
6. Text legibility survives, at the strongest move — the same proof the weather
   tiles get.
7. Drift is absent for closed, unknown, stale, flat, unknown-change, and
   no-price cases.
8. Pre-market and after-hours drift slower than open.
9. The wash and the drift read the same magnitude function.
10. `direction` is covered by `keyHash`, and a bogus value is coerced.
11. A non-finite `FxSpec` with `drift` renders safely — in a child process if it
    is measured to abort, in-process if it merely throws.

Every new test gets the break-the-fix check.

## Preview

The board with drift, at several instants, on the live distribution AND the flat
one, at every market state. One distribution hides defects.

## Out of scope

- Any change to the tape, the breadth lights, or the wash's own scale.
- Drift on the detail view.
- Drift on any other page.
