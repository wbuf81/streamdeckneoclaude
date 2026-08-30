# Stream Deck Neo Claude Deck — Design

- **Date:** 2026-08-12
- **Status:** Approved
- **Owner:** Wesley Bard
- **Writing style:** ASD-STE100 (Simplified Technical English)

---

## 1. Purpose

Build a daemon that controls an Elgato Stream Deck Neo. The daemon shows live
Claude Code status and Spotify playback. It replaces the Elgato software. The
Elgato software is not installed, and this project does not need it.

The user owns the device but does not use it. This project gives the device a
job.

## 2. Goals

1. Show every live Claude Code session on a key. Show the state, the project,
   and the model.
2. Show the 5-hour and 7-day rate limit usage on keys.
3. Press a session key to focus the terminal window of that session.
4. Show Spotify album art, track text, and a progress bar. Control playback.
5. Flip between pages with the two touch buttons.
6. Install and uninstall with one command each.

## 3. Non-goals

These are out of scope for v1. Each one needs its own design document.

- **Approve and deny tool calls.** The user runs Claude Code in auto mode.
  `~/.claude/settings.json` sets `permissions.defaultMode` to `auto`. The
  `PermissionRequest` hook almost never fires. The feature would sit idle.
- **House lights.** See section 14.
- **More pages.** Two pages are enough for v1.
- **A settings window.** A config file is enough.
- **Support for other Stream Deck models.** Only the Neo.

## 4. Verified hardware facts

I opened the device and read its descriptors. These are measurements, not
assumptions.

| Fact | Value |
| --- | --- |
| Product | Stream Deck Neo |
| USB vendor | `0x0FD9` (4057) |
| USB product | `0x009A` (154) |
| Firmware | `1.00.011` |
| Serial | *(removed: identifies one physical unit; no code reads it)* |
| Library model id | `neo` |

Controls:

| Control | Index | Type | Size |
| --- | --- | --- | --- |
| Keys, row 0 | 0–3 | `button`, feedback `lcd` | 96 × 96 px |
| Keys, row 1 | 4–7 | `button`, feedback `lcd` | 96 × 96 px |
| Left touch button | 8 | `button`, feedback `rgb` | No screen |
| Info strip | — | `lcd-segment`, id `0` | 248 × 58 px |
| Right touch button | 9 | `button`, feedback `rgb` | No screen |

Two facts drive the design:

1. The touch buttons have no screen. They show one color, and they report
   presses. They cannot show text.
2. The info strip reports `drawRegions: false`. The daemon must draw the whole
   248 × 58 strip as one image. It cannot address a sub-region.

The library `@elgato-stream-deck/node` opens the device with no native build
step and no Elgato software. I confirmed this on this machine.

## 5. Architecture

One process owns the USB device. HID access is exclusive, so a second process
cannot open the same device.

```
┌────────────────────────────────────────────────────┐
│  deckd  (one Node process, owns the HID handle)    │
│                                                    │
│   Sources            Pages          Output         │
│  ┌──────────┐      ┌─────────┐    ┌──────────┐     │
│  │ Claude   │─────▶│ Claude  │    │ Renderer │     │
│  │ Source   │      │ Page    │───▶│ (canvas) │     │
│  └──────────┘      └─────────┘    └────┬─────┘     │
│  ┌──────────┐      ┌─────────┐         │           │
│  │ Spotify  │─────▶│ Spotify │         ▼           │
│  │ Source   │      │ Page    │    ┌──────────┐     │
│  └──────────┘      └─────────┘    │ Device   │     │
│                         ▲         └──────────┘     │
│                    ┌────┴─────┐                    │
│                    │PageManager◀── touch buttons   │
│                    └──────────┘                    │
└────────────────────────────────────────────────────┘
```

Data flows one way. A Source reads the outside world. A Page turns that data
into a description. The Renderer turns the description into images. The Device
writes the images to the hardware.

### 5.1 Module boundaries

Each module has one job. Each module has a narrow interface. Each module has
tests that need no hardware.

**`Device`** wraps `@elgato-stream-deck/node`. It writes images to keys, sets
touch button colors, writes the strip, and reports presses. It handles connect
and disconnect. Nothing else touches the library.

```
connect()  disconnect()  onPress(cb)  onRelease(cb)
setKeyImage(index, buffer)  setStrip(buffer)  setButtonColor(index, rgb)
```

