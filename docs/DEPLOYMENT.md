# Deployment and recovery

Use this checklist for the installed daemon on this Mac. The launchd label is
`com.wbard.deckd`, and it runs the compiled output from this repository.

## Triage a live complaint

All read-only. Run in this order before touching anything.

```bash
launchctl print gui/$(id -u)/com.wbard.deckd | head -40   # state, pid, runs (>1 = crash loop)
tail -40 ~/.local/state/deckd/deckd.log                   # see the caveat below
ioreg -p IOUSB -w0 -l | grep -i "Stream Deck"             # device present on USB at all?
pmset -g assertions | grep -i deckd                       # deckd never holds one; see VERIFIED-FACTS
```

`runs = 1` with a long `ELAPSED` means the process never restarted — which is NOT the same
as healthy. A daemon can hold a dead handle indefinitely.

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
- It refuses if it cannot recover the original command from the installed wrap (for example,
  a hand edit removed the embedded blob and there is no usable backup). This does not touch
  `settings.json`, the wrapper, or launchd — but it does not necessarily change literally
  nothing on disk: `enforceDirModes` and the stray-probe repair run before this decision, so
  a state directory that did not exist yet may already have been created. That directory
  setup is deckd's own and safe to keep either way.
- It is safe to run more than once. Each run re-copies and re-verifies from the same source.

Before `refresh-wrapper` existed, the only way to update an installed wrapper was
`deckd uninstall` followed by `deckd install` — the same path the C-1 defect lived on. Prefer
`refresh-wrapper` for a wrapper-only change.

`install` and `refresh-wrapper` also run the user's real statusline command as part of their
own verification (`verifyWrap`), with a synthetic payload. Both run it TWICE, the same way:
once as the plain original command, and once more nested inside the wrapped form. A statusline
that keeps its own per-session cache could see it disturbed by this synthetic run. This has not
been observed on this machine's own statusline, but is a known, latent property of how
verification works.

## Uninstalling

`deckd uninstall` **never deletes `settings.json.deckd-backup`**, on any code path, no matter
how the uninstall proceeds. This is deliberate: three separate review rounds each found a
different way for a detection bug to make uninstall delete the one remaining copy of the
original `statusLine` command, leaving the statusline blank with no way back. Never deleting
the backup removes that whole class of failure — the cost is one small leftover file.

After a normal uninstall, `~/.claude/settings.json.deckd-backup` is expected to remain.
Delete it by hand once you have confirmed `settings.json` is correct. It is not a bug that it
is still there.

If `deckd uninstall` refuses with a message about statusLine already looking like a deckd
wrap, but not at the expected path, do not force it. This means the installed wrap points at
a different state directory than this invocation resolved (a changed `DECKD_STATE_DIR`, or a
moved wrapper). Check `DECKD_STATE_DIR` and retry with the correct value, or fix `statusLine`
in `settings.json` by hand.

## Verified facts about the wrapper's `set -m` and its kill line

Two measurements about `src/install/statusline-wrapper.sh` that a future edit could break
without any test failing loudly, unless the change also touches the other line named below.
Restated here (not only in the wrapper's own header comments) so a later contradiction between
a plan and this file cannot form silently — see lesson 16.

- **`set -m` is load-bearing for stdin fidelity, not only for signalling.** Measured directly,
  with `set -m` removed and nothing else changed: the no-mktemp fallback path handed the inner
  command 0 bytes of stdin instead of the real payload (10 bytes, in the measured case). POSIX
  assigns `/dev/null` to an asynchronous command's stdin when job control is off, and that
  fallback path exists specifically to preserve the payload when caching is impossible.
- **The process-group kill (`kill -TERM -"$INNER_PID"`) only reaches a compound inner command
  because of a bash-specific builtin behaviour**, not POSIX `kill` semantics. For
  `cat "$TMPIN" | sh -c "$INNER" &`, `$!` is the pid of the LAST process in the pipeline
  (`sh -c`), not the job's process-group id (`cat`'s pid) — the group form only works because
  bash's builtin `kill` looks the pid up in its own job table and calls `killpg` on the real
  group. A strict POSIX `/bin/sh` (dash, for example) would just report no such process,
  leaving a compound inner command's children orphaned.

**Do not "simplify" either line on its own.** `set -m` and the process-group `kill` line are a
pair: removing or rewriting one without re-measuring the other can silently reopen either the
blanked-stdin failure or the orphaned-child failure. This project is macOS-only, and macOS's
`/bin/sh` is bash 3.2, which is why the pairing works in production today.

## Restart the daemon

1. Find the exact process:

   ```bash
   pgrep -fl 'dist/bin/deckd.js start'
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
