import { describe, it, expect, vi, afterEach } from 'vitest'
import { createLogger } from '../src/log.js'
import { LockState, parseLockState, type LockRunner } from '../src/lock-state.js'

describe('parseLockState', () => {
  it('treats an absent key as unknown so a platform change is logged', () => {
    expect(parseLockState('+-o Root  <class IORegistryEntry>')).toBeNull()
  })

  it('parses the measured IOConsoleLocked key', () => {
    expect(parseLockState('  "IOConsoleLocked" = Yes')).toBe(true)
    expect(parseLockState('  "IOConsoleLocked" = No')).toBe(false)
  })

  it('retains the older CGSession spelling as a compatibility fallback', () => {
    expect(parseLockState('  "CGSSessionScreenIsLocked" = Yes')).toBe(true)
    expect(parseLockState('  "CGSSessionScreenIsLocked" = No')).toBe(false)
  })

  it('returns unknown for an unfamiliar present value', () => {
    expect(parseLockState('  "CGSSessionScreenIsLocked" = Maybe')).toBeNull()
  })
})

describe('LockState', () => {
  afterEach(() => vi.useRealTimers())

  it('emits only when the effective state changes', async () => {
    let output = '"IOConsoleLocked" = Yes'
    const runner = vi.fn<LockRunner>(async () => ({ stdout: output, stderr: '' }))
    const source = new LockState(runner, createLogger(() => {}))
    let changes = 0
    source.onChange(() => changes++)

    await source.refresh()
    await source.refresh()
    expect(source.isLocked()).toBe(true)
    expect(changes).toBe(1)

    output = '"IOConsoleLocked" = No'
    await source.refresh()
    expect(source.isLocked()).toBe(false)
    expect(changes).toBe(2)
    expect(runner).toHaveBeenCalledWith('/usr/sbin/ioreg', [
      '-n', 'Root', '-d1', '-k', 'IOConsoleLocked',
    ])
  })

  it('fails open and logs an unparseable result once until recovery', async () => {
    const lines: string[] = []
    let output = '"CGSSessionScreenIsLocked" = Maybe'
    const source = new LockState(
      async () => ({ stdout: output, stderr: '' }),
      createLogger((line) => lines.push(line)),
    )

    await source.refresh()
    await source.refresh()
    expect(source.isLocked()).toBe(false)
    expect(lines.filter((line) => line.includes('not recognized'))).toHaveLength(1)

    output = '"IOConsoleLocked" = No'
    await source.refresh()
    output = '"CGSSessionScreenIsLocked" = Maybe'
    await source.refresh()
    expect(lines.filter((line) => line.includes('not recognized'))).toHaveLength(2)
  })

  it('fails open when ioreg fails', async () => {
    const lines: string[] = []
    const source = new LockState(
      async () => { throw new Error('ioreg unavailable') },
      createLogger((line) => lines.push(line)),
    )

    await expect(source.refresh()).resolves.not.toThrow()
    expect(source.isLocked()).toBe(false)
    expect(lines.some((line) => line.includes('probe failed'))).toBe(true)
  })

  it('does not arm another poll when stop runs during an in-flight probe', async () => {
    vi.useFakeTimers()
    let release: ((value: { stdout: string; stderr: string }) => void) | undefined
    const runner = vi.fn(
      () => new Promise<{ stdout: string; stderr: string }>((resolve) => { release = resolve }),
    )
    const source = new LockState(runner, createLogger(() => {}))

    const starting = source.start()
    await Promise.resolve()
    await source.stop()
    release?.({ stdout: '', stderr: '' })
    await starting
    await vi.advanceTimersByTimeAsync(15_000)

    expect(runner).toHaveBeenCalledTimes(1)
  })
})
