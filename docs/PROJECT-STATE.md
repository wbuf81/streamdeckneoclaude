# Project state — handoff

Last updated 2026-08-12. **Read `docs/VERIFIED-FACTS.md` and `docs/LESSONS.md` before
writing any code.** They hold measurements and recurring bug classes that cost real fix
rounds to learn.

---

## What exists and runs right now

A Node daemon drives an Elgato Stream Deck Neo with **four pages**, flipped with the two
round buttons (8 = previous, 9 = next, wrapping both ways).

| Page | Contents | State |
| --- | --- | --- |
| **Claude** | 4 session keys (state, project, crab, model) + 4 usage gauges; press focuses that terminal | live |
| **Spotify** | album art spanning keys 0,1,4,5; play/pause 2; next 3; read-only heart 6; volume 7 | live |
| **Stocks** | 8 tickers with price, daily change, sparkline, red/green | live |
| **Weather** | 7 day tiles with colour emoji + temps + rain chance, wind tile | live |

**Installed.** `deckd install` was run with the user's explicit approval:

- launchd agent `com.wbard.deckd`, `RunAtLoad` + `KeepAlive`, running from `dist/`.
- `statusLine` in `~/.claude/settings.json` is **wrapped**, so rate-limit numbers reach
  `~/.local/state/deckd/usage.json`. Verified byte-for-byte identical output before and
  after: `sha256 75055d1ef0e07361e5693c840b16174776315da141922b98a83abb537f08fd79`.
- `deckd uninstall` reverses everything and never deletes the state directory.

### Live system paths

| Path | Note |
| --- | --- |
| `~/.local/state/deckd/spotify.json` | refresh token, mode 0600. **Never read or print.** Backup `.pre-rescope` |
| `~/.local/state/deckd/config.json` | Spotify client id, mode 0600, outside the repo |
| `~/.local/state/deckd/usage.json` | rate limits, written by the statusline wrapper |
| `~/.local/state/deckd/deckd.log` | contains a `SENTINEL do not delete` line — a tripwire proving tests do not write here |
| `~/.claude/settings.json.deckd-backup` | install's backup |
| `~/.claude/settings.json.pre-deckd-20260812-171845` | an extra independent backup |
| `~/Library/LaunchAgents/com.wbard.deckd.plist` | the agent |

### Restarting the daemon

`KeepAlive` revives it within ~2 s of a `pkill`, so a plain kill picks up a new build:

```bash
npm run build && pkill -f "dist/bin/deckd.js start"
```

To **free the device** for a benchmark or a hardware script, boot the agent out properly —
a `pkill` alone loses the race:

```bash
launchctl bootout gui/$(id -u)/com.wbard.deckd
# ... use the device ...
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wbard.deckd.plist
```

---

## Architecture

One process owns the USB device, because HID access is exclusive.

```
Sources ──▶ Pages ──▶ Renderer ──▶ Device
 (poll)     (pure)     (canvas)     (HID)
                ▲
          PageManager ◀── round buttons 8 / 9
```

- A **Source** owns one external system, takes an injected clock and `fetch`, polls only
  while its page is visible, and emits `change` **only when data actually changed**.
- A **Page** is pure: it takes narrow reader interfaces and returns a `DeckFrame`
  description. It never touches canvas or HID, so its tests need no hardware.
- The **Renderer** turns descriptions into raw RGBA buffers.
- The **Daemon** compares each key's `keyHash` against the last drawn and writes **only
  what changed**. This is why a page can render often and cost nothing.

Files: `src/sources/{claude,usage,spotify,spotify-auth,stocks,weather}.ts`,
`src/pages/{claude,spotify,stocks,weather}-page.ts`, `src/render/{specs,canvas,theme,text,sprites}.ts`,
`src/{device,fake-device,daemon,page-manager,focus-window,log,paths}.ts`,
`src/install/{install.ts,statusline-wrapper.sh}`, `bin/deckd.ts`.

### Hard invariants

1. **Nothing decodes an image on the render path.** No synchronous decode exists. Sources
   decode with `await loadImage` and cache; sprites decode once at startup.
2. **Pages are added BEFORE `restorePage(pages)`** in `bin/deckd.ts`. `setIndex` ignores an
   out-of-range index, so a page added after would make a saved index silently fail.
3. Order in `start()`: add all pages → `restorePage` → construct `Daemon` →
   `daemon.start()` → subscribe `change` listeners → all sources stopped in `shutdown()`.
4. `keyHash` covers every `KeySpec` field except `image`.
5. `log.once` on every repeating failure path. Never `log.warn` there.

---

## Task ledger — 21 of 24 complete

