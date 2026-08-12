import { describe, it, expect } from 'vitest'
import {
  buildPlist, wrapStatusLine, unwrapStatusLine, isInstalled, verifyWrap, WRAPPER_MARKER,
} from '../../src/install/install.js'

const WRAPPER = '/Users/w/.local/state/deckd/statusline-wrapper.sh'

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
