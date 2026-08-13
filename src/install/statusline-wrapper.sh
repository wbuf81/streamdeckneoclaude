#!/bin/sh
# deckd statusline wrapper.
#
# Claude Code sends the statusline payload on stdin. It contains rate_limits,
# which no file on disk holds. This script saves the fields the Stream Deck
# needs, and then runs the real statusline command with the same stdin.
#
# The install command sets DECKD_INNER to the original statusLine command.
# It sets DECKD_STATE_DIR only in tests. The default is the real state dir.
#
# session_id is not one of the fields the user's real statusline.sh reads. It
# comes from Claude Code's documented statusline payload instead of a
# measured jq filter. This script fails safe: with no session_id, it still
# writes usage.json and simply skips the per-session file. Task 15 confirms
# whether Claude Code actually sends session_id in this user's setup.
#
# This script must never fail in a way that hides the statusline. Every cache
# step tolerates an error, and the inner command always runs.

set -u
# I-2: enables job control, so a backgrounded inner command gets its OWN
# process group, led by its pid -- not merely a pid this script happens to
# know about. Needed below so a killing signal can reach a COMPOUND inner
# command's children, not just the single process bash would otherwise
# exec-optimise a simple one down to. This does not make the script
# interactive; it only changes how background jobs are grouped.
#
# VERIFIED FACT (M-4): `set -m` is ALSO load-bearing for stdin fidelity, a
# second, separate reason from the process-group one above -- measured
# directly, with `set -m` removed and everything else unchanged:
#
#   without set -m:  0 bytes reach the inner command's stdin on the
#                     no-mktemp fallback path (line ~177 below)
#   with    set -m: 10 bytes reach it (the real payload)
#
# POSIX assigns `/dev/null` to an asynchronous command's stdin when job
# control is OFF. The no-mktemp fallback exists precisely to preserve the
# payload when caching is impossible, by letting the backgrounded inner
# command inherit the wrapper's own stdin directly instead of reading a
# temp file -- remove `set -m` "for portability" and that fallback path
# silently blanks the statusline instead. Do not remove this line without
# re-measuring both effects it has, not just the process-group one the
# comment above already documents.
set -m

# VERIFIED FACT (M-5): the process-group kill on the signal path below
# (`kill -TERM -"$INNER_PID"`) only reaches a COMPOUND inner command
# because of a bash-specific builtin behaviour, not POSIX `kill` semantics.
# Measured: for `cat "$TMPIN" | sh -c "$INNER" &`, `$!` is the PID of the
# LAST process in the pipeline (`sh -c`), while the job's actual process
# GROUP id is `cat`'s pid -- so `kill -TERM -"$INNER_PID"` names a group id
# that, taken literally, does not exist. It still works here because
# bash's BUILTIN `kill` looks the pid up in its own job table and calls
# `killpg` on the job's real process group, not a plain `killpg(2)` on the
# literal number. On a strict POSIX `/bin/sh` (e.g. dash) the identical
# line would just ESRCH, leaving the compound inner command's children
# orphaned -- the exact failure this trap exists to prevent. This is
# bounded in practice (this project is macOS-only, and macOS's `/bin/sh`
# is bash 3.2), but it means `set -m` and this `kill` line must be changed
# together, if ever: neither is safe to "simplify" on its own. See also
# `docs/DEPLOYMENT.md`, which restates both of these as verified facts.
STATE_DIR="${DECKD_STATE_DIR:-${HOME:-}/.local/state/deckd}"
# M-7: `${HOME:-}` rather than a bare `$HOME` -- under `set -u`, expanding
# an unset `$HOME` inside the fallback of `${DECKD_STATE_DIR:-$HOME/...}`
# still aborts the whole script with "HOME: unbound variable", even though
# `DECKD_STATE_DIR` is the variable actually being tested. Measured: a
# hand-run of this script with `HOME` unset exited 1 before the inner
# command ever ran, in direct violation of the file's own header rule that
# it must never fail in a way that hides the statusline. The installed
# wrap always sets `DECKD_STATE_DIR`, so this only protects a hand-run or a
# future unwrapped invocation -- but a script this file's own header
# promises never to hide the statusline behind should not depend on that.
# With both variables unset, `STATE_DIR` falls back to `/.local/state/deckd`,
# which every caching step below already tolerates failing to use.
INNER="${DECKD_INNER:-}"

# Capture stdin to a temp file rather than a shell variable. `PAYLOAD=$(cat)`
# strips trailing newlines from command substitution, which would corrupt
# byte-for-byte passthrough. A file preserves every byte, including trailing
# newlines. If mktemp fails, TMPIN stays empty, caching is skipped, and the
# wrapper's own stdin is left untouched so the inner command can still read
# it directly below.
TMPIN=$(mktemp 2>/dev/null) || TMPIN=""
USAGE_TMP=""
SESSION_TMP=""
# Set once the inner command is actually running, so `cleanup` can forward a
# signal to it (M-3). Declared here, before the trap, so the trap's own
# reference to it is never unset.
INNER_PID=""

