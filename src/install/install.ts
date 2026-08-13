import {
  readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync,
  existsSync, chmodSync, mkdirSync, statSync, mkdtempSync, rmSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { paths, enforceDirModes, type Paths } from '../paths.js'

const run = promisify(execFile)

/** Marks a wrapped statusline, so install and uninstall recognise their work. */
export const WRAPPER_MARKER = '# deckd-wrapped'

/**
 * Finds the project root, the directory that holds `package.json`. Two reasons
 * this cannot use the module's own directory or `process.cwd()`:
 *
 *   1. `tsc` compiles `.ts` and does NOT copy `.sh`, so the wrapper script never
 *      appears next to the compiled `install.js`. It only exists in the source
 *      tree at `src/install/statusline-wrapper.sh`.
 *   2. This module sits at `src/install/` under `tsx` and at `dist/src/install/`
 *      after a build, so a fixed number of parent steps is wrong for one of them.
 */
export function projectRoot(): string | null {
  let dir = import.meta.dirname
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Escapes the five XML special characters. `nodePath`, `scriptPath`, and
 * `logPath` all come from filesystem paths, which can legally contain `&`,
 * `<`, `>`, `'`, or `"` (a username with an ampersand is not exotic). An
 * unescaped one would produce a malformed plist that launchd may refuse to
 * load, or that reads back with a corrupted path. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildPlist(
  label: string,
  nodePath: string,
  scriptPath: string,
  logPath: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`
}

interface WrapResult {
  statusLine: unknown
  inner: string
}

/**
 * Builds a statusline command that runs the wrapper first. The original command
 * travels inside the new one, after the marker, so uninstall needs no other
 * record. Losing the state directory therefore cannot strand a wrapped config.
 *
 * The command relies on three shell behaviours: a `VAR=value` assignment prefix,
 * `#` starting a comment so the trailing JSON is inert, and tilde expansion
 * inside the inner command. Claude Code does run the statusline through a shell,
 * and there is direct evidence rather than an assumption: this user's existing
 * value is `~/.claude/statusline.sh`, whose leading tilde only resolves under a
 * shell. A direct exec would fail with ENOENT.
 *
 * `stateDir` is embedded as a `DECKD_STATE_DIR=` assignment alongside
 * `DECKD_INNER`. Without it, the wrapper falls back to `$HOME/.local/state/deckd`
 * at render time, independent of whatever directory install actually used --
 * survivable when they happen to be the same path, but fragile in general, and
 * the exact gap a temporary probe state directory (see `install`) would fall
 * into if this were omitted. Embedding it here means the installed wrapper
 * always caches to the directory this install actually used, regardless of the
 * render-time environment under launchd.
 *
 * `verifyWrap` still proves the wrap end to end before `install` trusts it.
 */
export function wrapStatusLine(current: unknown, wrapperPath: string, stateDir: string): WrapResult {
  const inner = extractCommand(current)
  const encoded = JSON.stringify({ original: current ?? null })
  const command =
    `DECKD_STATE_DIR=${shellQuote(stateDir)} DECKD_INNER=${shellQuote(inner)} ` +
    `${shellQuote(wrapperPath)} ${WRAPPER_MARKER} ${encoded}`

  if (current && typeof current === 'object') {
    return { statusLine: { ...(current as object), command }, inner }
  }
  return { statusLine: command, inner }
}

interface UnwrapAttempt {
  /** False only when the marker is present but the trailing JSON blob will
   * not parse -- e.g. the command was hand-edited. True covers both "no
   * marker" and "marker, and the embedded original was legitimately empty",
   * which `unwrapStatusLine` cannot tell apart on its own, so callers that
   * need to distinguish "recovered nothing" from "recovery failed" use this
   * instead. */
  ok: boolean
  value: unknown
}

function tryUnwrapStatusLine(current: unknown): UnwrapAttempt {
  const command = extractCommand(current)
  const at = command.indexOf(WRAPPER_MARKER)
  if (at === -1) return { ok: true, value: current }
  try {
    const blob = command.slice(at + WRAPPER_MARKER.length).trim()
    const parsed = JSON.parse(blob) as { original: unknown }
    return { ok: true, value: parsed.original ?? undefined }
  } catch {
    return { ok: false, value: undefined }
  }
}

/** Recovers the original statusline from a wrapped one. */
export function unwrapStatusLine(current: unknown): unknown {
  return tryUnwrapStatusLine(current).value
}

export interface RecoverResult {
  /** The value to assign to `statusLine`, or `undefined` to leave it absent. */
  statusLine: unknown
  source: 'embedded' | 'backup' | 'none'
  /** Set only when the embedded copy failed, so the caller can report it. */
  warning?: string
}

/**
 * Recovers the statusLine value that `uninstall` should restore.
 *
 * The embedded copy inside the wrapped command is the normal path: it is
 * self-contained, and almost every uninstall uses it with no other file
 * involved. It can fail only if the wrapped command was hand-edited so the
 * trailing JSON blob no longer parses. In that case the pre-install backup at
 * `backupPath` is a safe fallback, because `install` wrote it before it ever
 * touched `statusLine`.
 *
 * If even the backup is missing or unreadable, this function does NOT invent
 * a value and does NOT signal "just delete it" by returning `undefined`
 * quietly -- it returns `source: 'none'` with a warning, so the caller can
 * tell the user plainly that their original statusline could not be found,
 * rather than silently discarding it.
 */
export function recoverStatusLine(current: unknown, backupPath: string): RecoverResult {
  const attempt = tryUnwrapStatusLine(current)
  if (attempt.ok) return { statusLine: attempt.value, source: 'embedded' }

  try {
    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as Record<string, unknown>
    return {
      statusLine: backup.statusLine,
      source: 'backup',
      warning:
        'the embedded original statusLine command was unreadable, so deckd restored ' +
        `it from the backup at ${backupPath}.`,
    }
  } catch {
    return {
      statusLine: undefined,
      source: 'none',
      warning:
        'the embedded original statusLine command was unreadable, and no usable backup ' +
        `was found at ${backupPath}. statusLine is left absent. Claude Code will use its default.`,
    }
  }
}

export function isInstalled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false
  const sl = (settings as Record<string, unknown>).statusLine
  if (sl === undefined) return false
  return extractCommand(sl).includes(WRAPPER_MARKER)
}

function extractCommand(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const c = (v as Record<string, unknown>).command
    if (typeof c === 'string') return c
  }
  return ''
}

/** Quotes a value for `sh`. A path with a space must survive. */
function shellQuote(s: string): string {
  if (s === '') return "''"
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Writes a file through a temporary name, so a crash cannot truncate it.
 *
 * By default, the target's own mode, when it already exists, is resolved
 * BEFORE anything is written, and the temp file is created at that mode from
 * the very start -- not written loose and tightened afterwards. Two defects
 * shaped this:
 *
 *   - The temp file used to be created at the caller's `mode` default
 *     (0o644) and only `chmodSync`'d to the target's tighter mode AFTER
 *     `renameSync`. A 0600 target's content then sat at 0644 for the whole
 *     write window -- and permanently, if the process died between the
 *     rename and the chmod. Resolving the final mode first, and applying it
 *     to the temp file before the rename, closes that window entirely:
 *     `file` is never visible at a looser mode than it is supposed to end
 *     up with, not even for an instant.
 *   - `${file}.${pid}.tmp` is stable per pid, so a crashed EARLIER run of
 *     the same pid could leave a stale temp file behind at a loose mode --
 *     and `writeFileSync`'s `mode` option applies only when it CREATES the
 *     file (Lesson 1), so it would be silently ignored on that leftover. A
 *     random suffix makes a collision practically impossible; the
 *     unconditional `chmodSync` below removes the remaining theoretical
 *     case rather than relying on the random suffix alone -- the same
 *     belt-and-braces the mode itself needed.
 *
 * `opts.preserveExistingMode` (default `true`) is what gives that
 * "preserve the current mode" behaviour. Pass `false` when the caller
 * needs to FORCE `mode` regardless of whatever mode the file currently has
 * -- `restoreFile` is the one caller that does, because during a rollback
 * the file's CURRENT mode is the mutated one, not the mode being restored
 * to, and probing it would silently reopen the exact window this function
 * exists to close.
 *
 * `content` accepts a `Buffer` as well as a `string`, so a caller restoring
 * an arbitrary snapshot never has to round-trip through `toString('utf8')`,
 * which is lossy for any byte sequence that is not valid UTF-8.
 *
 * Exported so a test can drive it directly against a temporary file,
 * without going through `install()`/`uninstall()`, which default to the
 * real paths under `~` and must never do so in a test.
 */
export function writeAtomic(
  file: string,
  content: string | Buffer,
  mode = 0o644,
  opts: { preserveExistingMode?: boolean } = {},
): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let targetMode = mode
  if (opts.preserveExistingMode !== false) {
    try {
      targetMode = statSync(file).mode & 0o777
    } catch {
      // The target does not exist yet. Use the requested mode.
    }
  }
  writeFileSync(tmp, content, { mode: targetMode })
  // `mode` on `writeFileSync` applies only at creation (Lesson 1). The
  // random suffix above means `tmp` is always newly created in practice, but
  // this does not depend on that being true.
  chmodSync(tmp, targetMode)
  renameSync(tmp, file)
}

export interface FileSnapshot {
  path: string
  content: Buffer | null
  mode: number
}

/** Captures one file before install mutates it. Null content means absent. */
export function snapshotFile(file: string): FileSnapshot {
  try {
    return { path: file, content: readFileSync(file), mode: statSync(file).mode & 0o777 }
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
      return { path: file, content: null, mode: 0o644 }
    }
    throw e
  }
}