**`Renderer`** turns a `KeySpec` into a 96 × 96 pixel buffer. It turns a
`StripSpec` into a 248 × 58 pixel buffer. It is a pure function of its input,
so its output is stable. It uses `@napi-rs/canvas`.

```
renderKey(spec: KeySpec) -> Buffer
renderStrip(spec: StripSpec) -> Buffer
```

**`Page`** describes what the deck shows. It handles presses on its own keys. It
does not know about canvas or HID.

```
name: string
render(state) -> { keys: KeySpec[8], strip: StripSpec }
onKeyPress(index)
onKeyHold(index)
```

**`Source`** reads one outside system. It emits a `change` event when its data
changes.

```
start()  stop()  getState()  on('change', cb)
```

**`PageManager`** holds the page list and the current index. It maps touch
button 8 to the previous page and touch button 9 to the next page. It routes key
presses to the current page.

### 5.2 Render loop

The daemon redraws on change, not on a timer. A Source emits `change`. The
PageManager asks the current page for a new description.

The daemon compares each new `KeySpec` to the last one it drew. It writes only
the keys that changed. This matters, because a full 8-key write costs USB
bandwidth and time.

The Spotify progress bar is the one exception. It advances once per second while
music plays. Only the strip changes, so the daemon writes only the strip.

## 6. Data sources

### 6.1 Claude session state

Claude Code hooks already write this data. The project reads it and writes
nothing.

Path: `~/.claude/daisy-statusbar/state.d/<session_id>.json`

The `daisy-statusbar` project owns these files. `update.js` writes one file per
session on every hook event. It writes to a temporary file and then renames it,
so a reader never sees a half-written file.

Fields, confirmed at `update.js:99`:

| Field | Example | Use |
| --- | --- | --- |
| `state` | `tool` | Key label and border color |
| `label` | `Running command` | Strip text |
| `tool` | `Bash` | Strip text |
| `project` | `streamdeckneoclaude` | Key line 2 |
| `cwd` | `/Users/you/Vibecoding/…` | Window match |
| `sessionId` | `e2798b1d-…` | Join key |
| `transcript` | `~/.claude/projects/…jsonl` | Reserved, not used in v1 |
| `term_program` | `ghostty` | Window focus |
| `pid` | `39894` | Window focus |
| `startedAt` | `1786549502` | Elapsed time |
| `ts` | `1786549560` | Liveness and sort order |

The `state` field has exactly five values. I read them from `update.js:54–84`.

| `state` | Key label | Border color |
| --- | --- | --- |
| `idle` | `IDLE` | Dim gray |
| `thinking` | `THINKING` | Blue |
| `tool` | `TOOL` | Cyan |
| `permission` | `PERMIT?` | Amber |
| `done` | `DONE` | Green |

An unknown value maps to the label `BUSY` and a dim gray border. This rule keeps
the deck working if `daisy-statusbar` adds a state later.

The daemon watches the directory with `fs.watch`. It reads a file on create,
change, and delete. A poll every 5 seconds acts as a backstop, because `fs.watch`
drops events on some file systems.

A session is stale when `ts` is more than 10 minutes old. The daemon hides stale
sessions. `SessionEnd` normally deletes the file, so this rule only catches a
crashed session.

**Fallback.** The daemon does not depend on `daisy-statusbar` forever. If
`state.d` is absent, the install command can add our own `SessionStart`,
`PreToolUse`, and `Stop` hooks. These write the same shape to
`~/.local/state/deckd/sessions/`. v1 reads `state.d` and reports a clear message
when it is absent.

### 6.2 Rate limit usage

**This data is not on disk.** Claude Code sends it to the statusline command on
stdin. It arrives once per statusline render. A separate daemon cannot read it.

The fix is a wrapper. The wrapper reads stdin, saves the fields it needs, and
then runs the existing `~/.claude/statusline.sh` with the same stdin. The
terminal statusline output does not change.

Confirmed stdin fields, read from the `jq` filters in `statusline.sh`:

- `.rate_limits.five_hour.used_percentage`
- `.rate_limits.five_hour.resets_at`
- `.rate_limits.seven_day.used_percentage`
- `.rate_limits.seven_day.resets_at`
- `.model.display_name`
- `.context_window.used_percentage`
- `.context_window.total_input_tokens`
- `.context_window.context_window_size`
- `.cost.total_cost_usd`
- `.effort.level`
- `.workspace.project_dir`

