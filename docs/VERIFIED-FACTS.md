# Verified facts

Everything here was **measured on this machine**, not assumed. Several of these
contradict what the plan originally said, and each wrong assumption cost a fix round.
**Do not re-derive these from documentation. Trust the measurement, or re-measure.**

---

## The device

Stream Deck Neo. USB vendor `0x0FD9`, product `0x009A`. Library model id `neo`.
Firmware `1.00.011`. Serial `REDACTED-SERIAL`.

| Control | Index | Detail |
| --- | --- | --- |
| Keys, top row | 0, 1, 2, 3 | 96 × 96 px LCD |
| Keys, bottom row | 4, 5, 6, 7 | 96 × 96 px LCD |
| Left round button | 8 | RGB backlight only, **no screen** |
| Right round button | 9 | RGB backlight only, **no screen** |
| Info strip | segment 0 | 248 × 58 px, `drawRegions: false` — one image only |

**User-confirmed by eye:** keys 0–3 are the TOP row, 4–7 the BOTTOM row. A press
listener confirmed every index: keys report 0–7, round buttons report 8 and 9.

### Screen-lock signal

Measured on this Mac on 2026-08-13: `/usr/sbin/ioreg -n Root -d1 -k
IOConsoleLocked` exposes `"IOConsoleLocked" = No` while unlocked. The previously
implemented `CGSSessionScreenIsLocked` query returns no such property on this
machine; interpreting that absence as unlocked caused the first live lock test
to fail silently. Absence is now an unknown/logged probe result, never a valid
unlocked observation.

**User-confirmed on the real deck:** after the correction, locking blanks all keys, the
strip, and both buttons within about two seconds. Escape at the lock screen keeps it blank,
and unlock restores the page. True system sleep/wake and USB unplug/reconnect are separate
physical checks and are not yet recorded as verified.

### Real library methods

```
fillKeyBuffer(keyIndex, buffer, { format })
fillLcd(lcdIndex, buffer, { format })          // the whole 248x58 strip
fillKeyColor(keyIndex, r, g, b)                // the RGB round buttons
setBrightness(percent)
clearKey(keyIndex)  clearPanel()  clearLcdSegment(lcdIndex)
```

- **There is no `setButtonColor`.** That name is ours; it is implemented with `fillKeyColor`.
- **`format` accepts `'rgb' | 'rgba' | 'bgr' | 'bgra'` only. There is NO `'png'`.**
  The device takes raw pixel buffers. `renderKey`/`renderStrip` therefore return raw RGBA.

### Throughput, benchmarked

| Scope | Rate |
| --- | --- |
| one key | 2043 key-writes/sec |
| four keys | 422 key-writes/sec → 105 fps as a group |
| all eight keys | 362 key-writes/sec → 45 fps as a group |
| the strip | 1218 writes/sec |

USB is **not** the animation constraint. The daemon's own render interval is.

---

## `@napi-rs/canvas` (0.1.100)

**There is NO synchronous image decode.** `const img = new Image(); img.src = buf` sets
`width`, `height` and `complete` immediately, but the pixel data is NOT ready — a later
`drawImage` paints transparent black `[0,0,0,0]`. True for PNG and JPEG both.

Only `await loadImage(buf)` yields a drawable image. The render loop cannot await, so
**every image decodes once, off the render path**, and `KeySpec.image` holds an
already-decoded `Image`.

**Colour emoji work.** `Apple Color Emoji` is available. A `⛈` at 44 px produced 1218 ink
pixels, 233 of them chromatic. Caveat: emoji are bitmap glyphs and **ignore `fillStyle`**,
so dimming requires `globalAlpha`.

### Text budget — a key

Usable width is **81 px** (96 − 3 border − 6 padding each side).

| Font | Advance | Chars |
| --- | --- | --- |
| 11 px | 6.62 px | 12 |
| 13 px | 7.83 px | 10 |
| 16 px | 9.63 px | 8 |
| 20 px | 12.04 px | 6 |
| 24 px | 14.45 px | 5 |
| 28 px | 16.86 px | 4 |

Specific measurements that constrain designs:

