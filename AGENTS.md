# Agent instructions

Read these files before changing code:

1. `docs/PROJECT-STATE.md` — current product state, priorities, and handoff.
2. `docs/VERIFIED-FACTS.md` — measurements from this Mac and the real device.
3. `docs/LESSONS.md` — recurring defects and review rules.
4. `docs/DEPLOYMENT.md` — safe build, deployment, verification, and recovery.

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
- Treat absent platform signals as unknown. Do not infer a safe state from missing data.
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
- The current signal is a full-key red flash for a press with no action. If red is ever needed
  for something else on that key, pick a different signal for the rejection — but never remove
  it.
- This applies to gauge keys, empty slots, decorative tiles, and any page added later.

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
