# streamdeckneoclaude

Custom control software for an Elgato Stream Deck Neo. It replaces the Elgato
software. It does not need the Elgato software.

The deck shows live Claude Code sessions and Spotify playback.

- **Claude page.** One key per live session, with the state, the project, and the
  model. Four gauge keys show the 5-hour and 7-day rate limit usage. Press a
  session key to focus that terminal window.
- **Spotify page.** Album art, transport controls, and a progress bar.
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

## Layout

**Claude page.** Keys 0 to 3 hold live sessions, newest first. A session keeps
its key while it lives, so the display does not move while you read it. Keys 4
to 7 show the 5-hour usage, the 7-day usage, the pace, and the reset countdown.
Press a session key to focus its terminal.

**Spotify page.** Key 0 shows album art. Keys 1 to 3 are previous, play or
pause, and next. Keys 4 and 5 step the volume. Keys 6 and 7 toggle shuffle and
cycle repeat.

**Paging.** The left touch button goes back a page. The right goes forward.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `cannot open the Stream Deck Neo` | Another process owns it. Quit the Elgato app or a second deckd. |
| Gauges show `--` | The statusline wrapper is not installed, or no Claude session has rendered yet. |
| Gauges show `STALE` | No Claude session has rendered a statusline in 15 minutes. |
| Keys show `no session data` | `~/.claude/daisy-statusbar/state.d/` is absent. |
| Key 0 shows `SIGN IN` | Run `deckd auth spotify`. |
| A transport key flashes red | No active Spotify device. Start playback somewhere. |
| A press does not focus a window | Approve the macOS automation prompt. |

Logs are at `~/.local/state/deckd/deckd.log`.

## Development

Requires macOS and Node 22 or later.

```bash
npm install
npm test          # unit tests, no hardware needed
npm run typecheck
npm run smoke     # draws a test pattern, needs the real device
```

`npm run smoke` is the fastest way to confirm the device works. It draws a
labelled pattern on all 8 keys, the info strip, and both touch buttons. It then
prints every press index.

Pass `--once` to draw the pattern and exit right away, with no wait for a key
press. Use it for an automated check: `npm run smoke -- --once`.

## Credits

The crab sprite art comes from
[clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk), used under the
MIT license.
