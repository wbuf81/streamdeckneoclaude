import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, rmSync,
  existsSync, unlinkSync, mkdirSync,
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
})

describe('isInstalled', () => {
  it('is false for a clean settings file', () => {
    expect(isInstalled({ statusLine: '~/.claude/statusline.sh' })).toBe(false)
  })

  it('is false when there is no statusline', () => {
    expect(isInstalled({})).toBe(false)
  })

  it('is true after a wrap', () => {
    const r = wrapStatusLine('x.sh', WRAPPER, STATE_DIR)
    expect(isInstalled({ statusLine: r.statusLine })).toBe(true)
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
  // exit non-zero. These three tests exercise the fixed behaviour: the
  // wrapped side always runs now, and its outcome is compared against the
  // original's, not just assumed equivalent.
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

  it('still accepts a wrapper that runs to completion despite a failing original', async () => {
    // Original fails; wrapper (standing in for the real mechanism) succeeds
    // anyway. The wrapper itself is proven to work; the original's failure
    // is the user's business.
    const r = await verifyWrap("printf 'ok\\n'", 'exit 4')
    expect(r.ok).toBe(true)
    expect(r.reason).toContain('original command failed')
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
})

describe('recoverStatusLine', () => {
  // A wrapped command with the marker present but a trailing blob that is not
  // valid JSON -- the shape a hand edit would produce. Every test below uses
  // a directory under the OS temp dir, never a path under the real home
  // directory.
  const BROKEN = `DECKD_INNER='x' '${WRAPPER}' ${WRAPPER_MARKER} {not valid json`

  it('uses the embedded original when it parses, and reports no warning', () => {
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER, STATE_DIR)
    const result = recoverStatusLine(r.statusLine, '/does/not/exist/settings.json.deckd-backup')
    expect(result.source).toBe('embedded')
    expect(result.statusLine).toBe('~/.claude/statusline.sh')
    expect(result.warning).toBeUndefined()
  })

  it('falls back to the backup when the embedded blob is malformed, and reports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-recover-'))
    try {
      const backupPath = join(dir, 'settings.json.deckd-backup')
      writeFileSync(backupPath, JSON.stringify({ statusLine: 'original-from-backup.sh' }))

      const result = recoverStatusLine(BROKEN, backupPath)
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

      const result = recoverStatusLine(BROKEN, backupPath)
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

      const result = recoverStatusLine(BROKEN, missingBackupPath)
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

      const result = recoverStatusLine(BROKEN, backupPath)
      expect(result.source).toBe('none')
      expect(result.statusLine).toBeUndefined()
      expect(result.warning).toContain('no usable backup')
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
    expect(isInstalled(settings)).toBe(true)
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

  it('uninstall unwraps, removes the wrapper, and removes its own backup', async () => {
    const p = makeTestPaths(dir)
    writeFileSync(p.claudeSettings, JSON.stringify({ statusLine: "printf 'STATUS OK\\n'" }))
    const controller = fakeController()
    await install({ paths: p, controller, script: writeGoodScript(dir) })
    expect(existsSync(`${p.claudeSettings}.deckd-backup`)).toBe(true)

    await uninstall({ paths: p, controller })

    const settings = JSON.parse(readFileSync(p.claudeSettings, 'utf8'))
    expect(settings.statusLine).toBe("printf 'STATUS OK\\n'")
    expect(existsSync(p.stateDir + '/statusline-wrapper.sh')).toBe(false)
    expect(existsSync(`${p.claudeSettings}.deckd-backup`)).toBe(false)
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
})
