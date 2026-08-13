# streamdeckneoclaude

Custom control software for an Elgato Stream Deck Neo. It replaces the Elgato
software. It does not need the Elgato software.

The deck shows live Claude Code sessions, OpenAI Codex tasks and usage, Spotify
playback, stocks, and weather.

- **Claude page.** Three live sessions, a Claude mascot, and four usage gauges.
  Press a session key to focus that terminal window.
- **Codex page.** Three active Codex tasks plus account usage, plan, token, and
  reset tiles. It reads Codex's local task index and rollout accounting events
  without sending data anywhere.
- **Spotify page.** Album art, transport controls, and a progress bar.
- **Stocks page.** Eight watchlist symbols with an on-deck detail view.
- **Weather page.** Seven forecast tiles and current wind conditions.
- **Paging.** The two touch buttons flip pages.

## Status

In development. The design is complete. See
[the design document](docs/superpowers/specs/2026-08-12-streamdeck-neo-claude-deck-design.md).

## Hardware

Stream Deck Neo only. USB `0x0FD9:0x009A`. The deck has 8 keys of 96 × 96 px, a
248 × 58 px info strip, and 2 touch buttons with no screen.

## Install

```bash
npm install
npm run build
node dist/bin/deckd.js install
```

The install does three things, and it prints each one:

1. Copies the statusline wrapper into `~/.local/state/deckd/`.
2. Wraps `statusLine` in `~/.claude/settings.json`, after a backup to
   `settings.json.deckd-backup`. Your terminal statusline output does not
   change. The wrapper only saves the rate limit numbers, which no file on disk
   holds.
3. Writes and loads a launchd agent, so the deck starts at login.

`node dist/bin/deckd.js uninstall` reverses all three. It leaves the state
directory, because that directory holds your Spotify token.

## Spotify

```bash
node dist/bin/deckd.js auth spotify --client-id <ID>
```

Create a free app at https://developer.spotify.com/dashboard first. Add this
redirect URI exactly:

```
http://127.0.0.1:8888/callback
```

Spotify rejects `localhost` for a plain HTTP redirect, so the URI must use the
loopback IP.

## Permissions

macOS asks to allow automation the first time the deck focuses a terminal
window. Approve it. Without approval the session keys still show status, but a
press cannot raise the window.

The deck detects the measured macOS `IOConsoleLocked` state every two seconds,
blanks, turns its panel brightness off, pauses the visible network source, and
ignores all presses while the Mac is locked. It restores a full frame after
unlock or wake.

## Layout

**Claude page.** Keys 0 to 2 hold live sessions. Key 3 holds the animated Claude
mascot. Keys 4 to 7 show the 5-hour usage, the 7-day usage, the pace, and the
reset countdown. Press a session key to focus its terminal.

**Codex page.** Keys 0 to 2 show active Codex tasks. Key 3 identifies the page
and shows the active count. Keys 4 to 7 show the account usage window, plan (or
a second limit when present), current task tokens, and reset countdown. The
page is read-only because Codex does not expose a supported local task-focus
command.

**Spotify page.** Album art spans keys 0, 1, 4, and 5. Key 2 plays or pauses.
Key 3 raises the volume. Keys 6 and 7 go to the previous or next track.

**Stocks page.** Each key shows one symbol. Press a symbol to open its price,
change, ranges, and intraday chart. Key 7 returns to the watchlist.

**Weather page.** Seven keys show the forecast. Key 7 shows wind and location.

**Paging.** The left touch button goes back a page. The right goes forward.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `cannot open the Stream Deck Neo` | Another process owns it. Quit the Elgato app or a second deckd. |
| Gauges show `--` | The statusline wrapper is not installed, or no Claude session has rendered yet. |
| Gauges show `STALE` | No Claude session has rendered a statusline in 15 minutes. |
| Keys show `no session data` | `~/.claude/daisy-statusbar/state.d/` is absent. |
| Codex shows `task data unavailable` | Codex has not created `~/.codex/state_5.sqlite`, or its local schema changed. Other pages continue working. |
| Key 0 shows `SIGN IN` | Run `deckd auth spotify`. |
| A transport key flashes red | No active Spotify device. Start playback somewhere. |
| A press does not focus a window | Approve the macOS automation prompt. |
| The whole deck is dark | Unlock the Mac. The deck restores itself within about two seconds. |

Logs are at `~/.local/state/deckd/deckd.log`.

## Development

Requires macOS and Node 22 or later.

```bash
npm install
npm test          # unit tests, no hardware needed
npm run typecheck
npm run smoke     # draws a test pattern, needs the real device
```

Set `DECKD_STATE_DIR` when an ad-hoc diagnostic must use isolated runtime
state instead of `~/.local/state/deckd`.

`npm run smoke` is the fastest way to confirm the device works. It draws a
labelled pattern on all 8 keys, the info strip, and both touch buttons. It then
prints every press index.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the installed-daemon restart,
verification, hardware-check, and recovery procedure.

Pass `--once` to draw the pattern and exit right away, with no wait for a key
press. Use it for an automated check: `npm run smoke -- --once`.

## Credits

The crab sprite art comes from
[clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk), used under the
MIT license.