Full detail is in `.superpowers/sdd/2026-08-12-streamdeck-neo-claude-deck/progress.md`,
but **that directory is git-ignored**, so this file is the durable record.

| # | Task | State |
| --- | --- | --- |
| 1–11 | scaffold → renderer → device → sources → Claude page → daemon | complete |
| 12 | Spotify OAuth (PKCE, port 8888) | complete |
| 13 | Spotify source | complete |
| 14 | Spotify page | complete |
| 15 | install + launchd | complete, **run** |
| 16 | per-window focus + press feedback | **pending** |
| 17 | stock source | complete |
| 18 | stocks page | complete |
| 19 | weather source + page | complete |
| 20 | Spotify redesign: 2×2 art, read-only heart | complete |
| 21 | extract animated crab frames | complete |
| 22 | animate the Claude crabs | complete, **NOT reviewed** |
| 23 | gauge row legibility (`lineSizes`) | complete, **NOT reviewed** |
| 24 | weather tile overlap + tint | **pending, needs 23** |

Briefs and reports for tasks 9–24 are in
`.superpowers/sdd/2026-08-12-streamdeck-neo-claude-deck-part2/`. **Git-ignored** — copy
anything still needed before that directory is cleaned.

### Remaining work, in dependency order

1. **Task 23** — `lineSizes` on `KeySpec` + variable line advance; gauges become
   `5-HR CAP` / `WEEK CAP` with big percentages, `BURN RATE` showing
   `UNDER`/`ON PACE`/`OVER` plus an evidence line `20% of 44%`, and `RESETS IN`.
   Must reuse `computePace` rather than duplicating the arithmetic.
2. **Task 24** — weather tiles: four non-overlapping bands (label 12 px, emoji 34 px at
   y 34, temps 16 px, rain 20 px), a dark per-condition background tint from the **same**
   keyword matcher as the emoji, heat-coloured temperatures, and the emoji `globalAlpha`
   dim fix. Needs Task 23's field.
3. **Task 22** — animation: `Page.tickMs`, `render(now, nowMs)`, per-page daemon interval,
   `getSpriteFrame(state, nowMs)`. Assets ready: 24 frames per state, 70 ms delay,
   in `assets/crab/<state>/` with `meta.json`. **User approved the frames.**
4. **Task 16** — per-window focus (needs the user to grant Accessibility to the `node`
   binary manually; may not prompt) and press feedback (flash white on success, red on
   failure — specified in the spec, never implemented).

### Not yet reviewed

Tasks 22 and 23 landed with strong self-evidence — measured `renderKey` cost of 0.032 ms,
before/after hashing proving the other three pages are pixel-identical, and verified frame
advance at 70 ms for all five states — and the controller independently confirmed the test
counts, the opt-in legacy text path, the shared `elapsedPercent` helper, and the frame
timing. **But neither went through the review loop.** That loop found real defects in most
tasks this session, so review them before trusting them fully.

## Deferred minors worth a sweep

- **Dead code:** the `sprite` field on `KeySpec` and `getSprite` in `src/render/sprites.ts`
  are now unused, because animation reuses `image`/`imageKey`. Task 22 left them rather than
  edit files another agent held. Remove them.

- `runAuthFlow` calls `closeAllConnections()` right after `res.end()`, which could truncate
  the browser's confirmation page. Close **after the response flushes** instead.
- `artRetryAt` in `src/sources/spotify.ts` has no eviction, unlike the capped art cache.
- 401 on a Spotify **control** call does not refresh-and-retry, unlike the poll path.
- `uninstall`'s summary says "restored … from the backup" even when it actually deleted.
- `writeAtomic` uses a fixed 0644 and does not preserve original permissions.
- `buildPlist` does not XML-escape interpolated paths.
- `StockSource.isStale()` is whole-source, so one lagging symbol is not dimmed alone.
- `getQuotes()` / `getSessions()` return internal collections by reference.
- `tests/paths.test.ts` still creates and chmods the real `~/.local/state/deckd` directories
  — non-destructive, but it violates the no-`~` rule.

---

## Working agreements with the user

- Prose in **ASD-STE100 Simplified Technical English** plus Zinsser: short sentences, active
  voice, present tense, one idea per sentence. Applies to replies, docs, comments, commits.
- Commit **directly to `main`** — explicitly consented, no worktree.
- **Ask before anything that touches their live config.** The install was approved
  explicitly and proven with a before/after hash.
- When a visual judgement is needed, **render a preview and send it** — they can see the
  device, no agent can. This resolved both the sprite choice and the crab frames.
- They report bugs precisely from real hardware. Three of their reports were genuine
  defects: two Ghostty windows not switching, the missing song title, and the overlapping
  weather icons. Take them literally.
