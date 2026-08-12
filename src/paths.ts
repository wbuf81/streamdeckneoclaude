import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, chmodSync } from 'node:fs'

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

/**
 * Creates the state directory tree. Mode 0700, because it holds a token.
 *
 * `mkdirSync` applies `mode` only to directories it creates. A directory
 * that already exists keeps its old mode. So each directory gets an
 * unconditional `chmodSync` too, to enforce 0700 even on a stale directory
 * left behind by a prior process, a backup restore, or an unpacked archive.
 */
export function ensureStateDir(): void {
  for (const dir of [paths.stateDir, paths.sessionsDir, paths.artDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
}
