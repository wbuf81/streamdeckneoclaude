import { describe, it, expect, vi, afterEach } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { FakeDevice } from '../src/fake-device.js'
import { PageManager } from '../src/page-manager.js'
import { BUTTON_RIGHT } from '../src/device.js'
import { setDefaultSink } from '../src/log.js'
import type { Page } from '../src/pages/types.js'
import type { DeckFrame, KeySpec } from '../src/render/specs.js'

/** Waits for every pending microtask queued so far to drain. A press's own
 * chain (`onKeyPress`, then `renderOnce`'s several awaited device writes) is
 * several `await`s deep, so a single `await Promise.resolve()` is not
 * enough to observe its outcome -- it only advances one microtask tick. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A page whose content the test controls. */
class ControlPage implements Page {
  readonly name = 'test'
  lines = ['A']
  stripText = 'strip A'
  presses: number[] = []

  render(): DeckFrame {
    const keys: KeySpec[] = Array.from({ length: 8 }, (_, i) =>
      i === 0 ? { kind: 'gauge', lines: this.lines } : { kind: 'blank' })
    return {
      keys,
      strip: { lines: [this.stripText] },
      buttons: [[10, 10, 10], [20, 20, 20]],
    }
  }

  onKeyPress(i: number): void {
    this.presses.push(i)
  }
}

function build() {
  const device = new FakeDevice()
  const page = new ControlPage()
  const manager = new PageManager()
  manager.add(page)
  const daemon = new Daemon(device, manager)
  return { device, page, manager, daemon }
}

describe('Daemon', () => {
  it('writes all 8 keys and the strip on the first render', async () => {
    const { device, daemon } = build()
    await daemon.start()
    expect(device.keyWrites).toHaveLength(8)
    expect(device.stripWrites).toBe(1)
    await daemon.stop()
  })

  it('sets both touch button colours on the first render', async () => {
    const { device, daemon } = build()
    await daemon.start()
    expect(device.buttonColors.get(8)).toEqual([10, 10, 10])
    expect(device.buttonColors.get(9)).toEqual([20, 20, 20])
    await daemon.stop()
  })

  it('writes nothing on a second render with no change', async () => {
    const { device, daemon } = build()
    await daemon.start()
    device.reset()
    await daemon.renderOnce(1, 1000)
    expect(device.keyWrites).toHaveLength(0)
    expect(device.stripWrites).toBe(0)
    await daemon.stop()
  })

  it('writes only the changed key', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.reset()
    page.lines = ['B']
    await daemon.renderOnce(1, 1000)
    expect(device.keyWrites).toEqual([{ index: 0, bytes: expect.any(Number) }])
    await daemon.stop()
  })

  it('writes only the strip when only the strip changed', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.reset()
    page.stripText = 'strip B'
    await daemon.renderOnce(1, 1000)
    expect(device.keyWrites).toHaveLength(0)
    expect(device.stripWrites).toBe(1)
    await daemon.stop()
  })

  it('routes a key press to the page', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.simulatePress(3)
    await Promise.resolve()
    expect(page.presses).toContain(3)
    await daemon.stop()
  })

  it('does not route a touch button press to the page', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.simulatePress(8)
    device.simulatePress(9)
    await Promise.resolve()
    expect(page.presses).toEqual([])
    await daemon.stop()
  })

  it('redraws every key after a reconnect', async () => {
    const { device, daemon } = build()
    await daemon.start()
    device.reset()
    await daemon.handleReconnect()
    expect(device.keyWrites).toHaveLength(8)
    await daemon.stop()
  })

  it('survives a write failure and keeps running', async () => {
    const { device, daemon } = build()
    await daemon.start()
    const original = device.setKeyImage.bind(device)
    device.setKeyImage = async () => { throw new Error('usb gone') }
    await expect(daemon.renderOnce(2, 2000)).resolves.not.toThrow()
    device.setKeyImage = original
    await daemon.stop()
  })
})

/** A page whose `tickMs` and content the test controls, for the animation tests below. */
class TickPage implements Page {
  readonly name = 'tick'
  renderCount = 0
  /** When set, each key 0's text shows the millisecond clock, so a test can
   * tell two renders apart without decoding a real sprite. */
  animate = false

