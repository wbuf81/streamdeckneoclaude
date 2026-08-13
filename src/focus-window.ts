import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import { log, type Logger } from './log.js'

const run = promisify(execFile)

/** The shape of `run`. A test injects a fake to avoid shelling out. */
type Runner = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>

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
 * True when `s` holds a character that could break out of an AppleScript
 * string literal. Both application names and window titles are checked with
 * this, and either kind, if unsafe, is rejected outright rather than
 * escaped — escaping a title we did not generate ourselves is a bigger
 * attack surface than just refusing it.
 */
function hasUnsafeQuote(s: string): boolean {
  return s.includes('"') || s.includes('\\')
}

/**
 * Builds the AppleScript that raises an application. It refuses a name with a
 * double quote or backslash, because that would let the name escape the
 * string literal.
 */
export function buildFocusScript(app: string): string {
  if (hasUnsafeQuote(app)) {
    throw new Error(`application name contains a quote: ${app}`)
  }
  return `tell application "${app}" to activate`
}

/**
 * Builds the AppleScript that lists the window titles of `app`'s process via
 * System Events. This is the call `docs/VERIFIED-FACTS.md` measured failing
 * with macOS error -1728 when Accessibility permission is not granted —
 * Automation permission (the one `buildFocusScript` needs) is not enough
 * here, because listing individual windows requires reading the accessibility
 * tree, not just the app-level activate.
 */
export function buildListWindowsScript(app: string): string {
  if (hasUnsafeQuote(app)) {
    throw new Error(`application name contains a quote: ${app}`)
  }
  return [
    'tell application "System Events"',
    '  set titles to {}',
    `  repeat with w in windows of process "${app}"`,
    '    set end of titles to name of w',
    '  end repeat',
    "  set AppleScript's text item delimiters to linefeed",
    '  return titles as text',
    'end tell',
  ].join('\n')
}

/**
 * Parses the newline-joined text `buildListWindowsScript` returns. Blank
 * output (no windows, or the app is not running) yields an empty list rather
 * than a list holding one blank title.
 */
export function parseWindowTitles(stdout: string): string[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  return trimmed.split('\n').map((t) => t.trim())
}

/**
 * A leading spinner glyph, plus the whitespace after it. Ghostty (and other
 * terminals showing a busy indicator) prefix the title with a character from
 * the Braille Patterns block (U+2800 to U+28FF) while a command runs, and
 * that glyph animates — measured live: `"⠐ Build Elgato Stream Deck custom
 * control software"`. Comparing the raw title would make the match unstable
 * from press to press as the glyph cycles, and would stop an exact-feeling
 * prefix match from ever lining up. This is stripped only for scoring; the
 * raise script still uses the exact title `buildListWindowsScript` returned,
 * because that is what the window's real name property holds.
 */
const SPINNER_PREFIX = /^[⠀-⣿\s]+/

function normalizeTitle(title: string): string {
  return title.replace(SPINNER_PREFIX, '').trim()
}

/**
 * A candidate shorter than this cannot be trusted as a match signal — a one-
 * or two-character candidate matches almost any title by luck. Verified live:
 * `pickWindowIndex(['Investigate flaky CI'], ['a', '/x/a', 'proj'])` used to
 * return `0` — the `a` inside "flaky" matched. A short cwd basename (a
 * session in `~/w` or `~/ai`) hit the same bug. Dropping it below this length
 * still leaves the full cwd path and the project name as candidates, so a
 * short basename alone giving up its vote is not a regression.
 */
export const MIN_CANDIDATE_LENGTH = 3

/**
 * Sentinel values a source substitutes for a field it could not read.
 * `src/sources/claude.ts` passes `—` for `project` when a session file omits
 * it. A placeholder carries no real match signal and must never enter
 * scoring — checked by value, not just by length, so it stays excluded even
 * if `MIN_CANDIDATE_LENGTH` ever changes. Verified live:
 * `pickWindowIndex(['nvim', '~/unrelated-dir — zsh'], ['foo', '/Users/x/foo', '—'])`
 * used to return `1`, raising a window that belongs to a different directory.
 */
