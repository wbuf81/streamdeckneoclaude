import { describe, it, expect, vi } from 'vitest'
import { makeChangeHandler, dispatch, isEntryPoint, type CliHandlers } from '../../bin/deckd.js'
import { Daemon } from '../../src/daemon.js'
import { FakeDevice } from '../../src/fake-device.js'
import { PageManager } from '../../src/page-manager.js'
import type { Page, PressOutcome } from '../../src/pages/types.js'
import type { DeckFrame, KeySpec } from '../../src/render/specs.js'

/** Waits for every pending microtask queued so far to drain, so an
 * un-awaited `void this.handlePress(i)` (see `Daemon`) has finished before
 * the assertion runs. A single `await Promise.resolve()` only advances one
 * microtask tick, and the press path is several `await`s deep. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Records every `(now, nowMs)` pair `render` was called with. */
class SpyPage implements Page {
  readonly name = 'spy'
  calls: Array<{ now: number; nowMs: number }> = []

  render(now: number, nowMs: number): DeckFrame {
    this.calls.push({ now, nowMs })
    const keys: KeySpec[] = Array.from({ length: 8 }, () => ({ kind: 'blank' }))
    return { keys, strip: { lines: [] }, buttons: [[0, 0, 0], [0, 0, 0]] }
  }

  onKeyPress(): PressOutcome {
    return 'ignored'
  }
}

describe('makeChangeHandler (B3)', () => {
  it('passes a real millisecond clock to renderOnce, not now * 1000', async () => {
    const device = new FakeDevice()
    const page = new SpyPage()
    const manager = new PageManager()
    manager.add(page)
    const daemon = new Daemon(device, manager)
    await daemon.start()
    page.calls = []

    // Deliberately not a whole multiple of 1000: the removed
    // `nowMs = now * 1000` default in `Daemon.renderOnce` would have produced
    // a different, wrong value here, and this assertion would catch it.
    const FIXED_MS = 1_723_000_555_432
    makeChangeHandler(daemon, () => FIXED_MS)()
    await flush()

    expect(page.calls).toHaveLength(1)
    expect(page.calls[0]).toEqual({ now: Math.floor(FIXED_MS / 1000), nowMs: FIXED_MS })

    await daemon.stop()
  })

  it('reads the clock exactly once, so now and nowMs always describe the same instant', () => {
    let reads = 0
    const clock = (): number => {
      reads += 1
      return 5000
    }
    const fakeDaemon = { renderOnce: () => Promise.resolve() } as unknown as Daemon
    makeChangeHandler(fakeDaemon, clock)()
    expect(reads).toBe(1)
  })
})

/**
 * `FlashPage` models a press-feedback flash the way `src/daemon.ts` used to
 * work BEFORE task 32 moved the real mechanism out of pages entirely (and
 * before `697a42b`'s per-page-and-per-key redesign after that). It exists
 * ONLY to exercise `makeChangeHandler`'s own clock plumbing — the thing
 * this file actually owns — against something that reacts to a millisecond
 * clock, independent of the daemon's real flash internals.
 *
 * IMPORTANT: this is NOT coverage of the daemon's actual flash (see
 * `tests/daemon.test.ts`'s "Daemon press-feedback flash" describe block for
 * that). `FlashPage` signals through `border`, a field the real mechanism
 * has not used since task 32, and both tests below pass identically against
 * a daemon whose flash logic is completely different from what ships today.
 * Renamed from titles that claimed press-flash coverage (M9) to avoid that
 * exact false impression.
 */
const FLASH_MS = 200

class FlashPage implements Page {
  readonly name = 'flash'
  private lastNowMs = 0
  private flashUntilMs: number | null = null

  render(_now: number, nowMs: number): DeckFrame {
    this.lastNowMs = nowMs
    const flashing = this.flashUntilMs !== null && nowMs < this.flashUntilMs
    const keys: KeySpec[] = [
      { kind: 'gauge', lines: ['x'], border: flashing ? [230, 60, 60] : undefined },
      ...Array.from({ length: 7 }, (): KeySpec => ({ kind: 'blank' })),
    ]
    return { keys, strip: { lines: ['flash'] }, buttons: [[0, 0, 0], [0, 0, 0]] }
  }

  onKeyPress(): PressOutcome {
    // Anchors off the clock the LAST render saw, never `Date.now()` itself,
    // since a page must never call the wall clock directly.
    this.flashUntilMs = this.lastNowMs + FLASH_MS
    return 'handled'
  }
}

