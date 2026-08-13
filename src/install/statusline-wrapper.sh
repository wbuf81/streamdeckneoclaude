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

STATE_DIR="${DECKD_STATE_DIR:-$HOME/.local/state/deckd}"
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
  # already gone. A no-op once the inner command has already exited.
  [ -z "$INNER_PID" ] || kill "$INNER_PID" 2>/dev/null || true
  [ -z "$TMPIN" ] || rm -f "$TMPIN"
  [ -z "$USAGE_TMP" ] || rm -f "$USAGE_TMP"
  [ -z "$SESSION_TMP" ] || rm -f "$SESSION_TMP"
}
trap cleanup EXIT
# Trap the terminating signals too, so a killed render still cleans up
# after itself and stops the inner command, rather than waiting for a
# foreground `wait` to return before the trap action can run.
trap 'cleanup; exit 143' TERM INT HUP

if [ -n "$TMPIN" ]; then
  cat > "$TMPIN"
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
else
  STATUS=0
fi
exit "$STATUS"
