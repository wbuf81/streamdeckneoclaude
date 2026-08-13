### Task 28: Blank the deck while the screen is locked

**Files:** create `src/lock-state.ts`; modify `src/daemon.ts` and `bin/deckd.ts`; plus tests.

---

## Why

The user confirmed from real hardware:

> "it stays lit and works when my screen is locked yes"

So while the Mac is locked the deck keeps rendering **and keeps accepting presses**. The
Claude page shows project names, session states and usage percentages; the stocks page shows
the user's watchlist. Anyone walking past a locked machine can read all of it. The screen
locks and the deck does not.

Secondary: the sources keep polling Yahoo, Spotify and the weather service every minute for
as long as the machine sits locked, and discard every result. Spotify's rate limit is real and
those calls spend the user's own credential.

**This is a privacy fix.** Treat it as such when choosing defaults.

---

## Part 1: detect the lock state

Create `src/lock-state.ts`. It polls, because macOS gives a bare `node` process no practical
way to subscribe to lock notifications.

**Measured:** `ioreg -n Root -d1 -k CGSSessionScreenIsLocked` costs about **4 ms** per call, so
a **5 second** interval is free. Do not poll faster.

Verified on this machine while **unlocked**: the key is **absent** from the output entirely.
The locked output was **not** verified, because verifying it means locking the user's screen.
So handle all of these:

| Output | Meaning |
| --- | --- |
| key absent | unlocked |
| `"CGSSessionScreenIsLocked" = Yes` | locked |
| `"CGSSessionScreenIsLocked" = No` | unlocked |
| anything else, or the command fails | **unknown** |

**Unknown must resolve to UNLOCKED.** A detection bug that blanks the deck forever is a
broken product; a detection bug that leaves it lit only matters while the machine is locked.
Log the unparseable case with `log.once` so it is diagnosable, and `log.clearOnce` on
recovery. This poll repeats forever — `log.warn` here is a defect, per lesson 5.

Follow the existing source pattern: an **injected** command runner and clock, an explicit
`stopped` flag (lesson 8 — clearing the timer is not enough, and the test must hold the runner
unresolved or the race window never opens), a `change` event only when the state actually
changes, and it must **never throw**.

**No test may spawn `ioreg` or lock the screen.** Inject a fake runner.

---

## Part 2: blank on lock, restore on unlock

In `src/daemon.ts`:

**On locked:**

1. Render a fully blank frame through the **normal render path** — every key `kind: 'blank'`,
   an empty strip, both round buttons black. Reuse the existing pipeline; do not add a new
   device method.
2. Then `setBrightness(0)`. Note it is currently **never called anywhere**, so the panel sits
   at the device default. Blanking the pixels *and* dropping the brightness is deliberate:
   brightness alone may leave a faint image, and a blank frame alone leaves a lit panel.
3. Stop the render timer.
4. Stop the sources by calling the current page's `onLeave?.()`. Pages already forward
   visibility to their sources, so this needs no new plumbing.
5. **Ignore every key press while locked.** The user reported that presses work behind the
   lock screen. A press cannot be useful there, and focusing a terminal from a locked machine
   is a capability to remove, not to preserve. Return early, before any page or focus call.

**On unlocked:**

1. `setBrightness` back to a named default constant.
2. **Invalidate the dirty-key state** (`lastKeys`, `lastStrip`, `lastButtons`) so the whole
   panel repaints. The daemon writes a key only when its hash changes, so a stale hash would
   leave the deck blank — see lesson 11 for the same trap in a different place.
3. Call the current page's `onEnter?.()` to resume its source.
4. Re-arm the render timer and render once immediately, so the deck does not wait a full tick.

Order matters in both directions. Blank the pixels **before** dropping brightness; restore
brightness **before** repainting.

---

## Part 3: wake from sleep

Whether the deck survives sleep is **not verified** — the user has confirmed the locked case
only. Handle it defensively rather than assuming.

The daemon's own timer is the signal: if far more wall-clock time has passed since the last
tick than the interval allows, the machine slept. On noticing that:

- Force a full repaint, invalidating the dirty-key state as above. A device that lost and
  regained power holds no state the daemon knows about.
- **Re-probe the lock state instead of trusting the last value.** A machine that sleeps
  unlocked very often wakes locked.

The device layer already has a reconnect retry loop, so a dropped USB connection is handled.
Do not duplicate it.

---

## Constraints

- The daemon is INSTALLED and running under launchd, holding the Stream Deck. **Do NOT run
  `launchctl`, do not stop or `pkill` the daemon, do not open the device.**
- **Do not lock the screen, sleep the machine, or change any system setting.**
- **Touch nothing under `~`.** No test may read, write, rename or delete any path under `~`.
  `~/.local/state/deckd/deckd.log` carries a `SENTINEL do not delete` tripwire line, and
  `spotify.json` holds a real token — never read it.
- **Do not run a scratch script that imports `dist/` or `src/log.js`** against the real state
  directory. One did that earlier and wrote a test error into the user's real log;
  `tests/setup.ts` only silences logging inside vitest.
- Keep the process **alive** while locked. It holds the exclusive USB handle, and exiting
  would fight launchd's `KeepAlive`.
- ESM only, no `require(`. Strict TypeScript with `noUncheckedIndexedAccess`. Imports use `.js`.
- `log.once` on every repeating path. A log call must never throw.
- The four pages must render **identically** when unlocked. Hash a key from each before and
  after.
- Prose in ASD-STE100 Simplified Technical English.

## Tests

Cover, with an injected runner and clock: absent key reads unlocked; `= Yes` reads locked;
`= No` reads unlocked; unparseable output reads unlocked **and** logs once, not once per poll;
a failing command reads unlocked; `stop()` mid-poll does not arm another timer; locking blanks
every key, the strip and both buttons, and sets brightness 0; unlocking restores brightness
and repaints all eight keys; a press while locked reaches **no** page and **no** focus call;
and a simulated clock jump forces a repaint and a fresh lock probe.
