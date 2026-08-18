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
  restored fallback is tagged rather than trusted outright — but "tagged" now depends on
  the `-wal` sidecar's own size, not on which URI mode answered.** A live writer holding
  the database under `PRAGMA locking_mode=exclusive` makes the primary `mode=ro` attempt
  fail with `Error: in prepare, database is locked (5)` — and makes the SAME
  `immutable=1` fallback SUCCEED, handing back pre-checkpoint rows as current, exit code
  0, no warning on stderr, because `immutable=1` does not read the WAL at all. The exact
  condition that makes the fallback unsafe is also the condition that triggers it. A
  fallback read is therefore never AUTOMATICALLY treated as equivalent to a primary
  one — but whether it actually IS unsafe on any given read depends on whether the `-wal`
  held anything for it to miss. See the correction directly below.
- **CORRECTION (round 3).** An earlier version of this file (and the source code it
  described) tagged EVERY fallback read degraded, unconditionally, on the reasoning that
  `immutable=1` never reads the WAL so it might always be missing something. Measured
  directly on a scratch WAL database, reproducing both states in turn on the SAME file:

  | `-wal` state | `immutable=1` result |
  | --- | --- |
  | absent (removed entirely after an auto-checkpoint on connection close) | returned every row a plain `mode=ro` read of the same file did, at the same moment |
  | present, truncated to exactly 0 bytes (`PRAGMA wal_checkpoint(TRUNCATE)`) | same — exact |
  | present, non-empty (a writer connection open with a committed-but-uncheckpointed row) | silently OMITTED that row, while a plain `mode=ro` read of the same file, at the same moment, returned it |

  So an absent OR zero-length `-wal` proves the `immutable=1` read is byte-exact — there
  was nothing in the WAL for it to miss — and unconditional tagging was wrong: it made
  "degraded" the PERMANENT resting state, because Codex normally has the database open,
  which makes the fallback the everyday path rather than a rare one. A permanent signal
  carries no information and trains the user to ignore the one case that matters. The
  fix checks the `-wal` sidecar's own byte size (one `statSync`, `ENOENT` treated the same
  as zero) at the moment of the fallback read: zero reports the read as EXACT, non-zero
  reports it genuinely degraded. This is now the REAL exclusive-lock trap's exact
  boundary too: the lock only makes the fallback unsafe while a writer has actually left
  something uncheckpointed in the WAL, which the same byte check catches directly instead
  of assuming from which URI mode happened to answer.
- **Current design.** Primary read: `file:<path>?mode=ro` (no `-readonly` flag — the
  table above shows it composes identically with the URI's own `mode=ro` in every case
  tried, so it added nothing). On failure, ONE fallback attempt: `mode=ro&immutable=1`,
  its result tagged degraded ONLY when the `-wal` sidecar is non-empty at read time (see
  the correction above) — an absent or empty `-wal` reports the fallback as exact, the
  same as a primary read. If BOTH attempts fail, the page shows the honest unavailable
  state, exactly as before. The database is never opened read-write, which would create
  the `-shm` and mutate Codex's own on-disk state — that is the one thing this source must
  never do, whichever read mode it is trying.
- `window_minutes` needs the same sanity bound `resets_at` already had: a value at or
  beyond roughly a year of minutes is far more likely to be the same figure in
  milliseconds (Codex's own sqlite already writes `updated_at_ms`/`created_at_ms` that
  way) than a real plan window, and is treated as unknown, failing that limit closed.
- A `token_count` event whose own `timestamp` does not parse renders `ts` as `null`
  (never a fabricated `0`, which previously displayed as 7:00 PM EST 1969 beside a live
  percentage) and forces that whole usage sample unknown, regardless of what its
  `resets_at` claims — an unparseable clock on the sample is reason enough to distrust
  the reading as a whole, not only its displayed time.
- **M9 — the 256 KB cold-start tail cap (`COLD_START_TAIL_BYTES`) can under-report an
  active task.** The cap itself is correct and necessary (see above: an unbounded first
  read of a multi-megabyte rollout would block the event loop). The consequence is not
  hypothetical and is recorded here rather than left implicit: a task whose
  `task_started` line sits more than 256 KB back from the end of its rollout reads as
  INACTIVE after a daemon restart, or the first time the Codex page opens for a rollout
  it has not seen before, because the cold-start tail contains that task's later
  `token_count` events but not its `task_started` line. `active` stays false, the task
  never enters `tasks`, and the grid can show empty while Codex is genuinely working.
  This fails closed, which is the right default, but the failure is silent from the
  page's perspective — there is no "possibly more active tasks than shown" signal.
  Widening the cap for this one case, or detecting "no lifecycle event found in a cold
  tail" and reading further back, would close it; neither is implemented.

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