/**
 * Restores a snapshot atomically, or removes a file that was absent before.
 *
 * Forces `preserveExistingMode: false` on the `writeAtomic` call. Without
 * that, `writeAtomic` would resolve the mode by stat-ing the file as it
 * currently sits -- during a rollback, that is the MUTATED file, not the
 * snapshot -- so the temp file would be created and renamed at the wrong
 * mode, and only the trailing `chmodSync` would fix it, reopening exactly
 * the "loose for an instant" window `writeAtomic`'s own docblock says is
 * closed. Passing the snapshot's mode straight through, unconditionally,
 * means the restored file is never visible at any mode but the one it is
 * being restored to.
 */
export function restoreFile(snapshot: FileSnapshot): void {
  if (snapshot.content === null) {
    if (existsSync(snapshot.path)) unlinkSync(snapshot.path)
    return
  }
  writeAtomic(snapshot.path, snapshot.content, snapshot.mode, { preserveExistingMode: false })
}

/** Controls the previous launch agent's load state during rollback. Real
 * launchctl calls in production; a test double records calls instead of
 * ever invoking the real binary. */
export interface LaunchAgentController {
  /** True only if `label` is actually loaded right now -- NOT merely
   * whether a plist file for it exists on disk (finding 4). */
  isLoaded(label: string): Promise<boolean>
  /** Stops `label` if loaded. Resolves without error if it was not. */
  bootout(label: string): Promise<void>
  /** Loads the plist at `plistPath` under `label`. */
  bootstrap(label: string, plistPath: string): Promise<void>
}