const PLACEHOLDER_CANDIDATES = new Set(['—'])

/** A title must match at least this well before `pickWindowIndex` will raise
 * it, rather than falling back to app-level `activate`. Named explicitly, so
 * the rule is "requires a minimum score" rather than merely "score is not
 * exactly zero". */
const MIN_SCORE = 1

/**
 * Scores each title against `candidates` — normally the session's cwd
 * basename, its full path, and its project name — and picks the single best
 * match. Measured live: a Claude Code session's Ghostty title is a task
 * summary the agent writes (`"Build Elgato Stream Deck custom control
 * software"`), which shares no substring with the cwd, so basename alone
 * scores zero for exactly the case this feature exists for. Checking several
 * candidates still lets a plain shell window win on its cwd, while giving a
 * Claude Code window a chance to win on its project name.
 *
 * Candidates shorter than `MIN_CANDIDATE_LENGTH`, and any known placeholder
 * sentinel, are dropped before scoring — neither carries a real match signal,
 * and either one can turn an unrelated title into a false match.
 *
 * Never guesses: this never returns "the closest of the bad options" or a
 * first-window default. It returns `null` — meaning "fall back to app-level
 * activate", today's behaviour — when: nothing scores at or above
 * `MIN_SCORE`; the top score is tied between two or more windows, which is
 * ambiguous rather than a real answer; or every positively-scoring title is
 * unsafe (contains a quote or backslash) and so can never be used in
 * `buildRaiseWindowScript` — an unsafe title is treated the same as no match
 * at all, never escaped.
 */
export function pickWindowIndex(titles: string[], candidates: readonly string[]): number | null {
  const wanted = candidates
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length >= MIN_CANDIDATE_LENGTH && !PLACEHOLDER_CANDIDATES.has(c))
  if (wanted.length === 0) return null

  let bestIndex: number | null = null
  let bestScore = 0
  let tied = false

  titles.forEach((rawTitle, i) => {
    if (hasUnsafeQuote(rawTitle)) return // never selectable, regardless of score
    const title = normalizeTitle(rawTitle).toLowerCase()
    // Counts how many candidates match, not just whether one does, so a
    // title matching both the cwd and the project outranks one matching
    // only the project — more agreement is a stronger signal.
    const score = wanted.reduce((acc, w) => acc + (title.includes(w) ? 1 : 0), 0)
    if (score < MIN_SCORE) return
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
      tied = false
    } else if (score === bestScore) {
      tied = true
    }
  })

  return tied ? null : bestIndex
}

/**
 * Builds the AppleScript that raises one specific window by title and brings
 * its process frontmost. `title` is expected to already be vetted by
 * `pickWindowIndex`, but this function re-checks anyway — a function this
 * close to shelling out must not trust its caller.
 */
export function buildRaiseWindowScript(app: string, title: string): string {
  if (hasUnsafeQuote(app)) {
    throw new Error(`application name contains a quote: ${app}`)
  }
  if (hasUnsafeQuote(title)) {
    throw new Error(`window title contains a quote: ${title}`)
  }
  return [
    'tell application "System Events"',
    `  tell process "${app}"`,
    '    set frontmost to true',
    `    perform action "AXRaise" of window "${title}"`,
    '  end tell',
    'end tell',
  ].join('\n')
}

/**
 * True when the error text carries macOS error -1728, "not allowed
 * assistive access" — the specific signature of missing Accessibility
 * permission, measured in `docs/VERIFIED-FACTS.md`. Distinguishing this from
 * any other AppleScript failure lets the caller log a message the user can
 * act on, instead of a generic failure they cannot.
 */
function isAccessibilityDenied(e: unknown): boolean {
  const stderr = e && typeof e === 'object' && 'stderr' in e ? String((e as { stderr: unknown }).stderr) : ''
  const message = e instanceof Error ? e.message : String(e)
  return message.includes('-1728') || stderr.includes('-1728')
}