  constructor(public tickMs: number | undefined) {}

  render(now: number, nowMs: number = now * 1000): DeckFrame {
    this.renderCount += 1
    const text = this.animate ? String(Math.floor(nowMs / 100)) : 'static'
    const keys: KeySpec[] = Array.from({ length: 8 }, (_, i) =>
      i === 0 ? { kind: 'gauge', lines: [text] } : { kind: 'blank' })
    return {
      keys,
      strip: { lines: ['tick'] },
      buttons: [[0, 0, 0], [0, 0, 0]],
    }
  }

  onKeyPress(): void {}
}

describe('Daemon per-page render interval', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the current page tickMs for the render interval', async () => {
    vi.useFakeTimers()
    const device = new FakeDevice()
    const page = new TickPage(100)
    const manager = new PageManager()
    manager.add(page)
    const daemon = new Daemon(device, manager)

    await daemon.start()
    page.renderCount = 0
    await vi.advanceTimersByTimeAsync(1000)
    // 1000 ms at a 100 ms tick is 10 renders, not the default 1.
    expect(page.renderCount).toBe(10)
    await daemon.stop()
  })

  it('does not raise the rate for a page with no tickMs', async () => {
    vi.useFakeTimers()
    const device = new FakeDevice()
    const page = new TickPage(undefined)
    const manager = new PageManager()
    manager.add(page)
    const daemon = new Daemon(device, manager)

    await daemon.start()
    page.renderCount = 0
    await vi.advanceTimersByTimeAsync(1000)
    // The default interval is 1000 ms, so 1000 ms of elapsed time is 1 render.
    expect(page.renderCount).toBe(1)
    await daemon.stop()
  })

  it('re-arms the interval when the page changes', async () => {
    vi.useFakeTimers()
    const device = new FakeDevice()
    const slow = new TickPage(1000)
    const fast = new TickPage(100)
    const manager = new PageManager()
    manager.add(slow)
    manager.add(fast)
    const daemon = new Daemon(device, manager)

    await daemon.start()
    slow.renderCount = 0
    await vi.advanceTimersByTimeAsync(1000)
    expect(slow.renderCount).toBe(1)

    device.simulatePress(BUTTON_RIGHT)
    await vi.advanceTimersByTimeAsync(0)
    fast.renderCount = 0
    await vi.advanceTimersByTimeAsync(1000)
    // Had the daemon kept the old 1000 ms timer, this would be 1, not 10.
    expect(fast.renderCount).toBe(10)

    await daemon.stop()
  })

  it('produces zero key writes across many ticks when content does not change', async () => {
    vi.useFakeTimers()
    const device = new FakeDevice()
    const page = new TickPage(100)
    const manager = new PageManager()
    manager.add(page)
    const daemon = new Daemon(device, manager)

    await daemon.start()
    device.reset()
    // 20 ticks of a page that always renders the same content: the dirty-key
    // hash means every one of them is a no-op write.
    await vi.advanceTimersByTimeAsync(2000)
    expect(device.keyWrites).toHaveLength(0)
    expect(device.stripWrites).toBe(0)

    await daemon.stop()
  })

  it('writes on every tick when the animating key actually changes', async () => {
    vi.useFakeTimers()
    const device = new FakeDevice()
    const page = new TickPage(100)
    page.animate = true
    const manager = new PageManager()
    manager.add(page)
    const daemon = new Daemon(device, manager)

    await daemon.start()
    device.reset()
    await vi.advanceTimersByTimeAsync(500)
    // 5 ticks, each with a different millisecond-derived label: 5 writes.
    expect(device.keyWrites.length).toBeGreaterThanOrEqual(4)
    expect(device.keyWrites.length).toBeLessThanOrEqual(5)

    await daemon.stop()
  })
})