The wrapper writes two files:

1. `~/.local/state/deckd/usage.json` holds the newest rate limit values and a
   timestamp. The gauge keys read this file.
2. `~/.local/state/deckd/sessions/<session_id>.json` holds `model.display_name`,
   the context window numbers, and the cost. The session keys read this file to
   show the model name. The `state.d` file does not carry the model name.

**One implementation task:** log one real statusline payload and confirm the
exact key for the session id. `statusline.sh` does not read it, so I could not
verify it. `update.js:99` proves that hook payloads use `session_id`. The
statusline payload very likely matches. The wrapper must fail safe. If the
session id is absent, the wrapper writes only `usage.json` and skips the
per-session file. The session key then omits the model line.

**Staleness.** The wrapper only runs while a Claude session renders a statusline.
The gauges go stale when no session runs. A value older than 15 minutes renders
dim, with the label `STALE`. The deck must not show an old number as if it were
fresh.

### 6.3 Spotify

The daemon uses the Spotify Web API. The user chose this over AppleScript,
because it gives album art. It also works when the music plays on a phone or a
speaker.

Setup, once:
1. The user registers a free app in the Spotify developer dashboard.
2. The user runs `deckd auth spotify`. The command starts a local redirect
   listener, opens the browser, and completes the OAuth code flow with PKCE.
3. The command saves the refresh token.

Scopes: `user-read-playback-state`, `user-modify-playback-state`,
`user-read-currently-playing`.

Credentials live in `~/.local/state/deckd/spotify.json` with mode `0600`. They
never enter the repository. The repository ignores the whole state directory.

Poll rules:
- Poll `GET /v1/me/player` every 3 seconds while music plays.
- Poll every 30 seconds while music is paused or stopped.
- Do not poll when the Spotify page is not visible. Read once on page entry.
- Advance the progress bar locally between polls. Do not poll for it.

On HTTP 401 the source refreshes the token once and retries. On a second 401 it
enters an unauthorized state. On HTTP 429 it honours the `Retry-After` header.

Album art: download the smallest image that is at least 96 px wide. Scale it to
96 × 96. Cache it on disk, keyed by track id. Cap the cache at 200 entries.

## 7. Claude page

Keys 0 to 3 hold live sessions. Keys 4 to 7 hold fixed gauges.

```
┌──────────┐┌──────────┐┌──────────┐┌──────────┐
│IDLE      ││ TOOL     ││ THINKING ││          │
│streamdeck││ daisy    ││ SNOOP    ││  (empty) │
│  (>_<)   ││  (>_<)   ││  (>_<)   ││          │
│  Opus 5  ││  Opus 5  ││  Opus 5  ││          │
└──────────┘└──────────┘└──────────┘└──────────┘
┌──────────┐┌──────────┐┌──────────┐┌──────────┐
│ 5h  62%  ││ 7d  34%  ││ PACE ⇡   ││ RESET    │
│  ███░░   ││  ██░░░   ││  fast    ││  2h11m   │
└──────────┘└──────────┘└──────────┘└──────────┘
 strip: streamdeckneoclaude · Bash · 14m
```

### 7.1 Session keys

A key holds its session. The deck must not reshuffle keys while the user reads
them, so the daemon never re-sorts a live session to a new key.

The assignment rules are exact:

1. On start, sort the live sessions by `ts`, newest first. Fill keys 0 to 3 in
   that order.
2. A session keeps its key until it ends or goes stale. Its `ts` may change. Its
   key does not.
3. A new session takes the lowest free key.
4. A key frees up when its session ends or goes stale. An unused key renders
   dark.

More than 4 live sessions is possible. Rule 3 then finds no free key, and the new
session gets no key. The strip shows a count, for example `+2 more`. A key frees
up under rule 4, and the waiting session with the newest `ts` claims it.

This design prefers a stable display over a complete one. The user reads these
keys at a glance, so movement costs more than coverage.

Each session key shows four things:

1. A state label, from the table in section 6.1.
2. The project name. The renderer truncates it to fit and adds an ellipsis.
3. The crab sprite.
4. The model display name, from the per-session cache file.

The border color carries the state. A key in the `permission` state pulses its
border between amber and dark, once per second. This draws the eye.

### 7.2 Gauge keys

