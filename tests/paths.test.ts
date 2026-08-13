import { describe, it, expect, afterEach, vi } from 'vitest'
import { paths, enforceDirModes, buildPaths } from '../src/paths.js'
import { homedir } from 'node:os'
import { mkdtempSync, mkdirSync, chmodSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('paths', () => {
  it('puts runtime state under ~/.local/state/deckd', () => {
    expect(paths.stateDir).toBe(`${homedir()}/.local/state/deckd`)
    expect(paths.usageFile).toBe(`${paths.stateDir}/usage.json`)
    expect(paths.sessionsDir).toBe(`${paths.stateDir}/sessions`)
    expect(paths.spotifyFile).toBe(`${paths.stateDir}/spotify.json`)
    expect(paths.artDir).toBe(`${paths.stateDir}/art`)
  })

  it('reads Claude session state from the daisy-statusbar directory', () => {
    expect(paths.claudeStateDir).toBe(`${homedir()}/.claude/daisy-statusbar/state.d`)
    expect(paths.claudeSettings).toBe(`${homedir()}/.claude/settings.json`)
  })

  it('names the launchd agent with a reverse-domain label', () => {
    expect(paths.launchAgentLabel).toBe('com.wbard.deckd')
    expect(paths.launchAgent).toBe(
      `${homedir()}/Library/LaunchAgents/com.wbard.deckd.plist`,
    )
  })

  it('can isolate every deckd state file without moving Claude or launchd paths', () => {
    const isolated = buildPaths('/Users/tester', '/tmp/deckd-test-state')
    expect(isolated.stateDir).toBe('/tmp/deckd-test-state')
    expect(isolated.logFile).toBe('/tmp/deckd-test-state/deckd.log')
    expect(isolated.spotifyFile).toBe('/tmp/deckd-test-state/spotify.json')
    expect(isolated.claudeSettings).toBe('/Users/tester/.claude/settings.json')
    expect(isolated.codexStateDb).toBe('/Users/tester/.codex/state_5.sqlite')
    expect(isolated.launchAgent).toBe('/Users/tester/Library/LaunchAgents/com.wbard.deckd.plist')
  })

  // Finding 11: an unvalidated DECKD_STATE_DIR was joined in with no check
  // that it was even absolute. A relative value would resolve against
  // `process.cwd()`, which Lesson 3 records as wrong under launchd -- the
  // daemon's working directory is not the project, so a relative override
  // would silently cache into a directory unrelated to what was intended.
  it('ignores a relative DECKD_STATE_DIR override and falls back to the default', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const isolated = buildPaths('/Users/tester', 'relative/state')
      expect(isolated.stateDir).toBe('/Users/tester/.local/state/deckd')
      expect(consoleError).toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('accepts an absolute DECKD_STATE_DIR override with no warning', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const isolated = buildPaths('/Users/tester', '/tmp/deckd-test-state')
      expect(isolated.stateDir).toBe('/tmp/deckd-test-state')
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  // M-4: DECKD_STATE_DIR=$HOME is a footgun worth rejecting outright, even
  // though it cannot weaken a mode. It would chmod the home directory
  // itself to 0700, create `sessions` and `art` directly inside it, make
  // `deckd uninstall` unlink `~/statusline-wrapper.sh`, and make the
  // render-time wrapper `chmod 700 $HOME` on every render.
  it('M-4: rejects DECKD_STATE_DIR set to the home directory itself', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const isolated = buildPaths('/Users/tester', '/Users/tester')
      expect(isolated.stateDir).toBe('/Users/tester/.local/state/deckd')
      expect(consoleError).toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  // I-3: measured accepted by the OLD exact-string compare, even though
  // each one still names the home directory or an ancestor of it, once
  // normalised.
  it.each([
    ['/Users/tester/', 'a trailing slash on the home directory'],
    ['/Users/tester/.', 'a trailing dot segment on the home directory'],
    ['/', 'the filesystem root'],
    ['/Users', 'the direct parent of the home directory'],
  ])('I-3: rejects DECKD_STATE_DIR=%s (%s)', (override) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const isolated = buildPaths('/Users/tester', override)
      expect(isolated.stateDir).toBe('/Users/tester/.local/state/deckd')
      expect(consoleError).toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  // A sibling of home, or an unrelated absolute path, is not an ancestor of
  // home and must still be accepted -- this override exists exactly so a
  // test, or a person, can point deckd's state somewhere else entirely.
  // Only home itself and its ancestors are rejected, never a directory that
  // merely shares a string prefix with home's name.
  it('I-3: accepts a sibling directory whose name merely starts with the same characters as home', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const isolated = buildPaths('/Users/tester', '/Users/testertwo')
      expect(isolated.stateDir).toBe('/Users/testertwo')
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('enforceDirModes', () => {
  // `ensureStateDir()` itself is not exercised here: it hard-codes the real
  // paths under `~/.local/state/deckd`, and this suite must never create,
  // chmod, or otherwise touch that real tree. `enforceDirModes` is the
  // logic `ensureStateDir` calls, with the directory list taken as a
  // parameter instead, so this test drives the exact same code against a
  // throwaway temporary directory. Mirrors `createFileSink(file)` in
  // tests/log.test.ts.
  let dir: string

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('forces mode 0700 on directories that already exist with a looser mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-paths-'))
    const stateDir = join(dir, 'state')
    const sessionsDir = join(dir, 'state', 'sessions')
    const artDir = join(dir, 'state', 'art')
    mkdirSync(sessionsDir, { recursive: true })
    mkdirSync(artDir, { recursive: true })
    chmodSync(stateDir, 0o755)
    chmodSync(sessionsDir, 0o755)
    chmodSync(artDir, 0o755)

    enforceDirModes([stateDir, sessionsDir, artDir])

    expect(statSync(stateDir).mode & 0o777).toBe(0o700)
    expect(statSync(sessionsDir).mode & 0o777).toBe(0o700)
    expect(statSync(artDir).mode & 0o777).toBe(0o700)
  })

  it('creates a directory that does not exist yet, at the requested mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-paths-'))
    const fresh = join(dir, 'brand-new')

    enforceDirModes([fresh], 0o700)

    expect(statSync(fresh).mode & 0o777).toBe(0o700)
  })
})
