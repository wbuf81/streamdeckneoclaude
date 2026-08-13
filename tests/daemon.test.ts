import { describe, it, expect, vi, afterEach } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { FakeDevice } from '../src/fake-device.js'
import { PageManager } from '../src/page-manager.js'
import { BUTTON_LEFT, BUTTON_RIGHT } from '../src/device.js'
import { setDefaultSink } from '../src/log.js'
import type { Page, PressOutcome } from '../src/pages/types.js'
import type { DeckFrame, KeySpec } from '../src/render/specs.js'
import { keyHash } from '../src/render/specs.js'
import { renderKey, renderStrip } from '../src/render/canvas.js'
import { theme } from '../src/render/theme.js'
import { DEFAULT_BRIGHTNESS, type LockStateReader } from '../src/daemon.js'

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
  enters = 0
  leaves = 0
  /** What `onKeyPress` reports for each key index. Absent means `handled` —
   * so every test that does not care about press feedback keeps working
   * unchanged, and the flash-focused tests below can override one key at a
   * time. */
  outcomes = new Map<number, PressOutcome>()

  render(): DeckFrame {
    const keys: KeySpec[] = Array.from({ length: 8 }, (_, i) =>
      i === 0 ? { kind: 'gauge', lines: this.lines } : { kind: 'blank' })
    return {
      keys,
      strip: { lines: [this.stripText] },
      buttons: [[10, 10, 10], [20, 20, 20]],
    }
  }

  onKeyPress(i: number): PressOutcome {
    this.presses.push(i)
    return this.outcomes.get(i) ?? 'handled'
  }

  onEnter(): void {
    this.enters += 1
  }

  onLeave(): void {
    this.leaves += 1
  }
}

class FakeLockState implements LockStateReader {
  startCalls = 0
  stopCalls = 0
  refreshCalls = 0
  private callbacks: (() => void)[] = []

  constructor(private locked: boolean) {}

  async start(): Promise<void> { this.startCalls += 1 }
  async stop(): Promise<void> { this.stopCalls += 1 }
  async refresh(): Promise<void> { this.refreshCalls += 1 }
  isLocked(): boolean { return this.locked }
  onChange(cb: () => void): void { this.callbacks.push(cb) }

