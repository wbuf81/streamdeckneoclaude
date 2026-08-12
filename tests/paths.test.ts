import { describe, it, expect } from 'vitest'
import { paths } from '../src/paths.js'
import { homedir } from 'node:os'

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