function uid(): number {
  return process.getuid?.() ?? 501
}

/** The real controller. Never used by a test -- the hard rule for this
 * project is that nothing under test may invoke `launchctl` at all. */
export const systemLaunchAgentController: LaunchAgentController = {
  async isLoaded(label) {
    try {
      await run('/bin/launchctl', ['list', label])
      return true
    } catch {
      return false
    }
  },
  async bootout(label) {
    await run('/bin/launchctl', ['bootout', `gui/${uid()}/${label}`]).catch(() => {
      // Not loaded. Nothing to stop.
    })
  },
  async bootstrap(label, plistPath) {
    await run('/bin/launchctl', ['bootstrap', `gui/${uid()}`, plistPath])
      .catch(() => run('/bin/launchctl', ['load', '-w', plistPath]))
  },
}

export interface InstallOptions {
  /** Defaults to the real paths under `~`. A test injects an isolated set
   * built with `buildPaths`, so nothing it does can touch the real home
   * directory. */
  paths?: Paths
  /** Defaults to `systemLaunchAgentController`. A test injects a double, so
   * nothing it does ever calls the real `launchctl`. */
  controller?: LaunchAgentController
  /** Overrides the compiled entry point used for the build preflight and as
   * the plist's launchd target. Only a test sets this, so the preflight
   * check can run against a small synthetic script instead of depending on
   * the repository's real `dist` build being present and current. */
  script?: string
}

/** The two probe files an earlier version of `verifyWrap` left behind in the
 * LIVE sessions directory (finding I2), because it ran the probe with no
 * `DECKD_STATE_DIR` override at all. Named here once, so both the repair
 * step below and its test refer to the same literal names. */
const STRAY_PROBE_FILES = ['deckd-install-probe.json', 'baseline-probe.json']

