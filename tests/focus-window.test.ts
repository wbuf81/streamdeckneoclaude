import { describe, it, expect } from 'vitest'
import {
  terminalAppName,
  buildFocusScript,
  buildListWindowsScript,
  parseWindowTitles,
  pickWindowIndex,
  buildRaiseWindowScript,
  findTerminalPid,
  focusWindow,
  MAX_WALK,
} from '../src/focus-window.js'
import { createLogger } from '../src/log.js'

type RunnerResult = { stdout: string; stderr: string }
type Runner = (file: string, args: readonly string[]) => Promise<RunnerResult>

/** Distinguishes the three AppleScript shapes `focusWindow` can send, by the
 * script text itself, so a fake runner can answer each one differently
 * without depending on argument order. */
function scriptKind(args: readonly string[]): 'list' | 'raise' | 'activate' {
  const script = args[1] ?? ''
  if (script.includes('windows of process')) return 'list'
  if (script.includes('AXRaise')) return 'raise'
  return 'activate'
}

describe('terminalAppName', () => {
  it('maps ghostty', () => {
    expect(terminalAppName('ghostty')).toBe('Ghostty')
  })

  it('is case insensitive', () => {
    expect(terminalAppName('Ghostty')).toBe('Ghostty')
    expect(terminalAppName('GHOSTTY')).toBe('Ghostty')
  })

  it('maps the other common terminals', () => {
    expect(terminalAppName('iTerm.app')).toBe('iTerm2')
    expect(terminalAppName('Apple_Terminal')).toBe('Terminal')
    expect(terminalAppName('WezTerm')).toBe('WezTerm')
    expect(terminalAppName('vscode')).toBe('Code')
  })

  it('returns null for an unknown terminal', () => {
    expect(terminalAppName('some-new-term')).toBeNull()
  })

  it('returns null for an empty value', () => {
    expect(terminalAppName('')).toBeNull()
  })
})

describe('buildFocusScript', () => {
  it('activates the named application', () => {
    const s = buildFocusScript('Ghostty')
    expect(s).toContain('Ghostty')
    expect(s).toContain('activate')
  })

  it('quotes the app name, so a space cannot break the script', () => {
    expect(buildFocusScript('Visual Studio Code')).toContain('"Visual Studio Code"')
  })

  it('refuses a name with a quote in it', () => {
    expect(() => buildFocusScript('bad"name')).toThrow(/name/i)
  })
})

describe('findTerminalPid', () => {
  it('returns the pid when it has no parent', () => {
    expect(findTerminalPid(100, () => null)).toBe(100)
  })

  it('walks up to the top of the tree', () => {
    // 100 -> 50 -> 1. The walk stops at 1, because 1 is launchd.
    const parents = new Map([[100, 50], [50, 1]])
    expect(findTerminalPid(100, (p) => parents.get(p) ?? null)).toBe(50)
  })

  it('stops at the depth cap on a cyclic tree', () => {
    // A cycle must not loop for ever.
    expect(findTerminalPid(2, () => 2)).toBe(2)
  })

  it('has a depth cap above 1', () => {
    expect(MAX_WALK).toBeGreaterThan(1)
  })

  it('returns the pid unchanged when it is already 1', () => {
    expect(findTerminalPid(1, () => null)).toBe(1)
  })
})

describe('buildListWindowsScript', () => {
  it('asks System Events for the titles of every window of the process', () => {
    const s = buildListWindowsScript('Ghostty')
    expect(s).toContain('windows of process "Ghostty"')
  })

  it('refuses a process name with a quote in it', () => {
    expect(() => buildListWindowsScript('bad"name')).toThrow(/name/i)
  })
})

describe('parseWindowTitles', () => {
  it('splits newline-joined titles', () => {
    expect(parseWindowTitles('one\ntwo\nthree')).toEqual(['one', 'two', 'three'])
  })

  it('returns an empty list for blank output, rather than one blank title', () => {
    expect(parseWindowTitles('')).toEqual([])
    expect(parseWindowTitles('   \n  ')).toEqual([])
  })

  it('trims stray whitespace around each title', () => {
    expect(parseWindowTitles(' one \n two ')).toEqual(['one', 'two'])
  })
})

