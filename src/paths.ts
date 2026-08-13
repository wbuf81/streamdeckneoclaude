import { homedir } from 'node:os'
import { join, isAbsolute, resolve, sep } from 'node:path'
import { mkdirSync, chmodSync } from 'node:fs'

/**
 * Resolves the state directory override.
 *
 * A relative value would resolve against `process.cwd()`, which Lesson 3
 * records as wrong under launchd -- the daemon's working directory is not
 * the project, so a relative `DECKD_STATE_DIR` would silently land somewhere
 * unrelated to what the person setting it intended. Reject it outright and
 * fall back to the default, rather than caching into the wrong directory.
 */
/**
 * True when `candidate` (already `resolve()`d) is exactly `of`, or a
 * directory somewhere above it. Compares whole path SEGMENTS, not a bare
 * string prefix -- `/Users` must match `/Users/tester`, but `/Users/test`
 * (missing the trailing separator) must NOT match `/Users/tester`, even
 * though the plain string is a prefix of it.
 */
function isAncestorOrSelf(candidate: string, of: string): boolean {
  if (candidate === of) return true
  const withSep = candidate.endsWith(sep) ? candidate : candidate + sep
  return of.startsWith(withSep)
}

/**
 * I-3: `DECKD_STATE_DIR=$HOME` used to be rejected only in that EXACT
 * spelling (`stateOverride === home`), a plain string compare with no
 * normalisation. Measured accepted: `$HOME/` (one keystroke off the
 * rejected spelling), `$HOME/.`, `/`, and `/Users` -- every one of them
 * still resolves to the home directory or an ancestor of it, and every
 * consequence the docblock below lists follows just as surely from an
 * ancestor as from home itself: `enforceDirModes` would `chmod 700` that
 * ancestor (tightening a directory deckd does not own, and everything
 * still under it), install would create `sessions` and `art` directly
 * inside it, `deckd uninstall` would unlink a `statusline-wrapper.sh` that
 * may not be deckd's, and the render-time wrapper would `chmod 700` it on
 * every render. Worse, uninstall's own "state directory remains" message
 * would then invite the user to delete their home directory (or its
 * parent) by hand.
 *
 * `resolve()` normalises away the trailing-slash and `.`-segment spellings
 * before comparing, and `isAncestorOrSelf` rejects the home directory
 * itself AND every directory above it, not only an exact match. A path
 * OUTSIDE home that is not one of its ancestors (a sibling directory, or an
 * unrelated absolute path such as the OS temp directory a test uses) is
 * deliberately still allowed -- this override exists precisely so a test,
 * or a person who wants deckd's state somewhere else entirely, can point it
 * off to one side of the home directory tree.
 */
function resolveStateDir(home: string, stateOverride?: string): string {
  const fallback = join(home, '.local', 'state', 'deckd')
  if (!stateOverride) return fallback
  if (!isAbsolute(stateOverride)) {
    console.error(
      `DECKD_STATE_DIR must be an absolute path; ignoring relative value ` +
        `${JSON.stringify(stateOverride)} and using ${fallback} instead.`,
    )
    return fallback
  }
  const resolvedHome = resolve(home)
  const resolved = resolve(stateOverride)
  if (isAncestorOrSelf(resolved, resolvedHome)) {
    console.error(
      `DECKD_STATE_DIR must not be the home directory, or any directory above it; ignoring ` +
        `${JSON.stringify(stateOverride)} (resolves to ${resolved}) and using ${fallback} instead.`,
    )
    return fallback
  }
  return resolved
}

/** Builds all runtime paths. Tests and ad-hoc tools can isolate deckd state. */
export function buildPaths(home: string, stateOverride?: string) {
  const stateDir = resolveStateDir(home, stateOverride)
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

/** The shape `buildPaths` returns. Install and uninstall take this as an
 * injectable parameter, so a test can isolate every path they touch without
 * going anywhere near the real home directory. */
export type Paths = ReturnType<typeof buildPaths>

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
