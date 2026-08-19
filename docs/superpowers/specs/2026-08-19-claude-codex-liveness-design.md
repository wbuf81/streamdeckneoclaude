# Claude and Codex pages — liveness design

Date: 2026-08-19. Status: approved by the user, not yet implemented.

All three pieces at once, by the user's choice.

## Piece 1 — a session's state becomes something you feel

A session's state is the most useful fact on the deck and today it is a border
colour plus a text label. Six states render identically apart from hue.

| State | Motion | Why |
| --- | --- | --- |
| `thinking` | slow upward drift | working steadily |
| `tool` | horizontal streaks | something is running |
| `permission` | **whole-tile pulse** | **Claude is BLOCKED waiting on you** |
| `idle`, `done` | none | nothing is happening |
| `unknown` | none | an absent signal is not a state (lesson 18) |

`permission` is the point of the whole piece. It is the one state that means the
user is the bottleneck, and it should be impossible to miss from across the room.
Vertical drift and horizontal streaks are deliberately different AXES, not just
different speeds, because two intensities of the same motion are not
distinguishable at a glance.

Codex tasks carry no state field — only `updatedAt` — so a task that moved within
`CODEX_ACTIVE_MOTION_SECONDS` drifts gently and the rest stay still. That is a
real signal ("this one just moved"), not an invented one.

### The renderer additions this needs

**`FxSpec.color?: Rgb`.** Deliberately omitted when the drift variant had one
consumer; this is its third, so it now pays for itself. When set it replaces the
variant's own base hue, so motion can carry `stateColor(state)`.

`sun` and `storm` ignore it: their palettes are semantic rather than decorative —
the sun IS amber and lightning IS white. Documented at both call sites.

**A new `pulse` variant.** Brightens the whole key on a sine. Nothing existing
does this: `storm`'s flash is a lightning event with a bolt, and every other
variant is particles. Its period is short enough to read as urgent and long enough
not to strobe.

### Legibility

A session tile carries text, so the same contrast ladder the stocks tiles have
applies: the layer must stay measurably below the text. The cap already
guarantees the ceiling; a test proves it on the real shipped tiles for every
state.

## Piece 2 — the budget becomes something you feel

Both cap tiles (Claude's 5-hour and weekly, Codex's usage cap) gain a background
wash whose colour AND strength come from the percentage.

The hue comes from `barColor`, the SAME function the tile's bar already uses, so
the bar and the wash can never disagree about whether 87 percent is amber or red.
Strength scales with the percentage, so a nearly-full budget is both redder and
stronger.

An unknown percentage draws no wash. A stale sample keeps its existing `STALE`
treatment and draws no wash either — a coloured budget that might be fifteen
minutes old would be worse than a plain one.

The Claude page already computes a **pace** (`fast` / `slow` / `even`). A `fast`
pace gives the burn-rate tile an upward drift in `barColor`'s hue: the direction
carries the RATE and the colour carries the valence. `slow` and `even` stay still.

## Piece 3 — titles get room to breathe

Codex task titles arrive up to 64 characters and are truncated hard onto a 96 px
key. The strip's tape scrolls the full titles of the active tasks, one segment
each. The Claude strip does the same for its live sessions' labels.

Both strips keep line 1 as it is, so the most important single fact stays readable
without waiting for the tape. Both already set a right-aligned field, and the
tape's clip excludes that gutter, so the two coexist.

No tape when there is nothing live — those strips keep their current messages.

## Render rate

Both pages need a fast tick only while something moves. The Claude page currently
declares a FIXED `tickMs = 100`, which is wrong in both directions now: it burns
the fast rate when every session is idle, and it is what the tape and the state
motion need when they are running.

It becomes a getter, following the rule the Spotify page's three revisions
established and this project now records: **the rate follows what actually moves.**

`tests/pages/tick-rate.test.ts` has lost a page to the same trap three times, so
neither page's conditional rate goes there — each is tested in its own suite with
fakes carrying real data.

## Testing

1. `FxSpec.color` replaces the base hue for the variants that honour it, and is
   ignored by `sun` and `storm`.
2. `pulse` brightens and dims over its period, stays under the cap, and is
   deterministic for one clock.
3. Each session state maps to its documented motion, and `idle`, `done` and
   `unknown` map to none.
4. The motion carries `stateColor`, so a permission tile's layer is the
   permission hue.
5. Text stays measurably brighter than the layer, on the real tiles, for every
   state.
6. The budget wash takes its hue from `barColor` and its strength from the
   percentage; unknown and stale draw none.
7. A `fast` pace drifts, `slow` and `even` do not.
8. Each strip tapes its live titles, caps the count, coexists with the
   right-aligned field, and is absent when nothing is live.
9. Both pages' `tickMs` is fast only while something moves, and each page's own
   suite covers it.
10. Every existing guarantee on both pages: staleness, the empty and
    unavailable states, the crab animation, and the key assigner.

Every new test gets the break-the-fix check.

## Preview

Contact sheets over several situations, since one hides defects: every session
state, a budget at 20/70/95 percent, a stale budget, a fast and a slow pace, and
both empty pages.

## Out of scope

- The cross-page urgency light. The round buttons are visible from every page, but
  each page sets them for itself, so an ambient "a session needs you" signal that
  survives flipping pages is an architectural change and its own piece of work.