export async function install(opts: InstallOptions = {}): Promise<void> {
  const p = opts.paths ?? paths
  const controller = opts.controller ?? systemLaunchAgentController
  enforceDirModes([p.stateDir, p.sessionsDir, p.artDir])

  // I2 repair: earlier versions of the probe below wrote fabricated usage
  // data straight into the live sessions directory, because `verifyWrap` ran
  // with no `DECKD_STATE_DIR` override and fell back to the real one. This
  // removes exactly those two known files, and only those -- never anything
  // else under `~` -- so a user who already installed once is repaired
  // rather than left with permanently fabricated usage on the deck.
  for (const name of STRAY_PROBE_FILES) {
    const stray = join(p.sessionsDir, name)
    try {
      if (existsSync(stray)) unlinkSync(stray)
    } catch {
      // Best-effort repair. A leftover probe file is not worth blocking
      // install over.
    }
  }

  const changed: string[] = []

  // Refuse to run twice. Checked first, before any file is touched, so a
  // repeat run leaves the wrapper copy, the backup, and settings.json alone.
  const settings = readSettingsForInstall(p)
  if (isInstalled(settings)) {
    console.log('deckd is already installed. Run `deckd uninstall` first to redo it.')
    return
  }

  // 1. Copy the wrapper into the state directory, so an uninstalled repo
  //    cannot break the statusline.
  const root = projectRoot()
  if (!root) throw new Error('cannot find the project root. Run install from the repository.')
  const wrapperSrc = join(root, 'src', 'install', 'statusline-wrapper.sh')
  if (!existsSync(wrapperSrc)) {
    throw new Error(`wrapper script missing: ${wrapperSrc}`)
  }
  const wrapperDst = join(p.stateDir, 'statusline-wrapper.sh')
  const backup = `${p.claudeSettings}.deckd-backup`
  const script = opts.script ?? join(root, 'dist', 'bin', 'deckd.js')
  await preflightBuild(script)

  // This is the wrap install actually uses: it points at `wrapperDst`, and
  // it embeds `p.stateDir` -- the real directory this install is targeting
  // -- so the render-time wrapper never has to guess it from an ambient
  // environment variable launchd will not set (finding 11).
  const finalWrap = wrapStatusLine(settings.statusLine, wrapperDst, p.stateDir)

  // Prove the wrap before trusting it. This is the user's live terminal
  // statusline: if the wrapped command produces different output from the
  // original, the wrap is broken and must not be left in place. Feed both a
  // synthetic payload and compare. Throw on any difference, before anything
  // is written.
  //
  // The probe runs against a throwaway temporary directory, never the real
  // state directory (finding I2): the probe's own wrap embeds
  // `probeStateDir` instead of `p.stateDir`, so the fabricated usage and
  // per-session probe files this necessarily writes land somewhere disposed
  // of in the `finally` below, and never anywhere the daemon or the deck
  // will ever read from.
  const probeStateDir = mkdtempSync(join(tmpdir(), 'deckd-install-probe-'))
  let probe: WrapProbe
  try {
    const probeWrap = wrapStatusLine(settings.statusLine, wrapperSrc, probeStateDir)
    probe = await verifyWrap(extractCommand(probeWrap.statusLine), probeWrap.inner)
  } finally {
    rmSync(probeStateDir, { recursive: true, force: true })
  }
  if (!probe.ok) {
    throw new Error(
      'the wrapped statusline did not reproduce the original output, so nothing ' +
        `was changed.\nreason: ${probe.reason}\n` +
        `original output: ${JSON.stringify(probe.before)}\n` +
        `wrapped output:  ${JSON.stringify(probe.after)}`,
    )
  }

  const snapshots = [
    snapshotFile(wrapperDst),
    snapshotFile(backup),
    snapshotFile(p.claudeSettings),
    snapshotFile(p.launchAgent),
  ]

  // Record whether the daemon is actually loaded right now, BEFORE this
  // attempt changes anything (finding 4). A plist file existing on disk is
  // not the same fact -- `docs/DEPLOYMENT.md` has the user run
  // `launchctl bootout` before a hardware check, leaving the plist in place
  // but the agent stopped on purpose. Rollback must restore exactly the
  // state recorded here, not infer one from file presence.
  const wasLoaded = await controller.isLoaded(p.launchAgentLabel)
  // True only once this attempt has actually issued a launchd call. A
  // failure before that point has nothing to roll back on the launchd side,
  // and must not stop -- or start -- anything there.
  let touchedLaunchd = false

  try {
    // 1. Copy the wrapper into the state directory, so removing the repository
    //    later cannot break the statusline.
    copyFileSync(wrapperSrc, wrapperDst)
    chmodSync(wrapperDst, 0o755)
    changed.push(`wrote ${wrapperDst}`)

    // 2. Wrap the statusline, after a backup.
    if (existsSync(p.claudeSettings)) {
      copyFileSync(p.claudeSettings, backup)
      // `copyFileSync` keeps an EXISTING destination's mode (finding 6). A
      // stale backup left at a looser mode by an earlier version, an
      // unzip, or a restore would otherwise receive a fresh copy of a
      // possibly 0600, secrets-bearing settings file and stay loose. Force
      // the backup to the live file's current mode every time.
      chmodSync(backup, statSync(p.claudeSettings).mode & 0o777)
      changed.push(`backed up ${p.claudeSettings} to ${backup}`)
    }
    settings.statusLine = finalWrap.statusLine
    writeAtomic(p.claudeSettings, JSON.stringify(settings, null, 2))
    changed.push(`wrapped statusLine in ${p.claudeSettings}`)

    // 3. Write and load the launchd agent.
    mkdirSync(dirname(p.launchAgent), { recursive: true })
    writeAtomic(
      p.launchAgent,
      buildPlist(p.launchAgentLabel, process.execPath, script, join(p.stateDir, 'launchd.log')),
    )
    changed.push(`wrote ${p.launchAgent}`)

    touchedLaunchd = true
    await controller.bootout(p.launchAgentLabel)
    await controller.bootstrap(p.launchAgentLabel, p.launchAgent)
    changed.push('loaded the launchd agent')
  } catch (e) {
    const rollbackErrors: string[] = []
    if (touchedLaunchd) {
      await controller.bootout(p.launchAgentLabel).catch((stopError: unknown) => {
        rollbackErrors.push(`stop the partially-installed agent: ${String(stopError)}`)
      })
    }
    for (const snapshot of [...snapshots].reverse()) {
      try {
        restoreFile(snapshot)
      } catch (restoreError) {
        rollbackErrors.push(`${snapshot.path}: ${String(restoreError)}`)
      }
    }
    // Restore exactly the load state recorded before this attempt touched
    // anything (finding 4): only if launchd was actually touched, and only
    // if the agent was actually loaded beforehand. A deliberate
    // `launchctl bootout` run in another terminal before a hardware check
    // must not be undone by a failed install here.
    if (touchedLaunchd && wasLoaded) {
      await controller.bootstrap(p.launchAgentLabel, p.launchAgent).catch((restoreError: unknown) => {
        rollbackErrors.push(`reload prior launch agent: ${String(restoreError)}`)
      })
    }
    const detail = rollbackErrors.length
      ? ` Rollback also had errors: ${rollbackErrors.join('; ')}`
      : ' All file changes were rolled back.'
    throw new Error(`${String(e)}${detail}`)
  }

  console.log('deckd installed.\n')
  for (const line of changed) console.log(`  . ${line}`)
  console.log('\nThe deck starts now, and at every login.')
  console.log('macOS may ask to allow automation. Approve it, so window focus works.')
}

