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
