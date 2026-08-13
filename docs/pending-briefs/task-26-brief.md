### Task 26: Claude page — a dedicated crab tile, three sessions, a flash you can see

Two defects the user reported from real hardware. Take both literally.

**Files:** `src/pages/claude-page.ts`, `src/render/specs.ts`, `src/render/canvas.ts`, and their
tests.

---

## Part 1: the crab draws over its own tile's text

### The user's report, verbatim

> "on the claude screen - the animated icon shows over the single tile text. what if we just
> put the animation on the top right and show at most 3 sessions ? leave the cute claude on
> his own tile always?"

That is a real overlap, and it is the same class of defect as the weather emoji in Task 24 —
see lesson 14 in `docs/LESSONS.md`. Overlapping text is not a tradeoff.

### The new layout, which the user chose

| Key | Contents |
| --- | --- |
| 0, 1, 2 | up to **three** sessions. Text only. **No crab behind the words.** |
| 3 | the **permanent Claude tile**: the animated crab, and nothing else |
| 4, 5, 6, 7 | the four usage gauges, unchanged |

Key 3 always shows the crab, whether or not any session is running. It is a mascot, not a
status slot, so it never turns into a session tile and never goes blank.

### Which state does the crab animate?

The **most urgent state across all sessions**, so the tile stays informative. Rank them:

    permission > tool > thinking > done > idle

With no sessions at all, use `idle`. Put this ranking in a named, exported constant with a
comment, and test it directly: given sessions in `idle` and `permission`, the crab must show
`permission`.

The crab tile carries no text. Removing the text is the point of the change.

### A fourth session becomes invisible, and that is intended

The user chose three sessions to win legibility. Do not add a "+1 more" indicator, a
rotation, or a smaller fourth tile. YAGNI.

Sessions keep their existing sort order, so the three shown are the three most recent.

---

## Part 2: the press flash is nearly invisible

### The user's report, verbatim

> "the 'flashes' are hard to see bc theyre onle the left strip"

Correct, and the cause is clear: Task 16 implemented the flash by recolouring the key
**border**, and this theme draws that border as a **left-edge strip**. So the flash was never
going to read as a flash.

### What to change

- The flash must paint the **whole key**: fill the entire key area with the flash colour,
  white on success and red on failure, so it is unmistakable at a glance.
- Text on a flashing key must stay legible, or be omitted for the flash's duration. Decide
  which, and **prove it with a pixel probe** — a white fill under white text is a blank key,
  which trades one invisible signal for another.
- Raise the duration. 200 ms was tuned for a thin border. A full-key flash can afford
  **250 ms**. Keep it a named constant with a comment stating the value and why.
- The flash still wins over the `permission` pulse while it is active, and the pulse resumes
  afterwards.
- It still applies to **every** key on the page, including gauge keys and empty session
  slots, where a red flash is honest feedback that a press did nothing.

### Keep these properties from Task 16

- An **expired** flash leaves no trace in `keyHash`, so the key stops being redrawn. Keep the
  test that proves it.
- The flash is per key: flashing key 0 must not change key 1.
- A press must never throw.

### Review the flash clock while you are here

`onKeyPress` has no clock, so expiry is anchored to the last `nowMs` the render loop saw.
Check the edge cases and fix any that misbehave: a press before the first render, a press
while the page is not visible, and a caller that omits `nowMs` so it defaults to
`now * 1000`. A flash must never stick permanently and never expire before it is drawn.

---

## Constraints

- ESM only, no `require(`. Strict TypeScript with `noUncheckedIndexedAccess`. Imports use
  `.js`.
- Pages stay **pure**: no canvas, no HID, and **never** `Date.now()`. The daemon supplies both
  clocks.
- `render` and `onKeyPress` must never throw.
- Any new `KeySpec` field must affect `keyHash` — lesson 11, and prove it with a test.
- `log.once` on repeating paths. A key press repeats. Never `log.warn` there.
- The other three pages must render **identically**. Hash a key from each before and after.
- No test may open the device, do network I/O, or touch any path under `~`.
- Measure pixels, do not reason about them — lesson 17. The gaps between bands and the
  legibility of text on a filled key both need real `getImageData` probes.
- Prose in ASD-STE100 Simplified Technical English.
