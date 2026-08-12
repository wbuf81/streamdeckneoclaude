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
