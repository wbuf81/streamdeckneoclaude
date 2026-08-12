### Task 22: Animate the Claude session crabs

**Goal:** the crab on each session key animates, and its animation matches what that
Claude session is doing.

**Files:**
- Modify: `src/pages/types.ts` — the `Page` interface gains a tick rate and a millisecond clock
- Modify: `src/render/sprites.ts` — load frame sequences, not single images
- Modify: `src/daemon.ts` — a per-page render interval
- Modify: `src/pages/claude-page.ts` — pick a frame per state
- Test: extend `tests/render/sprites.test.ts` if present or create it,
  `tests/daemon.test.ts`, `tests/pages/claude-page.test.ts`, `tests/page-manager.test.ts`

Task 21 already produced the assets: `assets/crab/<state>/NN.png` plus
`assets/crab/<state>/meta.json` holding `{ frameCount, delayMs }`. Read its report for
the exact states and frame counts before you start.

## The budget is generous, and it is measured

I benchmarked the real device:

| Scope | Throughput |
| --- | --- |
| one key | 2043 key-writes/sec |
| four keys | 422 key-writes/sec, 105 fps as a group |
| all eight keys | 362 key-writes/sec, 45 fps as a group |
| the strip | 1218 writes/sec |

So USB is not the constraint. **The constraint is that the daemon currently renders at
1 fps.** That is the thing to change, and to change carefully.

## Part 1: a per-page render interval

Different pages want different rates. The Claude page wants roughly 10 fps to animate.
The weather page changes every fifteen minutes and would waste CPU at 10 fps.

In `src/pages/types.ts`, add to `Page`:

```ts
  /** How often this page wants to be rendered, in milliseconds. Default 1000. */
  readonly tickMs?: number
```

In `src/daemon.ts`:

- Read the current page's `tickMs ?? 1000` and use it for the render interval.
- **Re-arm the interval when the page changes**, because the new page may want a
  different rate. The page change happens in `PageManager`, so the daemon must notice it
  — either re-read `tickMs` on every press that changes the page, or compare the current
  page's `tickMs` each tick and re-arm when it differs. Prefer the explicit approach: after
  any page change, clear and re-arm.
- Do NOT raise the rate for pages that do not ask for it.

**Why this is safe for USB:** the dirty-key comparison already means an unchanged key
produces no write. A page rendering at 10 fps with static content issues zero writes. Only
the animating keys write. Prove that with a test: a page with `tickMs = 100` and unchanged
content produces no key writes across many ticks.

**Watch the CPU, and report it.** Ten renders per second of four animating keys means
about 40 `renderKey` calls per second, each building a 96 x 96 canvas. Measure the actual
cost with a timing loop and put the number in your report. If a single `renderKey` costs
more than about 2 ms, say so plainly rather than shipping a daemon that burns a core.

## Part 2: a millisecond clock for the page

Frames advance faster than one per second, so `render(now)` in whole seconds cannot pick
them. Add a second parameter rather than changing the units of the first, because every
existing page and test uses seconds:

```ts
  render(now: number, nowMs?: number): DeckFrame
```

`now` stays unix seconds and every existing behaviour keeps using it. `nowMs` is unix
milliseconds and defaults to `now * 1000` when absent. The daemon passes both. Tests pass
`nowMs` explicitly so animation is deterministic — never call `Date.now()` inside a page.

## Part 3: frame sequences in the sprite module

`src/render/sprites.ts` currently loads one image per name. Extend it:

- `loadSprites()` reads each state directory, decodes every frame with `await loadImage`,
  and caches the ordered array plus the `delayMs` from `meta.json`.
- Add `getSpriteFrame(state: string, nowMs: number): Image | null`, which picks
  `frames[Math.floor(nowMs / delayMs) % frames.length]`.
- Keep the existing single-image `getSprite` working, or migrate its one caller — do not
  leave two mechanisms if one suffices.
- A missing state directory, a missing `meta.json`, or a zero frame count must degrade to
  null and log once. The keys then render without a crab, which is graceful.
- **Guard `delayMs` against zero or a negative value** with a floor of 40 ms, or the
  modulo divides by zero and the render loop throws.
- Decoding still happens ONCE at startup. Nothing decodes on the render path — that rule
  has already been broken once in this project and cost a round.

## Part 4: the Claude page picks a frame per state

Map each session state to its sprite directory. The states are exactly `idle`,
`thinking`, `tool`, `permission`, `done` and the `unknown` fallback.

Use the mapping Task 21 extracted. If a state has no frames, fall back to `idle`, and if
that is also absent, draw no crab.

The permission pulse already alternates the border once per second using `now`. Keep it
exactly as it is — it is driven by seconds and must not start flickering at 10 fps.

## What must NOT change

- The gauge row, the strip, the key assignment, and the press behaviour are all untouched
  by this task. Another task is redesigning the gauge row; do not touch it.
- The other three pages must render identically and must not gain a faster tick.
- The permission pulse stays at one second.

## Constraints

- ESM only. No CommonJS. Never write `require(` in `src/`, `bin/`, or `scripts/`.
- TypeScript strict with `noUncheckedIndexedAccess`. Imports use `.js`.
- **A log call must never throw**, and `log.once` guards anything repeating. At 10 fps an
  unguarded log would fill the disk in minutes, so this matters more here than anywhere.
- **No test may open the device, perform real network I/O, or touch any path under `~`.**
- Prose in ASD-STE100 Simplified Technical English.
- Commit with a `feat:` prefix.

## Tests to write

- `getSpriteFrame` advances with `nowMs` and wraps at the frame count.
- A `delayMs` of zero or negative is floored rather than dividing by zero.
- A missing state falls back to `idle`; a missing `idle` yields null and logs once.
- The Claude page emits a different crab frame for two `nowMs` values one frame apart, and
  the SAME frame for two values inside one frame's duration.
- The permission pulse still alternates on whole seconds, not on frames.
- The daemon uses the current page's `tickMs`, and re-arms when the page changes.
- A page with `tickMs = 100` and unchanged content produces ZERO key writes across many
  ticks — this is the test that proves animation costs nothing when nothing moves.
- An animating key DOES write on each frame change.
- The Spotify, stocks and weather pages keep the default 1000 ms interval.
