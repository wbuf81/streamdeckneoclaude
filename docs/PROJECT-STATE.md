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
| **Stocks** | 8 tickers with price, daily change, sparkline, red/green. Press a ticker for a detail view across all 8 keys, BACK on key 7 | live |
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

## Task ledger — 25 complete, 2 open

Full detail is in `.superpowers/sdd/2026-08-12-streamdeck-neo-claude-deck/progress.md`,
but **that directory is git-ignored**, so this file is the durable record.

| # | Task | State |
| --- | --- | --- |
| 1–11 | scaffold → renderer → device → sources → Claude page → daemon | complete |
| 12 | Spotify OAuth (PKCE, port 8888) | complete |
| 13 | Spotify source | complete |
| 14 | Spotify page | complete |
| 15 | install + launchd | complete, **run** |
| 16 | per-window focus + press feedback | complete, see the caveat below |
| 17 | stock source | complete |
| 18 | stocks page | complete |
| 19 | weather source + page | complete |
| 20 | Spotify redesign: 2×2 art, read-only heart | complete |
| 21 | extract animated crab frames | complete |
| 22 | animate the Claude crabs | complete |
| 23 | gauge row legibility (`lineSizes`) | complete |
| 24 | weather tile overlap + tint | complete |
| — | all 9 deferred minors | complete, commits `1b4ddca` `5c6f7d0` `d59e325` `09c3fc4` |
| 25 | stock detail drill-down (`slice`, `fitSize`) | complete |
| 26 | Claude page: dedicated crab tile, 3 sessions, full-key flash | **pending** |
| 27 | Spotify page: cold-load bug, volume replaces heart, idle animation | **pending** |

Briefs and reports for tasks 9–24 are in
`.superpowers/sdd/2026-08-12-streamdeck-neo-claude-deck-part2/`. **Git-ignored** — copy
anything still needed before that directory is cleaned.

### Remaining work

Full briefs are preserved in `docs/pending-briefs/`. Both items below come from the user's
own reports on real hardware, so take them literally.

1. **Task 26** — the animated crab draws OVER its own tile's text. The user chose the fix:
   keys 0–2 become three text-only session tiles, key 3 becomes a permanent crab tile with
   no text. The crab shows the most urgent state across all sessions
   (`permission > tool > thinking > done > idle`). A fourth session becomes invisible, and
   that is intended. Also: the press flash recolours the **border**, which this theme draws
   as a left-edge strip, so the user cannot see it — fill the whole key instead, at 250 ms.
2. **Task 27** — three items. The Spotify page does not paint when nothing is playing until
   the user flips away and back; **reproduce it with a failing test before fixing it**, and
   report the real cause. The heart is removed and volume replaces it: key 2 play/pause,
   key 3 volume, key 6 previous, key 7 next, and `previous()` does not exist yet. Plus a
   procedural idle animation across the four art keys, each with its own phase.

### Task 16's real limitation

Window targeting is built and Accessibility **is now granted**, so it is the live path. But
Claude Code sets the terminal title to a **task summary**, not the directory, so a title
carries no trace of the cwd, the path, or the project for any window running Claude Code.
Measured: title `⠐ Build Elgato Stream Deck custom control software` against cwd
`/Users/you/Vibecoding/streamdeckneoclaude`. Nothing matches, so it correctly falls back to
app-level `activate` and logs once. A Claude window versus a plain shell switches correctly;
**two Claude windows still only raise the app.** The fix is upstream in the title itself.

## Deferred minors — all cleared

Every item on the old list is fixed. `getSessions()` and `getQuotes()` return copies,
`runAuthFlow` closes after the response flushes, `artRetryAt` is bounded, a 401 on a control
call refreshes and retries (a 403 never does), `uninstall` reports what really happened,
`writeAtomic` preserves permissions, `buildPlist` escapes XML, `isSymbolStale` exists and the
stocks page consumes it, the dead `sprite`/`getSprite` path is gone, and `tests/paths.test.ts`
no longer touches `~` — it uses the `enforceDirModes` seam in `src/paths.ts`.

### Review status

Tasks 22 to 25 and the minors sweep — commits `3dbd748` through `7b89bfa` — went through one
review pass, run as two scoped reviewers over `799d1ff..HEAD`: one on the renderer and the
pages, one on the sources, install, focus and the daemon. Findings and their rulings are in
`.superpowers/sdd/2026-08-12-streamdeck-neo-claude-deck-part2/review-A-render-pages.md` and
`review-B-sources-install.md`. **That directory is git-ignored**, so copy anything load-bearing
into this file before it is cleaned.

### New invariants added by these tasks

- `KeySpec.lineSizes` is **opt-in per key**. Its absence takes the exact legacy path: 11 px
  text on a fixed 14 px advance. Three pages depend on that, so never make it non-optional.
- `SparkSpec.slice` lets one chart span several keys. Absent `slice`, single-key drawing must
  stay byte-identical. `slice` is in `keyHash`, and it must stay there — the three slices
  share one series, so without it two of three would never redraw.
- `fitSize` in `src/render/text.ts` picks the largest candidate size that **measures** within
  the budget. Use it for anything whose width varies with the data. Do not compute widths from
  the advance table in `VERIFIED-FACTS.md`; that table is a guide, not an oracle.
- Weather tiles use four non-overlapping bands. The emoji sits at **32 px, y 38** — the
  brief's own suggested 34 px at y 34 overlapped the label, found by pixel probe. Tests assert
  the gaps are background, so drift fails the suite instead of reaching the glass.

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
