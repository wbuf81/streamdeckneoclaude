# Deployment and recovery

Use this checklist for the installed daemon on this Mac. The launchd label is
`com.wbard.deckd`, and it runs the compiled output from this repository.

## Before deployment

1. Read `docs/PROJECT-STATE.md` and check `git status --short`.
2. Preserve unrelated changes. Do not deploy an unreviewed working tree.
3. Run the required validation:

   ```bash
   npm test
   npm run typecheck
   npm run build
   /bin/sh -n src/install/statusline-wrapper.sh
   git diff --check
   ```

4. If the wrapper changed, compare the tested source with the installed wrapper. Run
   `deckd refresh-wrapper` to replace it. Do not modify unrelated Claude settings.

## Updating an already-installed wrapper

`deckd refresh-wrapper` re-copies `src/install/statusline-wrapper.sh` into the state
directory and re-verifies it, without touching `settings.json` or launchd. Use it whenever
the wrapper script changes on an already-installed machine.

- It replaces the wrapper atomically (write a temp file, then rename), so a render cannot
  ever see a truncated script mid-copy.
- It re-verifies the wrap against the recovered original command, using a disposable
  temporary directory. It never writes to the live state directory during that check.
- It refuses, and changes nothing, if it cannot recover the original command from the
  installed wrap (for example, a hand edit removed the embedded blob and there is no usable
  backup).
- It is safe to run more than once. Each run re-copies and re-verifies from the same source.

Before `refresh-wrapper` existed, the only way to update an installed wrapper was
`deckd uninstall` followed by `deckd install` — the same path the C-1 defect lived on. Prefer
`refresh-wrapper` for a wrapper-only change.

## Restart the daemon

1. Find the exact process:

   ```bash
   pgrep -fl '/Users/you/Vibecoding/streamdeckneoclaude/dist/bin/deckd.js start'
   ```

2. Stop only the reported PID with `kill <PID>`. Do not use a broad process pattern when an
   exact PID is available.
3. Wait about three seconds. launchd `KeepAlive` starts the replacement.
4. Run the same `pgrep` command. Confirm that it reports a new PID.
5. Check the bounded log tail:

   ```bash
   tail -n 40 ~/.local/state/deckd/deckd.log
   ```

6. Confirm `deckd starting` and `connected to Stream Deck Neo`. Investigate any new warning
   or error before calling the deployment complete.

## Physical verification

Choose checks that match the changed behavior. Never perform them without the user.

- Navigate every changed page and inspect text, colour, truncation, and controls.
- For privacy changes, ask the user to lock and unlock the Mac.
- For wake handling, ask the user to use true system sleep and wake.
- For reconnect handling, ask the user to unplug and reconnect the Stream Deck.
- Record measured outcomes in `docs/PROJECT-STATE.md` or `docs/VERIFIED-FACTS.md`.

## Free the device for a hardware script

A normal `kill` is not enough because launchd restarts the daemon. With explicit user
approval, boot out only this agent:

```bash
launchctl bootout gui/$(id -u)/com.wbard.deckd
```

After the hardware script exits, restore it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wbard.deckd.plist
```

Verify the new process and log after restoring it.

## Recovery

- If the new process does not start, inspect the log and the launch plist before changing
  anything else.
- If a source fails, keep the daemon running and verify that only its page degraded.
- If the wrapper activation fails, restore the previous installed wrapper. Do not rewrite
  Claude settings manually.
- Never delete `~/.local/state/deckd`. It contains live configuration and the Spotify token.
- Never use `git reset --hard` or remove user changes as a recovery shortcut.