export interface RefreshWrapperResult {
  path: string
}

/**
 * Re-copies the wrapper script from the repository into the state directory
 * and re-verifies it, without touching settings.json or launchd (finding
 * 13). `install()` returns early once `isInstalled` is true, so it never
 * re-copies the wrapper once one exists, and the only documented recovery
 * for a drifted wrapper was a full `uninstall` followed by `install` --
 * which is exactly the path C1 lived on. This gives an already-installed
 * user a narrow, safe repair for a wrapper that has drifted from the
 * repository (a hand edit, a partial copy, a bad restore).
 */
export async function refreshWrapper(opts: InstallOptions = {}): Promise<RefreshWrapperResult> {
  const p = opts.paths ?? paths
  const root = projectRoot()
  if (!root) throw new Error('cannot find the project root. Run this from the repository.')
  const wrapperSrc = join(root, 'src', 'install', 'statusline-wrapper.sh')
  if (!existsSync(wrapperSrc)) throw new Error(`wrapper script missing: ${wrapperSrc}`)
  const wrapperDst = join(p.stateDir, 'statusline-wrapper.sh')

  const settings = readSettingsForInstall(p)
  if (!isInstalled(settings)) {
    throw new Error('deckd is not installed. Run `deckd install` first.')
  }

  const probeStateDir = mkdtempSync(join(tmpdir(), 'deckd-refresh-probe-'))
  try {
    const probeWrap = wrapStatusLine(settings.statusLine, wrapperSrc, probeStateDir)
    const probe = await verifyWrap(extractCommand(probeWrap.statusLine), probeWrap.inner)
    if (!probe.ok) {
      throw new Error(
        `the wrapper at ${wrapperSrc} did not reproduce the original output, so nothing ` +
          `was changed.\nreason: ${probe.reason}`,
      )
    }
  } finally {
    rmSync(probeStateDir, { recursive: true, force: true })
  }

  copyFileSync(wrapperSrc, wrapperDst)
  chmodSync(wrapperDst, 0o755)
  return { path: wrapperDst }
}

/** A representative statusline payload, used only to prove the wrap works. */
const PROBE_PAYLOAD = JSON.stringify({
  session_id: 'deckd-install-probe',
  model: { display_name: 'Opus 5' },
  context_window: { used_percentage: 10, total_input_tokens: 1, context_window_size: 2 },
  cost: { total_cost_usd: 0 },
  effort: { level: 'medium' },
  rate_limits: {
    five_hour: { used_percentage: 1, resets_at: 0 },
    seven_day: { used_percentage: 1, resets_at: 0 },
  },
  workspace: { project_dir: '/tmp' },
})