  setLocked(locked: boolean): void {
    if (locked === this.locked) return
    this.locked = locked
    this.callbacks.forEach((cb) => cb())
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

describe('Daemon screen lock privacy', () => {
  afterEach(() => vi.useRealTimers())

  function buildWithLock(initiallyLocked: boolean, clocks?: { seconds(): number; millis(): number }) {
    const device = new FakeDevice()
    const page = new ControlPage()
    const manager = new PageManager()
    manager.add(page)
    const lock = new FakeLockState(initiallyLocked)
    const daemon = new Daemon(
      device,
      manager,
      clocks?.seconds ?? (() => 1),
      clocks?.millis ?? (() => 1000),
      lock,
    )
    return { device, page, manager, lock, daemon }
  }

  it('starts fully blank and dark when the screen is already locked', async () => {
    const { device, page, lock, daemon } = buildWithLock(true)
    await daemon.start()

    expect(lock.startCalls).toBe(1)
    expect(page.leaves).toBe(1)
    expect(device.brightness).toBe(0)
    expect(device.keyWrites).toHaveLength(8)
    const blank = renderKey({ kind: 'blank' })
    for (let i = 0; i < 8; i++) expect(device.keyImages.get(i)?.equals(blank)).toBe(true)
    expect(device.stripImage?.equals(renderStrip({ lines: [] }))).toBe(true)
    expect(device.buttonColors.get(8)).toEqual([0, 0, 0])
    expect(device.buttonColors.get(9)).toEqual([0, 0, 0])

    await daemon.stop()
    expect(lock.stopCalls).toBe(1)
  })

  it('blanks on lock, ignores every press, then fully repaints on unlock', async () => {
    const { device, page, lock, daemon } = buildWithLock(false)
    await daemon.start()
    expect(page.enters).toBe(1) // PageManager entered it once.

    device.reset()
    lock.setLocked(true)
    await flush()
    expect(device.brightness).toBe(0)
    expect(device.keyWrites).toHaveLength(8)
    expect(page.leaves).toBe(1)

    device.simulatePress(0)
    device.simulatePress(BUTTON_RIGHT)
    await flush()
    expect(page.presses).toEqual([])

    device.reset()
    lock.setLocked(false)
    await flush()
    expect(device.brightness).toBe(DEFAULT_BRIGHTNESS)
    expect(device.keyWrites).toHaveLength(8)
    expect(page.enters).toBe(2)

    await daemon.stop()
  })

  it('waits for an in-progress frame, then leaves the blank frame on the glass', async () => {
    const { device, page, lock, daemon } = buildWithLock(false)
    await daemon.start()
    device.reset()
    page.lines = ['sensitive']

    const realSetKeyImage = device.setKeyImage.bind(device)
    let release: (() => void) | undefined
    let held = true
    device.setKeyImage = async (index, image) => {
      if (held) {
        held = false
        await new Promise<void>((resolve) => { release = resolve })
      }
      await realSetKeyImage(index, image)
    }

    const rendering = daemon.renderOnce(2, 2000)
    await Promise.resolve()
    lock.setLocked(true)
    release?.()
    await rendering
    await flush()

    const blank = renderKey({ kind: 'blank' })
    for (let i = 0; i < 8; i++) expect(device.keyImages.get(i)?.equals(blank)).toBe(true)
    expect(device.brightness).toBe(0)
    await daemon.stop()
  })

  it('still turns brightness off when a pixel write fails during lock blanking', async () => {
    const { device, lock, daemon } = buildWithLock(false)
    await daemon.start()
    device.setKeyImage = async () => { throw new Error('usb write failed') }

    lock.setLocked(true)
    await flush()

    expect(device.brightness).toBe(0)
    await daemon.stop()
  })

  it('re-probes after a sleep-sized clock jump and forces a full repaint', async () => {
    vi.useFakeTimers()
    let ms = 1000
    const clocks = { seconds: () => Math.floor(ms / 1000), millis: () => ms }
    const { device, lock, daemon } = buildWithLock(false, clocks)
    await daemon.start()
    device.reset()

    ms = 12_000
    await vi.advanceTimersByTimeAsync(1000)

    expect(lock.refreshCalls).toBe(1)
    expect(device.keyWrites).toHaveLength(8)
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

  onKeyPress(): PressOutcome {
    return 'ignored'
  }
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

  it('follows a page that changes its own tickMs without a page change', async () => {
    // The Spotify page asks for a fast tick only while it animates its idle
    // state. Reading `tickMs` solely on a page switch would freeze that
    // animation until the user flipped pages and back — the same defect the
    // user already reported once for the Spotify page not loading.
    vi.useFakeTimers()
    const device = new FakeDevice()
    const page = new TickPage(undefined)
    const manager = new PageManager()
    manager.add(page)
    const daemon = new Daemon(device, manager)

    await daemon.start()
    await vi.advanceTimersByTimeAsync(1000)

    // The page now wants 100 ms, with no page change to announce it.
    page.tickMs = 100
    // The next tick at the OLD rate is what notices the change and re-arms, so
    // give it that tick before measuring. Measuring across it would see the old
    // slow rate and pass for the wrong reason.
    await vi.advanceTimersByTimeAsync(1000)

    page.renderCount = 0
    await vi.advanceTimersByTimeAsync(1000)

    // Now the timer runs at 100 ms, so this is near 10 rather than 1.
    expect(page.renderCount).toBeGreaterThan(5)
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
      page.onKeyPress = (i: number) => { page.presses.push(i); return 'handled' }
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

/**
 * Task 32: the press-feedback flash moved out of the Claude page (its only
 * previous home) and into the daemon, so every page gets it. These tests
 * exercise the mechanism itself, independent of any one page's own logic --
 * the pages' own tests (`tests/pages/*.test.ts`) separately prove each page
 * reports the right outcome for each of its keys.
 */
describe('Daemon press-feedback flash', () => {
  /** A `ControlPage` behind a daemon whose clock is a plain mutable number,
   * so a test can place a press and a later render at exact, deterministic
   * millisecond offsets -- the flash's own anchoring logic is what these
   * tests are proving, and that logic is defined entirely in terms of
   * `nowMs`. */
  function buildFlash() {
    const device = new FakeDevice()
    const page = new ControlPage()
    const manager = new PageManager()
    manager.add(page)
    let ms = 1000
    const daemon = new Daemon(device, manager, () => Math.floor(ms / 1000), () => ms)
    return { device, page, manager, daemon, setMs: (v: number) => { ms = v } }
  }

  const whiteFlash = () => renderKey({ kind: 'gauge', bg: theme.white })
  const redFlash = () => renderKey({ kind: 'gauge', bg: theme.red })
  const plainKeyA = () => renderKey({ kind: 'gauge', lines: ['A'] })

  it('flashes a handled press white, then reverts to the page’s own content', async () => {
    const { device, daemon, setMs } = buildFlash()
    await daemon.start() // ms = 1000; the first render draws no flash.
    device.reset()

    device.simulatePress(0) // ControlPage's default outcome is 'handled'.
    await flush()
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    device.reset()
    setMs(1260) // past the 250 ms window, anchored at the press-render (ms 1000)
    await daemon.renderOnce(1, 1260)
    expect(device.keyImages.get(0)?.equals(plainKeyA())).toBe(true)

    await daemon.stop()
  })

  it('flashes an ignored press red', async () => {
    const { device, page, daemon } = buildFlash()
    await daemon.start()
    device.reset()
    page.outcomes.set(0, 'ignored')

    device.simulatePress(0)
    await flush()
    expect(device.keyImages.get(0)?.equals(redFlash())).toBe(true)

    await daemon.stop()
  })

  it('flashes a failed press red too — red already means "nothing happened", whether ignored or failed', async () => {
    const { device, page, daemon } = buildFlash()
    await daemon.start()
    device.reset()
    page.outcomes.set(0, 'failed')

    device.simulatePress(0)
    await flush()
    expect(device.keyImages.get(0)?.equals(redFlash())).toBe(true)

    await daemon.stop()
  })

  it('a page that throws in onKeyPress flashes red and does not crash the daemon', async () => {
    const written: string[] = []
    setDefaultSink((line) => written.push(line))
    try {
      const { device, page, daemon } = buildFlash()
      await daemon.start()
      device.reset()
      page.onKeyPress = () => { throw new Error('boom') }

      device.simulatePress(0)
      await flush()
      expect(device.keyImages.get(0)?.equals(redFlash())).toBe(true)

      // The daemon survives the throw: a later, ordinary press on the same
      // key still works, and still gets its own (white) flash.
      page.onKeyPress = (i: number) => { page.presses.push(i); return 'handled' }
      device.simulatePress(0)
      await flush()
      expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

      await daemon.stop()
    } finally {
      setDefaultSink(() => {})
    }
  })

  /** A page whose `onKeyPress` does not resolve until the test releases it,
   * so a test can prove the daemon waits for the real outcome instead of
   * drawing a flash off a guess. */
  class AsyncOutcomePage implements Page {
    readonly name = 'async'
    gate: Promise<void> = Promise.resolve()
    outcome: PressOutcome = 'handled'

    render(): DeckFrame {
      const keys: KeySpec[] = Array.from({ length: 8 }, (_, i) =>
        i === 0 ? { kind: 'gauge', lines: ['A'] } : { kind: 'blank' })
      return { keys, strip: { lines: ['async'] }, buttons: [[0, 0, 0], [0, 0, 0]] }
    }

    async onKeyPress(): Promise<PressOutcome> {
      await this.gate
      return this.outcome
    }
  }

  it('awaits an async page’s outcome before drawing the flash', async () => {
    const device = new FakeDevice()
    const page = new AsyncOutcomePage()
    let release: () => void = () => {}
    page.gate = new Promise((resolve) => { release = resolve })
    const manager = new PageManager()
    manager.add(page)
    const daemon = new Daemon(device, manager)
    await daemon.start()
    device.reset()

    device.simulatePress(0)
    await Promise.resolve()
    await Promise.resolve()
    // The press is parked inside the still-open gate: nothing has been
    // written to the device yet, because the daemon has not rendered at all.
    expect(device.keyWrites).toHaveLength(0)

    release()
    await flush()
    // Now the outcome has resolved, and the flash it earned is on the glass.
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    await daemon.stop()
  })

  it('is per key: flashing key 0 does not touch key 1', async () => {
    const { device, daemon } = buildFlash()
    await daemon.start() // the first full render writes every key, key 1 blank.
    const key1Before = device.keyImages.get(1)

    device.simulatePress(0)
    await flush()

    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)
    // Key 1's own content never changed, so the dirty-key check never
    // rewrote it -- still the exact same buffer from the first render.
    expect(device.keyImages.get(1)).toBe(key1Before)

    await daemon.stop()
  })

  it('an expired flash leaves no trace in keyHash, so the key stops being redrawn', async () => {
    // The flash and the page's own content hash differently -- otherwise
    // there would be nothing to leave a trace of in the first place.
    expect(keyHash({ kind: 'gauge', bg: theme.white })).not.toBe(keyHash({ kind: 'gauge', lines: ['A'] }))

    const { device, daemon, setMs } = buildFlash()
    await daemon.start()
    device.reset()

    device.simulatePress(0)
    await flush()
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    // Well past the 250 ms window: the key reverts, written back to its own
    // plain content exactly once.
    device.reset()
    setMs(1500)
    await daemon.renderOnce(1, 1500)
    expect(device.keyWrites).toEqual([{ index: 0, bytes: expect.any(Number) }])

    // A LATER tick, nothing else changed: the hash the daemon compares
    // against carries no lingering trace of the flash, so this is a true
    // no-op -- exactly the guarantee lesson 11 exists to protect.
    device.reset()
    setMs(1600)
    await daemon.renderOnce(1, 1600)
    expect(device.keyWrites).toHaveLength(0)

    await daemon.stop()
  })

  it('a round-button press flips the page without drawing any flash, for either button', async () => {
    const device = new FakeDevice()
    const pageA = new ControlPage()
    const pageB = new ControlPage()
    pageB.lines = ['B']
    const manager = new PageManager()
    manager.add(pageA)
    manager.add(pageB)
    const daemon = new Daemon(device, manager)
    await daemon.start() // the first full render writes every key of pageA.

    device.simulatePress(BUTTON_RIGHT) // pageA -> pageB
    await flush()
    expect(device.keyImages.get(0)?.equals(renderKey({ kind: 'gauge', lines: ['B'] }))).toBe(true)

    device.simulatePress(BUTTON_LEFT) // pageB -> pageA
    await flush()
    expect(device.keyImages.get(0)?.equals(plainKeyA())).toBe(true)

    // Every key ever written across start and both page flips -- never a
    // flash fill, since neither round button ever calls `setFlash`.
    const white = whiteFlash()
    const red = redFlash()
    for (const img of device.keyImages.values()) {
      expect(img.equals(white)).toBe(false)
      expect(img.equals(red)).toBe(false)
    }

    await daemon.stop()
  })

  it('the flash survives a change-driven render on the following tick', async () => {
    // The exact regression two reviewers found independently: a render
    // triggered by a source `change` event, moments after the press, must
    // not swallow the flash. It must show for the flash's full window
    // regardless of how many renders land inside it.
    const { device, daemon, setMs } = buildFlash()
    await daemon.start() // ms = 1000
    device.reset()

    device.simulatePress(0) // the press-render happens at ms 1000, anchoring expiry at 1250
    await flush()
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    setMs(1100) // still well within the 250 ms window
    await daemon.renderOnce(1, 1100)
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    await daemon.stop()
  })
})
