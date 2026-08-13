import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, rmSync,
  existsSync, unlinkSync, mkdirSync, renameSync,
} from 'node:fs'
import * as fsModule from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `writeAtomic`'s B4/M5 regression tests below need to observe the ORDER
// and ARGUMENTS of the raw `writeFileSync`/`chmodSync`/`renameSync` calls it
// makes, not just the file's mode once the call has already returned --
// `vi.spyOn` cannot redefine a built-in module's own exports in this
// runtime, so `vi.mock` intercepts the module instead. Everything except
// the three wrapped functions passes straight through to the real
// implementation, so every OTHER test in this file (which uses
// `mkdtempSync`, `readFileSync`, `statSync`, `rmSync` directly) is
// unaffected. `actualRef` gives the wrapped tests a handle on the real
// implementations to call through to.
const actualRef = vi.hoisted(() => ({ current: null as null | typeof import('node:fs') }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  actualRef.current = actual
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    chmodSync: vi.fn(actual.chmodSync),
    renameSync: vi.fn(actual.renameSync),
    copyFileSync: vi.fn(actual.copyFileSync),
  }
})
import {
  buildPlist, wrapStatusLine, unwrapStatusLine, recoverStatusLine, isInstalled, verifyWrap,
  writeAtomic, describeStatusLineOutcome,
  snapshotFile, restoreFile,
  parseSettingsObject,
  preflightBuild, install, uninstall, refreshWrapper,
  type LaunchAgentController,
  WRAPPER_MARKER,
} from '../../src/install/install.js'
import { buildPaths } from '../../src/paths.js'

const WRAPPER = '/Users/w/.local/state/deckd/statusline-wrapper.sh'
const STATE_DIR = '/Users/w/.local/state/deckd'
// A short timeout, so the hang tests below stay fast instead of waiting out
// a real multi-second timeout.
const SHORT_TIMEOUT_MS = 200

describe('buildPlist', () => {
  it('names the label', () => {
    expect(buildPlist('com.wbard.deckd', '/usr/bin/node', '/x/deckd.js', '/x/out.log'))
      .toContain('<string>com.wbard.deckd</string>')
  })

  it('runs at load and stays alive', () => {
    const p = buildPlist('com.wbard.deckd', '/usr/bin/node', '/x/deckd.js', '/x/out.log')
    expect(p).toContain('RunAtLoad')
    expect(p).toContain('KeepAlive')
  })

  it('passes the start argument', () => {
    const p = buildPlist('com.wbard.deckd', '/usr/bin/node', '/x/deckd.js', '/x/out.log')
    expect(p).toContain('<string>/usr/bin/node</string>')
    expect(p).toContain('<string>/x/deckd.js</string>')
    expect(p).toContain('<string>start</string>')
  })

  it('is a valid plist document', () => {
    const p = buildPlist('com.wbard.deckd', '/usr/bin/node', '/x/deckd.js', '/x/out.log')
    expect(p.startsWith('<?xml')).toBe(true)
    expect(p).toContain('</plist>')
  })

  it('XML-escapes an interpolated path containing an ampersand', () => {
    // A path with `&`, `<`, or `>` is not exotic -- a username or a
    // directory someone named years ago can contain one -- and an
    // unescaped one breaks the plist's own XML syntax, which launchd may
    // then refuse to load.
    const p = buildPlist(
      'com.wbard.deckd',
      '/usr/bin/node',
      "/Users/a&b/<script>deckd.js",
      '/x/out & log.log',
    )
    expect(p).not.toContain('a&b')
    expect(p).not.toContain('<script>')
    expect(p).toContain('a&amp;b')
    expect(p).toContain('&lt;script&gt;')
    expect(p).toContain('out &amp; log.log')
  })

  it('produces a document an XML parser accepts once escaped', () => {
    const p = buildPlist('com.wbard.deckd', '/usr/bin/node', '/x/a&b.js', '/x/out.log')
    // A cheap well-formedness check: every literal `&` in the output starts
    // a recognised entity. An unescaped ampersand would leave a bare `&`
    // that fails this.
    const bareAmpersand = /&(?!amp;|lt;|gt;|quot;|apos;)/
    expect(bareAmpersand.test(p)).toBe(false)
  })
})

describe('wrapStatusLine', () => {
  it('wraps a string command and keeps it as the inner command', () => {
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER, STATE_DIR)
    expect(r.inner).toBe('~/.claude/statusline.sh')
    expect(JSON.stringify(r.statusLine)).toContain(WRAPPER)
  })

  it('wraps an object command', () => {
    const r = wrapStatusLine({ type: 'command', command: 'foo.sh' }, WRAPPER, STATE_DIR)
    expect(r.inner).toBe('foo.sh')
    expect((r.statusLine as { command: string }).command).toContain(WRAPPER)
  })

  it('preserves other fields on an object command', () => {
    const r = wrapStatusLine({ type: 'command', command: 'foo.sh', padding: 1 }, WRAPPER, STATE_DIR)
    expect((r.statusLine as { padding: number }).padding).toBe(1)
    expect((r.statusLine as { type: string }).type).toBe('command')
  })

  it('handles an absent statusline', () => {
    const r = wrapStatusLine(undefined, WRAPPER, STATE_DIR)
    expect(r.inner).toBe('')
    expect(JSON.stringify(r.statusLine)).toContain(WRAPPER)
  })

  it('embeds the inner command so uninstall can recover it', () => {
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER, STATE_DIR)
    expect(JSON.stringify(r.statusLine)).toContain('~/.claude/statusline.sh')
  })

  it('includes the marker, so isInstalled can find it', () => {
    const r = wrapStatusLine('x.sh', WRAPPER, STATE_DIR)
    expect(JSON.stringify(r.statusLine)).toContain(WRAPPER_MARKER)
  })

  // Finding 11: the render-time wrapper had no way to learn the state
  // directory install actually used, and fell back to $HOME/.local/state/deckd
  // regardless. Embedding the assignment in the command itself means the
  // installed wrapper always caches to the right place, independent of
  // whatever environment launchd happens to give the process.
  it('embeds DECKD_STATE_DIR, so the render-time wrapper caches to the same directory install used', () => {
    const r = wrapStatusLine('x.sh', WRAPPER, '/custom/state/dir')
    expect(JSON.stringify(r.statusLine)).toContain('DECKD_STATE_DIR=')
    expect(JSON.stringify(r.statusLine)).toContain('/custom/state/dir')
  })

  // M-3: `typeof [] === 'object'` is true, so an array statusLine used to
  // take the object-spread branch and come out as `{"0":"a","1":"b",
  // "command":"..."}"} -- a shape Claude Code's settings schema does not
  // recognise as a command object, and an artifact of `typeof`, not a
  // deliberate one. It must be wrapped like every other non-object value
  // instead: the plain command string, with no numeric-key spread.
  it("M-3: wraps an array statusLine as a plain string, not a spread object with numeric keys", () => {
    const r = wrapStatusLine(['a', 'b'], WRAPPER, STATE_DIR)
    // A plain string, not the array-spread artifact `{"0":"a","1":"b",
    // "command":"..."}` -- `typeof [] === 'object'` is true, which is
    // exactly why this needed an explicit `Array.isArray` guard rather
    // than being caught by the ordinary object check.
    expect(typeof r.statusLine).toBe('string')
    expect(Array.isArray(r.statusLine)).toBe(false)
  })
})

describe('isInstalled', () => {
  it('is false for a clean settings file', () => {
    expect(isInstalled({ statusLine: '~/.claude/statusline.sh' }, WRAPPER)).toBe(false)
  })

  it('is false when there is no statusline', () => {
    expect(isInstalled({}, WRAPPER)).toBe(false)
  })

  it('is true after a wrap', () => {
    const r = wrapStatusLine('x.sh', WRAPPER, STATE_DIR)
    expect(isInstalled({ statusLine: r.statusLine }, WRAPPER)).toBe(true)
  })

  // C-1: the decision is keyed on the wrapper PATH, not the `# deckd-wrapped`
  // marker comment. A marker is cosmetic shell-comment text a person can
  // trim with zero effect on behaviour -- the wrapper keeps working -- so it
  // must never be what gates a destructive decision.
  it('is still true after the trailing marker comment is trimmed off', () => {
    const r = wrapStatusLine('x.sh', WRAPPER, STATE_DIR)
    const command = (r.statusLine as string)
    const trimmed = command.slice(0, command.indexOf(WRAPPER_MARKER)).trimEnd()
    expect(trimmed).not.toContain(WRAPPER_MARKER)
    expect(isInstalled({ statusLine: trimmed }, WRAPPER)).toBe(true)
  })

  it('is false for a command that invokes a DIFFERENT path, even one containing the marker', () => {
    const r = wrapStatusLine('x.sh', '/some/other/statusline-wrapper.sh', STATE_DIR)
    expect(isInstalled({ statusLine: r.statusLine }, WRAPPER)).toBe(false)
  })
})

