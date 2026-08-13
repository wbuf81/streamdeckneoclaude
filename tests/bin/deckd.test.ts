import { describe, it, expect } from 'vitest'
import { makeChangeHandler } from '../../bin/deckd.js'
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
 * Mirrors the shape of a press-feedback flash (now owned by `src/daemon.ts`,
 * not any one page): a press arms a flash timed off the millisecond clock
 * the page's own last `render()` call saw, and a later render shows it
 * until `nowMs` reaches that recorded expiry. Modeled locally, rather than
 * driving the real daemon-level mechanism, so this regression test stays
 * about `makeChangeHandler`'s own clock plumbing — the thing this file
 * actually owns — independent of the daemon's internals.
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

describe('press flash and a change-driven render (B3)', () => {
  it('reproduces the review-measured bug directly: a truncated change-driven render makes the very next press flash invisible', async () => {
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

  it('the flash survives a change-driven render on the following tick, once every path carries a real millisecond clock', async () => {
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
