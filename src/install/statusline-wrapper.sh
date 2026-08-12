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
if [ -n "$TMPIN" ]; then
  trap 'rm -f "$TMPIN"' EXIT
  cat > "$TMPIN"
fi

if [ -n "$TMPIN" ] && command -v jq >/dev/null 2>&1; then
  mkdir -p "$STATE_DIR/sessions" 2>/dev/null || true
  NOW=$(date +%s)

  # usage.json holds the newest rate limits. The gauge keys read it.
  jq -c --argjson ts "$NOW" \
    '{rate_limits: (.rate_limits // {}), ts: $ts}' \
    < "$TMPIN" \
    > "$STATE_DIR/usage.json.tmp" 2>/dev/null \
    && mv "$STATE_DIR/usage.json.tmp" "$STATE_DIR/usage.json" 2>/dev/null || true

  # The per-session file carries the model name. state.d does not have it.
  SID=$(jq -r '.session_id // empty' < "$TMPIN" 2>/dev/null || true)
  # session_id lands in a file path below. Reject anything outside a safe
  # charset, so a crafted id cannot write outside the sessions directory.
  case "$SID" in
    *[!A-Za-z0-9._-]*) SID="" ;;
  esac
  if [ -n "$SID" ]; then
    jq -c --argjson ts "$NOW" \
      '{model: (.model.display_name // ""),
        ctxPct: (.context_window.used_percentage // null),
        costUsd: (.cost.total_cost_usd // null),
        ts: $ts}' \
      < "$TMPIN" \
      > "$STATE_DIR/sessions/$SID.json.tmp" 2>/dev/null \
      && mv "$STATE_DIR/sessions/$SID.json.tmp" "$STATE_DIR/sessions/$SID.json" 2>/dev/null || true
  fi
fi

# Run the real statusline with the original stdin. Its output is the only
# output this script produces.
if [ -n "$INNER" ]; then
  if [ -n "$TMPIN" ]; then
    cat "$TMPIN" | sh -c "$INNER"
  else
    # No temp file. Nothing was cached, but stdin was never consumed either,
    # so the inner command still gets the original bytes unchanged.
    sh -c "$INNER"
  fi
fi