- `95°/77°` at 16 px = 77 px, fits. **At 17 px = 82 px, does NOT fit.**
- `2h11m` at 24 px = 72 px, fits. **At 28 px = 84 px, does NOT fit.**
- `20%` at 28 px = 51 px. `100%` at 28 px = 67 px.
- `5-HR CAP`, `WEEK CAP` = 53 px. `BURN RATE`, `RESETS IN` = 60 px. `20% of 44%` = 66 px.

### Text budget — the strip

Usable width 236 px → **30 characters at 13 px Menlo**. The clock `2:17 / 2:33` takes 11.

---

## Claude Code integration

### Session state

Read-only from `~/.claude/daisy-statusbar/state.d/<session_id>.json`, written by the
separate `daisy-statusbar` project's `update.js` via hooks. **This project never writes
there.** The writer writes a temp file then renames, and its temp files are named
`<id>.json.<pid>.tmp`, so a reader must accept only names ending `.json`.

**The `state` field has exactly five values** (`update.js:54-84`): `idle`, `thinking`,
`tool`, `permission`, `done`. Anything else maps to `unknown`.

Fields (`update.js:99`): `state`, `label`, `tool`, `project`, `cwd`, `sessionId`,
`transcript`, `entrypoint`, `term_program`, `pid`, `started`, `startedAt`, `ts`.

`pid` is `process.ppid` of the hook — the PARENT of the hook, **not the terminal**.

### Rate limits are NOT on disk

Claude Code passes them on **stdin to the statusline command**, once per render. A separate
daemon cannot read them. Hence the wrapper that tees them to
`~/.local/state/deckd/usage.json`.

Confirmed stdin fields: `.rate_limits.five_hour.used_percentage`, `.resets_at`,
`.rate_limits.seven_day.*`, `.model.display_name`, `.context_window.used_percentage`,
`.context_window.total_input_tokens`, `.context_window.context_window_size`,
`.cost.total_cost_usd`, `.effort.level`, `.workspace.project_dir`.

`session_id` is taken from Claude Code's documented payload rather than measured; the
wrapper fails safe without it (writes `usage.json`, skips the per-session file).

### statusLine is shell-executed — evidenced

The user's value is `~/.claude/statusline.sh`. That leading `~` only resolves under a
shell; a direct `exec` would fail with ENOENT. So the wrapper may rely on a `VAR=value`
assignment prefix, `#` starting a comment, and tilde expansion.

---

## OpenAI Codex desktop integration

Measured locally on 2026-08-13:

- `~/.codex/state_5.sqlite` contains the read-only `threads` index, including thread id,
  title, cwd, model, rollout path, updated time, archive state, and token count. Exact
  columns read: `threads.{id, rollout_path, updated_at_ms, title, cwd, model, tokens_used,
  archived, thread_source, preview}`. `model` can be `NULL`. `updated_at_ms` is epoch
  MILLISECONDS, unlike the accounting timestamps below.
- User-owned tasks have `thread_source = 'user'`; internal approval-review work is stored
  as `thread_source = 'subagent'` and must not appear as a user task tile. A third value,
  `realtime_voice`, also exists in the live index.
- **`title` has no length limit.** `MAX(LENGTH(title))` in the live index measured
  **42,081 characters** (that row is `thread_source = 'subagent'` and is correctly
  filtered, but the same column serves user rows too). The query truncates it with
  `substr(title, 1, 64)` rather than retaining or re-serialising the whole thing every poll.
- Rollout JSONL emits `type: "event_msg"` envelopes; the field that matters is
  `payload.type`, one of `"task_started"`, `"task_complete"`, or `"token_count"`.
  `event.timestamp` is an ISO string.
- Its repeated `token_count` events carry `payload.info.total_token_usage.total_tokens` and
  `payload.rate_limits.{primary, secondary, plan_type}`, where each non-null limit is
  `{used_percent, window_minutes, resets_at}` with `resets_at` in epoch SECONDS (not
  milliseconds — the two accounting clocks in this schema do not agree with each other or
  with `updated_at_ms` above). On this account: `plan_type = "team"`, `window_minutes =
  10080` (seven days), and `secondary` is currently `null` — one window only.
