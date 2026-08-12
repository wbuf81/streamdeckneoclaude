### Task 16: Per-window focus, and press feedback

Two related improvements to the Claude page, both reported by the user from real hardware.

**Depends on Task 22**, which adds `Page.tickMs` and `render(now, nowMs)`. A 200 ms flash
cannot be seen at the current 1 fps render rate, so press feedback needs the faster tick
that task introduces.

**Files:** `src/focus-window.ts`, `src/pages/claude-page.ts`, `src/pages/types.ts` if a
press result must reach the page, plus the matching tests.

---

## Part 1: raise the right WINDOW, not just the app

### The user's report, verbatim

> "if i have two ghsotty windows open it doesnt open the other one if i press the other
> button. it only goes to a ghostty window if i dont have focus on either ghostty window"

That is exactly right, and it is a real limitation rather than a bug in the wiring.

### Why it happens — measured

`tell application "Ghostty" to activate` raises the APPLICATION, not a window. So it is a
no-op when the app is already frontmost, and when it is behind, macOS raises whichever
window was last used.

Two obstacles, both confirmed:

1. **Accessibility permission is NOT granted.**
   `osascript -e 'tell application "System Events" to get name of every window of process "Ghostty"'`
   fails with `-1728 not allowed assistive access`. Automation permission — which already
   works — is not sufficient. Raising a specific window needs `System Events` and `AXRaise`,
   which require Accessibility.
2. **`pid` cannot identify the window.** Ghostty serves all its windows from ONE process, so
   every session's `pid` walks up to the same app process. The workable discriminator is the
   window **title**, matched against the session's `cwd`.

### The permission problem is the user's to solve, and may not be smooth

The daemon runs as a bare `node` binary under launchd, so there is no app bundle to grant.
The user must add that binary manually in System Settings → Privacy & Security →
Accessibility, and macOS may never show a prompt. **Tell the user honestly if it does not
work cleanly rather than presenting a half-working feature as done.**

### What to build

- Extend `src/focus-window.ts` with a window-targeting path that:
  - Lists the windows of the resolved application via `System Events`.
  - Scores each title against the session's `cwd` — the basename is the strongest signal,
    since Ghostty titles usually carry the directory or the running command.
  - Raises the best match with `AXRaise` plus `set frontmost to true`.
  - **Falls back to the existing app-level `activate`** when Accessibility is unavailable,
    when no window scores above a threshold, or on any error. The current behaviour must
    never regress — a worse outcome than today is not acceptable.
- Detect the `-1728` Accessibility failure specifically and report it with `log.once`, so
  the user learns what to grant instead of seeing silence. Never retry it in a loop; it
  cannot succeed until a human grants permission.
- Keep the existing safety properties: `focusWindow` **must never throw**, the AppleScript
  injection guard rejecting `"` and `\` stays, and `findTerminalPid`'s bounded walk stays.

### Tests

Keep them pure — no `osascript`, no windows raised. Inject the runner. Cover: title scoring
picks the window whose title contains the cwd basename; a tie or no match falls back to app
activation; a `-1728` error falls back AND logs once; repeated failures log once, not per
press; and a window title containing a quote or backslash is rejected rather than escaped.

---

## Part 2: press feedback

### Why

Right now a press gives no acknowledgement at all. Combined with Part 1's limitation, a
press that does nothing is indistinguishable from a press that did not register. The
project spec asked for this and the plan never carried it across — that omission is mine.

### What to build

The spec's rule: **flash the key border white on success, red on failure**, for about
200 ms.

- `focusWindow` already returns a boolean, so the page knows the outcome.
- Store a transient flash on the page: the key index, the outcome, and an expiry in
  milliseconds. `render(now, nowMs)` draws the border white or red while unexpired, then
  reverts to the state colour.
- 200 ms at the Claude page's animated tick is two or three frames, which is visible.
  **State the chosen duration in a comment** and make it a named constant.
- The flash must not fight the `permission` pulse. The flash wins while active, since it is
  a direct response to a human action.
- Apply it to gauge keys too: a press there does nothing, so a brief red flash is honest
  feedback rather than silence.

### Tests

- A successful press sets a white flash that expires; assert the border colour at
  `nowMs` inside the window and after it.
- A failed press sets red.
- The flash overrides the permission pulse while active, and the pulse resumes after.
- The flash is per key: flashing key 0 does not change key 1.
- An expired flash leaves no trace in `keyHash`, so the key stops being redrawn.

---

## Constraints

- ESM only, no `require(` in `src/`, `bin/`, `scripts/`. Strict TypeScript with
  `noUncheckedIndexedAccess`. Imports use `.js`.
- A log call must never throw. `log.once` on every repeating path — a press repeats.
- No test may open the device, perform real network I/O, or touch any path under `~`.
- The other three pages must render identically.
- Prose in ASD-STE100 Simplified Technical English.
- Read `docs/VERIFIED-FACTS.md` and `docs/LESSONS.md` first. Lessons 5, 11 and 17 apply
  directly: no `log.warn` on a repeating path, any new `KeySpec` field must affect
  `keyHash`, and measure pixels rather than reasoning about them.
