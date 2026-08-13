import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeSource, parseSessionFile, STALE_SECONDS } from '../../src/sources/claude.js'

const NOW = 1786549560

function fileFor(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: 'tool',
    label: 'Running command',
    tool: 'Bash',
    project: 'streamdeckneoclaude',
    cwd: '/Users/you/Vibecoding/streamdeckneoclaude',
    sessionId: 'aaaa',
    transcript: '/tmp/t.jsonl',
    entrypoint: 'cli',
    term_program: 'ghostty',
    pid: 39894,
    started: true,
    startedAt: NOW - 840,
    ts: NOW,
    ...overrides,
  })
}

describe('parseSessionFile', () => {
  it('reads every field the deck needs', () => {
    const s = parseSessionFile(fileFor(), NOW)!
    expect(s.sessionId).toBe('aaaa')
    expect(s.state).toBe('tool')
    expect(s.label).toBe('Running command')
    expect(s.tool).toBe('Bash')
    expect(s.project).toBe('streamdeckneoclaude')
    expect(s.termProgram).toBe('ghostty')
    expect(s.pid).toBe(39894)
    expect(s.startedAt).toBe(NOW - 840)
    expect(s.ts).toBe(NOW)
  })

  it('accepts all five real state values', () => {
    for (const v of ['idle', 'thinking', 'tool', 'permission', 'done'] as const) {
      expect(parseSessionFile(fileFor({ state: v }), NOW)!.state).toBe(v)
    }
  })

  it('maps an unrecognised state to unknown', () => {
    expect(parseSessionFile(fileFor({ state: 'juggling' }), NOW)!.state).toBe('unknown')
  })

  it('maps a missing state to unknown', () => {
    expect(parseSessionFile(fileFor({ state: undefined }), NOW)!.state).toBe('unknown')
  })

  it('returns null for a stale session', () => {
    expect(parseSessionFile(fileFor({ ts: NOW - STALE_SECONDS - 1 }), NOW)).toBeNull()
  })

  it('keeps a session exactly at the stale limit', () => {
    expect(parseSessionFile(fileFor({ ts: NOW - STALE_SECONDS }), NOW)).not.toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseSessionFile('{ not json', NOW)).toBeNull()
  })

  it('returns null when sessionId is absent', () => {
    expect(parseSessionFile(fileFor({ sessionId: '' }), NOW)).toBeNull()
  })

  it('defaults a missing project to a dash', () => {
    expect(parseSessionFile(fileFor({ project: undefined }), NOW)!.project).toBe('—')
  })

  // M1 — `startedAt` used to fabricate `0` (1970) for an absent field.
  // Break the fix (revert to `num()`) and this fails, receiving `0` instead
  // of `null`.
  it('reports startedAt as null, never a fabricated 0, when the field is absent', () => {
    expect(parseSessionFile(fileFor({ startedAt: undefined }), NOW)!.startedAt).toBeNull()
  })

  it('reports startedAt as null for a non-numeric value', () => {
    expect(parseSessionFile(fileFor({ startedAt: 'nope' }), NOW)!.startedAt).toBeNull()
  })
})

describe('ClaudeSource', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-state-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads every session file in the directory', async () => {
    writeFileSync(join(dir, 'aaaa.json'), fileFor({ sessionId: 'aaaa', ts: NOW }))
    writeFileSync(join(dir, 'bbbb.json'), fileFor({ sessionId: 'bbbb', ts: NOW }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    expect(src.getSessions()).toHaveLength(2)
    await src.stop()
  })

  it('sorts sessions by ts, newest first', async () => {
    writeFileSync(join(dir, 'old.json'), fileFor({ sessionId: 'old', ts: NOW - 100 }))
    writeFileSync(join(dir, 'new.json'), fileFor({ sessionId: 'new', ts: NOW }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    expect(src.getSessions().map((s) => s.sessionId)).toEqual(['new', 'old'])
    await src.stop()
  })

  it('hides a stale session', async () => {
    writeFileSync(join(dir, 'a.json'), fileFor({ sessionId: 'a', ts: NOW }))
    writeFileSync(join(dir, 'b.json'), fileFor({ sessionId: 'b', ts: NOW - 9999 }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    expect(src.getSessions().map((s) => s.sessionId)).toEqual(['a'])
    await src.stop()
  })

  it('skips a corrupt file and keeps the good ones', async () => {
    writeFileSync(join(dir, 'good.json'), fileFor({ sessionId: 'good', ts: NOW }))
    writeFileSync(join(dir, 'bad.json'), '{ truncated')
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    expect(src.getSessions().map((s) => s.sessionId)).toEqual(['good'])
    await src.stop()
  })

  it('ignores a file that is not .json', async () => {
    writeFileSync(join(dir, 'a.json'), fileFor({ sessionId: 'a', ts: NOW }))
    writeFileSync(join(dir, 'a.json.4242.tmp'), fileFor({ sessionId: 'tmp', ts: NOW }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    expect(src.getSessions().map((s) => s.sessionId)).toEqual(['a'])
    await src.stop()
  })

  it('reports an empty list when the directory is absent', async () => {
    const src = new ClaudeSource(join(dir, 'nope'), () => NOW)
    await src.start()
    expect(src.getSessions()).toEqual([])
    expect(src.directoryExists()).toBe(false)
    await src.stop()
  })

  it('returns a copy from getSessions, so mutating the result cannot corrupt the source', async () => {
    writeFileSync(join(dir, 'a.json'), fileFor({ sessionId: 'a', ts: NOW }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.refresh()

    const sessions = src.getSessions()
    sessions.length = 0

    expect(src.getSessions()).toHaveLength(1)
    expect(src.getSessions()[0]?.sessionId).toBe('a')
  })

  it('emits change when a session file appears', async () => {
    const src = new ClaudeSource(dir, () => NOW)
    let changes = 0
    src.on('change', () => { changes += 1 })
    await src.start()
    const before = changes
    writeFileSync(join(dir, 'new.json'), fileFor({ sessionId: 'new', ts: NOW }))
    await src.refresh()
    expect(changes).toBeGreaterThan(before)
    expect(src.getSessions()).toHaveLength(1)
    await src.stop()
  })

  it('does not emit change when nothing changed', async () => {
    writeFileSync(join(dir, 'a.json'), fileFor({ sessionId: 'a', ts: NOW }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    let changes = 0
    src.on('change', () => { changes += 1 })
    await src.refresh()
    await src.refresh()
    expect(changes).toBe(0)
    await src.stop()
  })

  it('emits change when only label differs within the same second', async () => {
    // sessionId, state, tool and ts (whole seconds) all stay identical here.
    // A key built from only those fields would miss this update, and the
    // deck (which redraws only on `change`) would keep showing stale text.
    writeFileSync(join(dir, 'a.json'), fileFor({ sessionId: 'a', label: 'Old label', ts: NOW }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    let changes = 0
    src.on('change', () => { changes += 1 })
    writeFileSync(join(dir, 'a.json'), fileFor({ sessionId: 'a', label: 'New label', ts: NOW }))
    await src.refresh()
    expect(changes).toBeGreaterThan(0)
    expect(src.getSessions()[0]?.label).toBe('New label')
    await src.stop()
  })
})