describe('verifyWrap', () => {
  it('accepts a wrapper that reproduces the original output', async () => {
    // A stand-in "original" that echoes a fixed line, and a "wrapped" form that
    // runs the same thing through a transparent shell pipeline.
    const inner = "printf 'STATUS OK\\n'"
    const wrapped = `cat >/dev/null; ${inner}`
    const r = await verifyWrap(wrapped, inner)
    expect(r.ok).toBe(true)
    expect(r.before).toBe(r.after)
  })

  it('rejects a wrapper whose output differs', async () => {
    const r = await verifyWrap("printf 'DIFFERENT\\n'", "printf 'STATUS OK\\n'")
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('differs')
  })

  it('rejects a wrapper that fails to run', async () => {
    const r = await verifyWrap('exit 3', "printf 'STATUS OK\\n'")
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('wrapped command failed')
  })

  it('allows the install when the ORIGINAL command already fails', async () => {
    // Not our problem to fix, and wrapping does not make it worse.
    const r = await verifyWrap("printf 'x\\n'", 'exit 4')
    expect(r.ok).toBe(true)
    expect(r.reason).toContain('original command failed')
  })

  it('treats an empty original as empty output', async () => {
    const r = await verifyWrap('cat >/dev/null', '')
    expect(r.ok).toBe(true)
  })

  it('rejects when the wrapped command never exits', async () => {
    // A short injected timeout keeps this fast. The wrapped side hangs;
    // the original succeeds quickly.
    const r = await verifyWrap('sleep 5', "printf 'STATUS OK\\n'", SHORT_TIMEOUT_MS)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('timed out')
  })

  it('rejects when the original command never exits, even though a fast-failing original is allowed', async () => {
    // This is the deliberate asymmetry: a fast FAILURE on the original is
    // fine to wrap (see above), but a HANG on the original is not, because
    // there is no output to compare against and nothing was verified.
    const r = await verifyWrap("printf 'STATUS OK\\n'", 'sleep 5', SHORT_TIMEOUT_MS)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('did not finish')
  })

  // Finding 3: the old code returned `ok: true` the instant the ORIGINAL
  // command failed, without ever running the WRAPPED command -- so a
  // wrapper that was non-executable, or carried a syntax error, went live
  // completely unverified whenever the user's own statusline happened to
  // exit non-zero. These two tests exercise the fixed behaviour: the
  // wrapped side always runs now, and its outcome is compared against the
  // original's, not just assumed equivalent. (I-7: a third test used to sit
  // here, "still accepts a wrapper that runs to completion despite a
  // failing original" -- it ran `verifyWrap("printf 'ok\n'", 'exit 4')`,
  // which is the identical case the "allows the install when the ORIGINAL
  // command already fails" test above already covers with different
  // literal strings. It passed against the UNFIXED code too, since that
  // code special-cased "original fails, wrapped succeeds" from the start.
  // It was removed rather than kept as a second copy of the same case.)
  it('accepts a wrapper that reproduces the SAME failure as a failing original', async () => {
    // Both "wrapped" and "inner" fail with the identical exit code here --
    // standing in for a wrapper that faithfully re-executes a broken inner
    // command and surfaces its exact exit status.
    const r = await verifyWrap('exit 5', 'exit 5')
    expect(r.ok).toBe(true)
    expect(r.reason).toContain('reproduced the same failure')
  })

  it('rejects a wrapper that fails DIFFERENTLY from a failing original', async () => {
    // The original fails one way; the "wrapper" -- standing in for a
    // non-executable or syntactically broken copy -- fails a different way.
    // The old code never even ran this side when the original failed, so it
    // could not catch this.
    const r = await verifyWrap('exit 9', 'exit 5')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('differently')
  })

  // M-9: the old truncation sliced with `.length` (UTF-16 code units) and
  // labelled the result "bytes" regardless -- wrong for any non-ASCII
  // stderr. "é" is one UTF-16 code unit but two UTF-8 bytes, so 150 of them
  // is 150 JS characters (under the old, wrong measure) but 300 real bytes
  // (over the 200-byte display limit either way). The reported count must
  // be the real byte count.
  it('M-9: truncates a failing command\'s stderr by real UTF-8 bytes, not UTF-16 code units', async () => {
    const stderrText = 'é'.repeat(150)
    const byteCount = Buffer.byteLength(stderrText, 'utf8')
    expect(byteCount).toBe(300) // sanity: genuinely more bytes than characters
    const r = await verifyWrap(`printf '${stderrText}' 1>&2; exit 3`, "printf 'STATUS OK\\n'")
    expect(r.ok).toBe(false)
    expect(r.reason).toContain(`${String(byteCount)} bytes total, truncated`)
  })
})

describe('unwrapStatusLine', () => {
  it('restores a wrapped string command', () => {
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER, STATE_DIR)
    expect(unwrapStatusLine(r.statusLine)).toBe('~/.claude/statusline.sh')
  })

  it('restores a wrapped object command', () => {
    const original = { type: 'command', command: 'foo.sh', padding: 1 }
    const r = wrapStatusLine(original, WRAPPER, STATE_DIR)
    expect(unwrapStatusLine(r.statusLine)).toEqual(original)
  })

  it('round-trips wrap then unwrap for an absent statusline', () => {
    const r = wrapStatusLine(undefined, WRAPPER, STATE_DIR)
    expect(unwrapStatusLine(r.statusLine)).toBeUndefined()
  })

  it('leaves an unwrapped command alone', () => {
    expect(unwrapStatusLine('plain.sh')).toBe('plain.sh')
  })

  it('round-trips the exact object form this user has', () => {
    // This is the user's real current value. The round trip must be exact,
    // not merely equivalent, because uninstall writes this back verbatim.
    const original = { type: 'command', command: '~/.claude/statusline.sh' }
    const r = wrapStatusLine(original, WRAPPER, STATE_DIR)
    expect(unwrapStatusLine(r.statusLine)).toEqual(original)
  })

  // M-2: `null` is a legitimate statusLine value some settings.json can
  // hold, distinct from "there was no statusLine key at all" (the absent
  // case above, which round-trips to `undefined`). The old `?? null` /
  // `?? undefined` pair collapsed both into the same encoded value, so an
  // explicitly `null` original came back as `undefined` -- which
  // `uninstall` then treats as "delete the key", destroying a distinction
  // the settings file actually made.
  it('M-2: round-trips an explicit null statusLine as null, not as absent', () => {
    const r = wrapStatusLine(null, WRAPPER, STATE_DIR)
    expect(unwrapStatusLine(r.statusLine)).toBeNull()
  })
})