| Key | Content |
| --- | --- |
| 4 | 5-hour window: percent used, bar |
| 5 | 7-day window: percent used, bar |
| 6 | Pace: burn rate against elapsed window time |
| 7 | Reset: time until the 5-hour window resets |

Bar colors: green below 60 percent, amber from 60 to 85 percent, red above 85
percent.

Pace compares the percent used against the percent of the window that has
elapsed. It shows `fast` with an up arrow when usage leads elapsed time. It
shows `slow` with a down arrow in the other case. It shows `even` when the two
are within 5 points. This copies the logic in `statusline.sh`.

A gauge renders dim with the label `STALE` when `usage.json` is more than 15
minutes old. A gauge renders `--` when `usage.json` is absent.

### 7.3 Presses

A press on a session key focuses the terminal window of that session.

The state file gives `pid` and `term_program`. For `term_program` of `ghostty`,
the daemon runs AppleScript to raise the window that owns that process. The
daemon walks up the process tree from `pid` to find the terminal process, because
`pid` is the hook process parent, not the terminal itself.

A press on an empty key does nothing. A press on a gauge key does nothing in v1.

Window focus can fail. It fails silently and logs a line. The daemon flashes the
key border white for 200 ms on success. It flashes red on failure. The user then
knows the press registered.

### 7.4 Strip

The strip shows the newest active session: project, tool, and elapsed time. It
shows `+N more` when more than 4 sessions are live. It shows the page name and
`no active sessions` when none are live.

## 8. Spotify page

```
┌──────────┐┌──────────┐┌──────────┐┌──────────┐
│░░░░░░░░░░││          ││          ││          │
│░ ALBUM ░░││   ◀◀     ││  ▶ / ❙❙  ││    ▶▶    │
│░  ART  ░░││          ││          ││          │
│░░░░░░░░░░││          ││          ││          │
└──────────┘└──────────┘└──────────┘└──────────┘
┌──────────┐┌──────────┐┌──────────┐┌──────────┐
│  VOL −   ││  VOL +   ││ SHUFFLE  ││  REPEAT  │
│          ││          ││   on     ││   off    │
└──────────┘└──────────┘└──────────┘└──────────┘
 strip: Black Sabbath — Planet Caravan
        ████████░░░░░░░░  2:14 / 4:32
```

| Key | Action |
| --- | --- |
| 0 | Album art. Press does nothing. |
| 1 | Previous track |
| 2 | Play or pause. The icon follows the real state. |
| 3 | Next track |
| 4 | Volume down, 10 points |
| 5 | Volume up, 10 points |
| 6 | Toggle shuffle. Shows the real state. |
| 7 | Cycle repeat: off, context, track |

Key 0 shows a Spotify logo when no track plays. It shows `SIGN IN` when the
source is unauthorized.

Every control writes to the API and then polls once after 300 ms. The API needs a
moment to settle, so an immediate poll returns the old state.

A control key flashes its border white for 200 ms on success. It flashes red on
failure. Spotify returns HTTP 403 when no device is active, so this feedback
matters.

## 9. Paging

| Input | Action |
| --- | --- |
| Touch button 8 | Previous page |
| Touch button 9 | Next page |

Pages wrap around. Page order: Claude, then Spotify.

Both touch buttons glow dim white. The button glows brighter for 150 ms on a
press.

The daemon saves the current page index to `~/.local/state/deckd/ui.json`. It
restores that page on start.

## 10. Install and uninstall

`deckd install` does four things:

1. Write a launchd agent to
   `~/Library/LaunchAgents/com.wbard.deckd.plist`. Set `RunAtLoad` and
   `KeepAlive`, so the daemon starts at login and restarts after a crash.
2. Create `~/.local/state/deckd/` with mode `0700`.
3. Install the statusline wrapper. Copy the current `statusLine` command from
   `~/.claude/settings.json`. Save it inside the wrapper. Point `statusLine` at
   the wrapper.
4. Print what it changed.

`deckd uninstall` reverses steps 1 to 3. It removes the launchd agent and stops
the daemon. It restores the original `statusLine` command. It leaves the state
directory in place, and it prints the path so the user can delete it. The state
directory holds the Spotify token, so the command must not delete it without a
request.

The install command backs up `~/.claude/settings.json` before it writes. It
writes to a temporary file and renames it, so a crash cannot leave a broken
settings file.

