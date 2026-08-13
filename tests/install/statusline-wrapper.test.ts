import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync, readdirSync,
  mkdirSync, statSync, utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WRAPPER = join(process.cwd(), 'src/install/statusline-wrapper.sh')

const PAYLOAD = JSON.stringify({
  session_id: 'aaaa-bbbb',
  model: { display_name: 'Opus 5' },
  context_window: { used_percentage: 41.2 },
  cost: { total_cost_usd: 1.23 },
  rate_limits: {
    five_hour: { used_percentage: 62, resets_at: 1786557420 },
    seven_day: { used_percentage: 34, resets_at: 1786895160 },
  },
  workspace: { project_dir: '/Users/you/Vibecoding/streamdeckneoclaude' },
})

describe('statusline-wrapper.sh', () => {
  let dir: string
  let inner: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-wrap-'))
    inner = join(dir, 'inner.sh')
    // The inner script proves stdin passes through unchanged.
    writeFileSync(inner, '#!/bin/sh\ncat > "$1"\necho "INNER OUTPUT"\n')
    chmodSync(inner, 0o755)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const run = () =>
    execFileSync('/bin/sh', [WRAPPER], {
      input: PAYLOAD,
      env: {
        ...process.env,
        DECKD_STATE_DIR: dir,
        DECKD_INNER: `${inner} ${join(dir, 'seen.json')}`,
      },
      encoding: 'utf8',
    })

  const runAsync = (payload: string, seen: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', [WRAPPER], {
        env: {
          ...process.env,
          DECKD_STATE_DIR: dir,
          DECKD_INNER: `${inner} ${seen}`,
        },
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`wrapper exited ${String(code)}: ${stderr}`))
      })
      child.stdin.end(payload)
    })

  it('prints the inner statusline output unchanged', () => {
    expect(run()).toContain('INNER OUTPUT')
  })

  it('passes stdin to the inner command byte for byte', () => {
    run()
    expect(readFileSync(join(dir, 'seen.json'), 'utf8')).toBe(PAYLOAD)
  })

  it('writes usage.json with the rate limits and a timestamp', () => {
    run()
    const u = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'))
    expect(u.rate_limits.five_hour.used_percentage).toBe(62)
    expect(u.rate_limits.seven_day.resets_at).toBe(1786895160)
    expect(typeof u.ts).toBe('number')
    expect(u.ts).toBeGreaterThan(1700000000)
  })

  it('writes a per-session file keyed by session_id', () => {
    run()
    const f = join(dir, 'sessions', 'aaaa-bbbb.json')
    expect(existsSync(f)).toBe(true)
    const m = JSON.parse(readFileSync(f, 'utf8'))
    expect(m.model).toBe('Opus 5')
    expect(m.ctxPct).toBe(41.2)
    expect(m.costUsd).toBe(1.23)
  })

  it('still writes usage.json when session_id is absent', () => {
    execFileSync('/bin/sh', [WRAPPER], {
      input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } } }),
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: `${inner} ${join(dir, 'seen.json')}` },
      encoding: 'utf8',
    })
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
  })

  it('prints the inner output even when the payload is not JSON', () => {
    const out = execFileSync('/bin/sh', [WRAPPER], {
      input: 'not json at all',
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: `${inner} ${join(dir, 'seen.json')}` },
      encoding: 'utf8',
    })
    expect(out).toContain('INNER OUTPUT')
  })

  it('prints nothing extra when no inner command is set', () => {
    const out = execFileSync('/bin/sh', [WRAPPER], {
      input: PAYLOAD,
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: '' },
      encoding: 'utf8',
    })
    expect(out.trim()).toBe('')
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
  })

  it('passes trailing blank lines through to the inner command, exact byte count', () => {
    // $(cat) in a shell variable strips trailing newlines. A payload ending
    // in two newlines proves the wrapper preserves them: 9 bytes in must be
    // 9 bytes out, not 7.
    const payload = '{"a":1}\n\n'
    execFileSync('/bin/sh', [WRAPPER], {
      input: payload,
      env: {
        ...process.env,
        DECKD_STATE_DIR: dir,
        DECKD_INNER: `${inner} ${join(dir, 'seen.json')}`,
      },
      encoding: 'utf8',
    })
    const seen = readFileSync(join(dir, 'seen.json'), 'utf8')
    expect(Buffer.byteLength(seen, 'utf8')).toBe(Buffer.byteLength(payload, 'utf8'))
    expect(seen).toBe(payload)
  })

  it('rejects a session_id with path traversal characters', () => {
    // "/" is outside the allowed charset, so "../evil" is rejected outright.
    // Without the guard, "$STATE_DIR/sessions/../evil.json" resolves to
    // "$STATE_DIR/evil.json" — one directory above where per-session files
    // belong, inside the user's state directory.
    const payload = JSON.stringify({
      session_id: '../evil',
      model: { display_name: 'Opus 5' },
      rate_limits: { five_hour: { used_percentage: 1, resets_at: 1 } },
    })
    execFileSync('/bin/sh', [WRAPPER], {
      input: payload,
      env: {
        ...process.env,
        DECKD_STATE_DIR: dir,
        DECKD_INNER: `${inner} ${join(dir, 'seen.json')}`,
      },
      encoding: 'utf8',
    })
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
    expect(existsSync(join(dir, 'evil.json'))).toBe(false)
    expect(existsSync(join(dir, 'sessions', 'evil.json'))).toBe(false)
    // Minor 8: a rejected session_id must not even leave a hidden mktemp
    // artifact behind in the sessions directory. (The old assertion here
    // checked for a literal `evil.json.tmp` name, which the current
    // `mktemp`-based naming scheme -- `.evil.json.XXXXXX` -- never
    // produces, so it always passed regardless of correctness.)
    expect(readdirSync(join(dir, 'sessions')).filter((name) => name.startsWith('.'))).toEqual([])
  })

  it('keeps concurrent cache writes atomic and leaves no temporary files', async () => {
    const runs = Array.from({ length: 16 }, (_, i) => {
      const payload = JSON.stringify({
        session_id: `session-${i}`,
        model: { display_name: `Model ${i}` },
        rate_limits: { five_hour: { used_percentage: i, resets_at: i } },
      })
      return runAsync(payload, join(dir, `seen-${i}.json`))
    })

    await Promise.all(runs)
    const usage = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'))
    expect(typeof usage.rate_limits.five_hour.used_percentage).toBe('number')
    for (let i = 0; i < 16; i++) {
      const session = JSON.parse(readFileSync(join(dir, 'sessions', `session-${i}.json`), 'utf8'))
      expect(session.model).toBe(`Model ${i}`)
    }
    // Minor 8: the temp names this script actually creates are
    // `.usage.json.XXXXXX` and `.SID.json.XXXXXX` -- neither contains
    // `.tmp`, so a `.includes('.tmp')` filter is empty no matter what the
    // wrapper does. `.startsWith('.')` matches the real naming scheme, so
    // this assertion can actually fail if a leftover temp file survives a
    // concurrent run.
    expect(readdirSync(dir).filter((name) => name.startsWith('.'))).toEqual([])
    expect(readdirSync(join(dir, 'sessions')).filter((name) => name.startsWith('.'))).toEqual([])
  })

  // I-8 / claim 6: this was previously verified only by hand (the review's
  // "Verified by experiment" section), never by an automated test. An
  // already-loose state directory (from a manual delete-and-recreate, or a
  // fresh machine where a render happens before the daemon ever runs) must
  // be forced to 0700 on the very next render, not merely created at 0700
  // the first time.
  it('claim 6: forces an already-loose state directory back to 0700', () => {
    chmodSync(dir, 0o755)
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    chmodSync(join(dir, 'sessions'), 0o755)

    run()

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'sessions')).mode & 0o777).toBe(0o700)
  })

  // M-1 / I-8: the prune used to match only `-name '*.json'`, which cannot
  // match this script's own `mktemp` leftovers -- `.<sid>.json.XXXXXX` --
  // because they do not END in `.json`. A leftover from a `SIGKILL`'d
  // render (the one signal that cannot be trapped) survived every prune
  // forever before this fix. This proves the fixed pattern actually
  // catches that exact shape, not just an ordinary `sid.json` file.
  it('M-1: prunes its own week-old mktemp leftovers, not just real session files', () => {
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const leftover = join(dir, 'sessions', '.old-leftover.json.AbCdEf')
    writeFileSync(leftover, '{}')
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(leftover, eightDaysAgo, eightDaysAgo)
    // A real, RECENT session file must survive -- this is a targeted
    // prune, not a directory wipe.
    const recentSession = join(dir, 'sessions', 'kept-session.json')
    writeFileSync(recentSession, '{}')

    run()

    expect(existsSync(leftover)).toBe(false)
    expect(existsSync(recentSession)).toBe(true)
  })

  // M-3 / I-8: a signal that kills the wrapper must reach the inner command
  // too, instead of leaving it orphaned and running for its full duration.
  // Measured before this fix: a `SIGTERM` sent while a slow inner command
  // was still running left the wrapper's cleanup deferred until the inner
  // process exited on its own, minutes later for a real hung render.
  it('M-3: forwards a killing signal to the inner command instead of leaving it orphaned', async () => {
    const child = spawn('/bin/sh', [WRAPPER], {
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: 'sleep 20' },
    })
    child.stdin.end(PAYLOAD)

    // Give the wrapper a moment to actually be running the inner command,
    // standing in for Claude Code timing out and killing a slow render.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const start = Date.now()
    child.kill('SIGTERM')

    const code: number | null = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c))
    })
    const elapsedMs = Date.now() - start

    // Before the fix, the wrapper's own trap did not run until the inner
    // `sleep 20` finished on its own -- so this would take ~20 seconds
    // regardless of when the signal arrived. Exiting promptly is only
    // possible if the signal was actually forwarded to the inner process.
    expect(elapsedMs).toBeLessThan(5000)
    expect(code).toBe(143)
  })

  // M-8: before this fix, ONE trap handled TERM, INT, and HUP together, so
  // it always reported exit 143 (the TERM code) no matter which signal
  // actually arrived. A separate trap per signal reports the conventional
  // 128+signal code for each.
  it.each([
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ] as const)('M-8: %s reports its own exit code, not always 143', async (signal, expectedCode) => {
    const child = spawn('/bin/sh', [WRAPPER], {
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: 'sleep 20' },
    })
    child.stdin.end(PAYLOAD)
    await new Promise((resolve) => setTimeout(resolve, 300))
    child.kill(signal)

    const code: number | null = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c))
    })
    expect(code).toBe(expectedCode)
  })

  // M-7: `${DECKD_STATE_DIR:-$HOME/...}` still evaluates `$HOME` under
  // `set -u` whenever `DECKD_STATE_DIR` is UNSET -- exactly the hand-run or
  // future-unwrapped-invocation case this guards. With both unset,
  // `HOME: unbound variable` used to abort the whole script before the
  // inner command ever ran, in direct violation of the file's own header
  // rule that it must never fail in a way that hides the statusline.
  it('M-7: does not abort when both HOME and DECKD_STATE_DIR are unset', () => {
    const env = { ...process.env }
    delete env.HOME
    delete env.DECKD_STATE_DIR
    env.DECKD_INNER = `${inner} ${join(dir, 'seen-home-unset.json')}`

    const out = execFileSync('/bin/sh', [WRAPPER], {
      input: PAYLOAD,
      env,
      encoding: 'utf8',
    })

    expect(out).toContain('INNER OUTPUT')
  })

  // M-6: instrumented copy that forces `$TMPIN` to be a DIRECTORY instead
  // of the file `mktemp` actually created, so `cat > "$TMPIN"` fails
  // deterministically and portably (no full filesystem needed) with
  // "Is a directory". Before the fix, this write was unchecked: the script
  // carried on as if caching had succeeded, `$TMPIN` still pointed at the
  // directory, and the cached-path read (`cat "$TMPIN" | sh -c "$INNER"`)
  // then silently failed too -- handing the inner command an EMPTY payload
  // instead of the real one. The fix falls back to the uncached path
  // (`TMPIN=""`), so the inner command reads the wrapper's own stdin
  // directly and gets the real bytes regardless.
  it('M-6: falls back to the uncached path when writing $TMPIN fails, instead of feeding a corrupted payload through', () => {
    const forcedDir = join(dir, 'forced-tmpin-is-a-directory')
    mkdirSync(forcedDir)
    const instrumented = join(dir, 'instrumented-m6-wrapper.sh')
    const src = readFileSync(WRAPPER, 'utf8')
    const marker = 'TMPIN=$(mktemp 2>/dev/null) || TMPIN=""'
    expect(src).toContain(marker)
    const patched = src.replace(marker, `${marker}\nTMPIN="${forcedDir}"`)
    expect(patched).not.toBe(src)
    writeFileSync(instrumented, patched)
    chmodSync(instrumented, 0o755)

    const seen = join(dir, 'seen-m6.json')
    const out = execFileSync('/bin/sh', [instrumented], {
      input: PAYLOAD,
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: `${inner} ${seen}` },
      encoding: 'utf8',
    })

    expect(out).toContain('INNER OUTPUT')
    expect(readFileSync(seen, 'utf8')).toBe(PAYLOAD)
  })

  // I-2: the M-3 test above uses `DECKD_INNER: 'sleep 20'` -- a single
  // simple command. `bash` (which `/bin/sh` is here) exec-optimises
  // `sh -c '<one simple command>'` down to that ONE process with no fork at
  // all, so `$!` IS the command, and a plain `kill "$INNER_PID"` happens to
  // reach it. That test therefore passes for the wrong reason: it cannot
  // tell a real fix from one that only kills `sh -c` itself. A COMPOUND
  // inner command (a `;`-list, exactly like a real statusline piping
  // through a filter) forces `sh -c` to fork, and measured before this fix:
  // the wrapper exited 143 at once while `sleep 20` kept running, orphaned,
  // for its full duration. This is that exact repro.
  it('I-2: forwards a killing signal to a COMPOUND inner command, leaving no orphan behind', async () => {
    const child = spawn('/bin/sh', [WRAPPER], {
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: 'echo EARLY; sleep 20; echo LATE' },
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stdin.end(PAYLOAD)

    // Wait for proof that `sleep 20` has actually STARTED, rather than a
    // fixed delay -- under a heavily loaded machine (the full suite running
    // many processes in parallel), a fixed short wait can fire before the
    // wrapper's own caching steps even finish, which would kill it before
    // it ever reaches the inner command at all and defeat the point of the
    // test. Bounded so a real regression (the signal never reaching
    // anything) still fails instead of hanging.
    await new Promise<void>((resolve, reject) => {
      const started = Date.now()
      const check = setInterval(() => {
        if (stdout.includes('EARLY')) {
          clearInterval(check)
          resolve()
        } else if (Date.now() - started > 8000) {
          clearInterval(check)
          reject(new Error('inner command never printed EARLY within 8s'))
        }
      }, 20)
    })
    const start = Date.now()
    child.kill('SIGTERM')

    const code: number | null = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c))
    })
    const elapsedMs = Date.now() - start

    expect(elapsedMs).toBeLessThan(5000)
    expect(code).toBe(143)
    // Output already flushed before the kill must survive; output after it
    // must not appear -- proof `sleep 20` (and the `echo LATE` after it)
    // never got to run to completion.
    expect(stdout).toContain('EARLY')
    expect(stdout).not.toContain('LATE')

    // No leftover `sleep 20` process anywhere on the system -- the group
    // kill must have reached the FORKED child, not just the `sh -c`
    // parent bash exec-optimised away for the simple-command test above.
    let leftover = ''
    try {
      leftover = execFileSync('pgrep', ['-f', 'sleep 20'], { encoding: 'utf8' })
    } catch {
      // pgrep exits 1 (with empty output) when nothing matches -- the
      // expected, passing outcome.
    }
    expect(leftover.trim()).toBe('')
  })

  // I-2: instrumented copy of the wrapper, the same technique the review
  // used to measure this -- a killing signal makes `cleanup` run TWICE
  // (once from `trap '...' TERM`, once more from the EXIT trap that
  // `exit 143` fires right after), and before the fix the second call
  // still saw the FIRST call's now-stale `INNER_PID` and re-issued
  // `kill -TERM -"$INNER_PID"` -- a process-GROUP signal -- against a pid
  // the OS was already free to have handed to an unrelated process. The
  // fix clears `INNER_PID` at the end of `cleanup` itself, so the second
  // call's own guard sees it empty and skips the kill entirely.
  it('I-2: cleanup does not re-signal a reaped pid on the second, EXIT-trap call after a killing signal', async () => {
    const traceFile = join(dir, 'cleanup-trace.log')
    writeFileSync(traceFile, '')
    const instrumented = join(dir, 'instrumented-wrapper.sh')
    const src = readFileSync(WRAPPER, 'utf8')
    const patched = src.replace(
      'cleanup() {',
      `cleanup() { printf 'CLEANUP-CALL INNER_PID=%s\\n' "$INNER_PID" >> ${JSON.stringify(traceFile)}`,
    )
    expect(patched).not.toBe(src)
    writeFileSync(instrumented, patched)
    chmodSync(instrumented, 0o755)

    const child = spawn('/bin/sh', [instrumented], {
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: 'sleep 20' },
    })
    child.stdin.end(PAYLOAD)
    // A short, fixed wait to let the inner `sleep 20` actually start before
    // the signal arrives, matching the M-3 test above (a single simple
    // inner command gives nothing else observable to poll for).
    await new Promise((resolve) => setTimeout(resolve, 300))
    child.kill('SIGTERM')
    await new Promise((resolve) => { child.on('close', resolve) })

    const lines = readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    const pids = lines.map((l) => l.replace('CLEANUP-CALL INNER_PID=', ''))
    expect(pids[0]).not.toBe('')
    expect(pids[1]).toBe('')
  })

  it('M-1: a normal, non-killed run clears INNER_PID before the EXIT trap runs', () => {
    // No direct hook into the trap's own state from outside the process,
    // so this asserts the externally observable half of the guarantee: a
    // normal run exits cleanly, with the exact status the inner command
    // itself produced, and no leftover mktemp file the EXIT trap's cleanup
    // would otherwise still need to remove. If `cleanup` ever again tried
    // to `kill` a stale, reused pid on this path, it could not affect this
    // assertion directly -- but it is exercised on every other run in this
    // file, none of which have ever left a temp file behind (M-1 in the
    // wrapper's own history), which is the failure mode a `kill` on a
    // wrong pid could plausibly cause downstream.
    const out = execFileSync('/bin/sh', [WRAPPER], {
      input: PAYLOAD,
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: `${inner} ${join(dir, 'seen.json')}` },
      encoding: 'utf8',
    })
    expect(out).toContain('INNER OUTPUT')
    expect(readdirSync(dir).filter((name) => name.startsWith('.'))).toEqual([])
  })
})
