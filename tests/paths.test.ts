import { describe, it, expect } from 'vitest'
import { paths, ensureStateDir } from '../src/paths.js'
import { homedir } from 'node:os'
import { mkdirSync, chmodSync, statSync } from 'node:fs'

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
})

describe('ensureStateDir', () => {
  it('forces mode 0700 on state directories that already exist with a looser mode', () => {
    mkdirSync(paths.sessionsDir, { recursive: true })
    mkdirSync(paths.artDir, { recursive: true })
    chmodSync(paths.stateDir, 0o755)
    chmodSync(paths.sessionsDir, 0o755)
    chmodSync(paths.artDir, 0o755)

    ensureStateDir()

    expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700)
    expect(statSync(paths.sessionsDir).mode & 0o777).toBe(0o700)
    expect(statSync(paths.artDir).mode & 0o777).toBe(0o700)
  })
})