describe('a page-local flash model exercises makeChangeHandler’s clock plumbing (B3)', () => {
  it('reproduces the review-measured bug directly: a truncated change-driven render makes the modeled flash invisible', async () => {
    // This test pins the OLD, buggy behaviour on purpose, to prove the
    // scenario is real rather than theoretical -- it calls `renderOnce`
    // with the truncated `now * 1000` value the removed default used to
    // supply, not through `makeChangeHandler`.
    const device = new FakeDevice()
    const page = new FlashPage()
    const manager = new PageManager()
    manager.add(page)
    let ms = 1000
    const daemon = new Daemon(device, manager, () => Math.floor(ms / 1000), () => ms)
    await daemon.start()

    // A change fires at a real wall-clock instant 850 ms into second 1, but
    // (the bug) is rendered with the truncated whole-second value instead.
    ms = 1850
    const truncatedNowMs = Math.floor(ms / 1000) * 1000 // 1000, not 1850
    await daemon.renderOnce(Math.floor(ms / 1000), truncatedNowMs)

    // A press follows moments later, at the real clock.
    ms = 1900
    device.simulatePress(0)
    await flush()

    const frame = page.render(Math.floor(ms / 1000), ms)
    expect(frame.keys[0]).toMatchObject({ border: undefined }) // the flash never appeared

    await daemon.stop()
  })

  it('the modeled flash survives a change-driven render on the following tick, once every path carries a real millisecond clock', async () => {
    const device = new FakeDevice()
    const page = new FlashPage()
    const manager = new PageManager()
    manager.add(page)
    let ms = 1000
    const daemon = new Daemon(device, manager, () => Math.floor(ms / 1000), () => ms)
    await daemon.start()

    // The fix: the change fires through `makeChangeHandler`, which carries
    // the real millisecond clock through, not a truncated one.
    ms = 1850
    makeChangeHandler(daemon, () => ms)()
    await flush()

    // The press follows moments later.
    ms = 1900
    device.simulatePress(0)
    await flush()
    let frame = page.render(Math.floor(ms / 1000), ms)
    expect(frame.keys[0]).toMatchObject({ border: [230, 60, 60] })

    // A source change fires again on the following tick -- still within the
    // flash's 200 ms window -- and must not make it disappear early.
    ms = 2000
    makeChangeHandler(daemon, () => ms)()
    await flush()
    frame = page.render(Math.floor(ms / 1000), ms)
    expect(frame.keys[0]).toMatchObject({ border: [230, 60, 60] })

    await daemon.stop()
  })
})

/**
 * I-6: `dispatch` had zero tests before this -- every verb's routing, the
 * missing-verb and unknown-verb usage paths, and the exit codes were only
 * ever verified by hand. Every handler here is a spy that never runs a real
 * install, uninstall, or start; `exit`, `err`, and `out` are spies too, so
 * nothing here prints to the real console or calls the real
 * `process.exit`.
 */
function fakeHandlers(): CliHandlers {
  return {
    start: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    refreshWrapper: vi.fn(async () => ({ path: '/fake/wrapper.sh' })),
    authSpotify: vi.fn(async () => {}),
  }
}