export interface WrapProbe {
  ok: boolean
  reason: string
  before: string
  after: string
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000

/** Distinguishes "the command never exited" from every other failure, so
 * `verifyWrap` can apply a different policy to it (see below). */
class ProbeTimeoutError extends Error {}

/** Distinguishes a clean, fast, nonzero exit from every other kind of
 * failure (a timeout, a spawn error), so `verifyWrap` can tell "the original
 * and the wrapped command failed the same way" from "the wrapper introduced
 * a different failure" (finding 3). */
class ProbeExitError extends Error {
  constructor(public readonly code: number | null, stderr: string) {
    super(`exit ${String(code)}: ${stderr}`)
    this.name = 'ProbeExitError'
  }
}

/**
 * Runs one shell command, feeding it `input` on stdin and collecting stdout.
 *
 * This does NOT use `promisify(execFile)` with an `input` option. That option
 * only exists on the synchronous `execFileSync`/`spawnSync`; the async
 * `execFile` silently ignores it. A probe command that reads stdin to
 * completion, such as `cat >/dev/null; ...`, would then block forever on a
 * pipe nothing ever closes. `spawn` writes the payload and ends stdin itself,
 * so the child always sees an EOF.
 *
 * That alone bounds a command that reads its input and then exits. It does
 * NOT bound a command that never exits at all -- an infinite loop, or a
 * network call that never returns -- so this also enforces `timeoutMs`,
 * killing the child and rejecting with `ProbeTimeoutError` if it fires.
 */
function runWithStdin(cmd: string, input: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!cmd) {
      resolve('')
      return
    }
    const child = spawn('/bin/sh', ['-c', cmd])
    let out = ''
    let err = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new ProbeTimeoutError(`timed out after ${timeoutMs}ms running: ${cmd}`))
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => { out += d })
    child.stderr.on('data', (d: Buffer) => { err += d })
    // A child that exits before it reads stdin -- e.g. `exit 3` with a
    // payload still queued -- makes this write emit EPIPE. The 'close'
    // handler below still reports the real outcome, so this only needs to
    // stop the unhandled error from crashing the process.
    child.stdin.on('error', () => {})
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) reject(new ProbeExitError(code, err))
      else resolve(out)
    })
    child.stdin.write(input)
    child.stdin.end()
  })
}

/**
 * Runs the original statusline command and the wrapped one with the same
 * payload, then compares their output. The wrapper must be transparent, so any
 * difference means the wrap is broken and install must not proceed.
 *
 * Both run through `sh -c`, which is how Claude Code runs a statusline command.
 *
 * `timeoutMs` defaults to 10 seconds -- generous, since a statusline runs on
 * every render and anything slower is already broken -- but is a parameter so
 * a test can inject a short one instead of actually waiting.
 *
 * Timeout policy is deliberately NOT the same as the "original already
 * fails" rule below, and that asymmetry is the point, not an oversight: a
 * command that HANGS cannot be compared at all -- there is no output to diff
 * against, and the wrapped form would hang for the identical reason, since it
 * runs the same inner command at the end -- so a timeout on EITHER side means
 * `ok: false` immediately, without bothering to run the other side too.
 *
 * A command that FAILS FAST, by contrast, is not skipped on either side
 * (finding 3, fixed here): the ORIGINAL failing fast used to make this return
 * `ok: true` without ever running the WRAPPED command, on the theory that
 * "wrapping a failing command changes nothing" -- true for the comparison,
 * false for the wrapper's own failure modes, which that branch never
 * exercised. Now both sides always run when the failure is not a timeout,
 * and the two outcomes are compared:
 *
 *   - Both fail, with the SAME exit code: the wrapper faithfully reproduced
 *     the original's own failure. That is the user's business, not the
 *     wrapper's, so this is `ok: true`.
 *   - Both fail, but DIFFERENTLY (or only the wrapped side fails): the
 *     wrapper itself may be broken -- non-executable, a syntax error, wrong
 *     permissions -- and none of that is safe to install unverified. `ok:
 *     false`.
 *   - The original fails but the wrapped side runs to completion anyway:
 *     the wrapper mechanism works. `ok: true`.
 */
