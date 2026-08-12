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

## Credits

The crab sprite art comes from
[clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk), used under the
MIT license.