/**
 * Tries to raise the specific window whose title best matches the session.
 * Returns false — never throws — when Accessibility is not granted, when no
 * window scores above the threshold, or on any other error; `focusWindow`
 * then falls back to the app-level `activate` it already had.
 */
async function tryFocusWindow(
  app: string,
  cwd: string,
  project: string,
  runner: Runner,
  logger: Logger,
): Promise<boolean> {
  let titles: string[]
  try {
    const { stdout } = await runner('/usr/bin/osascript', ['-e', buildListWindowsScript(app)])
    titles = parseWindowTitles(stdout)
  } catch (e) {
    if (isAccessibilityDenied(e)) {
      // Never retried: this cannot succeed until a human grants Accessibility
      // in System Settings, so a loop of retries would only be noise.
      // `log.once`, not `log.warn` — a key repeats on every press.
      logger.once(
        `accessibility-${app}`,
        `window focus for ${app} needs Accessibility permission (macOS -1728 ` +
          `"not allowed assistive access"); grant it to ${process.execPath} in ` +
          'System Settings > Privacy & Security > Accessibility. Falling back to ' +
          'app-level activate meanwhile, so a press still raises the app.',
      )
    }
    return false
  }

  // Listing just succeeded, so Accessibility is granted right now. Clear any
  // earlier denial here, not only after a later successful raise below — a
  // granted-but-no-match outcome (the very next block) must not leave a
  // later, genuine denial suppressed forever.
  logger.clearOnce(`accessibility-${app}`)

  const matchKey = `nomatch-${app}-${cwd}`
  let index: number | null
  try {
    // `basename` throws on a non-string input, and `pickWindowIndex` is a
    // plain function this code does not fully control the future shape of.
    // `focusWindow` promises never to throw, so this stays inside its own
    // try even though no live caller can reach a throwing input today —
    // `ClaudeSource` always coerces `cwd` and `project` to strings first.
    index = pickWindowIndex(titles, [basename(cwd), cwd, project])
  } catch {
    return false
  }
  if (index === null) {
    // Named so this is diagnosable later: which titles existed, and what the
    // session wanted matched against them. A plain shell window usually
    // carries its cwd in the title and wins here; a Claude Code window's
    // title is a task summary the agent wrote, which often shares no
    // substring with the cwd at all — this is the case that log line is for.
    logger.once(
      matchKey,
      `no ${app} window title matched cwd "${cwd}" or project "${project}"; ` +
        `saw: ${titles.length ? titles.map((t) => JSON.stringify(t)).join(', ') : '(no windows)'}`,
    )
    return false
  }
  const title = titles[index]
  if (title === undefined) return false

  try {
    await runner('/usr/bin/osascript', ['-e', buildRaiseWindowScript(app, title)])
    logger.clearOnce(matchKey)
    return true
  } catch {
    return false
  }
}

/**
 * Raises the terminal window of a session. It returns false on any failure, and
 * the caller flashes the key red. A failure is never fatal.
 *
 * It first tries to raise the specific window whose title best matches the
 * session's cwd or project — plain app-level `activate` is a no-op when the
 * app is already frontmost, so with two windows open it cannot switch
 * between them (measured in `docs/VERIFIED-FACTS.md`). That window-targeting
 * path needs macOS Accessibility permission; `tryFocusWindow` degrades to
 * `false` on any failure there, including a missing grant or no matching
 * title, and this function then falls back to the same app-level `activate`
 * behaviour that existed before — so a worse outcome than before is not
 * possible.
 *
 * `runner` and `logger` default to the real `osascript` call and the shared
 * `log`. A test overrides both, so it can inject a failure and capture the
 * log lines without shelling out or raising a window. Later callers use the
 * four-argument form.
 */
export async function focusWindow(
  pid: number,
  termProgram: string,
  cwd: string,
  project: string,
  runner: Runner = run,
  logger: Logger = log,
): Promise<boolean> {
  const app = terminalAppName(termProgram)
  if (!app) {
    logger.once(`term-${termProgram}`, `no window focus rule for terminal "${termProgram}"`)
    return false
  }

  if (await tryFocusWindow(app, cwd, project, runner, logger)) return true

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