export async function verifyWrap(
  wrapped: string,
  inner: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<WrapProbe> {
  const runProbe = (cmd: string): Promise<string> => runWithStdin(cmd, PROBE_PAYLOAD, timeoutMs)

  let before = ''
  let after = ''
  let innerError: unknown

  try {
    before = await runProbe(inner)
  } catch (e) {
    if (e instanceof ProbeTimeoutError) {
      return {
        ok: false,
        reason:
          `the original command did not finish within ${timeoutMs}ms, so the wrap could ` +
          `not be verified: ${e.message}`,
        before,
        after,
      }
    }
    // The original command failed, quickly. Do not return yet: the wrapped
    // form still has to run, on its own, before install can trust it.
    innerError = e
  }

  try {
    after = await runProbe(wrapped)
  } catch (e) {
    if (e instanceof ProbeTimeoutError) {
      return { ok: false, reason: `wrapped command timed out: ${e.message}`, before, after }
    }
    if (innerError instanceof ProbeExitError && e instanceof ProbeExitError && innerError.code === e.code) {
      return {
        ok: true,
        reason: `original command failed (exit ${String(e.code)}); the wrapper reproduced the same failure`,
        before,
        after,
      }
    }
    if (innerError !== undefined) {
      return {
        ok: false,
        reason:
          `the original command failed (${String(innerError)}) and the wrapped command failed ` +
          `differently (${String(e)}); the wrapper itself may be broken`,
        before,
        after,
      }
    }
    return { ok: false, reason: `wrapped command failed: ${String(e)}`, before, after }
  }

  if (innerError !== undefined) {
    // The original failed, but the wrapper ran to completion anyway. The
    // wrapper mechanism works; wrapping it changes nothing about the
    // original's own failure.
    return { ok: true, reason: `original command failed: ${String(innerError)}`, before, after }
  }

  if (before !== after) {
    return { ok: false, reason: 'output differs', before, after }
  }
  return { ok: true, reason: 'identical output', before, after }
}

/**
 * Proves the compiled entry point actually loads, not merely that the file
 * exists (finding 12). `existsSync` alone passes for a `dist` that throws at
 * import time; launchd's `KeepAlive` then restarts the crashing process
 * forever while the deck stays dark, and rollback never triggers, because
 * `bootstrap` itself returned 0.
 *
 * Running `node <script>` with no subcommand is safe to do here: `bin/deckd.ts`'s
 * own dispatch prints a usage line and exits 2 for that case, WITHOUT opening
 * the Stream Deck or touching launchd -- both only happen after a real
 * `start` argument reaches it. Any other outcome -- a different exit code, a
 * hang, an uncaught import-time exception (which Node reports as exit 1) --
 * means the build itself is broken, and install must not proceed.
 */
export async function preflightBuild(script: string, timeoutMs = 10_000): Promise<void> {
  if (!existsSync(script)) {
    throw new Error(`build first: ${script} does not exist. Run npm run build.`)
  }
  let exitedZero = false
  try {
    await run(process.execPath, [script], { timeout: timeoutMs })
    exitedZero = true
  } catch (e) {
    const code = (e as { code?: unknown }).code
    if (code === 2) return
    throw new Error(
      `build preflight failed: running ${script} with no arguments should print usage and ` +
        `exit 2, but it did not: ${String(e)}. The build may be broken.`,
    )
  }
  if (exitedZero) {
    throw new Error(
      `build preflight failed: running ${script} with no arguments exited 0; expected the ` +
        'usage message and exit code 2. The build may be broken.',
    )
  }
}

/**
 * Describes what `uninstall` actually did with the recovered statusLine
 * value, for the printed summary. A separate, exported function so a test
 * can check the wording directly against a synthetic `RecoverResult`,
 * without running the whole of `uninstall()`, which defaults to the real
 * `paths.claudeSettings`.
 *
 * `recoverStatusLine` can report `source: 'backup'` or `'embedded'` while
 * still giving back `statusLine: undefined` -- both sources can recover a
 * legitimately empty original, e.g. because install ran when statusLine was
 * already absent. That case is a deletion, not a restoration, and the
 * summary must say so plainly rather than claiming a restore that did not
 * happen.
 */
export function describeStatusLineOutcome(recovered: RecoverResult, settingsPath: string): string {
  if (recovered.source === 'none') {
    return `left statusLine absent in ${settingsPath} (original unrecoverable, see warning above)`
  }
  if (recovered.statusLine === undefined) {
    return `deleted statusLine in ${settingsPath} (the recovered original was empty)`
  }
  return recovered.source === 'backup'
    ? `restored statusLine in ${settingsPath} from the backup`
    : `restored statusLine in ${settingsPath}`
}

export interface UninstallOptions {
  /** Defaults to the real paths under `~`. A test injects an isolated set
   * built with `buildPaths`, so nothing it does can touch the real home
   * directory. */
  paths?: Paths
  /** Defaults to `systemLaunchAgentController`. A test injects a double, so
   * nothing it does ever calls the real `launchctl`. */
  controller?: LaunchAgentController
}

export async function uninstall(opts: UninstallOptions = {}): Promise<void> {
  const p = opts.paths ?? paths
  const controller = opts.controller ?? systemLaunchAgentController
  const removed: string[] = []

  // C1: refuse outright when settings.json will not parse, BEFORE touching
  // launchd, the plist, or anything else. The old lenient reader returned
  // {} on any parse error, which skipped the unwrap below but let execution
  // reach the wrapper delete anyway -- stranding a live reference to a file
  // about to be removed, with no deckd command left able to fix it. Doing
  // this read first, as a pure read with no side effect, means a settings
  // file this cannot parse leaves every file and every launchd state
  // completely untouched.
  const settings = readSettingsForUninstall(p)

  await controller.bootout(p.launchAgentLabel)
  if (existsSync(p.launchAgent)) {
    unlinkSync(p.launchAgent)
    removed.push(`removed ${p.launchAgent}`)
  }

  if (isInstalled(settings)) {
    const backupPath = `${p.claudeSettings}.deckd-backup`
    const recovered = recoverStatusLine(settings.statusLine, backupPath)
    if (recovered.warning) console.warn(recovered.warning)
    if (recovered.statusLine === undefined) delete settings.statusLine
    else settings.statusLine = recovered.statusLine
    writeAtomic(p.claudeSettings, JSON.stringify(settings, null, 2))
    removed.push(describeStatusLineOutcome(recovered, p.claudeSettings))

    // Verify the unwrap actually landed on disk before deleting the file
    // the old command pointed at. This is the exact ordering C1 found
    // missing: unwrap, verify the unwrap, and only THEN delete -- never
    // delete first, and never delete on the strength of an assumption that
    // the write above worked.
    if (isInstalled(readSettingsForUninstall(p))) {
      throw new Error(
        `${p.claudeSettings} still references the deckd wrapper after writing the unwrap. ` +
          'Refusing to delete the wrapper script, so nothing is stranded. Check the file by ' +
          'hand, then run `deckd uninstall` again.',
      )
    }
  }

  const wrapper = join(p.stateDir, 'statusline-wrapper.sh')
  if (existsSync(wrapper)) {
    unlinkSync(wrapper)
    removed.push(`removed ${wrapper}`)
  }

  // Finding 6: deckd made this backup; deckd removes it. Leaving it behind
  // forever meant a secrets-bearing duplicate of settings.json persisted
  // indefinitely with no cleanup path at all.
  const backupPath = `${p.claudeSettings}.deckd-backup`
  if (existsSync(backupPath)) {
    unlinkSync(backupPath)
    removed.push(`removed ${backupPath}`)
  }

  console.log('deckd uninstalled.\n')
  for (const line of removed) console.log(`  . ${line}`)
  console.log(`\nThe state directory remains: ${p.stateDir}`)
  console.log('It holds your Spotify token. Delete it by hand if you want it gone.')
}

/** Install must not replace an unreadable settings file with an empty object. */
function readSettingsForInstall(p: Paths): Record<string, unknown> {
  if (!existsSync(p.claudeSettings)) return {}
  return parseSettingsObject(readFileSync(p.claudeSettings, 'utf8'), p.claudeSettings, 'install')
}

/**
 * Uninstall must not delete the wrapper it cannot prove nothing still
 * references (C1). Where `readSettingsForInstall` can just let its generic
 * parse error propagate -- an install that never started needs no special
 * recovery advice -- an uninstall failing here can leave a user with a
 * broken statusline and no other deckd command able to help, so the thrown
 * message says exactly what is wrong and exactly what to do about it.
 */
function readSettingsForUninstall(p: Paths): Record<string, unknown> {
  if (!existsSync(p.claudeSettings)) return {}
  try {
    return parseSettingsObject(readFileSync(p.claudeSettings, 'utf8'), p.claudeSettings, 'uninstall')
  } catch (e) {
    const backupPath = `${p.claudeSettings}.deckd-backup`
    const repair = existsSync(backupPath)
      ? `A pre-install backup exists at ${backupPath}. Fix the syntax error in ` +
        `${p.claudeSettings} by hand (or restore it from that backup), then run ` +
        "'deckd uninstall' again."
      : `Fix the syntax error in ${p.claudeSettings} by hand, then run 'deckd uninstall' ` +
        'again. No pre-install backup was found to fall back to.'
    throw new Error(`${String(e)} ${repair}`)
  }
}

/** Parses settings without allowing install or uninstall to erase malformed
 * content. `action` only changes the wording of the thrown message. */
export function parseSettingsObject(
  text: string,
  file: string,
  action: 'install' | 'uninstall' = 'install',
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`cannot parse ${file}; no ${action} changes were made: ${String(e)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object; no ${action} changes were made.`)
  }
  return parsed as Record<string, unknown>
}
