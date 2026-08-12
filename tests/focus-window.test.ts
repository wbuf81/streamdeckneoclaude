import { describe, it, expect } from 'vitest'
import {
  terminalAppName,
  buildFocusScript,
  findTerminalPid,
  focusWindow,
  MAX_WALK,
} from '../src/focus-window.js'
import { createLogger } from '../src/log.js'

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

describe('focusWindow', () => {
  it('logs a repeated failure only once, and logs again after it clears', async () => {
    const written: string[] = []
    const logger = createLogger((line) => written.push(line))
    const failingRunner = async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('boom')
    }

    // A user holding down the same key while macOS denies automation must
    // not fill the log with one line per press.
    await focusWindow(123, 'ghostty', failingRunner, logger)
    await focusWindow(123, 'ghostty', failingRunner, logger)
    await focusWindow(123, 'ghostty', failingRunner, logger)
    expect(written).toHaveLength(1)

    const okRunner = async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: '',
      stderr: '',
    })

    // A success clears the once-key, so a later failure logs again.
    await focusWindow(123, 'ghostty', okRunner, logger)
    await focusWindow(123, 'ghostty', failingRunner, logger)
    expect(written).toHaveLength(2)
  })

  it('resolves true on success and false on failure, without throwing', async () => {
    const logger = createLogger(() => {})
    const okRunner = async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: '',
      stderr: '',
    })
    const failingRunner = async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('boom')
    }

    await expect(focusWindow(1, 'ghostty', okRunner, logger)).resolves.toBe(true)
    await expect(focusWindow(1, 'ghostty', failingRunner, logger)).resolves.toBe(false)
  })
})
