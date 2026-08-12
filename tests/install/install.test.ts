import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPlist, wrapStatusLine, unwrapStatusLine, recoverStatusLine, isInstalled, verifyWrap,
  writeAtomic, describeStatusLineOutcome,
  WRAPPER_MARKER,
} from '../../src/install/install.js'

const WRAPPER = '/Users/w/.local/state/deckd/statusline-wrapper.sh'
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
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER)
    expect(r.inner).toBe('~/.claude/statusline.sh')
    expect(JSON.stringify(r.statusLine)).toContain(WRAPPER)
  })

  it('wraps an object command', () => {
    const r = wrapStatusLine({ type: 'command', command: 'foo.sh' }, WRAPPER)
    expect(r.inner).toBe('foo.sh')
    expect((r.statusLine as { command: string }).command).toContain(WRAPPER)
  })

  it('preserves other fields on an object command', () => {
    const r = wrapStatusLine({ type: 'command', command: 'foo.sh', padding: 1 }, WRAPPER)
    expect((r.statusLine as { padding: number }).padding).toBe(1)
    expect((r.statusLine as { type: string }).type).toBe('command')
  })

  it('handles an absent statusline', () => {
    const r = wrapStatusLine(undefined, WRAPPER)
    expect(r.inner).toBe('')
    expect(JSON.stringify(r.statusLine)).toContain(WRAPPER)
  })

  it('embeds the inner command so uninstall can recover it', () => {
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER)
    expect(JSON.stringify(r.statusLine)).toContain('~/.claude/statusline.sh')
  })

  it('includes the marker, so isInstalled can find it', () => {
    const r = wrapStatusLine('x.sh', WRAPPER)
    expect(JSON.stringify(r.statusLine)).toContain(WRAPPER_MARKER)
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
    const r = wrapStatusLine('x.sh', WRAPPER)
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
})

describe('unwrapStatusLine', () => {
  it('restores a wrapped string command', () => {
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER)
    expect(unwrapStatusLine(r.statusLine)).toBe('~/.claude/statusline.sh')
  })

  it('restores a wrapped object command', () => {
    const original = { type: 'command', command: 'foo.sh', padding: 1 }
    const r = wrapStatusLine(original, WRAPPER)
    expect(unwrapStatusLine(r.statusLine)).toEqual(original)
  })

  it('round-trips wrap then unwrap for an absent statusline', () => {
    const r = wrapStatusLine(undefined, WRAPPER)
    expect(unwrapStatusLine(r.statusLine)).toBeUndefined()
  })

  it('leaves an unwrapped command alone', () => {
    expect(unwrapStatusLine('plain.sh')).toBe('plain.sh')
  })

  it('round-trips the exact object form this user has', () => {
    // This is the user's real current value. The round trip must be exact,
    // not merely equivalent, because uninstall writes this back verbatim.
    const original = { type: 'command', command: '~/.claude/statusline.sh' }
    const r = wrapStatusLine(original, WRAPPER)
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
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER)
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