### The four `meta` fields the source reads but this file never recorded

`parseQuote` reads `meta.symbol`, `meta.shortName`, `meta.currency`, and
`meta.regularMarketTime` — the last of these is the SOLE input to `Quote.asOf`,
which both staleness checks depend on. Live probe, TSLA intraday, 2026-08-13,
`User-Agent: Mozilla/5.0`:

| Field | Type | Value |
| --- | --- | --- |
| `symbol` | string | `"TSLA"` |
| `shortName` | string | `"Tesla, Inc."` |
| `currency` | string | `"USD"` |
| `regularMarketTime` | number | `1786651200` |
| `marketState` | undefined | still absent, as already recorded above |

All four assumptions hold. If `regularMarketTime` ever disappeared, `asOf`
would silently pin to `0` on every symbol — and with `marketState` unknown,
`isSymbolStale` now dims for that reason (see the "unknown" market-state
handling), rather than treating it as a safe, non-stale reading.

Also confirmed from the same body: `currentTradingPeriod.regular.end ===
currentTradingPeriod.post.start === 1786651200`, so `within`'s `[start, end)`
boundaries produce no gap at the pre/regular/post handover.

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
- **The conditions tile's raw `windSpeed` line, measured at the key's 11 px font (M3,
  2026-08-13):** `"8 mph"` (5 characters) is 33.1 px; `"3 to 8 mph"`/`"5 to 8 mph"` (10
  characters) are 66.2 px; `"10 to 15 mph"` (12 characters, the widest shape a day/night
  range plus `mph` can realistically take) is **79.5 px**, inside the 81 px usable width
  with only 1.5 px to spare. This is the same `12 characters` row `@napi-rs/canvas`'s own
  measured advance table already gives for 11 px (`docs/VERIFIED-FACTS.md`'s "Text budget —
  a key"), confirmed directly for this specific string rather than assumed from the general
  row. The margin is thin enough that this line is passed to `renderKey` as a one-candidate
  array (`[11]`), not a bare `11`, so it is measured and `shrinkToFit`-protected rather than
  drawn unchecked — a bare `number` in `lineSizes` skips measuring entirely.

### Four more `periods[]` fields, and the one assumption this file did not support

`parseForecast` also reads `periods[].name`, `isDaytime`, `startTime` (the tile
identity), and `temperature` — none previously recorded here. Live probe,
`gridpoints/OKX/33,37/forecast`, 2026-08-13:

```
periods: 14
distinct dates: 8
keys: number,name,startTime,endTime,isDaytime,temperature,temperatureUnit,
      temperatureTrend,probabilityOfPrecipitation,windSpeed,windDirection,
      icon,shortForecast,detailedForecast
temperatureUnit values: ["F"]
isDaytime seq: NDNDNDNDNDNDND
names[0..3]: ["Tonight","Friday","Friday Night","Saturday"]
probabilityOfPrecipitation nulls: 0
```

8 distinct dates across 14 periods is the correct shape (a past fixture with 7
days and 1 distinct date hid a Critical — see the day-identity tests). Tracing
this body through `parseForecast`: `p0` is `Tonight` (night), so tile 0 is
`2026-08-13:night`; the loop then pairs `Friday`/`Friday Night` into
`2026-08-14:day`, and so on. No identity collides on real data.

**The unsupported assumption, now flagged: `temperatureUnit` is never read.**
`PeriodDetail.temperature` is documented as "Degrees Fahrenheit" and `tempOf`
takes the number as-is with no unit check. The field exists on every period
and is `"F"` today, but nothing in the source ties the two together — if NWS
ever served Celsius for this office (the `/forecast?units=si` parameter
already produces exactly that), the deck would draw the number as Fahrenheit
with no error anywhere. This file records the assumption explicitly here
rather than leaving it silent: `temperatureUnit` is assumed `"F"` and is not
currently enforced in code.

### Zippopotam's `latitude`/`longitude` are JSON strings, not numbers

`parseZipBody` requires `typeof p.latitude === 'string'` (and the same for
`longitude`) before calling `Number.parseFloat` — a numeric `40.7484` in the
body would fail that check and return `null`. This file already recorded the
resolved values (`40.7484, -73.9967`) but not their JSON type. If the service
ever returned numbers instead of strings, `resolveZip` would return `null`
forever, `coords` would never cache, and the weather page would stay
permanently `empty` — recorded here so that failure mode is traceable to this
exact assumption rather than treated as a mystery.

---

## Football (task 42, measured 2026-08-14)

The task 40/41 version of this page used TheSportsDB's free tier, which
returns exactly one event per team per call — it cannot show "next three
games." Re-measured live for the rebuild:

- **`site.api.espn.com` is still Akamai-blocked**: HTTP 403, confirmed again
  with Node's own `fetch`, not just `curl`. Per lesson 10, this host is
  never retried.
- **A different ESPN host, `sports.core.api.espn.com`, is OPEN** and serves
  a team's full season, not one game:
  - `.../nfl/seasons/2026/teams/30/events?limit=50` → `count: 20`, 20 `$ref`
    items (Jaguars: 3 preseason + 17 regular season).
  - `.../college-football/seasons/2026/teams/57/events?limit=50` →
    `count: 12`, 12 items (Gators: no preseason games in this list at all).
  - Team ids on this host are ESPN's own and differ from the old TheSportsDB
    ids: **Jaguars = `30`** (league `nfl`), **Gators = `57`** (league
    `college-football`).
  - Each `$ref` must be followed individually — the list gives no inline
    date, name, or score. Following one event ref returns `name`
    (`"Jacksonville Jaguars at New Orleans Saints"`), `shortName`
    (`"JAX @ NO"`), `date` (`"2026-08-15T20:00Z"`), `timeValid` (boolean),
    and `competitions[0].competitors[]` with `id`/`homeAway`/`order` —
    but competitors' own `score`, `record`, and `status` are ALL further
    `$ref` links, not inlined. This page never follows those: no score is
    shown anywhere in the rebuilt page, by design (see below).

### Opponent name and home/away — no extra request needed

`name` is **always** `"Away Team at Home Team"`, verified on **32 of 32**
real events across both teams' full seasons, including neutral-site games
(the Florida-Georgia game's `name` still says "Florida Gators at Georgia
Bulldogs" even though `shortName` switches to `"FLA VS UGA"` and
`competitions[0].neutralSite` is `true`). Splitting on the literal `" at "`
gives the opponent's full name with **zero extra requests per game**.

Home/away itself comes ONLY from `competitors[].homeAway`, matched against
the known team id — never from the `name`/`shortName` string order. Proven
necessary by the Florida-Georgia game itself: Georgia (id `61`) is marked
`homeAway: "home"` there despite the fixed neutral venue (playoff-seeding
convention), so guessing "away team is whichever comes first in the string"
would have been right by luck on 31 of the 32 events and silently wrong on
this one.

`shortName` gives the same pair as an abbreviation (`"JAX"`/`"NO"`,
`"FLA"`/`"UGA"`), split on `" @ "` for a normal game or `" VS "` for a
neutral-site one (both measured live).

### TBD kickoffs — ARE distinguishable on this host

`timeValid` is a real, per-event boolean. Measured live across the full
Gators season: `false` on 7 of 12 games (everything more than roughly two
weeks out), `true` on the 5 closer in — this is a common, ongoing state
throughout a season, not a rare edge case confined to the far future. The
NFL's own Week 18 games (`timeValid: false`) additionally still carry a
placeholder, non-midnight UTC time (`05:00Z`), so the OLD ambiguity
(TheSportsDB's `00:00:00` that could be a real prime-time kickoff or a
placeholder) does not apply here: this source treats `timeValid !== true`
as TBD for the kickoff TIME only, while still trusting `date`'s calendar
day for the DATE line.

### Season record — a dedicated endpoint, not a self-tally

`.../<league>/seasons/2026/types/<N>/teams/<id>/record` returns several
named records; `items` with `name: "overall"` carries a flat `stats` array
including real numeric `wins`, `losses`, `ties`, and `gamesPlayed` — this
is ESPN's own authoritative tally, never computed by walking events.

Season-type numbering, measured identical on BOTH leagues: `types/1` =
Preseason, `types/2` = Regular Season, `types/3` = Postseason, `types/4` =
Off Season. The record shown on the logo tile reads `types/2` (regular
season) only — a preseason record folded into "the record for the year"
would misrepresent it. Measured live on 2026-08-14 (preseason under way,
regular season not started): `types/2`'s `gamesPlayed` is `0` for the
Jaguars, so the real, authoritative record IS `0-0` — but the page renders
this as an explicit unknown (`--`), never the literal `0-0`, per the task
brief's own instruction and lesson 18: a `gamesPlayed: 0` record is real
data saying "nothing has happened yet," and showing `0-0` on a tile reads
as "the team already went 0-0," which is false.

### N+1 cost and fetch strategy — measured

Following every event ref for a full combined season (20 NFL + 12 college
= 32 refs) at concurrency 10 completed in **0.58 s**, all 200s (`curl` via
`xargs -P 10`, measured 2026-08-14). Three sequential (unbatched) refs took
0.33 s. Based on this, `FootballSource` follows event refs at a concurrency
cap of **6 per team** (so up to 12 combined, both teams refreshing in
parallel) — comfortably under the measured-safe ceiling while keeping this
source well clear of a 32-request burst. This only ever runs from the
periodic 6-hour poll or the initial visible-refresh; `FootballPage`'s
`onKeyPress` performs no network I/O at all, so pressing a logo tile to
open the full schedule reads from the cache already populated by that
periodic refresh, never triggering a fresh 32-request burst on a key press.

The season's current year (`2026`) is hardcoded, matching this project's
existing convention for the team ids — `sports.core.api.espn.com/v2/
sports/football/leagues/<league>` DOES carry the live season year inline
(`season.year`), which would let this self-correct automatically, but that
is one more request per league per poll for a value that changes once a
year. Bump `SEASON_YEAR` in `src/sources/football.ts` when the 2027 season
starts.

### Logo art leaves too little clean margin for a record line — composited instead

Measured by drawing each REAL fetched crest full-bleed onto a 96×96 key
(the exact way `render/canvas.ts`'s `drawCroppedImage` draws it) and
scanning upward from the bottom row for the first pixel that differs from
the plain background by more than a small tolerance:

| Logo | Clean margin at the bottom |
| --- | --- |
| Jaguars (`jax.png`) | 15 px |
| Gators (`57.png`, NCAA) | 20 px |

15-20 px is too thin, and inconsistent between the two crests, to trust for
a legible record line drawn directly over the raw image — and `render/
canvas.ts`'s `drawCroppedImage` always draws to the FULL 96×96 destination
regardless of any source crop, so there is no renderer-level way to shrink
the image into part of the key (this task owns neither `render/canvas.ts`
nor `render/specs.ts`, so that could not be changed). `FootballSource`
instead composites the raw logo onto an offscreen canvas once, off the
render path: the crest is scaled to fit the top `LOGO_ART_FRACTION` (0.64)
of the frame, and the remaining bottom band is filled with the exact key
background colour (`theme.bg`), more than double the tighter of the two
measured margins. The result is re-encoded to PNG and re-decoded as a real
`Image` (`@napi-rs/canvas`'s `createCanvas`/`toBuffer`/`loadImage` round
trip, confirmed working locally) so `KeySpec.image` still holds an ordinary
decoded image — `FootballPage` then draws the record as a normal text line
at a fixed `lineY` inside that reserved band.

---

## Ambient effect layer (task 42)

Measured on this Mac on 2026-08-18, with `@napi-rs/canvas` 0.1.100.

### Canvas-to-canvas compositing

A canvas composites onto another canvas through `ctx.drawImage(canvas, 0, 0)`.
This is a surface blit, not an image decode, so it does not violate the
"nothing decodes an image on the render path" invariant.

| Property | Measurement |
| --- | --- |
| Blend is exact | `rgba(90,150,255,1)` at `globalAlpha` 0.28 over `rgb(18,28,44)` gives exactly `(38,62,103)` |
| `clearRect` fully resets a reused canvas | Yes, alpha included — so ONE module-level scratch canvas is safe |
| The cap holds against a hostile layer | A layer filled solid white at alpha 1 still composited to `(84,91,103)` |
| Determinism | Two identical renders are byte-identical |
| Cost | 0.37 ms per 8-key frame, against a 100 ms tick budget |

The cap therefore does not depend on each variant behaving. `FX_MAX_ALPHA` is
applied once, at the composite, so exceeding it is impossible by construction.

### Which variants are FATAL on a non-finite number

Measured by deleting the `out.fx` block from `sanitizeKeySpec` and running each
variant through an isolated child process:

| Variant | Result unguarded |
| --- | --- |
| `snow`, `cloud` | **exit 134, SIGABRT** — a Rust panic inside `ctx.arc` |
| `wind` | exit 1, an ordinary catchable JS throw |
| `rain`, `storm`, `fog`, `sun` | exit 0, survived |

`snow` and `cloud` pass a non-finite CENTRE to `ctx.arc`, which is the fatal
case. `sun` passes only a non-finite radius and was measured to survive it.
This is why only those two are tested in a child process — testing a fatal case
in-process kills the whole vitest worker instead of failing one test.

### The strike period must not alias with the render tick

Measured on 2026-08-18, on a simulated real forecast week (seven tiles, all
thunderstorms and rain — the actual August weather that exposed this).

The first version used a flat 4300 ms strike period with a 90 ms lit window. The
weather page renders every 100 ms, and **4300 ms is exactly 43 ticks**, so each
tile sampled one single phase value forever. A tile therefore either always
caught its flash or never did:

| Tile seed | Frames lit, of 860 | Strikes caught, of 20 |
| --- | --- | --- |
| 0, 1, 2, 3, 6 | 40 | 20 |
| 5 | 20 | 20 |
| **4** | **0** | **0** |

Seed 4 never lit once, permanently, by construction. After widening the window
to 240 ms and moving the period off a tick multiple, every seed catches 20/20.

Two properties fix it, and they are independent:

- **The lit window must exceed one tick.** A 240 ms window always contains at
  least two points of a 100 ms grid, whatever the phase. This alone defeats the
  aliasing — verified by restoring the flat 4300 ms period, which did NOT
  reintroduce the bug.
- **The period must not be a whole number of ticks.** Defence in depth, so
  narrowing the window later cannot bring the bug back. Asserted separately,
  because the sampling test cannot see it.

### What a lightning flash must NOT be

The first version filled the whole key with white at full strength. Composited
at the cap, that produced a flat, evenly lit key — which reads as the tile being
greyed out, and **collides with the page's own staleness signal**, where a
washed-out key means the data is old.

A bolt has to be bright and LOCAL. And it cannot be made brighter than the cap,
so the contrast has to come from inside the layer: the rain streaks recede while
the bolt is lit, exactly as real lightning outshines the rain in front of it. At
the first attempt the bolt was 3 px of white at the same alpha as the storm
streaks, and it read as one more streak.

### Storm rain against plain rain, and light rain against heavy

Both differences were invisible on the real deck, and both needed more than the
obvious knob:

- Storm rain differed from plain rain only by 5 px of extra slant. Only the
  background tint and the emoji really told them apart. Storm now runs faster,
  50 percent longer, 11 px of slant, and in cyan rather than blue.
- Intensity drove only the drop COUNT. Across a real week that meant 10 streaks
  against 15 — measured ink coverage ratio **2.09**, which nobody can see at a
  glance. Length and opacity now scale with intensity too: ratio **3.30**.

That 2.09 measurement also exposed a test that could not fail. A threshold of
1.8 on that ratio passed with the scaling removed, because the drop count alone
already cleared it. The threshold is now 2.7, between the two measured values.

### Text pixels on a weather day tile

Two measurements that each corrected a wrong assumption in a test:

- Selecting text pixels by proximity to `theme.text` finds only **57** on a real
  day tile, because the tile colours its temperature line by heat and its rain
  line by chance. Only the label is `theme.text`. The same selection on a key
  with no `lineColors` finds 204 — which is why the first version of that proof
  looked adequate and was not.
- Demanding byte-exact equality of content pixels across two effect clocks fails
  on **13 to 55** pixels per condition. An anti-aliased glyph edge blends with
  whatever sits underneath it by design. The worst real channel shift is **26**
  of 255, on the snow tile, and the smallest opaque-content set is 537 pixels,
  on the sunny tile.

### The `🌫` emoji is itself a pale block

Apple's fog emoji renders as a hazy grey square that fills most of the emoji
band. On a contact sheet this looks exactly like an effect layer that has piled
up in the middle of the key, and it was misdiagnosed as one. Rendering the emoji
and the layer separately is what settled it. The block predates the effect
layer entirely.

---

## The strip ticker tape (task 43)

Measured on 2026-08-18.

- The eight `SYMBOL price ▲change%` segments plus separators measure **1448 px**
  at 13 px Menlo. A character count had suggested about 1130 — reason from the
  measurement, never the estimate.
- At 32 px per second that loop took **45 seconds** to pass, so waiting for one
  particular ticker meant most of a minute. 60 px per second gives about 24
  seconds, at 2.4 px per frame on a 40 ms tick. The strip's measured 1218
  writes per second makes 25 frames per second free.
- `measureText` returns FRACTIONAL pixel widths, so no integer offset ever lands
  on the tape's loop boundary. A test that scanned integer offsets for a
  byte-identical frame found none and wrongly reported a broken wrap. Use
  `tapeLoopWidthPx` — the exact fractional width — to assert the wrap.
- A `NaN` offset reaching `fillText`'s x coordinate draws **nothing** and throws
  nothing. So a strip renders full-size and blank, and a test asserting only
  "a buffer came back" cannot detect a missing sanitizer. Assert that a hostile
  offset degrades to the offset-0 frame instead.

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
