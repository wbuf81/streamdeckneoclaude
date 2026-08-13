### Task 27: Spotify page — fix the cold load, new controls, an idle animation

Three items. The first is a bug the user reported from real hardware, and it is the most
important of the three.

**Files:** `src/sources/spotify.ts`, `src/pages/spotify-page.ts`, `src/render/specs.ts`,
`src/render/canvas.ts`, and their tests.

---

## Part 1: the page does not paint when nothing is playing

### The user's report, verbatim

> "on spotify - if nothing is playing and i goto it, it wont load, i have to go to a new page
> and back."

### Do NOT guess at the cause. Reproduce it first.

Write a failing test that reproduces the reported behaviour before you change any code, then
fix the cause the test exposes. A plausible fix aimed at the wrong cause is worse than no fix,
because it looks done.

Here is the leading hypothesis, offered as a starting point and **not** as a conclusion:
`SpotifySource.state` starts as `null`, and `parsePlayer` returns `null` for an empty body or
no track. So a first poll that finds nothing playing produces a snapshot identical to the
initial one, the change-detection key does not move, and no `change` event fires — meaning
nothing triggers a repaint. Leaving the page and returning forces a full repaint, which is
exactly the workaround the user found.

**Verify or refute that** by reading the code and by testing. Check specifically:

- Does the source emit `change` after its **first completed poll**, even when the result is
  "nothing playing"?
- Does `onEnter` force a full repaint, and does the daemon's dirty-key hash suppress the
  write when the computed hashes match what is already on the glass?
- Is the page returning early, or throwing, when `getState()` is `null` and there is no art?

Whatever the cause turns out to be, the fixed behaviour is: **entering the page paints a
correct frame promptly, with nothing playing and from a cold start, with no page flip needed.**

State plainly in your report what the real cause was. If the hypothesis above was wrong, say
so — that is useful information, not a failure.

---

## Part 2: the new control layout

The user replaced the heart with volume:

> "insread of the volume button, lets do play/pause - heart then left then right tracks"

then:

> "okay you cabn show volume thats fine over heart"

So the heart is **removed** and volume stays. Final layout:

```
┌───────────┬───────────┐
│  album    │  ▶ / ⏸    │  keys 0,1,4,5 = art
│   art     ├───────────┤  key 2 = play/pause
│   2x2     │  VOL 65%  │  key 3 = volume
│           ├───────────┤  key 6 = previous track
│           │ ◀ PREV    │  key 7 = next track
└───────────┴───────────┘     (6 and 7 are the bottom row)
```

| Key | Was | Now |
| --- | --- | --- |
| 2 | play/pause | play/pause, unchanged |
| 3 | next track | **volume**, moved here from key 7 |
| 6 | heart | **previous track**, new |
| 7 | volume | **next track**, moved here from key 3 |

- Keep the volume tile's existing behaviour and label exactly as it works today, including
  `VOLUME_STEP`. Only its key index changes.
- **`previous()` does not exist yet.** Add it to the source beside `next()`, calling
  `PUT /v1/me/player/previous`, following the existing method's shape for token handling,
  error handling and its return value.
- **Delete the heart**, including its saved-library read path if nothing else uses it. The
  saved-tracks Set exists only to feed the heart; if so, remove it and stop paging
  `GET /me/tracks` at startup. Confirm with grep before deleting, and say in your report what
  you removed.
- Previous and next sit side by side on the bottom row, so they read as a pair.

Do not add volume down. The existing tile cycles volume up with wraparound and the user has
not asked for more.

---

## Part 3: a good-looking idle state

### The user's request, verbatim

> "when nothing is playing lets do a cool nothing showing thing"

Build a **procedural animation** across the four art keys. No new image assets, no downloads.

- Draw vertical bars in Spotify green that rise and fall slowly, like an equaliser at rest.
- Give **each of the four art keys a different phase offset**, so a wave appears to travel
  across the 2×2 block. Draw each key independently from its own phase — **do not** attempt
  cross-key 2D cropping. Per-key drawing keeps the geometry trivial and testable.
- Add a `KeySpec` field for it, for example `pulse?: PulseSpec` holding the phase, the bar
  count and the colour. **It must be in `keyHash`** — lesson 11 — otherwise the animation
  freezes after its first frame, which is the exact defect that hit the Spotify 2×2 art.
- Drive it from `nowMs`, never `Date.now()`. Set the page's `tickMs` fast enough to look
  smooth. The device sustains 45 fps across all eight keys and `renderKey` costs 0.032 ms, so
  the render rate is the only constraint — but do not raise the rate while a track is playing
  and the tile is a still image.
- The strip shows a clear idle message plus the clock. The strip fits **30 characters at
  13 px**.
- The controls stay live and usable in this state, so the user can press play.

Test the animation by probing pixels at two different `nowMs` values and asserting the bar
heights differ. An animation test that renders one frame proves nothing.

---

## Constraints

- ESM only, no `require(`. Strict TypeScript with `noUncheckedIndexedAccess`. Imports use `.js`.
- Pages stay **pure**: no canvas, no HID, never `Date.now()`.
- `render` and `onKeyPress` must never throw. A `null` state, no art, and no device must all
  render a sensible key.
- **Never read or print `~/.local/state/deckd/spotify.json`.** It holds the user's real refresh
  token. No live Spotify API calls in tests — inject a fake `fetch`.
- A 401 refreshes and retries. **A 403 is never retried** — Spotify blocks the save endpoints
  at the app level and no code change fixes it.
- `log.once` on repeating paths, never `log.warn`. A log call must never throw.
- The other three pages must render **identically**. Hash a key from each before and after.
- No test may open the device, do network I/O, or touch any path under `~`.
- Prose in ASD-STE100 Simplified Technical English.