describe('pickWindowIndex', () => {
  it('picks the window whose title contains the cwd basename', () => {
    const titles = ['~/other-project — zsh', '~/streamdeckneoclaude — zsh']
    expect(pickWindowIndex(titles, ['streamdeckneoclaude'])).toBe(1)
  })

  it('falls back (returns null) when no title matches any candidate', () => {
    const titles = ['~/other-project — zsh', '~/another — zsh']
    expect(pickWindowIndex(titles, ['streamdeckneoclaude'])).toBeNull()
  })

  it('falls back when two titles tie for the best score', () => {
    const titles = ['~/streamdeckneoclaude — zsh', '~/streamdeckneoclaude — vim']
    expect(pickWindowIndex(titles, ['streamdeckneoclaude'])).toBeNull()
  })

  it('falls back on an empty window list', () => {
    expect(pickWindowIndex([], ['streamdeckneoclaude'])).toBeNull()
  })

  it('rejects a matching title that contains a quote, rather than escaping it', () => {
    const titles = ['~/streamdeckneoclaude "fork" — zsh']
    expect(pickWindowIndex(titles, ['streamdeckneoclaude'])).toBeNull()
  })

  it('rejects a matching title that contains a backslash, rather than escaping it', () => {
    const titles = ['~/streamdeckneoclaude\\fork — zsh']
    expect(pickWindowIndex(titles, ['streamdeckneoclaude'])).toBeNull()
  })

  it('still picks a safe match when an unsafe title is also present', () => {
    const titles = ['~/streamdeckneoclaude "fork" — zsh', '~/streamdeckneoclaude — zsh']
    expect(pickWindowIndex(titles, ['streamdeckneoclaude'])).toBe(1)
  })

  // The following cases match the coordinator's live measurement: a Claude
  // Code session's Ghostty title is a task summary the agent writes, not the
  // directory, so basename-only scoring is not enough on its own.

  it('picks a window on its project name when the cwd shares no substring with the title', () => {
    const titles = [
      '~/other-project — zsh',
      'Build Elgato Stream Deck custom control software',
    ]
    // Measured live: a Claude Code session's title is a task summary. The
    // cwd basename ("streamdeckneoclaude") and the full cwd never appear in
    // it, but the project name — passed as a separate, distinct candidate —
    // can still match a word the agent happened to use.
    const candidates = ['streamdeckneoclaude', '/x/streamdeckneoclaude', 'Stream Deck']
    expect(pickWindowIndex(titles, candidates)).toBe(1)
  })

  it('normalizes a leading spinner glyph before scoring, so an animating title still matches', () => {
    // ⠐ is a Braille Patterns glyph (U+2810), the kind Ghostty shows while a
    // command runs. Measured live: "⠐ Build Elgato Stream Deck custom
    // control software".
    const titles = ['⠐ my-project task summary']
    expect(pickWindowIndex(titles, ['my-project'])).toBe(0)
  })

  it('matches regardless of which spinner frame currently prefixes the title', () => {
    const base = 'my-project task summary'
    const frames = ['⠋', '⠙', '⠹', '⠼', '⠴', '⠦'].map((g) => `${g} ${base}`)
    for (const title of frames) {
      expect(pickWindowIndex([title], ['my-project'])).toBe(0)
    }
  })

  it('never guesses: returns null when a title is merely unrelated text, not a near miss', () => {
    // This is the honest limitation: a Claude Code task summary that never
    // mentions the cwd, the full path, or the project name cannot be found
    // by title matching at all, and this must fall back rather than picking
    // an arbitrary window.
    const titles = ['Investigate flaky CI test on the reporting service']
    expect(pickWindowIndex(titles, ['streamdeckneoclaude', '/x/streamdeckneoclaude', 'streamdeckneoclaude'])).toBeNull()
  })
})

describe('buildRaiseWindowScript', () => {
  it('raises the named window and brings the process frontmost', () => {
    const s = buildRaiseWindowScript('Ghostty', '~/streamdeckneoclaude — zsh')
    expect(s).toContain('AXRaise')
    expect(s).toContain('~/streamdeckneoclaude — zsh')
    expect(s).toContain('frontmost')
  })

  it('refuses a title with a quote in it', () => {
    expect(() => buildRaiseWindowScript('Ghostty', 'bad"title')).toThrow(/title/i)
  })

  it('refuses an app name with a quote in it', () => {
    expect(() => buildRaiseWindowScript('bad"app', 'title')).toThrow(/name/i)
  })
})

