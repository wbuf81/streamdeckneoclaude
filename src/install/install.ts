import {
  readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync,
  existsSync, chmodSync, mkdirSync,
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
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
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

/** Recovers the original statusline from a wrapped one. */
export function unwrapStatusLine(current: unknown): unknown {
  const command = extractCommand(current)
  const at = command.indexOf(WRAPPER_MARKER)
  if (at === -1) return current
  try {
    const blob = command.slice(at + WRAPPER_MARKER.length).trim()
    const parsed = JSON.parse(blob) as { original: unknown }
    return parsed.original ?? undefined
  } catch {
    return undefined
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

/** Writes a file through a temporary name, so a crash cannot truncate it. */
function writeAtomic(file: string, content: string, mode = 0o644): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content, { mode })
  renameSync(tmp, file)
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

/**
 * Runs one shell command, feeding it `input` on stdin and collecting stdout.
 *
 * This does NOT use `promisify(execFile)` with an `input` option. That option
 * only exists on the synchronous `execFileSync`/`spawnSync`; the async
 * `execFile` silently ignores it. A probe command that reads stdin to
 * completion, such as `cat >/dev/null; ...`, would then block forever on a
 * pipe nothing ever closes. `spawn` writes the payload and ends stdin itself,
 * so the child always sees an EOF.
 */
function runWithStdin(cmd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!cmd) {
      resolve('')
      return
    }
    const child = spawn('/bin/sh', ['-c', cmd])
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => { out += d })
    child.stderr.on('data', (d: Buffer) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => {
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
 */
export async function verifyWrap(wrapped: string, inner: string): Promise<WrapProbe> {
  const runProbe = (cmd: string): Promise<string> => runWithStdin(cmd, PROBE_PAYLOAD)

  let before = ''
  let after = ''
  try {
    before = await runProbe(inner)
  } catch (e) {
    // The ORIGINAL command already fails. That is not ours to fix, and wrapping
    // it changes nothing, so allow the install to continue.
    return { ok: true, reason: `original command failed: ${String(e)}`, before, after }
  }
  try {
    after = await runProbe(wrapped)
  } catch (e) {
    return { ok: false, reason: `wrapped command failed: ${String(e)}`, before, after }
  }

  if (before !== after) {
    return { ok: false, reason: 'output differs', before, after }
  }
  return { ok: true, reason: 'identical output', before, after }
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
    const original = unwrapStatusLine(settings.statusLine)
    if (original === undefined) delete settings.statusLine
    else settings.statusLine = original
    writeAtomic(paths.claudeSettings, JSON.stringify(settings, null, 2))
    removed.push(`restored statusLine in ${paths.claudeSettings}`)
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
