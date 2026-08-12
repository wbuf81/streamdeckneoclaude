import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log, type Logger } from './log.js'

const run = promisify(execFile)

/** The shape of `run`. A test injects a fake to avoid shelling out. */
type Runner = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>

/** Depth cap for the process walk. A broken tree must not loop. */
export const MAX_WALK = 12

const APPS: Record<string, string> = {
  ghostty: 'Ghostty',
  'iterm.app': 'iTerm2',
  iterm2: 'iTerm2',
  apple_terminal: 'Terminal',
  terminal: 'Terminal',
  wezterm: 'WezTerm',
  alacritty: 'Alacritty',
  kitty: 'kitty',
  vscode: 'Code',
  hyper: 'Hyper',
  warpterminal: 'Warp',
  tmux: 'Terminal',
}

/** Maps a `TERM_PROGRAM` value to a macOS application name. */
export function terminalAppName(termProgram: string): string | null {
  if (!termProgram) return null
  return APPS[termProgram.toLowerCase()] ?? null
}

/**
 * Builds the AppleScript that raises an application. It refuses a name with a
 * double quote, because that would let the name escape the string literal.
 */
export function buildFocusScript(app: string): string {
  if (app.includes('"') || app.includes('\\')) {
    throw new Error(`application name contains a quote: ${app}`)
  }
  return `tell application "${app}" to activate`
}

/**
 * Walks up the process tree from `pid`. It stops below `launchd`, which is pid
 * 1, and it stops at the depth cap.
 */
export function findTerminalPid(
  pid: number,
  readParent: (pid: number) => number | null,
): number {
  let current = pid
  for (let i = 0; i < MAX_WALK; i++) {
    const parent = readParent(current)
    if (parent === null || parent <= 1) return current
    if (parent === current) return current
    current = parent
  }
  return current
}

/** Reads a parent pid with `ps`. Returns null when the process is gone. */
export async function readParentPid(pid: number): Promise<number | null> {
  try {
    const { stdout } = await run('/bin/ps', ['-o', 'ppid=', '-p', String(pid)])
    const n = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * Raises the terminal window of a session. It returns false on any failure, and
 * the caller flashes the key red. A failure is never fatal.
 *
 * `runner` and `logger` default to the real `osascript` call and the shared
 * `log`. A test overrides both, so it can inject a failure and capture the
 * log lines without shelling out or raising a window. Later callers use the
 * two-argument form.
 */
export async function focusWindow(
  pid: number,
  termProgram: string,
  runner: Runner = run,
  logger: Logger = log,
): Promise<boolean> {
  const app = terminalAppName(termProgram)
  if (!app) {
    logger.once(`term-${termProgram}`, `no window focus rule for terminal "${termProgram}"`)
    return false
  }
  try {
    await runner('/usr/bin/osascript', ['-e', buildFocusScript(app)])
    // A later success after a failure should log again if it fails once more.
    logger.clearOnce(`focus-${app}`)
    return true
  } catch (e) {
    // `log.once`, not `log.warn`. A user who presses the same key while macOS
    // denies automation would otherwise write one line per press, without a
    // limit. The key clears on the next success.
    logger.once(`focus-${app}`, `window focus failed for ${app} pid ${pid}: ${String(e)}`)
    return false
  }
}