describe('focusWindow', () => {
  it('logs a repeated failure only once, and logs again after it clears', async () => {
    const written: string[] = []
    const logger = createLogger((line) => written.push(line))
    const failingRunner: Runner = async () => {
      throw new Error('boom')
    }

    // A user holding down the same key while macOS denies automation must
    // not fill the log with one line per press.
    await focusWindow(123, 'ghostty', '/x', 'proj', failingRunner, logger)
    await focusWindow(123, 'ghostty', '/x', 'proj', failingRunner, logger)
    await focusWindow(123, 'ghostty', '/x', 'proj', failingRunner, logger)
    expect(written).toHaveLength(1)

    // The list call fails for a reason unrelated to Accessibility here, so
    // `tryFocusWindow` degrades silently (no new log key) and only the
    // app-level activate call's own once/clearOnce pair is under test.
    const okRunner: Runner = async (_file, args) => {
      if (scriptKind(args) === 'list') throw new Error('boom-list')
      return { stdout: '', stderr: '' }
    }

    // A success clears the once-key, so a later failure logs again.
    await focusWindow(123, 'ghostty', '/x', 'proj', okRunner, logger)
    await focusWindow(123, 'ghostty', '/x', 'proj', failingRunner, logger)
    expect(written).toHaveLength(2)
  })

  it('resolves true on success and false on failure, without throwing', async () => {
    const logger = createLogger(() => {})
    const okRunner: Runner = async () => ({ stdout: '', stderr: '' })
    const failingRunner: Runner = async () => {
      throw new Error('boom')
    }

    await expect(focusWindow(1, 'ghostty', '/x', 'proj', okRunner, logger)).resolves.toBe(true)
    await expect(focusWindow(1, 'ghostty', '/x', 'proj', failingRunner, logger)).resolves.toBe(
      false,
    )
  })

  it('raises the specific window whose title matches the session cwd', async () => {
    const logger = createLogger(() => {})
    const calls: string[] = []
    const runner: Runner = async (_file, args) => {
      const kind = scriptKind(args)
      calls.push(kind)
      if (kind === 'list') {
        return { stdout: '~/other — zsh\n~/streamdeckneoclaude — zsh', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }

    const ok = await focusWindow(
      1,
      'ghostty',
      '/Users/x/streamdeckneoclaude',
      'streamdeckneoclaude',
      runner,
      logger,
    )
    expect(ok).toBe(true)
    expect(calls).toEqual(['list', 'raise'])
  })

  it('raises the specific window whose title matches the session project, when the cwd does not appear in it', async () => {
    const logger = createLogger(() => {})
    const calls: string[] = []
    const runner: Runner = async (_file, args) => {
      const kind = scriptKind(args)
      calls.push(kind)
      if (kind === 'list') {
        // Measured live: a Claude Code window's title is a task summary that
        // shares no substring with the cwd, only (sometimes) with the
        // project name — here "Stream Deck", distinct from the cwd's own
        // basename "streamdeckneoclaude".
        return {
          stdout: '~/other — zsh\nBuild Elgato Stream Deck custom control software',
          stderr: '',
        }
      }
      return { stdout: '', stderr: '' }
    }

    const ok = await focusWindow(
      1,
      'ghostty',
      '/Users/x/streamdeckneoclaude',
      'Stream Deck',
      runner,
      logger,
    )
    expect(ok).toBe(true)
    expect(calls).toEqual(['list', 'raise'])
  })

  it('falls back to app-level activate when no window title matches', async () => {
    const logger = createLogger(() => {})
    const calls: string[] = []
    const runner: Runner = async (_file, args) => {
      const kind = scriptKind(args)
      calls.push(kind)
      if (kind === 'list') return { stdout: '~/other — zsh', stderr: '' }
      return { stdout: '', stderr: '' }
    }

    const ok = await focusWindow(
      1,
      'ghostty',
      '/Users/x/streamdeckneoclaude',
      'streamdeckneoclaude',
      runner,
      logger,
    )
    expect(ok).toBe(true)
    expect(calls).toEqual(['list', 'activate'])
  })

  it('falls back to app-level activate when the terminal has one window only', async () => {
    const logger = createLogger(() => {})
    const calls: string[] = []
    const runner: Runner = async (_file, args) => {
      const kind = scriptKind(args)
      calls.push(kind)
      if (kind === 'list') return { stdout: '~/other — zsh', stderr: '' }
      return { stdout: '', stderr: '' }
    }
    await focusWindow(
      1,
      'ghostty',
      '/Users/x/streamdeckneoclaude',
      'streamdeckneoclaude',
      runner,
      logger,
    )
    expect(calls).toEqual(['list', 'activate'])
  })

  it('never guesses: falls back when the title is unrelated text, not a near miss', async () => {
    const logger = createLogger(() => {})
    const calls: string[] = []
    const runner: Runner = async (_file, args) => {
      const kind = scriptKind(args)
      calls.push(kind)
      if (kind === 'list') {
        return { stdout: 'Investigate flaky CI test on the reporting service', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }
    const ok = await focusWindow(
      1,
      'ghostty',
      '/Users/x/streamdeckneoclaude',
      'streamdeckneoclaude',
      runner,
      logger,
    )
    expect(ok).toBe(true) // app-level activate still succeeds
    expect(calls).toEqual(['list', 'activate'])
  })

  it('logs once, naming the titles seen, when nothing matches', async () => {
    const written: string[] = []
    const logger = createLogger((line) => written.push(line))
    const runner: Runner = async (_file, args) => {
      if (scriptKind(args) === 'list') {
        return { stdout: 'Investigate flaky CI test on the reporting service', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }

    await focusWindow(1, 'ghostty', '/x/streamdeckneoclaude', 'streamdeckneoclaude', runner, logger)
    await focusWindow(1, 'ghostty', '/x/streamdeckneoclaude', 'streamdeckneoclaude', runner, logger)
    await focusWindow(1, 'ghostty', '/x/streamdeckneoclaude', 'streamdeckneoclaude', runner, logger)

    const noMatchLines = written.filter((l) => l.includes('no') && l.includes('matched'))
    expect(noMatchLines).toHaveLength(1)
    expect(noMatchLines[0]).toContain('streamdeckneoclaude')
    expect(noMatchLines[0]).toContain('Investigate flaky CI test')
  })

  it('falls back to app-level activate on a -1728 Accessibility failure, and logs once', async () => {
    const written: string[] = []
    const logger = createLogger((line) => written.push(line))
    const calls: string[] = []
    const runner: Runner = async (_file, args) => {
      const kind = scriptKind(args)
      calls.push(kind)
      if (kind === 'list') {
        throw new Error(
          'execution error: System Events got an error: osascript is not allowed ' +
            'assistive access. (-1728)',
        )
      }
      return { stdout: '', stderr: '' }
    }

    const ok = await focusWindow(
      1,
      'ghostty',
      '/Users/x/streamdeckneoclaude',
      'streamdeckneoclaude',
      runner,
      logger,
    )
    expect(ok).toBe(true)
    expect(calls).toEqual(['list', 'activate'])
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('-1728')
  })

  it('mentions the exact binary to grant Accessibility to, and the Settings path', async () => {
    const written: string[] = []
    const logger = createLogger((line) => written.push(line))
    const runner: Runner = async (_file, args) => {
      if (scriptKind(args) === 'list') throw new Error('not allowed assistive access. (-1728)')
      return { stdout: '', stderr: '' }
    }
    await focusWindow(1, 'ghostty', '/x/streamdeckneoclaude', 'streamdeckneoclaude', runner, logger)
    expect(written[0]).toContain(process.execPath)
    expect(written[0]).toContain('Accessibility')
  })

  it('logs the -1728 failure only once across repeated presses', async () => {
    const written: string[] = []
    const logger = createLogger((line) => written.push(line))
    const runner: Runner = async (_file, args) => {
      if (scriptKind(args) === 'list') {
        throw new Error('not allowed assistive access. (-1728)')
      }
      return { stdout: '', stderr: '' }
    }

    await focusWindow(1, 'ghostty', '/x/streamdeckneoclaude', 'streamdeckneoclaude', runner, logger)
    await focusWindow(1, 'ghostty', '/x/streamdeckneoclaude', 'streamdeckneoclaude', runner, logger)
    await focusWindow(1, 'ghostty', '/x/streamdeckneoclaude', 'streamdeckneoclaude', runner, logger)

    const accessibilityLines = written.filter((l) => l.includes('-1728'))
    expect(accessibilityLines).toHaveLength(1)
  })

  it('never throws when every osascript call fails', async () => {
    const logger = createLogger(() => {})
    const runner: Runner = async () => {
      throw new Error('boom')
    }
    await expect(
      focusWindow(1, 'ghostty', '/x/streamdeckneoclaude', 'streamdeckneoclaude', runner, logger),
    ).resolves.toBe(false)
  })

  it('does not attempt window listing for a terminal with no focus rule', async () => {
    const logger = createLogger(() => {})
    const calls: string[] = []
    const runner: Runner = async (_file, args) => {
      calls.push(scriptKind(args))
      return { stdout: '', stderr: '' }
    }
    const ok = await focusWindow(1, 'some-new-term', '/x', 'proj', runner, logger)
    expect(ok).toBe(false)
    expect(calls).toEqual([])
  })
})