describe('recoverStatusLine', () => {
  // A wrapped command with the marker present but a trailing blob that is not
  // valid JSON -- the shape a hand edit would produce. Every test below uses
  // a directory under the OS temp dir, never a path under the real home
  // directory.
  const BROKEN = `DECKD_INNER='x' '${WRAPPER}' ${WRAPPER_MARKER} {not valid json`

  it('uses the embedded original when it parses, and reports no warning', () => {
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER, STATE_DIR)
    const result = recoverStatusLine(r.statusLine, '/does/not/exist/settings.json.deckd-backup', WRAPPER)
    expect(result.source).toBe('embedded')
    expect(result.statusLine).toBe('~/.claude/statusline.sh')
    expect(result.warning).toBeUndefined()
  })

  it('falls back to the backup when the embedded blob is malformed, and reports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-recover-'))
    try {
      const backupPath = join(dir, 'settings.json.deckd-backup')
      writeFileSync(backupPath, JSON.stringify({ statusLine: 'original-from-backup.sh' }))

      const result = recoverStatusLine(BROKEN, backupPath, WRAPPER)
      expect(result.source).toBe('backup')
      expect(result.statusLine).toBe('original-from-backup.sh')
      expect(result.warning).toContain('backup')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the backup even when the backup itself has no statusLine key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-recover-'))
    try {
      const backupPath = join(dir, 'settings.json.deckd-backup')
      writeFileSync(backupPath, JSON.stringify({ someOtherSetting: true }))

      const result = recoverStatusLine(BROKEN, backupPath, WRAPPER)
      expect(result.source).toBe('backup')
      expect(result.statusLine).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves statusLine absent and reports it when the blob is malformed and there is no backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-recover-'))
    try {
      const missingBackupPath = join(dir, 'settings.json.deckd-backup')
      // Deliberately do not create the file.

      const result = recoverStatusLine(BROKEN, missingBackupPath, WRAPPER)
      expect(result.source).toBe('none')
      expect(result.statusLine).toBeUndefined()
      expect(result.warning).toContain('no usable backup')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves statusLine absent and reports it when the backup file is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-recover-'))
    try {
      const backupPath = join(dir, 'settings.json.deckd-backup')
      writeFileSync(backupPath, 'not valid json either')

      const result = recoverStatusLine(BROKEN, backupPath, WRAPPER)
      expect(result.source).toBe('none')
      expect(result.statusLine).toBeUndefined()
      expect(result.warning).toContain('no usable backup')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // C-1: a wrapped command whose trailing marker comment has been trimmed
  // off must NOT be treated as "already the original" -- it still invokes
  // the wrapper at WRAPPER, so handing it back unchanged would leave a live
  // reference to the wrapper mislabelled as recovered. This must fall back
  // to the backup, exactly like a malformed blob does.
  it('C-1: falls back to the backup when the marker comment itself was trimmed off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-recover-'))
    try {
      const wrapped = wrapStatusLine('~/.claude/statusline.sh', WRAPPER, STATE_DIR)
      const command = wrapped.statusLine as string
      const markerTrimmed = command.slice(0, command.indexOf(WRAPPER_MARKER)).trimEnd()
      expect(markerTrimmed).toContain(WRAPPER)
      expect(markerTrimmed).not.toContain(WRAPPER_MARKER)

      const backupPath = join(dir, 'settings.json.deckd-backup')
      writeFileSync(backupPath, JSON.stringify({ statusLine: '~/.claude/statusline.sh' }))

      const result = recoverStatusLine(markerTrimmed, backupPath, WRAPPER)
      expect(result.source).toBe('backup')
      expect(result.statusLine).toBe('~/.claude/statusline.sh')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('C-1: reports source "none" (never "embedded") when the marker is trimmed and no backup exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-recover-'))
    try {
      const wrapped = wrapStatusLine('~/.claude/statusline.sh', WRAPPER, STATE_DIR)
      const command = wrapped.statusLine as string
      const markerTrimmed = command.slice(0, command.indexOf(WRAPPER_MARKER)).trimEnd()
      const missingBackupPath = join(dir, 'settings.json.deckd-backup')

      const result = recoverStatusLine(markerTrimmed, missingBackupPath, WRAPPER)
      // The old bug: this used to report `source: 'embedded'` with
      // `statusLine` set to the STILL-WRAPPED command itself, which the
      // caller would then treat as "already the original" and delete the
      // wrapper out from under it.
      expect(result.source).toBe('none')
      expect(result.statusLine).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('writeAtomic', () => {
  // Every case uses a directory under the OS temp dir, never a path under
  // the real home directory.
  it('preserves the mode of a file that already exists, even a tighter one than the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-atomic-'))
    try {
      const f = join(dir, 'settings.json')
      writeFileSync(f, '{}', { mode: 0o600 })
      expect(statSync(f).mode & 0o777).toBe(0o600)

      // `writeFileSync`'s `mode` option only applies at creation. The temp
      // file this function writes through is always newly created, so
      // without preserving the target's mode explicitly, the rename would
      // silently replace 0600 with the default 0644.
      writeAtomic(f, '{"a":1}')

      expect(statSync(f).mode & 0o777).toBe(0o600)
      expect(readFileSync(f, 'utf8')).toBe('{"a":1}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves a looser mode too, not just a tight one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-atomic-'))
    try {
      const f = join(dir, 'plist.xml')
      writeFileSync(f, 'old', { mode: 0o644 })
      chmodSync(f, 0o664)

      writeAtomic(f, 'new')

      expect(statSync(f).mode & 0o777).toBe(0o664)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the requested mode for a file that does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-atomic-'))
    try {
      const f = join(dir, 'brand-new.json')
      writeAtomic(f, '{}', 0o600)
      expect(statSync(f).mode & 0o777).toBe(0o600)
      expect(readFileSync(f, 'utf8')).toBe('{}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression coverage for B4: the temp file used to be created at the
  // caller's `mode` default (0o644) and only tightened to the target's real
  // mode AFTER `renameSync`, so a 0600 target's content sat at 0644 for the
  // whole write window -- and permanently if the process died in between.
  // This does not wait for a real crash to prove it: it wraps the three fs
  // calls `writeAtomic` makes and inspects both the arguments passed and the
  // real mode on disk at each step, which is the earliest and only place the
  // old code could still be caught creating the content loose.
  it('creates the temp file at the target mode from the very first write, and chmods it before the rename, never after', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-atomic-'))
    const actual = actualRef.current!
    try {
      const f = join(dir, 'settings.json')
      actual.writeFileSync(f, '{}', { mode: 0o600 })

      const order: string[] = []
      const modeAtWrite: number[] = []
      const modeAtChmod: number[] = []
      const writeMock = vi.mocked(fsModule.writeFileSync)
      const chmodMock = vi.mocked(fsModule.chmodSync)
      const renameMock = vi.mocked(fsModule.renameSync)

      writeMock.mockImplementation((...args: Parameters<typeof writeFileSync>) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (actual.writeFileSync as any)(...args)
        if (String(args[0]).includes('.tmp')) {
          order.push('write')
          modeAtWrite.push(actual.statSync(args[0] as string).mode & 0o777)
        }
        return result
      })
      chmodMock.mockImplementation((...args: Parameters<typeof chmodSync>) => {
        if (String(args[0]).includes('.tmp')) {
          order.push('chmod')
          modeAtChmod.push(args[1] as number)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (actual.chmodSync as any)(...args)
      })
      renameMock.mockImplementation((...args: Parameters<typeof renameSync>) => {
        order.push('rename')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (actual.renameSync as any)(...args)
      })

      try {
        writeAtomic(f, '{"a":1}')
      } finally {
        writeMock.mockImplementation(actual.writeFileSync)
        chmodMock.mockImplementation(actual.chmodSync)
        renameMock.mockImplementation(actual.renameSync)
      }

      // The temp file is 0600 from the very first `writeFileSync` -- never
      // the caller's 0o644 default -- and `chmodSync` runs on it, at 0600
      // again, strictly before `renameSync`.
      expect(modeAtWrite).toEqual([0o600])
      expect(modeAtChmod).toEqual([0o600])
      expect(order).toEqual(['write', 'chmod', 'rename'])
      expect(actual.statSync(f).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never reuses the same temp file name across two calls, even from the same process (M5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-atomic-'))
    const actual = actualRef.current!
    try {
      const f = join(dir, 'settings.json')
      const seenTmpNames = new Set<string>()
      const writeMock = vi.mocked(fsModule.writeFileSync)
      writeMock.mockImplementation((...args: Parameters<typeof writeFileSync>) => {
        if (String(args[0]).includes('.tmp')) seenTmpNames.add(String(args[0]))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (actual.writeFileSync as any)(...args)
      })
      try {
        writeAtomic(f, '{"a":1}')
        writeAtomic(f, '{"a":2}')
      } finally {
        writeMock.mockImplementation(actual.writeFileSync)
      }
      // Two calls, two distinct temp names -- the old `${file}.${pid}.tmp`
      // scheme would have produced the same name both times.
      expect(seenTmpNames.size).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // M-3: a failed `renameSync` used to leave the temp file behind forever --
  // a full duplicate of the new content, at `${file}.<pid>.<hex>.tmp`, with
  // no pruner anywhere for that shape. Forcing the rename to fail (by
  // sabotaging it directly, standing in for a full disk or a permissions
  // error) must still clean the temp file up before the error propagates.
  it('M-3: unlinks its temp file when renameSync fails, rather than leaving a duplicate behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-atomic-'))
    const actual = actualRef.current!
    try {
      const f = join(dir, 'settings.json')
      let capturedTmp = ''
      const renameMock = vi.mocked(fsModule.renameSync)
      renameMock.mockImplementation((...args: Parameters<typeof renameSync>) => {
        capturedTmp = String(args[0])
        throw new Error('simulated rename failure (disk full, permissions, ...)')
      })

      try {
        expect(() => writeAtomic(f, '{"a":1}')).toThrow(/simulated rename failure/)
      } finally {
        renameMock.mockImplementation(actual.renameSync)
      }

      expect(capturedTmp).toContain('.tmp')
      expect(actual.existsSync(capturedTmp)).toBe(false)
      expect(actual.existsSync(f)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // I-4: `renameSync(tmp, file)` replaces whatever inode sits at `file` --
  // for a symlink, that is the LINK itself, not whatever it points to.
  // Symlinking `~/.claude/settings.json` into a dotfiles repository is
  // ordinary practice, and the old, unconditional rename silently replaced
  // that link with a plain file holding the new content, breaking the link
  // with no warning anywhere. This proves the link survives and the REAL
  // target receives the new content instead.
  it('I-4: writes through a symlink, leaving the link itself untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-atomic-symlink-'))
    try {
      const real = join(dir, 'real-settings.json')
      const link = join(dir, 'settings.json')
      writeFileSync(real, '{"before":true}', { mode: 0o600 })
      fsModule.symlinkSync(real, link)

      writeAtomic(link, '{"after":true}')

      expect(fsModule.lstatSync(link).isSymbolicLink()).toBe(true)
      expect(fsModule.readlinkSync(link)).toBe(real)
      expect(readFileSync(real, 'utf8')).toBe('{"after":true}')
      expect(readFileSync(link, 'utf8')).toBe('{"after":true}')
      expect(statSync(real).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // I-4: a symlink whose target does not exist at all cannot be resolved to
  // anywhere safe to write. Refusing, rather than guessing, means this
  // never silently creates a file at whatever path the dangling link
  // happens to name, and never silently treats the link itself as an
  // ordinary file either.
  it('I-4: refuses to write through a dangling symlink, and changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-atomic-dangling-'))
    try {
      const missing = join(dir, 'does-not-exist.json')
      const link = join(dir, 'settings.json')
      fsModule.symlinkSync(missing, link)

      expect(() => writeAtomic(link, '{"after":true}')).toThrow(/dangling/)

      expect(fsModule.lstatSync(link).isSymbolicLink()).toBe(true)
      expect(fsModule.readlinkSync(link)).toBe(missing)
      expect(existsSync(missing)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // I-4: a chain of symlinks (a -> b -> c, with c the real file) must
  // resolve all the way through, not just one hop.
  it('I-4: follows a chain of symlinks all the way to the real file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-atomic-chain-'))
    try {
      const real = join(dir, 'c-real.json')
      const b = join(dir, 'b-link.json')
      const a = join(dir, 'a-link.json')
      writeFileSync(real, '{"before":true}', { mode: 0o600 })
      fsModule.symlinkSync(real, b)
      fsModule.symlinkSync(b, a)

      writeAtomic(a, '{"after":true}')

      expect(fsModule.lstatSync(a).isSymbolicLink()).toBe(true)
      expect(fsModule.lstatSync(b).isSymbolicLink()).toBe(true)
      expect(readFileSync(real, 'utf8')).toBe('{"after":true}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('install file rollback', () => {
  it('restores existing content and mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-rollback-'))
    try {
      const file = join(dir, 'settings.json')
      writeFileSync(file, 'before', { mode: 0o600 })
      const snapshot = snapshotFile(file)
      writeFileSync(file, 'after')
      chmodSync(file, 0o644)

      restoreFile(snapshot)
      expect(readFileSync(file, 'utf8')).toBe('before')
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes a file that did not exist before the attempted install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-rollback-'))
    try {
      const file = join(dir, 'new.plist')
      const snapshot = snapshotFile(file)
      writeFileSync(file, 'created by failed install')

      restoreFile(snapshot)
      expect(fsModule.existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Minor 7: `restoreFile` used to pass `snapshot.mode` into `writeAtomic`
  // as its `mode` argument, but `writeAtomic`'s default behaviour resolves
  // the mode by stat-ing the file AS IT CURRENTLY SITS -- during a
  // rollback, that is the MUTATED file, not the snapshot. So the temp file
  // was created and renamed at the current (wrong) mode, and only a
  // trailing `chmodSync` fixed it after the fact, reopening the exact
  // "never loose, not even for an instant" window `writeAtomic` exists to
  // close. This drives the same instrumented mock the writeAtomic suite
  // above uses, to prove the temp file is created at the SNAPSHOT's mode
  // from the very first write, not the mutated file's current mode.
  it('creates the restored file at the snapshot mode from the first write, never the mutated mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-rollback-'))
    const actual = actualRef.current!
    try {
      const file = join(dir, 'settings.json')
      actual.writeFileSync(file, 'before', { mode: 0o600 })
      const snapshot = snapshotFile(file)
      // Mutate to a LOOSER mode, as install's own writes would before a
      // later step fails and rollback runs.
      actual.writeFileSync(file, 'after')
      actual.chmodSync(file, 0o644)

      const modeAtWrite: number[] = []
      const writeMock = vi.mocked(fsModule.writeFileSync)
      writeMock.mockImplementation((...args: Parameters<typeof writeFileSync>) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (actual.writeFileSync as any)(...args)
        if (String(args[0]).includes('.tmp')) {
          modeAtWrite.push(actual.statSync(args[0] as string).mode & 0o777)
        }
        return result
      })
      try {
        restoreFile(snapshot)
      } finally {
        writeMock.mockImplementation(actual.writeFileSync)
      }

      // The temp file was 0600 -- the SNAPSHOT's mode -- from its very
      // first write, never 0644, the mode the file happened to have at the
      // moment restoreFile ran.
      expect(modeAtWrite).toEqual([0o600])
      expect(actual.statSync(file).mode & 0o777).toBe(0o600)
      expect(actual.readFileSync(file, 'utf8')).toBe('before')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Minor 7: `content.toString('utf8')` round-trips a Buffer through a
  // string, which is lossy for any byte sequence that is not valid UTF-8.
  // `restoreFile` now passes the Buffer straight through.
  it('restores non-UTF-8 bytes exactly, instead of replacing them with U+FFFD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-rollback-'))
    try {
      const file = join(dir, 'binary.plist')
      const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x80, 0x81])
      writeFileSync(file, bytes)
      const snapshot = snapshotFile(file)
      writeFileSync(file, 'mutated')

      restoreFile(snapshot)
      expect(readFileSync(file)).toEqual(bytes)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('install settings preflight', () => {
  it('preserves valid settings fields', () => {
    expect(parseSettingsObject('{"theme":"dark"}', '/tmp/settings.json'))
      .toEqual({ theme: 'dark' })
  })

  it('rejects malformed JSON instead of treating it as empty settings', () => {
    expect(() => parseSettingsObject('{ broken', '/tmp/settings.json'))
      .toThrow(/no install changes were made/i)
  })

  it('rejects a valid JSON value that is not an object', () => {
    expect(() => parseSettingsObject('[]', '/tmp/settings.json'))
      .toThrow(/must contain a JSON object/i)
  })

  // M-5: Node's own `JSON.parse` error text can embed the first bytes of
  // the input for input that is not JSON at all (measured: `Unexpected
  // token 's', ""sk-ant-api"... is not valid JSON`). settings.json can hold
  // anything by the time this runs, so the thrown message must never repeat
  // any of it back -- only a safe, contentless detail (or none at all).
  it('M-5: never echoes file content in the error, even for input that is not JSON at all', () => {
    let message = ''
    try {
      parseSettingsObject('sk-ant-api-fake-secret-value-should-never-appear', '/tmp/settings.json')
    } catch (e) {
      message = String(e)
    }
    expect(message).toContain('no install changes were made')
    expect(message).not.toContain('sk-ant-api')
    expect(message).not.toContain('fake-secret')
  })
})

describe('describeStatusLineOutcome', () => {
  it('says "restored ... from the backup" when the backup carried a real value', () => {
    const line = describeStatusLineOutcome(
      { statusLine: 'x.sh', source: 'backup' },
      '/x/settings.json',
    )
    expect(line).toContain('restored')
    expect(line).toContain('from the backup')
  })

  it('says "restored" (no backup wording) for a real embedded value', () => {
    const line = describeStatusLineOutcome(
      { statusLine: 'x.sh', source: 'embedded' },
      '/x/settings.json',
    )
    expect(line).toContain('restored')
    expect(line).not.toContain('backup')
  })

  // Regression coverage for the actual defect: `recoverStatusLine` can
  // report `source: 'backup'` while `statusLine` is `undefined` -- the
  // backup file existed and parsed, but it had no `statusLine` key of its
  // own, e.g. because install ran when statusLine was already absent. The
  // old wording said "restored ... from the backup" even though nothing
  // was restored; the key was deleted from settings.
  it('says "deleted", not "restored", when the backup source had no actual value', () => {
    const line = describeStatusLineOutcome(
      { statusLine: undefined, source: 'backup' },
      '/x/settings.json',
    )
    expect(line).toContain('deleted')
    expect(line).not.toContain('restored')
  })

  it('says "deleted", not "restored", when the embedded source had no actual value', () => {
    const line = describeStatusLineOutcome(
      { statusLine: undefined, source: 'embedded' },
      '/x/settings.json',
    )
    expect(line).toContain('deleted')
    expect(line).not.toContain('restored')
  })

  it('reports the unrecoverable case distinctly, without claiming a delete or a restore', () => {
    const line = describeStatusLineOutcome(
      { statusLine: undefined, source: 'none', warning: 'x' },
      '/x/settings.json',
    )
    expect(line).toContain('left statusLine absent')
    expect(line).not.toContain('restored')
    expect(line).not.toContain('deleted')
  })
})

// Finding 12: `existsSync` alone cannot tell a working build from one that
// throws at import time. These drive `preflightBuild` against small
// synthetic scripts, so the test never depends on the repository's real
// `dist` build being present or current.
describe('preflightBuild', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-preflight-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a script that does not exist', async () => {
    await expect(preflightBuild(join(dir, 'missing.js'))).rejects.toThrow(/does not exist/)
  })

  it('passes a script that mimics the real usage contract: exit 2 on no arguments', async () => {
    const script = join(dir, 'good.js')
    writeFileSync(script, 'process.exit(2)\n')
    await expect(preflightBuild(script)).resolves.toBeUndefined()
  })

  it('rejects a script that throws at import time (Node reports this as exit 1)', async () => {
    const script = join(dir, 'broken.js')
    writeFileSync(script, "throw new Error('boom')\n")
    await expect(preflightBuild(script)).rejects.toThrow(/build may be broken/)
  })

  it('rejects a script that exits 0 instead of the expected usage exit code 2', async () => {
    const script = join(dir, 'zero.js')
    writeFileSync(script, 'process.exit(0)\n')
    await expect(preflightBuild(script)).rejects.toThrow(/exited 0/)
  })

  it('rejects a script that hangs, within the injected timeout', async () => {
    const script = join(dir, 'hangs.js')
    writeFileSync(script, 'setInterval(() => {}, 1000)\n')
    await expect(preflightBuild(script, SHORT_TIMEOUT_MS)).rejects.toThrow(/build may be broken/)
  })
})

// Everything below drives `install()` and `uninstall()` directly, with
// injected paths (built fresh under the OS temp dir, never `~`) and a fake
// `LaunchAgentController` that never calls the real `launchctl`. Per the
// project's hard rule, nothing here may invoke `launchctl`, open the
// device, or touch any path under the real home directory.
function makeTestPaths(dir: string) {
  return buildPaths(join(dir, 'home'), join(dir, 'state'))
}

interface FakeControllerOptions {
  initialLoaded?: boolean
  /** Throws on the FIRST call to `bootstrap` only, so a test can force a
   * failure squarely inside the window after launchd has been touched. */
  failFirstBootstrap?: boolean
}

function fakeController(opts: FakeControllerOptions = {}): LaunchAgentController & { calls: string[] } {
  let loaded = opts.initialLoaded ?? false
  let bootstrapCalls = 0
  const calls: string[] = []
  return {
    calls,
    async isLoaded() {
      calls.push('isLoaded')
      return loaded
    },
    async bootout() {
      calls.push('bootout')
      loaded = false
    },
    async bootstrap() {
      bootstrapCalls += 1
      calls.push('bootstrap')
      if (opts.failFirstBootstrap && bootstrapCalls === 1) {
        throw new Error('simulated bootstrap failure')
      }
      loaded = true
    },
  }
}

/** A stand-in compiled entry point. `process.exit(2)` on no arguments is
 * exactly the contract `preflightBuild` checks for -- the real
 * `bin/deckd.ts`'s usage() path -- without needing the actual `dist` build
 * or importing the whole daemon module graph. */
function writeGoodScript(dir: string): string {
  const script = join(dir, 'good-deckd.js')
  writeFileSync(script, 'process.exit(2)\n')
  return script
}

describe('install() and uninstall()', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-install-e2e-'))
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('wraps the statusline, copies the wrapper at 0755, and writes the plist', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const controller = fakeController({ initialLoaded: false })

    await install({ paths: p, controller, script: writeGoodScript(dir) })

    expect(statSync(p.stateDir + '/statusline-wrapper.sh').mode & 0o777).toBe(0o755)
    const settings = JSON.parse(readFileSync(p.claudeSettings, 'utf8'))
    expect(isInstalled(settings, p.stateDir + '/statusline-wrapper.sh')).toBe(true)
    expect(existsSync(p.launchAgent)).toBe(true)
    expect(controller.calls).toContain('bootstrap')
  })

  it('refuses to double-install and leaves everything alone', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const controller = fakeController()
    await install({ paths: p, controller, script: writeGoodScript(dir) })
    const before = readFileSync(p.claudeSettings, 'utf8')
    controller.calls.length = 0

    await install({ paths: p, controller, script: writeGoodScript(dir) })

    expect(readFileSync(p.claudeSettings, 'utf8')).toBe(before)
    expect(controller.calls).toEqual([])
  })

  // C-1, the other direction of the critical finding: with the marker gone,
  // the OLD `isInstalled` did not recognise the existing wrap, so install
  // wrapped the already-wrapped invocation a SECOND time. `verifyWrap`
  // still passed, because a double wrap reproduces the original output
  // byte for byte, so the double wrap would have gone live silently. Keying
  // detection on the wrapper PATH instead means this still refuses, exactly
  // like the ordinary double-install case above, even with the marker gone.
  it('C-1: still refuses to double-wrap when the marker comment has been trimmed off', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const controller = fakeController()
    await install({ paths: p, controller, script: writeGoodScript(dir) })
    const wrapped = JSON.parse(readFileSync(p.claudeSettings, 'utf8')) as { statusLine: string }
    const markerAt = wrapped.statusLine.indexOf(WRAPPER_MARKER)
    expect(markerAt).toBeGreaterThan(-1)
    const trimmed = wrapped.statusLine.slice(0, markerAt).trimEnd()
    expect(trimmed).not.toContain(WRAPPER_MARKER)
    expect(trimmed).toContain(p.stateDir + '/statusline-wrapper.sh')
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: trimmed }))
    const before = readFileSync(p.claudeSettings, 'utf8')
    controller.calls.length = 0

    await install({ paths: p, controller, script: writeGoodScript(dir) })

    // Refused, not nested: settings.json is untouched, and launchd was
    // never called a second time.
    expect(readFileSync(p.claudeSettings, 'utf8')).toBe(before)
    expect(controller.calls).toEqual([])
  })

  // C-1: an AMBIGUOUS wrap -- one that looks like some deckd wrapper but not
  // the exact path this install would use, e.g. because DECKD_STATE_DIR
  // changed since a prior install -- must refuse rather than nest one wrap
  // inside another.
  it('C-1: refuses to wrap a statusLine that already looks like a DIFFERENT deckd wrap', async () => {
    const p = makeTestPaths(dir)
    const otherWrapperPath = join(dir, 'some-other-state-dir', 'statusline-wrapper.sh')
    const otherWrap = wrapStatusLine(
      "printf 'STATUS OK\\n'",
      otherWrapperPath,
      join(dir, 'some-other-state-dir'),
    )
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: otherWrap.statusLine }))
    const before = readFileSync(p.claudeSettings, 'utf8')

    let thrown: unknown
    try {
      await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })
    } catch (e) {
      thrown = e
    }

    expect((thrown as Error).message).toMatch(/already looks like a deckd wrap/)
    // M-14: names the wrapper path the AMBIGUOUS wrap actually invokes,
    // not just the path this install expected -- turning a three-step
    // diagnosis (read settings.json by hand, find statusLine, find the
    // wrapper path inside it) into a one-step one. Not a secret: it is a
    // path deckd itself wrote.
    expect((thrown as Error).message).toContain(otherWrapperPath)
    // M-1: enforceDirModes and the I-2 stray-probe repair already ran by
    // this point, so the message must say so rather than claim the
    // refusal changed nothing at all.
    expect((thrown as Error).message).toMatch(/state directory setup/)

    // Refused, changing nothing IN SETTINGS.JSON, THE WRAPPER, OR LAUNCHD:
    // no wrapper copied, no plist written.
    expect(readFileSync(p.claudeSettings, 'utf8')).toBe(before)
    expect(existsSync(p.stateDir + '/statusline-wrapper.sh')).toBe(false)
    expect(existsSync(p.launchAgent)).toBe(false)
  })

  // I-1: the review's own measured repro. A preflight script standing in
  // for ANY concurrent writer -- Claude Code itself persists an approved
  // `permissions.allow` entry into settings.json -- writes into
  // settings.json and then exits 2 (which `preflightBuild` treats as
  // success, the same shape its own usage() contract produces), simulating
  // a real write landing squarely inside the preflight/verify window. The
  // OLD code read settings.json once at the very top and wrote the
  // in-memory copy back at the very end, silently discarding whatever was
  // written in between. The fix must detect the change and abort instead,
  // leaving the concurrent write intact and settings.json exactly as the
  // "concurrent writer" left it -- not wrapped, and not clobbered.
  it('I-1: aborts, and does not clobber, when settings.json changes during the preflight/verify window', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))

    const racingScript = join(dir, 'racing-preflight.mjs')
    writeFileSync(
      racingScript,
      [
        "import { readFileSync, writeFileSync } from 'node:fs'",
        `const target = ${JSON.stringify(p.claudeSettings)}`,
        "const s = JSON.parse(readFileSync(target, 'utf8'))",
        "s.permissions = { allow: ['Bash(rm:*)'] }",
        'writeFileSync(target, JSON.stringify(s))',
        'process.exit(2)',
        '',
      ].join('\n'),
    )
    const controller = fakeController()

    await expect(
      install({ paths: p, controller, script: racingScript }),
    ).rejects.toThrow(/changed while install was verifying the wrap/)

    // The concurrent write survived, untouched by install -- proof this is
    // an abort, not a silent overwrite. statusLine must NOT have been
    // wrapped either: nothing was written past the point of detecting the
    // race.
    const settings = JSON.parse(readFileSync(p.claudeSettings, 'utf8'))
    expect(settings.permissions).toEqual({ allow: ['Bash(rm:*)'] })
    expect(settings.statusLine).toBe("printf 'STATUS OK\\n'")
    expect(existsSync(p.launchAgent)).toBe(false)
    // The wrapper copy that happened before the race check fired was rolled
    // back too -- this install never existed before, so nothing should be
    // left behind by the attempt.
    expect(existsSync(p.stateDir + '/statusline-wrapper.sh')).toBe(false)
    // `isLoaded` is queried unconditionally before the try block (finding
    // 4), well before this abort -- but launchd was never actually
    // TOUCHED: no bootout, no bootstrap.
    expect(controller.calls.filter((c) => c === 'bootout' || c === 'bootstrap')).toEqual([])
  })

  // M-10: `probe.before`/`probe.after` used to be embedded in this message
  // with NO bound at all, while the exact same command's stderr
  // (`ProbeExitError`) was already capped at 200 bytes -- two channels of
  // the same kind of user-controlled text on two different policies. The
  // statusline command below is deliberately NON-deterministic (it counts
  // its own invocations into a file) so `before` and `after` are guaranteed
  // to differ, and each one is padded well past the 200-byte display limit.
  it('M-10: bounds probe.before/after in the failed-verify message, sharing the stderr policy', async () => {
    const p = makeTestPaths(dir)
    const counterFile = join(dir, 'counter')
    writeFileSync(counterFile, '0')
    const innerScript = join(dir, 'inner-nondeterministic.sh')
    writeFileSync(
      innerScript,
      [
        '#!/bin/sh',
        `N=$(cat ${JSON.stringify(counterFile)})`,
        'N=$((N + 1))',
        `echo "$N" > ${JSON.stringify(counterFile)}`,
        'i=0',
        'while [ "$i" -lt 40 ]; do printf "PADDING-%s-" "$N"; i=$((i + 1)); done',
        '',
      ].join('\n'),
    )
    chmodSync(innerScript, 0o755)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: innerScript }))

    let thrown: unknown
    try {
      await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toMatch(/did not reproduce the original output/)
    expect(message).toMatch(/bytes total, truncated/)
  })

  // M-5: install() creates settings.json when the file did not exist at
  // all beforehand. The default `writeAtomic` mode (0644) would leave it
  // world-readable even though nothing had a chance to loosen it first --
  // `preserveExistingMode` finds nothing to stat.
  it('M-5: a settings.json install() creates from nothing is written at 0600', async () => {
    const p = makeTestPaths(dir)
    // No settings.json at all beforehand -- install must create one.

    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })

    expect(statSync(p.claudeSettings).mode & 0o777).toBe(0o600)
  })

  // I-4: the review's own repro. Symlinking `~/.claude/settings.json` into a
  // dotfiles repository (managed with `stow`, `chezmoi`, or a bare `ln -s`)
  // is ordinary practice. Before the fix, `writeAtomic`'s `renameSync`
  // replaced the LINK with a plain file holding the wrapped content, so the
  // dotfiles repo's own copy never saw the change and the next `stow` or
  // `git checkout` there would silently restore the unwrapped original.
  it('I-4: install writes through a symlinked settings.json, leaving the dotfiles link itself untouched', async () => {
    const p = makeTestPaths(dir)
    const dotfilesCopy = join(dir, 'dotfiles-settings.json')
    writeFileSync(dotfilesCopy, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    // p.claudeSettings does not exist as a real file at all -- it is a
    // symlink into a separate "dotfiles repository", exactly like a real
    // `stow`/`chezmoi`-managed checkout.
    fsModule.symlinkSync(dotfilesCopy, p.claudeSettings)

    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })

    expect(fsModule.lstatSync(p.claudeSettings).isSymbolicLink()).toBe(true)
    expect(fsModule.readlinkSync(p.claudeSettings)).toBe(dotfilesCopy)
    const settings = JSON.parse(readFileSync(dotfilesCopy, 'utf8'))
    expect(isInstalled(settings, p.stateDir + '/statusline-wrapper.sh')).toBe(true)
  })

  // M-6: the backup write itself must be atomic, like every other write in
  // this file. A `renameSync` failure partway through the backup write
  // must not leave a truncated backup, and must not leave a stray temp
  // file behind either (M-3).
  it('M-6: the backup is written atomically, via a temp file and a rename, not truncated in place', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const backupPath = `${p.claudeSettings}.deckd-backup`

    const renameMock = vi.mocked(fsModule.renameSync)
    renameMock.mockClear()

    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })

    const backupRenames = renameMock.mock.calls.filter(([, dest]) => String(dest) === backupPath)
    expect(backupRenames.length).toBeGreaterThanOrEqual(1)
    for (const [src] of backupRenames) {
      expect(String(src)).not.toBe(backupPath)
      expect(String(src)).toContain('.tmp')
    }
  })

  // M-6: `install()` always runs `enforceDirModes` and the I-2 stray-file
  // repair BEFORE reading settings.json, because the state directory is
  // wanted regardless of whether settings.json turns out to be readable.
  // So when settings.json cannot be parsed, the thrown message must not
  // claim it changed nothing at all -- that would be false, since the
  // state directory was just created and chmod'd. It must say so plainly.
  it("M-6: the state directory is still created even when settings.json cannot be parsed, and the error says so", async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, '{ not valid json')

    await expect(
      install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) }),
    ).rejects.toThrow(/already ran and is safe to keep/)

    expect(existsSync(p.stateDir)).toBe(true)
    expect(statSync(p.stateDir).mode & 0o777).toBe(0o700)
  })

  // C1, the critical finding. The old `readSettings()` swallowed every parse
  // error and returned `{}`, which skipped the unwrap but let execution
  // reach the wrapper delete anyway -- deleting the file a still-wrapped
  // settings.json pointed at, and reporting success. This is the exact
  // repro: a settings.json with a hand-edit typo (trailing comma).
  it('C1: refuses to uninstall when settings.json will not parse, and changes nothing', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const controller = fakeController({ initialLoaded: true })
    await install({ paths: p, controller, script: writeGoodScript(dir) })

    const wrapperPath = p.stateDir + '/statusline-wrapper.sh'
    const settingsBefore = readFileSync(p.claudeSettings, 'utf8')
    const wrapperBefore = readFileSync(wrapperPath, 'utf8')
    const plistBefore = readFileSync(p.launchAgent, 'utf8')
    expect(existsSync(wrapperPath)).toBe(true)

    // Hand-edit: trailing comma, exactly the review's repro.
    writeFileSync(p.claudeSettings, settingsBefore.replace(/}\s*$/, ',}'))
    controller.calls.length = 0

    await expect(uninstall({ paths: p, controller })).rejects.toThrow(/no uninstall changes were made/)

    // Nothing changed: not the settings file (still the hand-edited,
    // broken version -- uninstall must not "fix" it by overwriting), not
    // the wrapper, not the plist, and launchd was never called.
    expect(readFileSync(p.claudeSettings, 'utf8')).toBe(settingsBefore.replace(/}\s*$/, ',}'))
    expect(readFileSync(wrapperPath, 'utf8')).toBe(wrapperBefore)
    expect(readFileSync(p.launchAgent, 'utf8')).toBe(plistBefore)
    expect(controller.calls).toEqual([])
  })

  it('C1: the error names the problem and tells the user what to do, including the backup', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, '{ not valid json')
    writeFileSync(`${p.claudeSettings}.deckd-backup`, JSON.stringify({ statusLine: 'x.sh' }))

    await expect(uninstall({ paths: p, controller: fakeController() })).rejects.toThrow(
      /backup exists at/,
    )
  })

  // Review round 4, finding I-1: `install` was given a concurrent-write
  // guard in an earlier round (see the "I-1" tests above), but `uninstall`
  // never got it -- lesson 21, the same harm reachable by the OTHER verb.
  // `uninstall` reads settings.json, then `await controller.bootout(...)` --
  // a real `launchctl` subprocess -- then writes the whole in-memory object
  // back. This stands in for Claude Code itself persisting a
  // `permissions.allow` entry into settings.json while `bootout` is in
  // flight: the fake controller's own `bootout` performs the concurrent
  // write, landing it squarely inside the window a real subprocess call
  // would leave open. The fix must detect the change and abort, leaving the
  // concurrent write intact and settings.json still fully wrapped -- not
  // silently discarded by the stale in-memory copy.
  it('I-1: aborts, and does not clobber, when settings.json changes during the bootout await window', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const baseController = fakeController()
    await install({ paths: p, controller: baseController, script: writeGoodScript(dir) })
    baseController.calls.length = 0
    const wrapperPath = p.stateDir + '/statusline-wrapper.sh'

    const racingController: LaunchAgentController = {
      isLoaded: (label) => baseController.isLoaded(label),
      bootstrap: (label, plistPath) => baseController.bootstrap(label, plistPath),
      async bootout(label) {
        // Stands in for Claude Code itself persisting a write while
        // `launchctl bootout` -- a real subprocess -- is in flight.
        const s = JSON.parse(readFileSync(p.claudeSettings, 'utf8')) as Record<string, unknown>
        s.permissions = { allow: ['Bash(rm:*)'] }
        writeFileSync(p.claudeSettings, JSON.stringify(s))
        return baseController.bootout(label)
      },
    }

    await expect(uninstall({ paths: p, controller: racingController })).rejects.toThrow(
      /changed while uninstall was running/,
    )

    const settings = JSON.parse(readFileSync(p.claudeSettings, 'utf8')) as Record<string, unknown>
    // The concurrent write survived, untouched by uninstall -- proof this
    // is an abort, not a silent overwrite.
    expect(settings.permissions).toEqual({ allow: ['Bash(rm:*)'] })
    // Still fully wrapped: uninstall never got far enough to unwrap it.
    expect(isInstalled(settings, wrapperPath)).toBe(true)
    // The wrapper itself must not be stranded by the abort either.
    expect(existsSync(wrapperPath)).toBe(true)
  })

  // Review round 4, finding I-5: a failed uninstall used to leave the agent
  // stopped and the plist deleted, reporting only a bare filesystem error
  // (e.g. `EACCES ... .tmp`) that names a temp file the user has never
  // heard of. Every failure exit from uninstall must say exactly what state
  // the system is already in, and what to do next. Read-only `.claude`
  // reproduces the review's own driver: bootout and the plist delete both
  // succeed (they touch different directories), but writeAtomic's temp file
  // creation for settings.json fails with EACCES.
  it('I-5: a failed uninstall states what already happened and how to recover, and does not strand the wrapper', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const controller = fakeController({ initialLoaded: true })
    await install({ paths: p, controller, script: writeGoodScript(dir) })
    controller.calls.length = 0
    const wrapperPath = p.stateDir + '/statusline-wrapper.sh'
    const claudeDir = join(dir, 'home', '.claude')

    chmodSync(claudeDir, 0o500) // read + execute, no write: can read settings.json, cannot create a temp file in the directory
    let thrown: unknown
    try {
      await uninstall({ paths: p, controller })
    } catch (e) {
      thrown = e
    } finally {
      chmodSync(claudeDir, 0o700)
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    // States what already happened...
    expect(message).toMatch(/launch agent .* has already been stopped/)
    expect(message).toMatch(/plist at .* has already been removed/)
    expect(message).toMatch(/was NOT modified by this attempt/)
    // ...and what command recovers it.
    expect(message).toMatch(/deckd uninstall/)
    // The wrapper is only ever deleted after the settings write succeeds
    // and the re-read proves the unwrap took -- a failure this early must
    // not strand it.
    expect(existsSync(wrapperPath)).toBe(true)
    expect(existsSync(p.launchAgent)).toBe(false)
  })

  it('a settings.json that parses but whose wrapper file is already missing recovers cleanly', async () => {
    // This is the state a user was left in by the OLD, buggy uninstall:
    // settings.json still parses and still points at the wrapper, but the
    // wrapper file itself is gone. The fixed uninstall must repair this,
    // not refuse it -- refusal is only for a settings.json that cannot be
    // parsed at all.
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const controller = fakeController()
    await install({ paths: p, controller, script: writeGoodScript(dir) })
    unlinkSync(p.stateDir + '/statusline-wrapper.sh')

    await uninstall({ paths: p, controller })

    const settings = JSON.parse(readFileSync(p.claudeSettings, 'utf8'))
    expect(settings.statusLine).toBe("printf 'STATUS OK\\n'")
  })

  // Half one's negative guarantee: uninstall NEVER deletes the backup, on
  // ANY code path -- not even the most ordinary, successful uninstall,
  // which is exactly the path an earlier version of this same test asserted
  // the OPPOSITE of (`existsSync(backup)` used to assert `false` here).
  // Three straight review rounds each found a fresh way for uninstall to
  // delete the last copy of the user's original statusLine; the fix that
  // ends the whole harm class is refusing to delete it at all, regardless
  // of which detection path got there. The cost is one leftover file,
  // documented in `docs/DEPLOYMENT.md`.
  it('uninstall unwraps, removes the wrapper, and leaves its own backup in place', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const controller = fakeController()
    await install({ paths: p, controller, script: writeGoodScript(dir) })
    expect(existsSync(`${p.claudeSettings}.deckd-backup`)).toBe(true)
    const backupBefore = readFileSync(`${p.claudeSettings}.deckd-backup`, 'utf8')

    await uninstall({ paths: p, controller })

    const settings = JSON.parse(readFileSync(p.claudeSettings, 'utf8'))
    expect(settings.statusLine).toBe("printf 'STATUS OK\\n'")
    expect(existsSync(p.stateDir + '/statusline-wrapper.sh')).toBe(false)
    expect(existsSync(`${p.claudeSettings}.deckd-backup`)).toBe(true)
    expect(readFileSync(`${p.claudeSettings}.deckd-backup`, 'utf8')).toBe(backupBefore)
  })

  // M-2: the review's own measured repro. `{"statusLine":null,"keepMe":1}`
  // used to come back as `{"keepMe":1}` after install then uninstall --
  // the `statusLine` key itself was gone, not merely `null` again. A
  // `null` statusLine is a legitimate value some settings.json can hold,
  // distinct from never having had the key at all; deckd should not
  // quietly delete a key it did not put there.
  it('M-2: round-trips an explicit null statusLine through a full install/uninstall cycle', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: null, keepMe: 1 }))
    const controller = fakeController()

    await install({ paths: p, controller, script: writeGoodScript(dir) })
    await uninstall({ paths: p, controller })

    const settings = JSON.parse(readFileSync(p.claudeSettings, 'utf8')) as Record<string, unknown>
    expect(settings.keepMe).toBe(1)
    expect('statusLine' in settings).toBe(true)
    expect(settings.statusLine).toBeNull()
  })

  // C-1, THE critical finding's round-2 repro: the user (or an agent
  // "cleaning up" the noisy trailing JSON) trims the `# deckd-wrapped {...}`
  // comment. The statusline keeps working -- it is only a shell comment --
  // so nothing signals anything changed. The OLD `isInstalled` was false
  // afterward, so `uninstall` skipped the unwrap entirely and fell through
  // to unlinking the wrapper AND the backup unconditionally, stranding
  // settings.json pointing at a file it had just deleted, with the backup
  // gone too. The fix must still recognise this as installed (by path,
  // C-1), fall back to the backup to recover the original (since the
  // embedded blob is unreadable with the marker gone), delete the wrapper --
  // and, per half one, leave the backup exactly where it is.
  it('C-1: uninstall still recovers and cleans up when the marker comment was trimmed off', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const controller = fakeController()
    await install({ paths: p, controller, script: writeGoodScript(dir) })
    expect(existsSync(`${p.claudeSettings}.deckd-backup`)).toBe(true)

    const wrapped = JSON.parse(readFileSync(p.claudeSettings, 'utf8')) as { statusLine: string }
    const markerAt = wrapped.statusLine.indexOf(WRAPPER_MARKER)
    const trimmed = wrapped.statusLine.slice(0, markerAt).trimEnd()
    expect(trimmed).not.toContain(WRAPPER_MARKER)
    expect(trimmed).toContain(p.stateDir + '/statusline-wrapper.sh')
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: trimmed }))

    await uninstall({ paths: p, controller })

    const settings = JSON.parse(readFileSync(p.claudeSettings, 'utf8'))
    // Recovered from the backup, since the embedded blob is gone with the
    // marker -- NOT left as the still-wrapped `trimmed` command, which is
    // what the old bug would have done (by never touching settings.json
    // at all after concluding, wrongly, that nothing was installed).
    expect(settings.statusLine).toBe("printf 'STATUS OK\\n'")
    expect(existsSync(p.stateDir + '/statusline-wrapper.sh')).toBe(false)
    expect(existsSync(`${p.claudeSettings}.deckd-backup`)).toBe(true)
  })

  // C-1, THE critical finding's round-3 repro, and the exact case I-4 named
  // as missing: install with one state directory (A), then uninstall
  // resolving a DIFFERENT one (B) -- the mirror image of the install-side
  // test above ("refuses to wrap a statusLine that already looks like a
  // DIFFERENT deckd wrap"). Measured against the OLD code: `isInstalled`
  // was false (wrong path), so uninstall fell to its "never wrapped at
  // all" branch, reported "deckd uninstalled", removed the plist, deleted
  // the backup, and left `statusLine` invoking A's wrapper -- with the
  // closing message naming B, the wrong directory. The fixed `detectWrap`
  // recognises this as `'ambiguous'` and refuses outright, before touching
  // launchd, the plist, or anything else.
  it('C-1: uninstall refuses when the wrap points at a DIFFERENT state directory than this invocation resolved', async () => {
    const home = join(dir, 'home')
    const stateA = join(dir, 'state-a')
    const stateB = join(dir, 'state-b')
    mkdirSync(join(home, '.claude'), { recursive: true })
    const pA = buildPaths(home, stateA)
    const pB = buildPaths(home, stateB)
    const controller = fakeController()
    writeFileSync(pA.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    await install({ paths: pA, controller, script: writeGoodScript(dir) })

    const settingsBefore = readFileSync(pA.claudeSettings, 'utf8')
    const backupBefore = readFileSync(`${pA.claudeSettings}.deckd-backup`, 'utf8')
    const plistBefore = readFileSync(pA.launchAgent, 'utf8')
    controller.calls.length = 0

    // Same home, but resolved against stateB -- e.g. DECKD_STATE_DIR was
    // set for install and not for this uninstall, or vice versa.
    await expect(uninstall({ paths: pB, controller })).rejects.toThrow(/already looks like a deckd wrap/)

    // Refused, changing NOTHING: settings.json, the backup, and the plist
    // are all untouched, and launchd was never called -- not even the
    // bootout an ordinary uninstall issues unconditionally.
    expect(readFileSync(pA.claudeSettings, 'utf8')).toBe(settingsBefore)
    expect(readFileSync(`${pA.claudeSettings}.deckd-backup`, 'utf8')).toBe(backupBefore)
    expect(readFileSync(pA.launchAgent, 'utf8')).toBe(plistBefore)
    expect(existsSync(stateA + '/statusline-wrapper.sh')).toBe(true)
    expect(controller.calls).toEqual([])
  })

  // I-4: when recovery source is 'none' -- the embedded blob is unreadable
  // AND the backup itself will not parse -- the backup file is very likely
  // the last legible copy of the original left anywhere. Deleting it
  // destroys exactly what a person could otherwise have recovered by eye.
  // (Half one makes this the SAME outcome as every other case now, since
  // uninstall never deletes the backup regardless -- this test still earns
  // its place because it is the one case where the OLD code deleted it
  // even by its OWN, narrower rule.)
  it("I-4: uninstall keeps the backup when it could not recover anything (source: 'none')", async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const controller = fakeController()
    await install({ paths: p, controller, script: writeGoodScript(dir) })

    const wrapped = JSON.parse(readFileSync(p.claudeSettings, 'utf8')) as { statusLine: string }
    const markerAt = wrapped.statusLine.indexOf(WRAPPER_MARKER)
    const trimmed = wrapped.statusLine.slice(0, markerAt).trimEnd()
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: trimmed }))
    // Corrupt the backup too, so recovery has nowhere left to fall back to.
    writeFileSync(`${p.claudeSettings}.deckd-backup`, 'not valid json at all')

    await uninstall({ paths: p, controller })

    const settings = JSON.parse(readFileSync(p.claudeSettings, 'utf8'))
    expect(settings.statusLine).toBeUndefined()
    expect(existsSync(p.stateDir + '/statusline-wrapper.sh')).toBe(false)
    // The old bug: this file was deleted unconditionally, even here --
    // destroying the last legible copy of the original statusLine, which a
    // person could still have read by eye even though `JSON.parse` failed.
    expect(existsSync(`${p.claudeSettings}.deckd-backup`)).toBe(true)
    expect(readFileSync(`${p.claudeSettings}.deckd-backup`, 'utf8')).toBe('not valid json at all')
  })

  // Half one, asserted directly rather than through any one scenario: sweep
  // every uninstall path this suite exercises above and confirm every
  // single one leaves the backup behind. This is the guarantee itself, not
  // a repro of any one trigger -- the whole point is that it must hold no
  // matter which detection branch runs.
  it('half one: no uninstall code path in this suite ever deletes the backup', async () => {
    const scenarios: Array<(p: ReturnType<typeof makeTestPaths>) => Promise<void>> = [
      // Ordinary uninstall.
      async (p) => {
        writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'A\\n'" }))
        await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })
        await uninstall({ paths: p, controller: fakeController() })
      },
      // Marker trimmed -- recovers from the backup.
      async (p) => {
        writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'B\\n'" }))
        await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })
        const wrapped = JSON.parse(readFileSync(p.claudeSettings, 'utf8')) as { statusLine: string }
        const markerAt = wrapped.statusLine.indexOf(WRAPPER_MARKER)
        writeFileSync(
          p.claudeSettings,
          JSON.stringify({ statusLine: wrapped.statusLine.slice(0, markerAt).trimEnd() }),
        )
        await uninstall({ paths: p, controller: fakeController() })
      },
      // Never installed at all -- statusLine absent throughout.
      async (p) => {
        writeFileSync(`${p.claudeSettings}.deckd-backup`, JSON.stringify({ statusLine: 'x.sh' }))
        await uninstall({ paths: p, controller: fakeController() })
      },
    ]

    for (const [i, scenario] of scenarios.entries()) {
      const scenarioDir = join(dir, `half-one-${String(i)}`)
      mkdirSync(join(scenarioDir, 'home', '.claude'), { recursive: true })
      const p = makeTestPaths(scenarioDir)
      await scenario(p)
      expect(existsSync(`${p.claudeSettings}.deckd-backup`)).toBe(true)
    }
  })

  // Finding I2. The old probe ran with no DECKD_STATE_DIR override, so it
  // cached fabricated usage straight into the live sessions directory.
  it("I2: install never writes probe data into the real sessions directory", async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))

    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })

    expect(existsSync(join(p.sessionsDir, 'deckd-install-probe.json'))).toBe(false)
    expect(existsSync(join(p.sessionsDir, 'baseline-probe.json'))).toBe(false)
    expect(existsSync(join(p.stateDir, 'usage.json'))).toBe(false)
  })

  it('I2: install repairs an already-installed user by removing stray probe files', async () => {
    const p = makeTestPaths(dir)
    mkdirSync(p.sessionsDir, { recursive: true })
    writeFileSync(join(p.sessionsDir, 'deckd-install-probe.json'), '{"fake":true}')
    writeFileSync(join(p.sessionsDir, 'baseline-probe.json'), '{"fake":true}')
    // Already installed: install() returns early, but the repair step
    // above it must still run.
    const wrap = wrapStatusLine("printf 'STATUS OK\\n'", p.stateDir + '/statusline-wrapper.sh', p.stateDir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: wrap.statusLine }))

    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })

    expect(existsSync(join(p.sessionsDir, 'deckd-install-probe.json'))).toBe(false)
    expect(existsSync(join(p.sessionsDir, 'baseline-probe.json'))).toBe(false)
  })

  // Finding I6. copyFileSync keeps an EXISTING destination's mode, so a
  // stale loose backup would otherwise receive a fresh copy of a
  // secrets-bearing settings file and stay loose.
  it('I6: forces the backup to the live settings file mode, even over a stale looser backup', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }), { mode: 0o600 })
    chmodSync(p.claudeSettings, 0o600)
    writeFileSync(`${p.claudeSettings}.deckd-backup`, '{"stale":true}', { mode: 0o644 })
    chmodSync(`${p.claudeSettings}.deckd-backup`, 0o644)

    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })

    expect(statSync(`${p.claudeSettings}.deckd-backup`).mode & 0o777).toBe(0o600)
  })

  // Review round 4, finding I-3: this test used to sabotage `copyFileSync`
  // for the backup path, but the backup has been written by `writeAtomic`
  // (not `copyFileSync`) since the M-6 change above -- `install`'s only
  // `copyFileSync` call is for the WRAPPER script, never the backup. The
  // sabotage branch (`String(args[1]) === backupPath`) could therefore
  // never execute, so the assertion passed purely because `writeAtomic`
  // forces the mode regardless, proving nothing: a test that cannot fail
  // (lesson 22). Rewritten against the mechanism the backup actually uses
  // today: `writeAtomic` resolves the target mode itself, then writes the
  // temp file with that mode AND unconditionally `chmodSync`s it before the
  // rename (see `writeAtomic`'s own docblock). This sabotages the FIRST of
  // those two -- `writeFileSync`'s own `mode` option, for the backup's temp
  // file specifically -- so the assertion can only pass if `writeAtomic`'s
  // own explicit `chmodSync` call is the thing that actually corrects it.
  it('I-3: writeAtomic\'s own chmodSync call forces the backup mode, independent of what writeFileSync\'s mode option leaves behind', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }), { mode: 0o600 })
    chmodSync(p.claudeSettings, 0o600)
    const backupPath = `${p.claudeSettings}.deckd-backup`
    writeFileSync(backupPath, '{"stale":true}', { mode: 0o644 })
    chmodSync(backupPath, 0o644)

    const actual = actualRef.current!
    const writeMock = vi.mocked(fsModule.writeFileSync)
    writeMock.mockImplementation((...args: Parameters<typeof fsModule.writeFileSync>) => {
      const target = String(args[0])
      if (target.startsWith(`${backupPath}.`) && target.endsWith('.tmp')) {
        // Simulate a runtime where writeFileSync's `mode` option is
        // silently ignored on creation, so the fresh temp file lands at
        // whatever the default is (not the requested 0600) -- only
        // writeAtomic's OWN unconditional `chmodSync(tmp, targetMode)`
        // call, not the `mode` option passed alongside the content, can
        // still land it at 0600 before the rename.
        return actual.writeFileSync(args[0], args[1])
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.writeFileSync as any)(...args)
    })
    try {
      await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })
    } finally {
      writeMock.mockImplementation(actual.writeFileSync)
    }

    expect(statSync(backupPath).mode & 0o777).toBe(0o600)
  })

  // Finding I4. Presence of a plist file is not the same as the agent
  // being loaded. Rollback must record and restore the ACTUAL load state,
  // and must never touch launchd for a failure that never reached it.
  describe('I4: rollback and launchd state', () => {
    it('never calls the launchd controller for a failure that never touched launchd', async () => {
      const p = makeTestPaths(dir)
      // The settings file's parent directory does not exist, so the
      // atomic write in step 2 fails with ENOENT -- well before step 3
      // ever reaches launchd.
      const brokenSettingsPath = join(dir, 'home', '.claude', 'missing-dir', 'settings.json')
      const p2 = { ...p, claudeSettings: brokenSettingsPath }
      const controller = fakeController({ initialLoaded: true })

      await expect(
        install({ paths: p2, controller, script: writeGoodScript(dir) }),
      ).rejects.toThrow()

      expect(controller.calls.filter((c) => c === 'bootout' || c === 'bootstrap')).toEqual([])
    })

    it('does not restart the daemon on rollback when it was NOT loaded beforehand (deliberate bootout)', async () => {
      const p = makeTestPaths(dir)
      writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
      const controller = fakeController({ initialLoaded: false, failFirstBootstrap: true })

      await expect(
        install({ paths: p, controller, script: writeGoodScript(dir) }),
      ).rejects.toThrow(/simulated bootstrap failure/)

      // bootstrap was attempted once (and failed) as part of the normal
      // install flow. Rollback must not attempt it again, because the
      // agent was not loaded before this install began.
      expect(controller.calls.filter((c) => c === 'bootstrap')).toHaveLength(1)
      // Rollback still stops whatever the failed attempt may have loaded.
      expect(controller.calls.filter((c) => c === 'bootout').length).toBeGreaterThanOrEqual(1)
    })

    it('restores the daemon on rollback when it WAS loaded beforehand', async () => {
      const p = makeTestPaths(dir)
      writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
      const controller = fakeController({ initialLoaded: true, failFirstBootstrap: true })

      await expect(
        install({ paths: p, controller, script: writeGoodScript(dir) }),
      ).rejects.toThrow(/simulated bootstrap failure/)

      // Once for the failed install attempt, once more for rollback
      // restoring the prior loaded state.
      expect(controller.calls.filter((c) => c === 'bootstrap')).toHaveLength(2)
    })

    it('rolls back file changes made before the launchd failure', async () => {
      const p = makeTestPaths(dir)
      const original = JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" })
      writeFileSync(p.claudeSettings, original)
      const controller = fakeController({ initialLoaded: false, failFirstBootstrap: true })

      await expect(
        install({ paths: p, controller, script: writeGoodScript(dir) }),
      ).rejects.toThrow()

      expect(readFileSync(p.claudeSettings, 'utf8')).toBe(original)
      expect(existsSync(p.launchAgent)).toBe(false)
    })

    // I-1: a failed restore must stop rollback immediately, not get logged
    // and skipped over. The old code pushed the failure onto
    // `rollbackErrors` and kept going -- so a failed settings.json restore
    // did not stop the loop from reaching the wrapper's own snapshot next
    // (content `null`, since the wrapper did not exist before this
    // install) and unlinking it. Result: settings.json left exactly as the
    // sabotage below leaves it -- still referencing a wrapper the old
    // rollback had just deleted. This sabotages the settings.json restore
    // itself (by replacing it with a directory right when `bootstrap`
    // fails, so `renameSync` inside `restoreFile` cannot succeed) and
    // proves the fixed rollback stops there rather than reaching the
    // wrapper or the backup snapshots that come after it in the reversed
    // order.
    it('I-1: stops rollback immediately on a failed restore, so no later snapshot is deleted', async () => {
      const p = makeTestPaths(dir)
      writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
      let bootstrapCalls = 0
      const controller: LaunchAgentController = {
        async isLoaded() { return false },
        async bootout() {},
        async bootstrap() {
          bootstrapCalls += 1
          if (bootstrapCalls === 1) {
            // Sabotage the settings.json restore: replace it with a
            // directory, so `restoreFile`'s `renameSync(tmp, file)` fails.
            // This models a real failure (permissions, a full disk, a
            // concurrent process) without needing one to actually occur.
            unlinkSync(p.claudeSettings)
            mkdirSync(p.claudeSettings)
            throw new Error('simulated bootstrap failure')
          }
        },
      }

      await expect(
        install({ paths: p, controller, script: writeGoodScript(dir) }),
      ).rejects.toThrow(/could not restore/)

      // Snapshot order is [wrapperDst, backup, claudeSettings, launchAgent],
      // restored REVERSED: launchAgent, then claudeSettings (which fails
      // here), then backup, then wrapperDst. Stopping the instant
      // claudeSettings fails to restore must leave backup and wrapperDst
      // exactly as the forward pass left them -- neither was reached.
      expect(existsSync(p.stateDir + '/statusline-wrapper.sh')).toBe(true)
      expect(existsSync(`${p.claudeSettings}.deckd-backup`)).toBe(true)
    })
  })
})