describe('Daemon.stop (M1)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Regression coverage for M1: `device.onPress`'s listener is never
  // unregistered by `stop()`, so a press can still arrive afterwards -- the
  // real scenario is `SIGTERM` → `shutdown()` → `await daemon.stop()`, then
  // a press landing while the rest of shutdown (the sources, the device) is
  // still stopping. Without a `stopped` flag, that press called
  // `armTimer()` and created a brand new interval, undoing `stop()`.
  //
  // Lesson 8: the test holds an EARLIER press's own work unresolved across
  // the `stop()` call, so `stop()` genuinely runs while a press is still in
  // flight -- with fake timers and no held promise, the in-flight promise
  // would settle before `stop()` ever ran, the race window would never
  // open, and this test would pass even against the unfixed code.
  it('a press arriving after stop() cannot re-arm the render timer, even if an earlier press was still in flight when stop() was called', async () => {
    vi.useFakeTimers()
    const device = new FakeDevice()
    const slow = new TickPage(1000)
    const fast = new TickPage(100)
    const manager = new PageManager()
    manager.add(slow)
    manager.add(fast)
    const daemon = new Daemon(device, manager)
    await daemon.start()

    // An ordinary key press whose own work has not finished yet -- standing
    // in for something slow in a real page's `onKeyPress` (a shell call in
    // `focusWindow`, say). Held open on purpose; see the Lesson 8 note above.
    let releasePress: (() => void) | undefined
    slow.onKeyPress = () => new Promise<void>((resolve) => { releasePress = resolve })
    device.simulatePress(0)
    await Promise.resolve() // handlePress is now parked inside the held onKeyPress

    await daemon.stop()

    // Let the held press finish. Its own continuation (a render) must not
    // throw and must not do anything further on its own.
    releasePress?.()
    await Promise.resolve()
    await Promise.resolve()

    // The scenario itself: a round button press arrives while the rest of
    // shutdown is still running.
    device.simulatePress(BUTTON_RIGHT)
    await Promise.resolve()
    expect(manager.current()).toBe(slow) // the page did not change

    device.reset()
    await vi.advanceTimersByTimeAsync(5000)
    expect(device.keyWrites).toHaveLength(0) // no interval is running
  })

  it('a press arriving after stop() does not throw or write to the device at all', async () => {
    const device = new FakeDevice()
    const page = new ControlPage()
    const manager = new PageManager()
    manager.add(page)
    const daemon = new Daemon(device, manager)
    await daemon.start()
    await daemon.stop()

    device.reset()
    device.simulatePress(3)
    await Promise.resolve()
    await Promise.resolve()

    expect(page.presses).toEqual([]) // the plain key-press branch bailed too
    expect(device.keyWrites).toHaveLength(0)
  })
})

describe('Daemon press failure logging (M2)', () => {
  it('logs a repeated press failure only once, keyed per index, and logs again after a success clears it', async () => {
    const written: string[] = []
    setDefaultSink((line) => written.push(line))
    try {
      const device = new FakeDevice()
      const page = new ControlPage()
      page.onKeyPress = (i: number) => {
        page.presses.push(i)
        throw new Error('boom')
      }
      const manager = new PageManager()
      manager.add(page)
      const daemon = new Daemon(device, manager)
      await daemon.start()

      // A press repeats: three failures on the same key must log once, not
      // three times -- the M2 defect logged `log.error` unconditionally on
      // every one.
      device.simulatePress(2)
      await flush()
      device.simulatePress(2)
      await flush()
      device.simulatePress(2)
      await flush()

      const failureLines = written.filter((l) => l.includes('press handler failed'))
      expect(failureLines).toHaveLength(1)

      // A different key's failure must still log -- the key is per index,
      // not a single shared one.
      device.simulatePress(5)
      await flush()
      expect(written.filter((l) => l.includes('press handler failed'))).toHaveLength(2)

      // Recovery: key 2 stops failing. The next success clears its key, so
      // a later, genuine failure on key 2 logs again instead of staying
      // suppressed forever (M4's sibling defect, applied here to M2).
      page.onKeyPress = (i: number) => { page.presses.push(i) }
      device.simulatePress(2)
      await flush()

      page.onKeyPress = () => { throw new Error('boom again') }
      device.simulatePress(2)
      await flush()
      expect(written.filter((l) => l.includes('press handler failed'))).toHaveLength(3)

      await daemon.stop()
    } finally {
      setDefaultSink(() => {})
    }
  })
})
