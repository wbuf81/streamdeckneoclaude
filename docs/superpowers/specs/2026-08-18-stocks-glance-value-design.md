# Stocks page glance value — design

Date: 2026-08-18. Status: approved direction, not yet implemented.

## Goal

Make the stocks board readable from across the room, before any digit is
readable. Three changes, all driven by data the page already has:

1. A heat wash behind each tile, from that symbol's own move.
2. The two round buttons carrying market breadth.
3. Market state setting the mood for both.

A scrolling ticker tape on the strip is agreed as the NEXT piece of work and is
out of scope here. It needs a renderer change; these three need none.

## What the page has and wastes

`Quote` already carries `price`, `previousClose`, `changePercent`, `spark`,
`dayHigh`, `dayLow`, `week52High`, `week52Low`, `volume` and `asOf`, plus a
per-symbol staleness flag and a five-value `MarketState`.

The page draws static text, a small sparkline, and a trend-coloured left border.
No tile sets a background. Both round buttons are flat grey — as they are on
every one of the seven pages, so this is the first page to use them for data.

## 1. Heat wash

Each ticker tile gets `bg`, interpolated from the neutral key background toward
green or red by the size of the day's move.

**The scale is ABSOLUTE, not relative to the board.** It saturates at
`HEAT_SATURATION_PCT` (3 percent). A relative scale — normalising against the
biggest mover — would always look contrasty, but it would paint a 0.3 percent
nudge exactly as brightly as a 5 percent crash. This project does not
misrepresent data (lesson 18, and the "never a fabricated value" rule running
through every page). A flat day is allowed to look calm, because it IS calm.

Measured live on 2026-08-18, the eight real symbols spanned `-3.47%` to
`+2.33%`, with two inside ±0.2 percent. So a 3 percent saturation puts real
boards across most of the range while leaving room above it.

Rules:

- `changePercent` null or non-finite is UNKNOWN. The tile keeps the plain
  background — never a fabricated neutral-green.
- A real 0.00 percent is flat, and also keeps the plain background.
- Any non-zero move gets at least `HEAT_FLOOR` of the wash, so a small real move
  is visible rather than rounding away to nothing.
- Every wash stays dark enough for white text. The cap is a maximum blend
  fraction toward the trend colour, verified by a contrast test, exactly as the
  weather tints are.

The existing trend-coloured border stays. Border and wash come from the SAME
`trendOf` result, so they cannot disagree.

## 2. Round buttons as market breadth

`strip()` already counts how many symbols are up and how many are down, to
write "5 up · 3 down". That count moves into one exported function, and both the
strip text and the button colour read it — so the lights and the words can never
disagree.

| Board | Both buttons |
| --- | --- |
| More up than down | Green |
| More down than up | Red |
| Equal, with at least one counted | Amber |
| Nothing counted, or offline | Grey |

Both buttons take the same colour. One board-level signal reads better than two
half-signals, and the buttons are page navigation, so they must not look like
two different controls.

In the DETAIL view the buttons carry that one symbol's own trend instead, since
the whole frame is about one symbol.

## 3. Market state sets the mood

One multiplier scales both the heat wash and the button colour:

| State | Multiplier | Why |
| --- | --- | --- |
| `open` | 1.0 | Live. Full strength. |
| `pre`, `post` | 0.55 | Real trading, thinner and quieter. |
| `closed` | 0.3 | Yesterday's news. Calm. |
| `unknown` | 0.3 | We do not know the market is live, so it must not look live. |

`unknown` deliberately shares `closed`'s multiplier but NOT its meaning. The
strip keeps saying `MARKET UNKNOWN`, which is the only place that states the
fact. Treating unknown as calm is a display choice; claiming it is closed would
be a lie, and `STATE_LABELS` already refuses to.

Per-symbol staleness keeps working exactly as it does now, on top of this: a
stale tile dims through `dim`, independently of the market-wide mood.

## Testing

1. The heat scale is monotonic in the size of the move, and symmetric in sign.
2. It saturates at `HEAT_SATURATION_PCT` and never exceeds the blend cap.
3. A null or non-finite `changePercent` gets the plain background — proven
   against the real `parseQuote` behaviour for a missing price, not a
   hand-made null.
4. A real 0.00 percent is flat and unwashed.
5. Every wash keeps white text above a measured contrast margin, for the
   strongest move at every market state.
6. Breadth colour and strip text come from one function and always agree,
   including the offline and nothing-counted cases.
7. The detail view's buttons follow the selected symbol's trend, not breadth.
8. Each market state scales the wash, and `open` is strictly the strongest.
9. `unknown` never renders as `closed`'s label while sharing its multiplier.
10. A stale tile still dims, on top of any wash.

Every new test gets the break-the-fix check.

## Preview before deployment

Two contact sheets, because one distribution hides defects — the lesson the
weather work paid for:

- The real live board, from measured values.
- A synthetic FLAT day, every symbol inside ±0.4 percent, which is the case an
  absolute scale is least flattering to.

Both go to the user before anything reaches the device.

## Out of scope

- The ticker tape on the strip. Next piece of work.
- The directional drift effect. The user deferred it.
- Any change to the sparkline, including the previous-close baseline idea.
- Any new `fx` variant. These three changes need no renderer work at all.
