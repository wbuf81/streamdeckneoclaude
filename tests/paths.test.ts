import { describe, it, expect, afterEach } from 'vitest'
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