/** Waits for the microtask chain a fire-and-forget `.catch(...)` handler
 * runs on to settle, so an assertion after `dispatch` can see its effect. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('dispatch (I-6)', () => {
  it('routes "start" to the start handler', () => {
    const handlers = fakeHandlers()
    const exit = vi.fn()
    dispatch(['node', 'deckd', 'start'], handlers, exit)
    expect(handlers.start).toHaveBeenCalledTimes(1)
    expect(handlers.install).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('routes "install" to the install handler', () => {
    const handlers = fakeHandlers()
    const exit = vi.fn()
    dispatch(['node', 'deckd', 'install'], handlers, exit)
    expect(handlers.install).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
  })

  it('routes "uninstall" to the uninstall handler', () => {
    const handlers = fakeHandlers()
    const exit = vi.fn()
    dispatch(['node', 'deckd', 'uninstall'], handlers, exit)
    expect(handlers.uninstall).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
  })

  it('routes "refresh-wrapper" to the refreshWrapper handler and prints its resulting path', async () => {
    const handlers = fakeHandlers()
    const exit = vi.fn()
    const out = vi.fn()
    dispatch(['node', 'deckd', 'refresh-wrapper'], handlers, exit, vi.fn(), out)
    await settle()
    expect(handlers.refreshWrapper).toHaveBeenCalledTimes(1)
    expect(out).toHaveBeenCalledWith(expect.stringContaining('/fake/wrapper.sh'))
    expect(exit).not.toHaveBeenCalled()
  })

  it('routes "auth spotify" to the authSpotify handler', () => {
    const handlers = fakeHandlers()
    const exit = vi.fn()
    dispatch(['node', 'deckd', 'auth', 'spotify'], handlers, exit)
    expect(handlers.authSpotify).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
  })

  it('"auth" with no sub-verb prints usage and exits 2, without calling authSpotify', () => {
    const handlers = fakeHandlers()
    const exit = vi.fn()
    const err = vi.fn()
    dispatch(['node', 'deckd', 'auth'], handlers, exit, err)
    expect(handlers.authSpotify).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith('usage: deckd auth spotify')
    expect(exit).toHaveBeenCalledWith(2)
  })

  it('"auth" with an unrecognised sub-verb prints usage and exits 2', () => {
    const handlers = fakeHandlers()
    const exit = vi.fn()
    const err = vi.fn()
    dispatch(['node', 'deckd', 'auth', 'github'], handlers, exit, err)
    expect(handlers.authSpotify).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(2)
  })

  it('no verb at all prints usage and exits 2, calling no handler', () => {
    const handlers = fakeHandlers()
    const exit = vi.fn()
    const err = vi.fn()
    dispatch(['node', 'deckd'], handlers, exit, err)
    expect(err).toHaveBeenCalledWith('usage: deckd <start|install|uninstall|refresh-wrapper|auth>')
    expect(exit).toHaveBeenCalledWith(2)
    expect(handlers.start).not.toHaveBeenCalled()
    expect(handlers.install).not.toHaveBeenCalled()
    expect(handlers.uninstall).not.toHaveBeenCalled()
    expect(handlers.refreshWrapper).not.toHaveBeenCalled()
    expect(handlers.authSpotify).not.toHaveBeenCalled()
  })

  it('an unknown verb reports it by name, still prints usage, and exits 2', () => {
    const handlers = fakeHandlers()
    const exit = vi.fn()
    const err = vi.fn()
    dispatch(['node', 'deckd', 'frobnicate'], handlers, exit, err)
    expect(err).toHaveBeenCalledWith('unknown command: frobnicate')
    expect(err).toHaveBeenCalledWith('usage: deckd <start|install|uninstall|refresh-wrapper|auth>')
    expect(exit).toHaveBeenCalledWith(2)
    expect(handlers.start).not.toHaveBeenCalled()
  })

  it('a rejecting handler logs the error and exits 1, for every verb that runs one', async () => {
    for (const argv of [
      ['node', 'deckd', 'start'],
      ['node', 'deckd', 'install'],
      ['node', 'deckd', 'uninstall'],
      ['node', 'deckd', 'refresh-wrapper'],
      ['node', 'deckd', 'auth', 'spotify'],
    ]) {
      const handlers: CliHandlers = {
        start: vi.fn(async () => { throw new Error('start boom') }),
        install: vi.fn(async () => { throw new Error('install boom') }),
        uninstall: vi.fn(async () => { throw new Error('uninstall boom') }),
        refreshWrapper: vi.fn(async () => { throw new Error('refresh boom') }),
        authSpotify: vi.fn(async () => { throw new Error('auth boom') }),
      }
      const exit = vi.fn()
      const err = vi.fn()
      dispatch(argv, handlers, exit, err)
      await settle()
      expect(exit).toHaveBeenCalledWith(1)
      expect(err).toHaveBeenCalledTimes(1)
    }
  })
})

/**
 * `isEntryPoint` is the pure logic behind `isMain()`'s guard, which keeps
 * this whole file's dispatch block from running when a test merely IMPORTS
 * it. Pulled apart so a test can drive it directly with synthetic paths,
 * instead of mutating the real `process.argv` -- nothing exercised the
 * `realpath` (symlink) branch at all before this.
 */
describe('isEntryPoint', () => {
  it('is true when argv1 is exactly the resolved module path', () => {
    expect(isEntryPoint('/repo/dist/bin/deckd.js', '/repo/dist/bin/deckd.js')).toBe(true)
  })

  it('is false when argv1 is absent (e.g. some non-file invocation)', () => {
    expect(isEntryPoint(undefined, '/repo/dist/bin/deckd.js')).toBe(false)
  })

  it('is true when argv1 is a symlink whose realpath resolves to the module path', () => {
    // The `npm link` / global-install case: `argv1` is
    // `/usr/local/bin/deckd`, a symlink, and only `realpath` reveals it
    // points at the same file.
    const realpath = (p: string): string => {
      expect(p).toBe('/usr/local/bin/deckd')
      return '/repo/dist/bin/deckd.js'
    }
    expect(isEntryPoint('/usr/local/bin/deckd', '/repo/dist/bin/deckd.js', realpath)).toBe(true)
  })

  it('is false when argv1 resolves to a different file entirely', () => {
    const realpath = (): string => '/repo/dist/bin/some-other-tool.js'
    expect(isEntryPoint('/usr/local/bin/other-tool', '/repo/dist/bin/deckd.js', realpath)).toBe(false)
  })

  it('is false, not throwing, when argv1 does not exist on disk at all', () => {
    const realpath = (): string => {
      throw new Error('ENOENT: no such file or directory')
    }
    expect(isEntryPoint('-e', '/repo/dist/bin/deckd.js', realpath)).toBe(false)
  })
})
