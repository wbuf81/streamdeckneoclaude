# Agent instructions

Read these files before changing code:

1. `docs/PROJECT-STATE.md` — current product state, priorities, and handoff.
2. `docs/VERIFIED-FACTS.md` — measurements from this Mac and the real device.
3. `docs/LESSONS.md` — recurring defects and review rules.
4. `docs/DEPLOYMENT.md` — safe build, deployment, verification, and recovery.

To diagnose a live complaint ("it stopped working"), start with `docs/DEPLOYMENT.md`'s
"Triage a live complaint" section before reading code.

## Working rules

- Use ASD-STE100-style prose: short sentences, active voice, and one idea per sentence.
- Preserve unrelated user changes. Check `git status --short` before editing and committing.
- Commit directly to `main` only when the user asks. Review the staged file list first.
- Use ESM and `.js` import suffixes. Keep strict TypeScript and
  `noUncheckedIndexedAccess` clean.
- Keep pages pure. A page returns a `DeckFrame`; it does not access canvas, HID, the network,
  or the wall clock.
- Inject clocks, commands, paths, and network clients. Tests must not read or write the real
  home directory.
- Never read, print, replace, or commit `~/.local/state/deckd/spotify.json`.
- Never print OAuth tokens, full Codex prompts, or unrelated Claude settings.
- Use `log.once` for repeating failures and clear its key after recovery.
- A quiet log is not a healthy log. A stuck `log.once` key suppresses every repeat, so read
  silence as "no NEW failure kind", never as "no failure". Log state transitions, not just
  first occurrences.
- `vi.useFakeTimers()` mocks `Date.now` too, so code under test needs no injected clock to be
  time-controllable — inject one only when a test must set an absolute time.
- Treat absent platform signals as unknown. Do not infer a safe state from missing data.
- Never hardcode a value that belongs to one person — a ZIP code, a watchlist, a team, a
  hostname on someone's LAN. It goes in `config.json` through `src/config.ts`, validated
  per section, and an absent section switches its page off rather than falling back to
  somebody else's answer. Only a genuinely generic default (the broad-market watchlist)
  earns a fallback.
- Put private external schemas behind one source boundary. A schema change must not stop the
  daemon or unrelated pages.

## Product conventions

These are the user's standing decisions. They apply to every page, now and in future work.

### Timestamps

- Render every wall-clock time in **US Eastern time**, on a **12-hour clock with AM or PM**,
  through the **one shared helper**. Do not hand-roll a second formatter — four different ones
  had already grown before this rule existed.
- Use the `America/New_York` zone, never a fixed offset, so the switch between standard and
  daylight time is automatic.
- Annotate the zone with the **real** abbreviation for that date. In summer that is `EDT`, not
  `EST`. The user asked for "EST", meaning Eastern; printing `EST` in July would be wrong.
- A **duration** is not a timestamp. `formatClock` renders elapsed and remaining time, and it
  stays a 24-hour-style `m:ss`.

### Press feedback

- **Every key press gives feedback on the device.** A press that does nothing must still be
  visibly rejected, because silence is indistinguishable from a press the deck never received.
- This belongs in the **daemon**, once, not in each page. A page reports whether it handled the
  press; the daemon draws the feedback.
- The current signal is a thin ring around the key's whole perimeter, **90 ms**, in muted
  colours — white for a press that did something, red for one that did not. It is never a
  full-key fill. If red is ever needed for something else on that key, pick a different signal
  for the rejection — but never remove the ring.
- **The flash has been wrong in both directions once already.** An earlier version recoloured
  only the key's left-edge border strip, which the user could barely see. The version right
  after that filled the whole key, which the user reported as "too bright" and "jarring." The
  thin perimeter ring at 90 ms is the corrected middle ground — do not revert to either extreme.
- This applies to gauge keys, empty slots, decorative tiles, and any page added later.

## Fix briefs and review loops

These rules exist because four review rounds found ~12 Critical defects, and most were
repeat occurrences of a harm whose "fix" had already landed. The evidence is in
`docs/LESSONS.md`, lessons 21 and 22. The rules bind whoever writes a fix brief and
whoever implements one.

- A reviewer's repro is evidence of a broken invariant. It is not the bug. Brief the
  invariant plus the known route, never the route alone.
- Before implementing a fix, list three other routes to the same harm. Fix the class,
  or state why it is bounded. The second route has existed every time so far.
- Prefer making the harm impossible over making the trigger unreachable. "Uninstall
  never deletes the backup" ended a three-round Critical streak.
- A prescribed implementation in a brief is a hypothesis. If the evidence contradicts
  it, stop and report — do not build it. Implementers have used this correctly.
- The sibling sweep is part of the fix, not an extra. When you fix one page, verb, or
  source, check its siblings for the same hole before you finish. Family drift is this
  project's dominant defect pattern.
- Every new test: break the fix, watch the test fail, restore. A test that cannot fail
  reports safety that does not exist. Probe regions, never single pixel columns. Build
  fixtures from real captured output — `sqlite3 -json` prints nothing for zero rows.
- One writer per file at a time, docs included. Concurrent agents commit with the
  pathspec form only.
- A point-in-time proof (a golden hash pinning another page's bytes) retires when its
  change lands. Do not leave it to fire on the next legitimate change.
- A measurement is valid only with its preconditions recorded. The same command can
  give opposite answers in different states — re-measure in the failing state before
  reversing a design.

## Live-system safety

- The launchd daemon normally owns the Stream Deck. Do not open the device concurrently.
- Ask before changing live configuration, authorization, launchd state, or files under `~`.
- Do not lock, sleep, or wake the Mac. Ask the user to perform physical checks.
- A normal code deployment builds first, stops only the current `deckd` PID, and lets
  launchd restart it. Follow `docs/DEPLOYMENT.md`.
- Do not use destructive Git commands or delete runtime state.

## Required validation

For code changes, run:

```bash
npm test
npm run typecheck
npm run build
/bin/sh -n src/install/statusline-wrapper.sh
git diff --check
```

Documentation-only changes require `git diff --check` and a review of changed links and
commands. Hardware behavior still needs a user-observed physical check.
