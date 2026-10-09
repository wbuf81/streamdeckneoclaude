import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ACK_LEVELS,
  ACK_OK_RGB,
  ACK_REJECT_RGB,
  ACK_STEP_MS,
  Daemon,
  PAGE_NAME_MS,
  WIPE_STEP_MS,
  pageNameStrip,
  cameoSprite,
  CAMEO_MS,
  CAMEO_PERIOD_MS,
  type LockStateReader,
} from '../src/daemon.js'
import { FakeDevice } from '../src/fake-device.js'
import { PageManager } from '../src/page-manager.js'
import { BUTTON_LEFT, BUTTON_RIGHT } from '../src/device.js'
import type { Page, PressOutcome } from '../src/pages/types.js'
import type { DeckFrame, KeySpec, Rgb } from '../src/render/specs.js'
import { renderKey, renderStrip, STRIP_HEIGHT, STRIP_WIDTH } from '../src/render/canvas.js'
import { theme } from '../src/render/theme.js'

/** A page whose eight keys all differ from every other page's, so a page
 * change rewrites every key and the write log shows the wipe's order. */
class NamedPage implements Page {
  presses: number[] = []
  constructor(readonly name: string, readonly button: Rgb = [40, 80, 120]) {}
  key(i: number): KeySpec {
    return { kind: 'gauge', lines: [`${this.name}${i}`] }
  }
  render(): DeckFrame {
    return {
      keys: Array.from({ length: 8 }, (_, i) => this.key(i)),
      strip: { lines: [`${this.name} strip`] },
      buttons: [this.button, this.button],
    }
  }
  onKeyPress(i: number): PressOutcome {
    this.presses.push(i)
    return 'handled'
  }
}

class Lock implements LockStateReader {
  private cbs: (() => void)[] = []
  locked = false
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async refresh(): Promise<void> {}
  isLocked(): boolean { return this.locked }
  onChange(cb: () => void): void { this.cbs.push(cb) }
  set(locked: boolean): void {
    this.locked = locked
    this.cbs.forEach((cb) => cb())
  }
}

interface Logged { at: number; index: number }

/** Builds a daemon over `pages`, with every key and button write logged
 * against the (faked) clock. */
async function build(pages: NamedPage[], lock: Lock | null = null) {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const device = new FakeDevice()
  const keyLog: Logged[] = []
  const buttonLog: { at: number; index: number; rgb: Rgb }[] = []
  const setKey = device.setKeyImage.bind(device)
  device.setKeyImage = async (index, png) => {
    await setKey(index, png)
    keyLog.push({ at: Date.now(), index })
  }
  const setButton = device.setButtonColor.bind(device)
  device.setButtonColor = async (index, rgb) => {
    await setButton(index, rgb)
    buttonLog.push({ at: Date.now(), index, rgb })
  }
  const manager = new PageManager()
  pages.forEach((p) => manager.add(p))
  const daemon = new Daemon(device, manager, undefined, undefined, lock)
  await daemon.start()
  keyLog.length = 0
  buttonLog.length = 0
  device.stripWrites = 0
  return { device, daemon, manager, keyLog, buttonLog, t0: Date.now() }
}

/** The page's own image for key `i`. */
const imageOf = (page: NamedPage, i: number) => renderKey(page.key(i))

/** Groups a key-write log into the columns written at each offset from `t0`. */
function columnsByTime(log: Logged[], t0: number): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const w of log) {
    const list = out.get(w.at - t0) ?? []
    list.push(w.index)
    out.set(w.at - t0, list)
  }
  for (const list of out.values()) list.sort((a, b) => a - b)
  return out
}

afterEach(() => {
  vi.useRealTimers()
})

