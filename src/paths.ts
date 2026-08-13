import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, chmodSync } from 'node:fs'

/** Builds all runtime paths. Tests and ad-hoc tools can isolate deckd state. */
export function buildPaths(home: string, stateOverride?: string) {
  const stateDir = stateOverride || join(home, '.local', 'state', 'deckd')
  const claudeDir = join(home, '.claude')
  const codexDir = join(home, '.codex')
  return {
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
    codexStateDb: join(codexDir, 'state_5.sqlite'),
    launchAgentLabel: 'com.wbard.deckd',
    launchAgent: join(home, 'Library', 'LaunchAgents', 'com.wbard.deckd.plist'),
  } as const
}

export const paths = buildPaths(homedir(), process.env.DECKD_STATE_DIR)

/**
 * Creates each of `dirs` and forces `mode` on it, unconditionally.
 *
 * `mkdirSync` applies `mode` only to directories it creates. A directory
 * that already exists keeps its old mode. So each directory gets an
 * unconditional `chmodSync` too, to enforce the mode even on a stale
 * directory left behind by a prior process, a backup restore, or an
 * unpacked archive.
 *
 * The directory list is a parameter, distinct from `ensureStateDir` below,
 * so a test can drive this exact logic against a temporary directory
 * instead of the real state directories under `~`. Mirrors the seam
 * `createFileSink(file)` gives the log tests.
 */
export function enforceDirModes(dirs: readonly string[], mode = 0o700): void {
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode })
    chmodSync(dir, mode)
  }
}

/** Creates the real state directory tree. Mode 0700, because it holds a
 * token. See `enforceDirModes` for why an existing directory needs an
 * unconditional `chmodSync`, not just `mkdirSync`'s `mode` option. */
export function ensureStateDir(): void {
  enforceDirModes([paths.stateDir, paths.sessionsDir, paths.artDir])
}
