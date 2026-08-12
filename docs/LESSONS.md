# Lessons — recurring bug classes in this project

Every entry below was a **real defect found by review** here, most of them in the plan
rather than in an implementer's work. They repeat. Check for them before writing code, and
check for them when reviewing.

---

## 1. `mode` on `mkdirSync` / `writeFileSync` applies only at CREATION

An existing file or directory keeps its old permissions and **no error reports it**. So any
place needing an exact mode must also `chmodSync` unconditionally.

Bit us three times: `ensureStateDir` (0700), `TokenStore.save` (0600 on the file holding a
refresh token), and the art directory. A test that writes into a fresh temp directory
**cannot catch this** — test the already-exists-too-open case explicitly.

## 2. Fixed-depth relative paths break between `src/` and `dist/`

`join(import.meta.dirname, '..', '..')` resolves differently under `tsx` (`src/x/`) than
after a build (`dist/src/x/`). **Three separate occurrences**, and every one failed
SILENTLY — the sprite loader found nothing, the frame extractor wrote zero files.

Always walk UP looking for a landmark (`package.json`, or an `assets` directory), bounded
by a hop limit.

## 3. `process.cwd()` is wrong under launchd

The daemon's working directory is not the project. Anything resolving assets or scripts
from `cwd` silently finds nothing in production while working perfectly in development.

## 4. `tsc` compiles TypeScript and does NOT copy other files

`statusline-wrapper.sh` never appears beside the compiled `install.js`. Verified:
`dist/src/install/` did not exist at all. Read non-TS files from the source tree.

## 5. `log.warn` on a repeating path is a defect

The render loop runs at 1 Hz (soon faster), device retry every 2 s, sources poll on timers.
An unguarded log fills the disk. Use `log.once(key, msg)` with a **distinct key**, and
`log.clearOnce(key)` on recovery so a later failure logs again.

## 6. A log call must never throw

Callers log from inside their own `catch` blocks, and several promise never to throw
(`focusWindow`, the render loop). So the sink swallows its own write errors — a lost log
line costs less than a crashed key press.

## 7. Partial change-detection keys leave stale data on the glass

`ClaudeSource` keyed on `sessionId:state:ts:tool` and missed `label` changes inside the same
second, leaving stale text. `UsageSource` omitted the per-session metadata entirely.

**Hash the whole snapshot.** `JSON.stringify(next)` is fine and cheap at these sizes.

## 8. `stop()` needs an explicit `stopped` flag — clearing the timer is not enough

An in-flight `poll().then(() => this.schedule())` runs AFTER `stop()` returns and arms a
brand-new timer. Check the flag at the top of the scheduler.

The test must **hold the fetch unresolved**, call `stop()` mid-flight, then resolve — with
fake timers the promise settles first and the race window never opens, so the naive test
passes against broken code.

## 9. "The timer is cleared" is NOT "the process can exit"

`runAuthFlow` still hung after the timeout fix. `lsof` on the live process showed why:

```
TCP localhost:8888->localhost:62901 (ESTABLISHED)
```

The **browser's keep-alive socket**. `server.close()` stops accepting new connections but
does not destroy existing ones. Two things held the event loop; the first fix removed one.

**Check open handles, not just timers.** Send `Connection: close` and call
`server.closeAllConnections()`.

## 10. A guard that clears on failure is not a guard — it is a request storm

The album-art `pending` set was deleted in a `finally`, including on failure and on the
no-URL path. A render happens every second, so a failing art URL started a new request
every second against a rate-limited API using the user's credential.

Use a **cooldown** (`artRetryAt`), not a permanent denial, so a transient failure does not
deny forever. And **never retry a 403** — it cannot succeed until the user re-authorizes.

## 11. A new `KeySpec` field must affect `keyHash`

The daemon writes a key only when its hash changes. A field outside the hash leaves stale
pixels. `keyHash` spreads everything except `image`, so plain fields are covered — but
prove it with a test.

This matters most where keys share an `imageKey`: the Spotify 2×2 art gives all four keys
the same track id, so without `imageCrop` in the hash three quadrants would never update.

## 12. Two agents, one git index

`git add <explicit paths>` is **not** sufficient. If another agent has already staged its
own files, `git commit` takes the whole index regardless of what you just added. This
swallowed an implementer's source changes into a `docs:` commit **twice**.

Use the pathspec form: `git commit -m "..." -- <paths>`. Check
`git diff --cached --name-only` before committing.

## 13. Tests must never touch anything under `~`

A rotation test targeted the real log path and `rmSync`'d it in both `beforeEach` and
`afterEach` — so `npm test` **deleted the user's log and its only backup**. Harmless then,
destructive once the daemon writes real diagnostics.

Take the path as a parameter. Two seams enforce this now: `setDefaultSink` routed to a
no-op via `tests/setup.ts`, and `createFileSink(file)`.

## 14. Overlapping text is not a tradeoff

A brief instructed drawing an emoji "before the text lines, so a number that overlaps it
stays on top and legible." On a 96 px key that is just crowding, and the user spotted it
immediately on real hardware. Reserve non-overlapping bands and **assert the gaps are
background** in a test.

## 15. Colour emoji ignore `fillStyle`

They are bitmap glyphs, so a dimmed key dims its text and border while the emoji stays at
full brightness — undercutting the staleness signal. Use `globalAlpha`.

## 16. Escalate contradictions, do not pick one

A reviewer found the task brief and the review checklist disagreed about whether the stock
sparkline should carry the trend colour. It stopped and asked rather than guessing. That was
right: an agent silently choosing between two authorities produces work nobody can trust.

## 17. Measure, do not reason, about text and pixels

Every layout number in this project is measured with canvas. `95°/77°` fits at 16 px and
does not at 17 px; `2h11m` fits at 24 px and does not at 28 px. Guessing produced clipped
text twice before the habit stuck.