cleanup() {
  # M-3: a bare `trap cleanup EXIT` does not run WHILE a foreground command
  # is still executing -- measured: a `SIGTERM` sent while the inner command
  # was still running left it orphaned and running for its full duration,
  # because nothing told it to stop. Killing `$INNER_PID` here forwards the
  # signal that reached the wrapper on to the command actually holding the
  # terminal, instead of leaving it to run unattended after its parent has
  # already gone. A no-op once the inner command has already exited --
  # M-1: including the normal, non-killed case, because the main flow below
  # clears INNER_PID once `wait` returns on its own, before this EXIT trap
  # ever runs.
  #
  # I-2: a NEGATIVE pid signals the whole PROCESS GROUP, not just the pid of
  # `sh -c "$INNER"` itself. Measured: bash exec-optimises
  # `sh -c '<one simple command>'` down to that one process with no
  # children, so a plain `kill "$INNER_PID"` happens to reach it -- but for
  # a compound inner command (a pipeline, an `&&` list), `sh -c` forks, and
  # killing only the parent left the fork running for its full duration,
  # orphaned. `set -m` above makes the backgrounded job its own process
  # group, led by $INNER_PID, so the group form reaches a fork the plain
  # form cannot. `wait` afterward blocks until the group's leader has
  # actually finished dying, rather than returning immediately and letting
  # this script exit while the group is still mid-shutdown.
  if [ -n "$INNER_PID" ]; then
    kill -TERM -"$INNER_PID" 2>/dev/null || true
    wait "$INNER_PID" 2>/dev/null || true
  fi
  # I-2: clear it here, unconditionally, the instant the kill-and-wait above
  # (if any) is done -- not only on the normal, non-killed path further
  # down. On the SIGNAL path, `trap '...' TERM INT HUP` calls this function
  # directly, then `exit`, which fires the EXIT trap and calls `cleanup` a
  # SECOND time with `INNER_PID` still holding the value from the FIRST
  # call, unless it is cleared here. Instrumented: two `cleanup` calls
  # logged with the identical pid, and the second one issued
  # `kill -TERM -"$INNER_PID"` -- a process-GROUP signal -- against a pid
  # the first call had already reaped, which the OS is free to have handed
  # to a completely unrelated process by then. Clearing it here means the
  # second call's own `[ -n "$INNER_PID" ]` guard is false, so it never
  # signals anything at all. This makes the later, main-path clearing
  # (marked M-1, below) redundant on that path specifically, but harmless
  # to leave -- it documents the SAME guarantee for readers who only see
  # that path.
  INNER_PID=""
  [ -z "$TMPIN" ] || rm -f "$TMPIN"
  [ -z "$USAGE_TMP" ] || rm -f "$USAGE_TMP"
  [ -z "$SESSION_TMP" ] || rm -f "$SESSION_TMP"
}
trap cleanup EXIT
# Trap the terminating signals too, so a killed render still cleans up
# after itself and stops the inner command, rather than waiting for a
# foreground `wait` to return before the trap action can run.
#
# M-8: a separate trap per signal, so the exit status actually reflects
# WHICH signal arrived (143 = 128+SIGTERM, 130 = 128+SIGINT, 129 = 128+SIGHUP)
# instead of always reporting 143 regardless of which of the three fired.
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 129' HUP

if [ -n "$TMPIN" ]; then
  # M-6: was unchecked. A short write here (a full filesystem, most likely)
  # used to leave the wrapper running as if caching had fully succeeded,
  # with $TMPIN holding a TRUNCATED copy of the payload -- so the inner
  # command below silently received the truncated bytes instead of the
  # original ones. Falling back to TMPIN="" on failure instead takes the
  # already-correct uncached path: every later step that depends on
  # $TMPIN skips itself, exactly as it does when `mktemp` itself fails
  # above. Any bytes `cat` already wrote to disk before failing are a
  # leftover file pruned later by age, like every other mktemp leftover
  # this script produces.
  cat > "$TMPIN" || TMPIN=""
fi

