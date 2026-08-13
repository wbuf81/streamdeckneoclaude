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

/** A page whose content the test controls. `name` defaults to `'test'`, but
 * a test proving the flash is scoped per page (M3) needs two instances with
 * DIFFERENT names. */
class ControlPage implements Page {
  readonly name: string
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

  constructor(name = 'test') {
    this.name = name
  }

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

  onKeyPress(): PressOutcome | Promise<PressOutcome> {
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
    // Resolves to a real `PressOutcome`, not `undefined` (I8) — this used
    // to be `Promise<void>`, which `tsc` never caught because `tests/` was
    // outside `tsconfig.json`'s `include`. The mismatch was silent: an
    // `undefined` outcome compares `!== 'handled'`, so it happened to still
    // produce a (wrong-coloured) flash rather than a crash, which is why the
    // suite stayed green regardless.
    slow.onKeyPress = () => new Promise<PressOutcome>((resolve) => { releasePress = () => resolve('handled') })
    device.simulatePress(0)
    await Promise.resolve() // handlePress is now parked inside the held onKeyPress

    // Reset BEFORE stop(), not after resolving the held press -- the
    // original form of this test called `device.reset()` here, which
    // silently discarded the very write M1 is about (the held press's own
    // continuation, resolving AFTER `stop()`, used to still reach the
    // device) before the assertion below ever counted it.
    device.reset()
    await daemon.stop()

    // Let the held press finish. Its own continuation (a render) must not
    // throw, and per M1, must not write a ring to the device now that the
    // daemon has stopped -- `renderOnce` checks `stopped` for exactly this.
    releasePress?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(device.keyWrites).toHaveLength(0) // M1: no post-stop write

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

  // The flash keeps the key's own content (`lines: ['A']`) and only adds
  // the ring on top -- task 36 moved away from a solid `bg` fill because it
  // read as too bright on real hardware.
  const whiteFlash = () => renderKey({ kind: 'gauge', lines: ['A'], flashRing: theme.flashWhite })
  const redFlash = () => renderKey({ kind: 'gauge', lines: ['A'], flashRing: theme.flashRed })
  const plainKeyA = () => renderKey({ kind: 'gauge', lines: ['A'] })

  it('flashes a handled press white, then reverts to the page’s own content', async () => {
    const { device, daemon, setMs } = buildFlash()
    await daemon.start() // ms = 1000; the first render draws no flash.
    device.reset()

    device.simulatePress(0) // ControlPage's default outcome is 'handled'.
    await flush()
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    device.reset()
    setMs(1260) // past the 150 ms window, anchored at the press-render (ms 1000)
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

  it('clears the ring on its own, without waiting for the page tick', async () => {
    // `ControlPage` sets no `tickMs`, so it renders at DEFAULT_TICK_MS (1000).
    // Before task 36's follow-up nothing scheduled a render at expiry, so the
    // ring survived until that next tick -- up to a full second on this page,
    // whatever FLASH_MS said. Lowering FLASH_MS alone changed nothing here.
    // This test uses REAL timers and waits far less than one tick, so a pass
    // can only mean the daemon cleared the ring itself.
    const { device, daemon, setMs } = buildFlash()
    await daemon.start()
    device.reset()

    device.simulatePress(0)
    await flush()
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    // Move the injected clock past the flash's expiry, then wait 250 real ms:
    // long enough for the daemon's own clearing timer, far short of the 1000 ms
    // page tick.
    setMs(5000)
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(device.keyImages.get(0)?.equals(plainKeyA())).toBe(true)
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

  /** Two pages, both async in `onKeyPress`, so a test can flip pages WHILE a
   * press's own outcome is still pending -- the exact window r3's C1 finding
   * closes. `ControlPage`'s `onKeyPress` is synchronous, so no test built on
   * it can open this window at all. */
  class AsyncFlipPage implements Page {
    gate: Promise<void> = Promise.resolve()
    outcome: PressOutcome = 'handled'
    constructor(readonly name: string, private readonly line: string) {}

    render(): DeckFrame {
      const keys: KeySpec[] = Array.from({ length: 8 }, (_, i) =>
        i === 0 ? { kind: 'gauge', lines: [this.line] } : { kind: 'blank' })
      return { keys, strip: { lines: [this.name] }, buttons: [[0, 0, 0], [0, 0, 0]] }
    }

    async onKeyPress(): Promise<PressOutcome> {
      await this.gate
      return this.outcome
    }
  }

  /**
   * R3 review, C1: `setFlash` used to read `this.pages.current().name` (and
   * the clock) AFTER awaiting `onKeyPress` -- so a press whose own work is
   * still running when the user flips pages got tagged with the NEW page,
   * and drawn there: a ring on a key the user never pressed, on a page that
   * was not even visible when the press landed. Probe-confirmed by the
   * review: pressing key 2 on Spotify, then flipping during its HTTP await,
   * put a ring on the Stocks page's key 2. Capturing the page and clock
   * BEFORE the await closes this.
   */
  it('tags the flash with the page CURRENT AT PRESS TIME, not whatever page is current once the press resolves (C1)', async () => {
    const device = new FakeDevice()
    const pageA = new AsyncFlipPage('pageA', 'A')
    const pageB = new AsyncFlipPage('pageB', 'B')
    let release: () => void = () => {}
    pageA.gate = new Promise((resolve) => { release = resolve })
    const manager = new PageManager()
    manager.add(pageA)
    manager.add(pageB)
    let ms = 1000
    const daemon = new Daemon(device, manager, () => Math.floor(ms / 1000), () => ms)
    await daemon.start() // pageA is current; first render writes every key.

    device.simulatePress(0) // pageA's onKeyPress parks inside the held gate, at ms 1000
    await Promise.resolve()
    await Promise.resolve()

    // The user flips pages WHILE the press is still in flight -- an ordinary
    // "press play, then flip to Stocks" sequence, not an edge case.
    ms = 1010
    device.simulatePress(BUTTON_RIGHT) // pageA -> pageB
    await flush()
    expect(device.keyImages.get(0)?.equals(renderKey({ kind: 'gauge', lines: ['B'] }))).toBe(true)

    // Now the held press resolves. pageB is current at this instant, but the
    // press landed on pageA, at ms 1000.
    release()
    await flush()

    // The flash must never appear on pageB's key 0 -- pageB is current now,
    // but the user never pressed it, and it was not even visible at press
    // time. Under the C1 bug, `setFlash` would have tagged this flash with
    // pageB (read after the await), and `applyFlash` would have drawn it
    // right here, on a key the user never touched.
    expect(device.keyImages.get(0)?.equals(renderKey({ kind: 'gauge', lines: ['B'] }))).toBe(true)

    // Flipping BACK to pageA proves the flash truly disappeared rather than
    // lurking somewhere invisible: `applyFlash` discards a flash the FIRST
    // render it ever sees mismatched (the pageB render above), so it cannot
    // resurface here either -- pageA's key 0 must show its own plain
    // content, still with no ring, exactly like the M3 flip-discard tests
    // already prove for a flash that WAS drawn before the flip.
    ms = 1020
    device.simulatePress(BUTTON_LEFT) // pageB -> pageA
    await flush()
    expect(device.keyImages.get(0)?.equals(renderKey({ kind: 'gauge', lines: ['A'] }))).toBe(true)

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
    expect(keyHash({ kind: 'gauge', lines: ['A'], flashRing: theme.flashWhite }))
      .not.toBe(keyHash({ kind: 'gauge', lines: ['A'] }))

    const { device, daemon, setMs } = buildFlash()
    await daemon.start()
    device.reset()

    device.simulatePress(0)
    await flush()
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    // Well past the 150 ms window: the key reverts, written back to its own
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

    device.simulatePress(0) // the press-render happens at ms 1000, anchoring expiry at 1090
    await flush()
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    setMs(1040) // still inside the 90 ms window
    await daemon.renderOnce(1, 1040)
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    await daemon.stop()
  })

  /**
   * R2 review, I1: a press whose render lands while another render is
   * already writing to the device used to draw NO ring at all -- the flash
   * stayed pending (`expiresAtMs === null`) until whatever render happened
   * to come next, up to a full second on a 1000 ms page. Proven here by
   * holding a device write open across a press, exactly like the review's
   * `flash.probe.test.ts`.
   */
  it('shows a press’s ring promptly even when the render it earned landed mid-write (I1)', async () => {
    const { device, page, daemon } = buildFlash()
    await daemon.start()
    device.reset()
    page.lines = ['sensitive'] // gives the in-flight render something to write

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

    // An ordinary render, not press-triggered, holding key 0's write open.
    const rendering = daemon.renderOnce(1, 1010)
    await Promise.resolve()

    // The press lands while that render is still in flight.
    device.simulatePress(0)
    await flush()

    release?.()
    await rendering // the held render finishes, then its own follow-up runs
    await flush()

    expect(
      device.keyImages
        .get(0)
        ?.equals(renderKey({ kind: 'gauge', lines: ['sensitive'], flashRing: theme.flashWhite })),
    ).toBe(true)

    await daemon.stop()
  })

  /**
   * R2 review, I2: the render that clears a flash on time can itself be
   * dropped for finding the pipeline busy -- exactly the render this test
   * simulates with an unrelated held write. Before this fix, nothing ever
   * re-armed a replacement, so the ring survived far past `FLASH_MS`
   * (measured on the probe: still up 200 ms and 450 ms after a 90 ms
   * flash). Here, nothing but the daemon's own re-arming clears the ring --
   * the page's tick is never advanced.
   */
  it('re-arms after a dropped clearing attempt, so the ring does not survive it (I2)', async () => {
    const { device, page, daemon, setMs } = buildFlash()
    await daemon.start()
    device.reset()

    device.simulatePress(0) // anchors key 0's expiry at ms 1000 + 90 = 1090
    await flush()
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    // An unrelated render, held open past the flash's own expiry -- standing
    // in for the pump's scheduled clearing render finding the daemon busy.
    page.lines = ['B']
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
    const busy = daemon.renderOnce(1, 1010)
    await Promise.resolve()

    // The flash's own clearing attempt lands while that write is still
    // held, and is dropped -- the exact failure I2 describes.
    setMs(1091)
    await daemon.renderOnce(1, 1091)

    // Release the held write. Nothing else in this test drives another
    // render from here.
    release?.()
    await busy
    await flush()

    expect(device.keyImages.get(0)?.equals(renderKey({ kind: 'gauge', lines: ['B'] }))).toBe(true)

    await daemon.stop()
  })

  /**
   * R2 review, I3: one shared timer, re-armed at `FLASH_MS + 1` from
   * whichever press was most recent, let a later press extend an earlier
   * key's ring past its own schedule (measured on the probe: about 211 ms
   * for a flash specified as 90). Recomputing the earliest pending expiry
   * after every render, instead of re-arming blindly from "now", fixes
   * this: key 0's ring here is gone by its own deadline regardless of key
   * 1's later press.
   */
  it('never lets a later press extend an earlier key’s ring past its own schedule (I3)', async () => {
    // This has to let the daemon's OWN scheduled timer fire, not drive
    // `renderOnce` by hand -- the I3 bug was entirely about WHEN that timer
    // re-arms, which a manual render call cannot exercise. Real waits, per
    // the existing "clears the ring on its own" test's own pattern: the
    // logical clock (via `setMs`) determines whether a fired render sees a
    // flash as expired, and the real wait is what lets the timer itself
    // fire on its own schedule.
    const { device, daemon, setMs } = buildFlash()
    await daemon.start() // ms = 1000
    device.reset()

    device.simulatePress(0) // anchors key 0's expiry at 1000 + 90 = 1090
    await flush()
    expect(device.keyImages.get(0)?.equals(whiteFlash())).toBe(true)

    setMs(1060)
    device.simulatePress(1) // anchors key 1's expiry at 1060 + 90 = 1150
    await flush()

    // Move the logical clock just past key 0's OWN deadline, well before
    // key 1's, then wait in REAL time for the daemon's own timer to fire.
    // Old code re-armed its one shared timer to fire 91 REAL ms after
    // whichever press was most recent (key 1's, here) -- about 91 ms from
    // now. This wait is comfortably shorter than that, so a pass can only
    // mean the NEW code's timer, re-targeted to key 0's earlier deadline,
    // fired on its own.
    setMs(1091)
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(device.keyImages.get(0)?.equals(renderKey({ kind: 'gauge', lines: ['A'] }))).toBe(true)
    // Key 1's own deadline (1150) has not arrived yet -- its ring must still
    // be showing, not cleared early by key 0's timer.
    expect(
      device.keyImages.get(1)?.equals(renderKey({ kind: 'blank', flashRing: theme.flashWhite })),
    ).toBe(true)

    // Key 1 clears on ITS OWN deadline shortly after.
    setMs(1151)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(device.keyImages.get(1)?.equals(renderKey({ kind: 'blank' }))).toBe(true)

    await daemon.stop()
  })

  /**
   * R2 review, M3: a flash was keyed by key index only, never by page.
   * Proven by probe (`flash3.probe.test.ts`): press key 0 on one page, flip
   * within the flash's window, and the OTHER page's key 0 -- a key the user
   * never pressed, on a page that was not even visible at press time --
   * shows the ring too. Tagging the flash with the page it was earned on,
   * and discarding it the moment that page no longer matches, closes this.
   */
  it('does not bleed a pending ring onto a different page’s same key after a flip (M3)', async () => {
    const device = new FakeDevice()
    const pageA = new ControlPage('pageA')
    const pageB = new ControlPage('pageB')
    pageB.lines = ['B']
    const manager = new PageManager()
    manager.add(pageA)
    manager.add(pageB)
    let ms = 1000
    const daemon = new Daemon(device, manager, () => Math.floor(ms / 1000), () => ms)
    await daemon.start()

    device.simulatePress(0) // handled, on pageA; anchors at ms 1000, expires 1090
    await flush()
    expect(
      device.keyImages.get(0)?.equals(renderKey({ kind: 'gauge', lines: ['A'], flashRing: theme.flashWhite })),
    ).toBe(true)

    ms = 1030 // still well inside the flash's 90 ms window
    device.simulatePress(BUTTON_RIGHT) // flips to pageB
    await flush()

    expect(device.keyImages.get(0)?.equals(renderKey({ kind: 'gauge', lines: ['B'] }))).toBe(true)

    await daemon.stop()
  })

  /**
   * R2 review, M3's longer-lived variant: a flash whose press-render never
   * ran at all (here, the device disconnects right after the press) used to
   * keep `expiresAtMs === null` indefinitely and could first be drawn
   * minutes later, at reconnect or unlock. Bounding how long a flash may sit
   * pending closes this: reconnecting long after the press discards it
   * instead of drawing it late.
   */
  it('discards a flash that never got a chance to render before it aged out (M3 age bound)', async () => {
    const { device, daemon, setMs } = buildFlash()
    await daemon.start() // ms = 1000
    device.reset()

    await device.disconnect()
    device.simulatePress(0) // records a pending flash; renderOnce bails: not connected
    await flush()
    expect(device.keyWrites).toHaveLength(0)

    setMs(10_000) // long past the pending-flash age bound
    await device.connect() // triggers the daemon's own reconnect handler
    await flush()

    expect(device.keyImages.get(0)?.equals(renderKey({ kind: 'gauge', lines: ['A'] }))).toBe(true)

    await daemon.stop()
  })

  /**
   * R3 review, C2: a flash is cleared only inside `applyFlash`, which runs
   * only when a render's page-building step succeeds far enough to reach
   * `overlayFlashes`. A page that throws in `render()` -- a case
   * `runRender`'s own comment anticipates -- never gets there, so a flash
   * already past its anchored expiry stayed exactly that far past it on
   * every following attempt, and `scheduleFlashPump` re-armed at delay 0
   * every time: measured on the review's own probe at about 850
   * `page.render()` calls per second, indefinitely, from one press and one
   * broken page. This asserts a BOUNDED call count over a fixed span, not
   * merely that the loop eventually stops -- a slow leak could satisfy the
   * weaker claim too.
   */
  it('bounds the flash pump to a small, finite number of extra renders when page.render() throws, instead of spinning forever (C2)', async () => {
    vi.useFakeTimers()
    try {
      class ThrowingPage implements Page {
        readonly name = 'throwing'
        readonly tickMs = 100_000 // so only the flash pump can drive a render here
        renderCount = 0
        throwing = false

        render(): DeckFrame {
          this.renderCount += 1
          if (this.throwing) throw new Error('boom')
          const keys: KeySpec[] = Array.from({ length: 8 }, () => ({ kind: 'blank' as const }))
          return { keys, strip: { lines: ['x'] }, buttons: [[0, 0, 0], [0, 0, 0]] }
        }

        onKeyPress(): PressOutcome {
          return 'handled'
        }
      }

      const device = new FakeDevice()
      const page = new ThrowingPage()
      const manager = new PageManager()
      manager.add(page)
      const daemon = new Daemon(device, manager)
      await daemon.start() // succeeds; anchors nothing yet.

      device.simulatePress(0) // anchors a flash, expiring 90ms later; this render still succeeds.
      await vi.advanceTimersByTimeAsync(0)

      page.throwing = true // every render from here on throws.
      page.renderCount = 0

      // 5 seconds of fake time. The old code rendered about 850 times PER
      // SECOND, indefinitely -- thousands of calls here. The fix bounds this
      // to a handful: the flash's own already-armed expiry firing once (and
      // being pruned on the clock, independent of the render ever
      // succeeding), not a tight loop.
      await vi.advanceTimersByTimeAsync(5000)

      expect(page.renderCount).toBeLessThan(10)

      await daemon.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