describe('refreshWrapper', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-refresh-'))
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses when deckd is not installed', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))

    await expect(refreshWrapper({ paths: p })).rejects.toThrow(/not installed/)
  })

  it('re-copies the wrapper at 0755 without touching settings.json or the plist', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })
    const wrapperPath = p.stateDir + '/statusline-wrapper.sh'
    const settingsBefore = readFileSync(p.claudeSettings, 'utf8')
    // Simulate drift: a hand edit that broke the installed copy.
    writeFileSync(wrapperPath, '#!/bin/sh\necho drifted\n')
    chmodSync(wrapperPath, 0o644)

    const result = await refreshWrapper({ paths: p })

    expect(result.path).toBe(wrapperPath)
    expect(statSync(wrapperPath).mode & 0o777).toBe(0o755)
    expect(readFileSync(wrapperPath, 'utf8')).toBe(
      readFileSync(join(process.cwd(), 'src/install/statusline-wrapper.sh'), 'utf8'),
    )
    expect(readFileSync(p.claudeSettings, 'utf8')).toBe(settingsBefore)
  })

  // I-2: `settings.statusLine` here is already the WRAPPED command, unlike
  // in `install()`. The old code passed it to `wrapStatusLine` as if it
  // were the pristine original, so the probe's "before" ran the entire
  // installed command directly -- reading the LIVE `DECKD_STATE_DIR` baked
  // into it by a prior install -- and cached fabricated usage and a probe
  // session file straight into the live sessions directory, twice, with no
  // cleanup. The fix recovers the true pre-wrap original first, so neither
  // probe run ever touches the live directory at all.
  it('I-2: never writes probe data into the live state directory', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })
    expect(existsSync(join(p.sessionsDir, 'deckd-install-probe.json'))).toBe(false)
    expect(existsSync(join(p.stateDir, 'usage.json'))).toBe(false)

    await refreshWrapper({ paths: p })

    expect(existsSync(join(p.sessionsDir, 'deckd-install-probe.json'))).toBe(false)
    expect(existsSync(join(p.stateDir, 'usage.json'))).toBe(false)
  })

  // I-3: the live wrapper script must be replaced atomically -- a temp file
  // written in the same directory, then renamed -- never truncated and
  // streamed into in place. `copyFileSync` does the latter, so a render
  // that `exec`s the file mid-copy would run a truncated script.
  it('I-3: replaces the wrapper via a temp file and a rename, never by truncating it in place', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })
    const wrapperPath = p.stateDir + '/statusline-wrapper.sh'

    const renameMock = vi.mocked(fsModule.renameSync)
    renameMock.mockClear()

    await refreshWrapper({ paths: p })

    const wrapperRenames = renameMock.mock.calls.filter(([, dest]) => String(dest) === wrapperPath)
    expect(wrapperRenames.length).toBeGreaterThanOrEqual(1)
    for (const [src] of wrapperRenames) {
      // The source of the rename is a DISTINCT temp file, never the
      // destination path itself -- proof this went through a temp-file
      // swap, not an in-place write.
      expect(String(src)).not.toBe(wrapperPath)
      expect(String(src)).toContain('.tmp')
    }
  })

  // C-1's "if ambiguous, refuse" rule, applied to refreshWrapper: if the
  // original command cannot be recovered from the installed wrap (the
  // marker is gone and there is no way to prove what the wrapper should
  // reproduce), refuse outright rather than guess at what to re-verify
  // against.
  it('refuses to refresh when the installed wrap cannot be unwrapped, and changes nothing', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })
    const wrapperPath = p.stateDir + '/statusline-wrapper.sh'
    const wrapperBefore = readFileSync(wrapperPath, 'utf8')

    const wrapped = JSON.parse(readFileSync(p.claudeSettings, 'utf8')) as { statusLine: string }
    const markerAt = wrapped.statusLine.indexOf(WRAPPER_MARKER)
    const trimmed = wrapped.statusLine.slice(0, markerAt).trimEnd()
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: trimmed }))

    await expect(refreshWrapper({ paths: p })).rejects.toThrow(/could not recover the original/)

    expect(readFileSync(wrapperPath, 'utf8')).toBe(wrapperBefore)
  })

  // Half one: refreshWrapper uses the SAME shared `detectWrap` as install
  // and uninstall. An ambiguous wrap (some other deckd wrapper, pointing at
  // a different state directory) must refuse here too, exactly like the
  // other two -- otherwise refreshing would re-verify the wrapper against
  // the wrong recovered original.
  it('refuses to refresh when statusLine looks like a DIFFERENT deckd wrap', async () => {
    const p = makeTestPaths(dir)
    const otherWrap = wrapStatusLine(
      "printf 'STATUS OK\\n'",
      join(dir, 'some-other-state-dir', 'statusline-wrapper.sh'),
      join(dir, 'some-other-state-dir'),
    )
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: otherWrap.statusLine }))
    const before = readFileSync(p.claudeSettings, 'utf8')

    await expect(refreshWrapper({ paths: p })).rejects.toThrow(/already looks like a deckd wrap/)

    expect(readFileSync(p.claudeSettings, 'utf8')).toBe(before)
    expect(existsSync(p.stateDir + '/statusline-wrapper.sh')).toBe(false)
  })

  // M-2: `writeAtomic`'s temp file needs somewhere to live. `install`
  // always runs `enforceDirModes` before it ever touches settings.json, but
  // `refreshWrapper` did not -- so an already-installed user whose state
  // directory was later removed by hand got a bare ENOENT instead of the
  // repair `docs/DEPLOYMENT.md` promises `refresh-wrapper` performs.
  it('M-2: repairs a missing state directory instead of failing with a bare ENOENT', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    await install({ paths: p, controller: fakeController(), script: writeGoodScript(dir) })
    rmSync(p.stateDir, { recursive: true, force: true })
    expect(existsSync(p.stateDir)).toBe(false)

    const result = await refreshWrapper({ paths: p })

    expect(result.path).toBe(p.stateDir + '/statusline-wrapper.sh')
    expect(existsSync(result.path)).toBe(true)
    expect(statSync(p.stateDir).mode & 0o777).toBe(0o700)
  })
})