if [ -n "$TMPIN" ] && command -v jq >/dev/null 2>&1; then
  # M-2: `mkdir -p` then a separate `chmod` is two steps, so a FRESHLY
  # created directory exists at the umask's default (0755 under a common
  # `umask 022`) until the `chmod` right after it runs. Setting the umask
  # to 077 for just this one call closes that window: every directory
  # `mkdir -p` creates here is 0700 from the instant it exists, not merely
  # once this line finishes. The subshell keeps the umask change scoped to
  # this one command; the rest of the script is unaffected.
  (umask 077; mkdir -p "$STATE_DIR/sessions") 2>/dev/null || true
  # `mkdir -p` only sets a mode on a directory it CREATES (Lesson 1). This
  # runs on every render, so it is the one place a token-bearing directory
  # can end up world-readable if it is ever recreated -- after a manual
  # delete, or on a fresh machine where a render happens before the daemon
  # ever starts. Force 0700 unconditionally; `chmod` fixes an
  # already-existing looser directory, which `mkdir -p` cannot.
  chmod 700 "$STATE_DIR" "$STATE_DIR/sessions" 2>/dev/null || true
  NOW=$(date +%s)

  # usage.json holds the newest rate limits. The gauge keys read it.
  USAGE_TMP=$(mktemp "$STATE_DIR/.usage.json.XXXXXX" 2>/dev/null) || USAGE_TMP=""
  if [ -n "$USAGE_TMP" ]; then
    if jq -c --argjson ts "$NOW" \
      '{rate_limits: (.rate_limits // {}), ts: $ts}' \
      < "$TMPIN" \
      > "$USAGE_TMP" 2>/dev/null \
      && mv "$USAGE_TMP" "$STATE_DIR/usage.json" 2>/dev/null; then
      USAGE_TMP=""
    fi
  fi

  # The per-session file carries the model name. state.d does not have it.
  SID=$(jq -r '.session_id // empty' < "$TMPIN" 2>/dev/null || true)
  # session_id lands in a file path below. Reject anything outside a safe
  # charset, so a crafted id cannot write outside the sessions directory.
  case "$SID" in
    *[!A-Za-z0-9._-]*) SID="" ;;
  esac
  if [ -n "$SID" ]; then
    SESSION_TMP=$(mktemp "$STATE_DIR/sessions/.$SID.json.XXXXXX" 2>/dev/null) || SESSION_TMP=""
    if [ -n "$SESSION_TMP" ]; then
      if jq -c --argjson ts "$NOW" \
        '{model: (.model.display_name // ""),
          ctxPct: (.context_window.used_percentage // null),
          costUsd: (.cost.total_cost_usd // null),
          ts: $ts}' \
        < "$TMPIN" \
        > "$SESSION_TMP" 2>/dev/null \
        && mv "$SESSION_TMP" "$STATE_DIR/sessions/$SID.json" 2>/dev/null; then
        SESSION_TMP=""
      fi
    fi
  fi

  # Nothing else ever expires a per-session file, so one accumulates per
  # Claude Code session id forever, and UsageSource re-reads every file in
  # this directory on every poll. Bound the growth: a session more than a
  # week old is stale far past any use, so prune it. Error-tolerant, and
  # bounded to this one directory.
  #
  # M-1: the pattern used to be `-name '*.json'` only, which cannot match
  # this script's OWN `mktemp` leftovers -- `.<sid>.json.XXXXXX` -- because
  # they do not END in `.json`. Measured: a leftover from a `SIGKILL`'d
  # render (the one signal that cannot be trapped) survived every prune
  # forever. Matching `.*.json.*` too catches exactly that shape without
  # touching any other dotfile that might land in this directory.
  find "$STATE_DIR/sessions" -maxdepth 1 \( -name '*.json' -o -name '.*.json.*' \) \
    -mtime +7 -delete 2>/dev/null || true
  # The matching leftover shape directly in $STATE_DIR itself is
  # `.usage.json.XXXXXX`. Same reasoning, same bound.
  find "$STATE_DIR" -maxdepth 1 -name '.usage.json.*' -mtime +7 -delete 2>/dev/null || true
fi

# Run the real statusline with the original stdin. Its output is the only
# output this script produces.
#
# M-3: run the inner command in the BACKGROUND and `wait` for it, rather
# than running it in the foreground directly. A shell only checks its traps
# BETWEEN commands, so a signal arriving while a foreground command is
# still running is not acted on until that command finishes -- measured:
# a `SIGTERM` sent during a slow inner command left it running for its full
# duration. `wait` is interruptible, so the trap above runs as soon as the
# signal arrives, and its `cleanup` can then forward the signal to
# `$INNER_PID` immediately, instead of waiting for the inner command to
# finish on its own.
if [ -n "$INNER" ]; then
  if [ -n "$TMPIN" ]; then
    cat "$TMPIN" | sh -c "$INNER" &
  else
    # No temp file. Nothing was cached, but stdin was never consumed either,
    # so the inner command still gets the original bytes unchanged.
    sh -c "$INNER" &
  fi
  INNER_PID=$!
  wait "$INNER_PID"
  STATUS=$?
  # M-1: clear it the instant `wait` returns ON ITS OWN -- a normal,
  # non-killed exit. Once `wait` returns, the pid has been reaped and is
  # free for the OS to hand to a completely unrelated process. Without this,
  # the EXIT trap right after this line still runs `cleanup`, which used to
  # `kill "$INNER_PID"` unconditionally -- on a busy machine, that pid can
  # by then belong to someone else's process entirely. Clearing it here
  # closes the window completely, rather than narrowing it.
  INNER_PID=""
else
  STATUS=0
fi
exit "$STATUS"
