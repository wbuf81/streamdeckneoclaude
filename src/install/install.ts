import {
  readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync,
  existsSync, chmodSync, mkdirSync, statSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { paths, ensureStateDir } from '../paths.js'

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
 * `verifyWrap` still proves the wrap end to end before `install` trusts it.
 */
export function wrapStatusLine(current: unknown, wrapperPath: string): WrapResult {
  const inner = extractCommand(current)
  const encoded = JSON.stringify({ original: current ?? null })
  const command = `DECKD_INNER=${shellQuote(inner)} ${shellQuote(wrapperPath)} ${WRAPPER_MARKER} ${encoded}`

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
 * The temp file is always newly created, so `mode` does apply to it -- but
 * `renameSync` then makes that temp file BECOME `file`, and the temp file's
 * mode is not necessarily the mode `file` already had. A target that
 * existed with a tighter mode (a token file at 0600, say) would otherwise
 * silently loosen to `mode`'s default of 0644 the next time something
 * wrote through this function. So the target's own mode, when it already
 * exists, is preserved with an unconditional `chmodSync` after the rename --
 * `mode` only decides the mode for a file that does not exist yet.
 *
 * Exported so a test can drive it directly against a temporary file,
 * without going through `install()`/`uninstall()`, which hard-code the
 * real paths under `~` and must never run in a test.
 */
export function writeAtomic(file: string, content: string, mode = 0o644): void {
  const tmp = `${file}.${process.pid}.tmp`
  let existingMode: number | null = null
  try {
    existingMode = statSync(file).mode & 0o777
  } catch {
    // The target does not exist yet. Nothing to preserve.
  }
  writeFileSync(tmp, content, { mode })
  renameSync(tmp, file)
  if (existingMode !== null) chmodSync(file, existingMode)
}

export async function install(): Promise<void> {
  ensureStateDir()
  const changed: string[] = []

  // Refuse to run twice. Checked first, before any file is touched, so a
  // repeat run leaves the wrapper copy, the backup, and settings.json alone.
  const settings = readSettings()
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
  const wrapperDst = join(paths.stateDir, 'statusline-wrapper.sh')
  copyFileSync(wrapperSrc, wrapperDst)
  chmodSync(wrapperDst, 0o755)
  changed.push(`wrote ${wrapperDst}`)

  // 2. Wrap the statusline, after a backup.
  const backup = `${paths.claudeSettings}.deckd-backup`
  if (existsSync(paths.claudeSettings)) {
    copyFileSync(paths.claudeSettings, backup)
    changed.push(`backed up ${paths.claudeSettings} to ${backup}`)
  }
  const { statusLine, inner } = wrapStatusLine(settings.statusLine, wrapperDst)

  // Prove the wrap before trusting it. This is the user's live terminal
  // statusline: if the wrapped command produces different output from the
  // original, the wrap is broken and must not be left in place. Feed both a
  // synthetic payload and compare. Throw on any difference, before anything
  // is written.
  const probe = await verifyWrap(extractCommand(statusLine), inner)
  if (!probe.ok) {
    throw new Error(
      'the wrapped statusline did not reproduce the original output, so nothing ' +
        `was changed.\nreason: ${probe.reason}\n` +
        `original output: ${JSON.stringify(probe.before)}\n` +
        `wrapped output:  ${JSON.stringify(probe.after)}`,
    )
  }

  settings.statusLine = statusLine
  writeAtomic(paths.claudeSettings, JSON.stringify(settings, null, 2))
  changed.push(`wrapped statusLine in ${paths.claudeSettings}`)

  // 3. Write and load the launchd agent.
  const script = join(root, 'dist', 'bin', 'deckd.js')
  if (!existsSync(script)) {
    throw new Error(`build first: ${script} does not exist. Run npm run build.`)
  }
  mkdirSync(dirname(paths.launchAgent), { recursive: true })
  writeAtomic(
    paths.launchAgent,
    buildPlist(paths.launchAgentLabel, process.execPath, script, join(paths.stateDir, 'launchd.log')),
  )
  changed.push(`wrote ${paths.launchAgent}`)
  await bootout()
  await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, paths.launchAgent])
    .catch(() => run('/bin/launchctl', ['load', '-w', paths.launchAgent]))
  changed.push('loaded the launchd agent')

  console.log('deckd installed.\n')
  for (const line of changed) console.log(`  . ${line}`)
  console.log('\nThe deck starts now, and at every login.')
  console.log('macOS may ask to allow automation. Approve it, so window focus works.')
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
      if (code !== 0) reject(new Error(`exit ${String(code)}: ${err}`))
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
 * Timeout policy is deliberately NOT the same as the existing "original
 * already fails" rule, and that asymmetry is the point, not an oversight:
 *
 *   - A command that FAILS FAST is fine to wrap. Wrapping does not make it
 *     worse, and the fast failure is itself the comparison result.
 *   - A command that HANGS cannot be compared at all -- there is no output to
 *     diff against -- so proceeding would mean installing unverified, which
 *     defeats the reason `verifyWrap` exists. So a timeout on EITHER side
 *     means `ok: false`, even when it is the original that hung. Do not
 *     "simplify" this into reusing the already-failing-original branch.
 */
export async function verifyWrap(
  wrapped: string,
  inner: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<WrapProbe> {
  const runProbe = (cmd: string): Promise<string> => runWithStdin(cmd, PROBE_PAYLOAD, timeoutMs)

  let before = ''
  let after = ''
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
    // The ORIGINAL command already fails, quickly. That is not ours to fix,
    // and wrapping it changes nothing, so allow the install to continue.
    return { ok: true, reason: `original command failed: ${String(e)}`, before, after }
  }
  try {
    after = await runProbe(wrapped)
  } catch (e) {
    if (e instanceof ProbeTimeoutError) {
      return { ok: false, reason: `wrapped command timed out: ${e.message}`, before, after }
    }
    return { ok: false, reason: `wrapped command failed: ${String(e)}`, before, after }
  }

  if (before !== after) {
    return { ok: false, reason: 'output differs', before, after }
  }
  return { ok: true, reason: 'identical output', before, after }
}

/**
 * Describes what `uninstall` actually did with the recovered statusLine
 * value, for the printed summary. A separate, exported function so a test
 * can check the wording directly against a synthetic `RecoverResult`,
 * without running the whole of `uninstall()`, which hard-codes the real
 * `paths.claudeSettings` and must never run in a test.
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

export async function uninstall(): Promise<void> {
  const removed: string[] = []

  await bootout()
  if (existsSync(paths.launchAgent)) {
    unlinkSync(paths.launchAgent)
    removed.push(`removed ${paths.launchAgent}`)
  }

  const settings = readSettings()
  if (isInstalled(settings)) {
    const backupPath = `${paths.claudeSettings}.deckd-backup`
    const recovered = recoverStatusLine(settings.statusLine, backupPath)
    if (recovered.warning) console.warn(recovered.warning)
    if (recovered.statusLine === undefined) delete settings.statusLine
    else settings.statusLine = recovered.statusLine
    writeAtomic(paths.claudeSettings, JSON.stringify(settings, null, 2))
    removed.push(describeStatusLineOutcome(recovered, paths.claudeSettings))
  }

  const wrapper = join(paths.stateDir, 'statusline-wrapper.sh')
  if (existsSync(wrapper)) {
    unlinkSync(wrapper)
    removed.push(`removed ${wrapper}`)
  }

  console.log('deckd uninstalled.\n')
  for (const line of removed) console.log(`  . ${line}`)
  console.log(`\nThe state directory remains: ${paths.stateDir}`)
  console.log('It holds your Spotify token. Delete it by hand if you want it gone.')
}

async function bootout(): Promise<void> {
  const uid = process.getuid?.() ?? 501
  await run('/bin/launchctl', ['bootout', `gui/${uid}/${paths.launchAgentLabel}`]).catch(() => {
    // Not loaded. Nothing to stop.
  })
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(paths.claudeSettings, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
