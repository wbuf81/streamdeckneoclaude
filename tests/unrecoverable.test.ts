import { describe, it, expect, vi } from 'vitest'
import { reportUnrecoverable, NOTIFY_COOLDOWN_MS } from '../src/unrecoverable.js'

/** Builds a deps object with in-memory state and spies for every effect. */
function harness(opts: { state?: string | null; nowMs?: number } = {}) {
  let stored = opts.state ?? null
  return {
    notify: vi.fn(),
    exit: vi.fn(),
    readState: vi.fn(() => {
      if (stored === null) throw new Error('ENOENT')
      return stored
    }),
    writeState: vi.fn((data: string) => {
      stored = data
    }),
    now: vi.fn(() => opts.nowMs ?? 10_000_000_000),
    get stored() {
      return stored
    },
  }
}

describe('reportUnrecoverable', () => {
  it('notifies the user and exits so launchd starts a clean process', () => {
    const deps = harness()

    reportUnrecoverable('the deck stopped accepting writes', deps)

    expect(deps.notify).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledWith(1)
  })

  it('exits even when the notification itself fails', () => {
    const deps = harness()
    deps.notify.mockImplementation(() => {
      throw new Error('osascript is missing')
    })

    reportUnrecoverable('wedged', deps)

    // Recovery must never depend on being able to tell anyone about it.
    expect(deps.exit).toHaveBeenCalledWith(1)
  })

  it('stays silent on a repeat inside the cooldown, but still exits', () => {
    const first = harness({ nowMs: 10_000_000_000 })
    reportUnrecoverable('wedged', first)

    // launchd respawned us and the deck wedged again straight away. Exiting
    // again is right; a second banner a few seconds later is not.
    const second = harness({ state: first.stored, nowMs: 10_000_000_000 + 5000 })
    reportUnrecoverable('wedged', second)

    expect(second.notify).not.toHaveBeenCalled()
    expect(second.exit).toHaveBeenCalledWith(1)
  })

  it('notifies again once the cooldown has passed', () => {
    const first = harness({ nowMs: 10_000_000_000 })
    reportUnrecoverable('wedged', first)

    const later = harness({ state: first.stored, nowMs: 10_000_000_000 + NOTIFY_COOLDOWN_MS + 1 })
    reportUnrecoverable('wedged', later)

    expect(later.notify).toHaveBeenCalledTimes(1)
  })

  it('notifies when the stored timestamp is unreadable', () => {
    const deps = harness({ state: 'not json at all' })

    reportUnrecoverable('wedged', deps)

    // Failing open matters more than rate limiting: a corrupt state file
    // must not be able to silence every future alert.
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('still exits when the state file cannot be written', () => {
    const deps = harness()
    deps.writeState.mockImplementation(() => {
      throw new Error('EROFS')
    })

    reportUnrecoverable('wedged', deps)

    expect(deps.exit).toHaveBeenCalledWith(1)
  })
})
