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

## 18. A missing platform signal is UNKNOWN, not a measured state

The first lock detector queried `CGSSessionScreenIsLocked`. That property was absent on the
target Mac, and the parser treated absence as unlocked. Automated tests passed while the real
deck stayed active behind the lock screen.

Measure the property on the target system. Here it is `IOConsoleLocked`. Keep compatibility
fallbacks, but make absence explicit and logged. Fail open when permanent blanking would make
the product unusable, then require a real hardware check for the privacy behavior.

## 19. Persist stable identity, not collection position

The UI originally saved only a numeric page index. Inserting the Codex page after Claude
would have changed a saved Spotify index into Codex after restart.

Persist the page name as the stable identity. Keep a narrow legacy-index migration for old
state. This applies to pages, configured lists, and any user-visible collection whose order
can change in a later release.

## 20. Private schemas need one fail-safe boundary

The Codex page reads a private local SQLite schema and rollout JSONL events. Those formats can
change without notice. If their details leak through the application, one upstream change can
break the daemon.

Keep the schema inside one source. Read it without mutation, retain no prompt bodies, filter
internal tasks, bound or incrementally scan large files, and preserve the last safe product
state when reading fails. A private-schema failure may degrade its page; it must not stop the
device, navigation, or unrelated sources.

## 21. A fix aimed at the repro leaves the harm reachable by another route

The dominant defect class of 2026-08-13. **Four Criticals in one day were second or third
occurrences of a harm whose earlier fix had already "landed".**

| Harm | Round 1 trigger | Later trigger |
| --- | --- | --- |
| Blank statusline, original unrecoverable | a lenient parse skipped the unwrap but deleted the wrapper | wrapping detected from a user-editable comment; then `uninstall` not using the ambiguity check `install` already used |
| A ring drawn on a page it was not pressed on | flashes keyed by index, not page | page identity read **after** awaiting an async press handler |
| The weather detail view opens the wrong day | selection keyed on array position | selection keyed on a calendar date that is **not unique** overnight |

Every one of those fixes was implemented correctly. The briefs were wrong: they described the
**trigger** a reviewer happened to find, so the implementer closed that route and no other.

**A reviewer reports a repro. A repro is evidence of a broken invariant; it is not the bug.**

Write the invariant instead. Not "detect the wrap by path rather than by comment", but "it must
be impossible to delete the wrapper while the settings still reference it — here is one known
route". Then:

- **Enumerate before implementing.** List at least three other ways to reach the same harm.
  Fix the class, or state why it is bounded. On this project the second route has existed every
  single time.
- **Prefer impossible to unreachable.** `uninstall` never deleting a backup ends that class
  whatever the detection does. Capturing the page identity *before* the await removes the
  window instead of narrowing it. Ask first whether the bad outcome can be made unreachable by
  construction.
- **One decision, one function.** Round 3's Critical existed because `install` and `uninstall`
  answered "is this wrapped?" separately. Callers that reason independently about the same
  question will diverge again.
- **Do not prescribe an implementation you have not verified.** Every controller-authored defect
  this day came from specifying *how*: an `immutable=1` fallback that could not be bounded, a
  flat 24-hour staleness backstop, a null-safe ordering key implemented backwards, a
  non-unique date identity. Label a prescription as a hypothesis and invite the implementer to
  refute it — one did, correctly.

The same disease appears one layer down, in tests. See lesson 22.

## 22. A test written for the repro is a test that cannot fail

Four review rounds found this shape in **six** files, and it survived being fixed twice:

- geometry proofs probing a **single column** that is background for any overflow — measured, an
  overloaded strip painted no further right than column 241 while the test probed 247
- a caption probe that only trips at 14 characters, against a caption that is 4
- a centring proof comparing four emoji whose ink boxes are **byte-identical**, so it compares
  equal numbers and would pass with the wrong glyph entirely
- a signal-forwarding test using the one command shape `bash` exec-optimises, so it passed
  without the feature working
- a backup-mode test that passed unfixed, because `copyFileSync` already copies the source mode
- fixtures encoding behaviour the real tool does not have: `sqlite3 -json` prints **nothing**
  for zero rows, never `[]`, and a weather fixture parsed to 7 days with 1 distinct date, hiding
  a Critical

These are worse than no test. They report safety that does not exist, and they are why three of
the defects above reached hardware behind a green suite.

**Assert the property, not the instance.** Probe the region rather than one column. Use the
widest realistic content, not the example. Build fixtures from **real** captured output. And for
any test claiming to prove a fix: break the fix and watch it fail. If it still passes, the test
is decoration.

## 23. Half a transport has half a failure detector

Measured live on 2026-08-23. After an afternoon of USB drops (76 reconnects, against about
one a day all week), `openStreamDeck` returned a handle whose **every write** rejected with
`(0xE00002C2) invalid argument`, while the library's `'error'` event — raised by the READ
loop — never fired again.

`handleLoss` was wired only to that read-side event. Every write path simply rejected to its
caller. So `isConnected()` stayed `true`, no retry was ever scheduled, and the dead handle
delivered no `down` events either. The deck had **neither input nor output for three hours**
and no path back: only `launchctl kickstart` cleared it. The privacy blank at 23:12:42 failed
on that handle — pixel write and brightness backstop both — and left a locked Mac's last
frame lit.

Two things made it invisible. `log.once('render', …)` had already fired, so every later
failure was suppressed and the log looked healthy. And `writeFrame` skips unchanged keys, so
"no write has failed recently" means nothing at all while a static page is showing.

**A transport has two directions, and a failure detector wired to one of them detects half
the failures.** Worse, the half it misses is the half that has no timeout of its own — a read
loop notices silence, a write path only notices when something asks it to write.

The fix deliberately does **not** classify IOKit error codes. A taxonomy only ever covers the
failures already seen, and the next unknown code wedges you again the same way (lesson 21).
State the invariant instead:

> **Connected means the handle accepted a write recently.**

Which needs three things, because each one alone has a hole:

1. any failed write recycles the handle — a needless reconnect costs two seconds
2. a heartbeat re-sends the brightness already on the device when nothing else has written
   for a while, because skipped frames mean silence is not evidence
3. repeated sessions that open but never accept a byte exit the process, so launchd's
   `KeepAlive` does what the human had to do by hand

The heartbeat probes with the value already on the glass. Probing with any other would light
a locked, blanked deck — a privacy failure caused by the health check itself.
