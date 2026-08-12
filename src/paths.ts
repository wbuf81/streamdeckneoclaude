import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const home = homedir()
const stateDir = join(home, '.local', 'state', 'deckd')
const claudeDir = join(home, '.claude')

export const paths = {
  stateDir,
  sessionsDir: join(stateDir, 'sessions'),
  usageFile: join(stateDir, 'usage.json'),
  uiFile: join(stateDir, 'ui.json'),
  configFile: join(stateDir, 'config.json'),
  spotifyFile: join(stateDir, 'spotify.json'),
  artDir: join(stateDir, 'art'),
  logFile: join(stateDir, 'deckd.log'),
  claudeStateDir: join(claudeDir, 'daisy-statusbar', 'state.d'),
  claudeSettings: join(claudeDir, 'settings.json'),
  launchAgentLabel: 'com.wbard.deckd',
  launchAgent: join(home, 'Library', 'LaunchAgents', 'com.wbard.deckd.plist'),
} as const

/** Creates the state directory tree. Mode 0700, because it holds a token. */
export function ensureStateDir(): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(paths.sessionsDir, { recursive: true, mode: 0o700 })
  mkdirSync(paths.artDir, { recursive: true, mode: 0o700 })
}