- A rollout can be many megabytes; the live index already references one at 2.7 MB. The
  Codex source establishes its byte offset once per rollout and reads only appended bytes
  on every poll AFTER that — but the very FIRST read of any rollout (a cold daemon start, or
  a rollout newly entering the top ten) is itself bounded to a fixed trailing byte window
  rather than the whole file, precisely because a multi-megabyte first read would block the
  event loop for seconds on its own. Do not read the earlier wording ("establishes state
  once, remembers its byte offset, and reads only appended bytes") as covering the cold
  start — it does not; that gap was a Critical review finding.
- These files are local implementation details rather than a public integration API.
  Schema or event changes must fail closed to an unavailable Codex page and must never
  stop the daemon or the other pages. A field that is absent or renamed must render as
  unknown (`--`), never as a measured `0` — that failure mode reached shipped code once
  already and is why this line is here.
- **The database is WAL mode, and its `-wal`/`-shm` sidecars exist only while Codex is
  actively holding the database open.** Measured on this machine on 2026-08-13: while
  Codex has `state_5.sqlite` open, `state_5.sqlite-wal` and `state_5.sqlite-shm` exist
  beside it; once Codex closes or checkpoints, they disappear, and only the bare
  `state_5.sqlite` file remains. This is the database's NORMAL resting state, not a rare
  edge case — Codex is not continuously writing to it.
- **With the sidecars absent, every read-only form of `mode=ro` fails; `immutable=1` is
  the only one that still works, and it creates no sidecar file.** Measured directly
  against a scratch WAL database with its sidecars removed by hand (the reproduction
  technique that caught the correction below, and the one this fix's own tests use):

  | Command | Result |
  | --- | --- |
  | `sqlite3 -readonly "file:<path>?mode=ro"` | error 14 |
  | `sqlite3 "file:<path>?mode=ro"` | error 14 |
  | `sqlite3 -readonly <path>` | error 14 |
  | `sqlite3 "file:<path>?mode=ro&immutable=1"` | **works**, creates no sidecar |
  | plain read-write open | works, but **creates the `-shm`** |

  The cause: a read-only connection to a WAL database needs the `-shm` file to track the
  WAL's state, and a read-only connection cannot create one. This is also the root cause
  of the daemon's own intermittent `unable to open database file (14)` warning on the
  live deck: not a locked writer, simply Codex not holding the database open at that
  instant, which is most of the time.
- **CORRECTION.** An earlier version of this file claimed the opposite: that `mode=ro`
  creates the missing `-shm` itself and so never needs an `immutable=1` fallback. **That
  claim was false**, and the fallback that absence justified removing was wrongly
  removed along with it — for a time, the live Codex page showed no task data whenever
  Codex was not that instant writing to its database. The false claim looked true only
  because the one time it was checked, the sidecars already existed (Codex happened to
  be holding the database open at that moment), so the open trivially succeeded and the
  absence of any create-`-shm` step went unnoticed. Retested with the sidecars actually
  absent, per the table above, `mode=ro` fails outright. **Do not re-derive this from
  memory of an earlier version of this file; the table above is the measurement.**
- **The exclusive-lock trap measured previously still stands, and is exactly why the
  restored fallback is tagged rather than trusted outright.** A live writer holding the
  database under `PRAGMA locking_mode=exclusive` makes the primary `mode=ro` attempt
  fail with `Error: in prepare, database is locked (5)` — and makes the SAME
  `immutable=1` fallback SUCCEED, handing back pre-checkpoint rows as current, exit code
  0, no warning on stderr, because `immutable=1` does not read the WAL at all. The exact
  condition that makes the fallback unsafe is also the condition that triggers it. This
  is why a fallback read is never treated as equivalent to a primary one: it is tagged
  degraded, rendered dimmed on the page, and never allowed to satisfy a freshness
  check — the user would rather see a slightly old task list, clearly marked, than an
  empty page, but only for as long as it cannot masquerade as current.
- **Current design.** Primary read: `file:<path>?mode=ro` (no `-readonly` flag — the
  table above shows it composes identically with the URI's own `mode=ro` in every case
  tried, so it added nothing). On failure, ONE fallback attempt: `mode=ro&immutable=1`,
  its result always tagged degraded. If BOTH attempts fail, the page shows the honest
  unavailable state, exactly as before. The database is never opened read-write, which
  would create the `-shm` and mutate Codex's own on-disk state — that is the one thing
  this source must never do, whichever read mode it is trying.
- `window_minutes` needs the same sanity bound `resets_at` already had: a value at or
  beyond roughly a year of minutes is far more likely to be the same figure in
  milliseconds (Codex's own sqlite already writes `updated_at_ms`/`created_at_ms` that
  way) than a real plan window, and is treated as unknown, failing that limit closed.
- A `token_count` event whose own `timestamp` does not parse renders `ts` as `null`
  (never a fabricated `0`, which previously displayed as 7:00 PM EST 1969 beside a live
  percentage) and forces that whole usage sample unknown, regardless of what its
  `resets_at` claims — an unparseable clock on the sample is reason enough to distrust
  the reading as a whole, not only its displayed time.

---

## Spotify

- Client id `REDACTED-CLIENT-ID`, taken from the user's own
  `~/Vibecoding/m5stackfirmware/src/config/secrets.h`. Provisioned to
  `~/.local/state/deckd/config.json`, mode 0600, **outside the repo** so no credential is
  in git.
- Redirect URI **`http://127.0.0.1:8888/callback`** — the URI that app already registers.
  Spotify docs, quoted: *"Use HTTPS for your redirect URI, unless you are using a loopback
  address, when HTTP is permitted"* and *"localhost is not allowed as redirect URI."*
- PKCE only. **The client secret and the m5 project's refresh token are never used**,
  because reusing that token could break the user's other device if Spotify rotates it.
- Album art is served as **JPEG** at 640×640, 300×300 and 64×64. `pickArtUrl(images, 96)`
  selects the 300.

### The heart is READ-ONLY, and that is Spotify's restriction

The existing token has all five historical scopes — confirmed from the token refresh
response. The heart and saved-library code are now removed, so new authorization requests
only the three playback scopes. Despite the historical library scopes,
measured with a freshly refreshed token:

| Endpoint | Status |
| --- | --- |
| `GET /v1/me` | 200 |
| `GET /v1/me/player` | 200 |
| `GET /v1/me/tracks?limit=1` | **200**, total 946 |
| `GET /v1/me/albums?limit=1` | 200, total 35 |
| `GET /v1/me/tracks/contains` | **403 Forbidden** |
| `PUT /v1/me/tracks` | **403 Forbidden** |

The PUT was tested on an **already-saved** track so it was idempotent; the library is
unchanged at 946. This is an app-level restriction, not a scope gap. **No code change
unblocks it.** The lead, if ever wanted, is the app's status in the Spotify dashboard.

So saved state is read by paging `GET /me/tracks` into a Set once per process, and the
heart displays but does not toggle. `toggleSaved` was deleted rather than stubbed.

---

## Stocks

Yahoo's chart endpoint, **no API key**:
`https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?range=1d&interval=5m`
Send `User-Agent: Mozilla/5.0` or it can be rejected.

- **`meta.marketState` does NOT exist.** Derive the market state from
  `meta.currentTradingPeriod`, which holds `pre`/`regular`/`post` windows as epochs.
- Intraday closes at `indicators.quote[0].close`, ~79 points at 5-minute interval, with
  `null` holes that must be filtered.
- Daily change = `(regularMarketPrice - previousClose) / previousClose * 100`, falling back
  to `chartPreviousClose`.
- **`SPCX` is a real ticker**: `Space Exploration Technologies Corp.` on NasdaqGS.
- The eight symbols: `TSLA MSFT NVDA NOW SOFI HIMS SPCX AMZN`.

### Task 25: the detail view's `meta` fields, verified on TSLA

Probed live from the same chart endpoint. These feed `Quote.dayHigh`,
`dayLow`, `week52High`, `week52Low` and `volume`, each `number | null`, parsed
with the existing `numberOrNull` helper — absent renders as `--`, never `0`:

| `meta` field | Value |
| --- | --- |
| `regularMarketDayHigh` | `335.5` |
| `regularMarketDayLow` | `323.64` |
| `fiftyTwoWeekHigh` | `498.83` |
| `fiftyTwoWeekLow` | `297.38` |
| `regularMarketVolume` | `27695899` |

No second endpoint was fetched — every one of these already comes back on
the same `chart` response the source already requests for the spark and the
price.

### Task 33: the 52-week chart's own request, verified live on 2026-08-13

A second request, on the SAME keyless endpoint and the SAME `User-Agent`:
`https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?range=1y&interval=1d`

| Symbol | Points | `null` holes | Note |
| --- | --- | --- | --- |
| `TSLA` | 251 | 0 | full year of trading days |
| `HIMS` | 251 | 0 | |
| `SOFI` | 251 | 0 | |
| `SPCX` | 42 | 0 | listed under a year ago — `firstTradeDate` limits it |

- **The `meta` shape is the SAME `chart.result[0].meta` block**, so the
  existing `extractMeta`/`extractCloses` helpers need no change to read it.
  `fiftyTwoWeekHigh`, `fiftyTwoWeekLow`, `regularMarketPrice` and
  `regularMarketVolume` are all still present.
- **`meta.previousClose` is ABSENT on the yearly response** (present on the
  intraday one). Only `chartPreviousClose` is there. This does not affect the
  chart, which only reads `indicators.quote[0].close`, but it means the
  yearly body must never be used as a substitute for the intraday one for any
  price-derived field.
- `meta.marketState` still does not exist here either, consistent with the
  intraday endpoint.
- A short-history symbol (`SPCX`, 42 points, not 251) is a real, expected
  shape, not a malformed response — the chart must render correctly with far
  fewer than 252 points too.

---

## Weather

US National Weather Service, **no API key**. **Rejects requests without a `User-Agent`.**

1. `https://api.zippopotam.us/us/10001` → Brooklyn, FL at `40.7484, -73.9967`.
2. `https://api.weather.gov/points/<lat>,<lon>` → `properties.forecast` (a URL). Office `OKX`.
3. GET that URL → `properties.periods`, ~14 entries alternating day and night.

- `probabilityOfPrecipitation` is an **object** whose `.value` can be `null`. Null means
  unknown and must never render as `0%`.
- `windSpeed` is a **string** like `"8 mph"`. Measured live on 2026-08-13 (OKX office): 14
  periods, 4 distinct `windSpeed` values, 3 of the 4 a range like `"5 to 8 mph"` — a range is
  the COMMON shape here, not an edge case.
- `windDirection` is a **string** like `"NE"`, already abbreviated (1 to 3 letters: `N`,
  `SW`, `WNW`). Empty when unknown, never fabricated.
- `detailedForecast` is a full paragraph. Measured live on 2026-08-13: longest 290
  characters. `shortForecast`'s longest measured the same day was 58 characters.
- **User decision: percent chance only, NO rainfall amounts.** So `forecastGridData` is
  never fetched and there is no millimetre conversion. (Amounts *are* available there as
  `quantitativePrecipitation` in mm, if that ever changes.)

---

## macOS specifics

- **Per-window focus needs Accessibility permission**, which is NOT granted.
  `osascript -e 'tell application "System Events" to get name of every window of process "Ghostty"'`
  fails with `-1728 not allowed assistive access`. Automation permission (already working)
  is not sufficient.
- **Ghostty serves all its windows from one process**, so a session's `pid` walks up to the
  same app process for every window — pid cannot distinguish them. The workable
  discriminator is the window **title** matched against the session's `cwd`.
- `tell application "X" to activate` raises the APP, not a window, so it is a no-op when the
  app is already frontmost. This is why pressing a session key does not switch between two
  Ghostty windows.
- No `ffmpeg`, no ImageMagick, no `gifsicle`, no Pillow. `sips` exists but returns only
  frame 0 of a GIF. GIF frame extraction therefore uses the `omggif` devDependency,
  offline, shipping PNGs.