describe('page wipe', () => {
  it('right button: reveals the new page column by column, left to right, 45 ms apart', async () => {
    const a = new NamedPage('a')
    const b = new NamedPage('b')
    const { device, daemon, keyLog, t0 } = await build([a, b])

    device.simulatePress(BUTTON_RIGHT)
    await vi.advanceTimersByTimeAsync(0)
    // Only column 0 so far; the old page's other columns stay on the glass.
    expect(device.keyImages.get(0)?.equals(imageOf(b, 0))).toBe(true)
    expect(device.keyImages.get(3)?.equals(imageOf(a, 3))).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    expect([...columnsByTime(keyLog, t0)]).toEqual([
      [0, [0, 4]],
      [WIPE_STEP_MS, [1, 5]],
      [2 * WIPE_STEP_MS, [2, 6]],
      [3 * WIPE_STEP_MS, [3, 7]],
    ])
    // Each key is written exactly once per page change.
    expect(keyLog).toHaveLength(8)
    for (let i = 0; i < 8; i++) expect(device.keyImages.get(i)?.equals(imageOf(b, i))).toBe(true)
    await daemon.stop()
  })

  it('left button: reveals right to left', async () => {
    const a = new NamedPage('a')
    const b = new NamedPage('b')
    const { device, daemon, keyLog, t0 } = await build([a, b])

    device.simulatePress(BUTTON_LEFT) // a -> b, wrapping backwards
    await vi.advanceTimersByTimeAsync(500)
    expect([...columnsByTime(keyLog, t0)]).toEqual([
      [0, [3, 7]],
      [WIPE_STEP_MS, [2, 6]],
      [2 * WIPE_STEP_MS, [1, 5]],
      [3 * WIPE_STEP_MS, [0, 4]],
    ])
    for (let i = 0; i < 8; i++) expect(device.keyImages.get(i)?.equals(imageOf(b, i))).toBe(true)
    await daemon.stop()
  })

  it('a second page change mid-wipe restarts toward the newest page and leaves no stale column', async () => {
    const a = new NamedPage('a')
    const b = new NamedPage('b')
    const c = new NamedPage('c')
    const { device, daemon, manager, keyLog } = await build([a, b, c])

    device.simulatePress(BUTTON_RIGHT) // a -> b, left to right
    await vi.advanceTimersByTimeAsync(WIPE_STEP_MS + 5) // columns 0 and 1 show b
    keyLog.length = 0
    device.simulatePress(BUTTON_RIGHT) // b -> c
    await vi.advanceTimersByTimeAsync(0)
    // The wipe restarted at column 0 for c. The old wipe would have let
    // columns 0 AND 1 through at once.
    expect(keyLog.map((w) => w.index).sort()).toEqual([0, 4])

    await vi.advanceTimersByTimeAsync(10)
    device.simulatePress(BUTTON_LEFT) // c -> b, reversing mid-wipe
    await vi.advanceTimersByTimeAsync(WIPE_STEP_MS)
    device.simulatePress(BUTTON_RIGHT) // b -> c
    await vi.advanceTimersByTimeAsync(WIPE_STEP_MS)
    device.simulatePress(BUTTON_LEFT) // c -> b
    await vi.advanceTimersByTimeAsync(5)
    device.simulatePress(BUTTON_LEFT) // b -> a
    await vi.advanceTimersByTimeAsync(PAGE_NAME_MS + 100)

    expect(manager.current()).toBe(a)
    for (let i = 0; i < 8; i++) expect(device.keyImages.get(i)?.equals(imageOf(a, i))).toBe(true)
    await daemon.stop()
  })

  it('a lock during a wipe blanks every key at once, and unlock paints the whole page at once', async () => {
    const lock = new Lock()
    const a = new NamedPage('a')
    const b = new NamedPage('b')
    const { device, daemon, keyLog } = await build([a, b], lock)

    device.simulatePress(BUTTON_LEFT)
    await vi.advanceTimersByTimeAsync(10)
    keyLog.length = 0
    lock.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(keyLog.map((w) => w.index).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(device.brightness).toBe(0)

    // Unlock while the wipe would still be running: the whole page lands in
    // one frame, not behind a resumed wipe.
    keyLog.length = 0
    lock.set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(keyLog.map((w) => w.index).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    for (let i = 0; i < 8; i++) expect(device.keyImages.get(i)?.equals(imageOf(b, i))).toBe(true)

    // And a lock that lasts past the wipe writes nothing behind the blank.
    lock.set(true)
    await vi.advanceTimersByTimeAsync(0)
    device.simulatePress(BUTTON_RIGHT) // ignored while locked
    keyLog.length = 0
    await vi.advanceTimersByTimeAsync(500)
    expect(keyLog).toHaveLength(0)
    await daemon.stop()
  })

  it('a reconnect during a wipe writes every key of the new page at once', async () => {
    const a = new NamedPage('a')
    const b = new NamedPage('b')
    const { device, daemon, keyLog } = await build([a, b])

    device.simulatePress(BUTTON_LEFT)
    await vi.advanceTimersByTimeAsync(10)
    keyLog.length = 0
    await daemon.handleReconnect()
    expect(keyLog.map((w) => w.index).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    for (let i = 0; i < 8; i++) expect(device.keyImages.get(i)?.equals(imageOf(b, i))).toBe(true)
    // The strip is the page's own again, not the name flash.
    expect(device.stripImage?.equals(renderStrip(b.render().strip))).toBe(true)
    await daemon.stop()
  })

  it('a press during the wipe goes to the new page, draws its ring at once, and clears it before the column arrives', async () => {
    const a = new NamedPage('a')
    const b = new NamedPage('b')
    const { device, daemon } = await build([a, b])

    device.simulatePress(BUTTON_LEFT) // right-to-left: key 0 is the last column, at 135 ms
    await vi.advanceTimersByTimeAsync(5)
    device.simulatePress(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(b.presses).toEqual([0])
    expect(a.presses).toEqual([])
    expect(device.keyImages.get(0)?.equals(renderKey({ ...b.key(0), flashRing: theme.flashWhite }))).toBe(true)

    // The ring expires at about 95 ms, before the wipe reaches column 0. The
    // key must still be written back without its ring.
    await vi.advanceTimersByTimeAsync(110)
    expect(device.keyImages.get(0)?.equals(imageOf(b, 0))).toBe(true)
    await daemon.stop()
  })
})

describe('page-name strip', () => {
  it('shows the new page name for about a second, then the page’s own strip', async () => {
    const a = new NamedPage('a')
    const b = new NamedPage('weather')
    const { device, daemon } = await build([a, b])

    device.simulatePress(BUTTON_RIGHT)
    await vi.advanceTimersByTimeAsync(0)
    expect(device.stripImage?.equals(renderStrip(pageNameStrip('weather')))).toBe(true)
    await vi.advanceTimersByTimeAsync(PAGE_NAME_MS - 10)
    expect(device.stripImage?.equals(renderStrip(pageNameStrip('weather')))).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    expect(device.stripImage?.equals(renderStrip(b.render().strip))).toBe(true)
    // One write in, one write out.
    expect(device.stripWrites).toBe(2)
    await daemon.stop()
  })

  it('centres every real page name on the strip', () => {
    // Ink bounds over the whole strip region, not one column (lesson 22).
    for (const name of ['claude', 'codex', 'spotify', 'stocks', 'weather', 'football', 'system']) {
      const data = renderStrip(pageNameStrip(name)) // raw RGBA
      expect(data.length).toBe(STRIP_WIDTH * STRIP_HEIGHT * 4)
      let left = STRIP_WIDTH
      let right = -1
      for (let y = 0; y < STRIP_HEIGHT; y++) {
        for (let x = 0; x < STRIP_WIDTH; x++) {
          const o = (y * STRIP_WIDTH + x) * 4
          const ink = Math.abs(data[o]! - theme.bg[0]) + Math.abs(data[o + 1]! - theme.bg[1]) + Math.abs(data[o + 2]! - theme.bg[2])
          if (ink > 60) {
            left = Math.min(left, x)
            right = Math.max(right, x)
          }
        }
      }
      expect(right, name).toBeGreaterThan(left)
      expect(Math.abs((left + right) / 2 - STRIP_WIDTH / 2), name).toBeLessThan(8)
    }
  })
})

describe('round-button acknowledgement', () => {
  const mix = (base: Rgb, target: Rgb, t: number): Rgb =>
    [0, 1, 2].map((i) => Math.round(base[i]! + (target[i]! - base[i]!) * t)) as unknown as Rgb

  it('brightens the pressed button toward white, then settles to the page colour in a few steps', async () => {
    const a = new NamedPage('a', [10, 20, 30])
    const b = new NamedPage('b', [40, 80, 120])
    const { device, daemon, buttonLog, t0 } = await build([a, b])

    device.simulatePress(BUTTON_RIGHT)
    await vi.advanceTimersByTimeAsync(PAGE_NAME_MS + 100)

    const right = buttonLog.filter((w) => w.index === BUTTON_RIGHT)
    expect(right.map((w) => [w.at - t0, w.rgb])).toEqual([
      ...ACK_LEVELS.map((level, step) => [step * ACK_STEP_MS, mix(b.button, ACK_OK_RGB, level)]),
      [ACK_LEVELS.length * ACK_STEP_MS, b.button],
    ])
    expect(right.length).toBeLessThanOrEqual(10)
    // The other button only follows the page colour change: one write.
    expect(buttonLog.filter((w) => w.index === BUTTON_LEFT).map((w) => w.rgb)).toEqual([b.button])
    await daemon.stop()
  })

  it('a one-page deck rejects the press: a red-tinted ack, no wipe, no name strip', async () => {
    const only = new NamedPage('only', [40, 80, 120])
    const { device, daemon, keyLog, buttonLog } = await build([only])

    device.simulatePress(BUTTON_LEFT)
    await vi.advanceTimersByTimeAsync(PAGE_NAME_MS + 100)

    expect(keyLog).toHaveLength(0)
    expect(device.stripWrites).toBe(0)
    const left = buttonLog.filter((w) => w.index === BUTTON_LEFT).map((w) => w.rgb)
    expect(left).toEqual([
      ...ACK_LEVELS.map((level) => mix(only.button, ACK_REJECT_RGB, level)),
      only.button,
    ])
    const first = left[0]!
    expect(first[0]).toBeGreaterThan(first[1] + 100) // visibly red
    expect(buttonLog.filter((w) => w.index === BUTTON_RIGHT)).toHaveLength(0)
    await daemon.stop()
  })
})

describe('hourly crab cameo', () => {
  afterEach(() => { vi.useRealTimers() })

  it('walks the crab across the strip on the hour, then restores the strip', async () => {
    const page = new NamedPage('stocks')
    const { device, daemon } = await build([page])
    const toHour = CAMEO_PERIOD_MS - (Date.now() % CAMEO_PERIOD_MS)
    await vi.advanceTimersByTimeAsync(toHour - 1)
    device.stripWrites = 0
    await vi.advanceTimersByTimeAsync(CAMEO_MS / 2)
    // Mid-walk: the strip shows the crab over the page's own strip.
    expect(device.stripWrites).toBeGreaterThan(10)
    expect(device.stripImage?.equals(renderStrip(page.render().strip))).toBe(false)
    await vi.advanceTimersByTimeAsync(CAMEO_MS)
    expect(device.stripImage?.equals(renderStrip(page.render().strip))).toBe(true)
    const writes = device.stripWrites
    await vi.advanceTimersByTimeAsync(5000)
    expect(device.stripWrites).toBe(writes)
    await daemon.stop()
  })

  it('does not walk while the screen is locked', async () => {
    const lock = new Lock()
    const { device, daemon } = await build([new NamedPage('stocks')], lock)
    lock.set(true)
    await vi.advanceTimersByTimeAsync(10)
    device.stripWrites = 0
    const toHour = CAMEO_PERIOD_MS - (Date.now() % CAMEO_PERIOD_MS)
    await vi.advanceTimersByTimeAsync(toHour + CAMEO_MS / 2)
    expect(device.stripWrites).toBe(0)
    await daemon.stop()
  })

  it('enters off the left edge, says hi mid-walk, and leaves off the right', () => {
    expect(cameoSprite(0).x).toBeLessThanOrEqual(-48)
    expect(cameoSprite(CAMEO_MS).x).toBeGreaterThanOrEqual(STRIP_WIDTH)
    expect(cameoSprite(CAMEO_MS / 2).say).toBe('hi!')
    expect(cameoSprite(200).say).toBeUndefined()
    expect(cameoSprite(0).frame).not.toBe(cameoSprite(125).frame)
  })
})