The install command refuses to run twice. It detects its own wrapper and reports
that the install is already complete.

## 11. Rendering

The renderer uses `@napi-rs/canvas`. This package ships prebuilt binaries, so it
needs no compiler. It gives the full Canvas 2D API, which the project needs for
text, bars, sprites, and album art.

Fonts: use one bundled bitmap-style font for all text. A bundled font makes the
output stable across machines. A system font can change and break a snapshot
test.

The crab sprite comes from `~/Vibecoding/clawd-on-desk/assets/`. That project
uses the MIT license, so the project may reuse the art. The `ACKNOWLEDGEMENTS.md`
file records the credit.

Text truncation is a shared helper. It measures the string, cuts it, and adds an
ellipsis. Every page uses the same helper, so truncation looks the same
everywhere.

The renderer draws on a dark background, because the keys glow in a dark room.

## 12. Failure modes

Every failure leaves the daemon useful. No failure crashes it.

| Failure | Behavior |
| --- | --- |
| Device unplugged | Log once. Retry enumeration every 2 seconds. Redraw all keys on reconnect. |
| Device in use by another process | Report a clear message. Name the likely cause. Exit with code 1. |
| `state.d` absent | Claude page shows `no session data`. Spotify page still works. |
| One state file is corrupt | Skip that file. Log once. Do not crash. |
| `usage.json` absent or stale | Gauges show `--` or `STALE`. |
| Spotify unauthorized | Key 0 shows `SIGN IN`. Claude page unaffected. |
| Spotify network error | Keep the last known state. Dim the strip. Retry with backoff. |
| No active Spotify device | Control keys flash red. |
| Window focus fails | Key flashes red. Log a line. |
| Daemon stopped | The user loses a display. Claude Code is unaffected, because no blocking hook exists. |

The daemon writes logs to `~/.local/state/deckd/deckd.log`. It rotates the file
at 5 MB and keeps one old copy.

## 13. Testing

The design puts the hardware behind one interface, so most tests need no
hardware.

**Unit tests, no hardware and no canvas.** A page returns a description object. A
test asserts on that object. Example: given three state files, the Claude page
puts `PERMIT?` on key 1 with an amber border.

**Source tests.** Feed a fake state directory and fake HTTP responses. Assert the
emitted state. Cover the stale rule, the corrupt file rule, and the 401 refresh
path.

**Renderer snapshot tests.** Render a `KeySpec` to a PNG and compare it against a
stored image. A bundled font keeps this stable.

**Device tests.** A fake `Device` records every write. A test asserts that a
one-key change writes one key, not eight. This protects the dirty-key
optimization.

**Install tests.** Run the install against a temporary settings file. Assert the
`statusLine` change. Run the uninstall. Assert that the file matches the
original byte for byte.

**Manual smoke script.** `npm run smoke` draws a test pattern on all 8 keys, both
touch buttons, and the strip. This is the only step that needs the device.

## 14. Future scope

### 14.1 House lights

The user has TP-Link Kasa devices, and the mix includes more than one device
type. This becomes a third page.

Kasa devices answer on the local network on TCP port 9999. The Node library
`tplink-smarthome-api` finds them with a UDP broadcast. Local control needs no
cloud account.

One risk needs a check first. Older Kasa devices use the simple local protocol.
Newer devices use a protocol called KLAP, and KLAP needs the TP-Link account
login. The first task of that project is a network scan that lists the exact
models. The design follows the scan, not the other way around.

### 14.2 Other ideas

- Read the transcript file to show a token count per session.
- Show a build or test status page.
- Add our own hooks, and drop the `daisy-statusbar` dependency.

## 15. References

| Item | Path or name |
| --- | --- |
| Device library | `@elgato-stream-deck/node` |
| Render library | `@napi-rs/canvas` |
| Session state writer | `~/.claude/daisy-statusbar/update.js` |
| Session state files | `~/.claude/daisy-statusbar/state.d/` |
| Statusline script | `~/.claude/statusline.sh` |
| Crab sprites, MIT | `~/Vibecoding/clawd-on-desk/assets/` |
| Kasa library, future | `tplink-smarthome-api` |

Section 3 drops the approve and deny feature. If a later project revives it,
`~/Vibecoding/clawd-on-desk/src/permission.js` holds a working reference. It
shows the `PermissionRequest` HTTP hook and the exact response shape.
