import type { DeckDevice } from './device.js'
import { BUTTON_LEFT, BUTTON_RIGHT, NEO_KEY_COUNT } from './device.js'
import type { PageManager } from './page-manager.js'
import { renderKey, renderStrip } from './render/canvas.js'
import { keyHash, stripHash, type DeckFrame, type Rgb } from './render/specs.js'
import { log } from './log.js'
import type { LockState } from './lock-state.js'

const DEFAULT_TICK_MS = 1000
export const DEFAULT_BRIGHTNESS = 100
const SLEEP_GAP_MIN_MS = 5000

/** The lock-state methods the daemon needs. Kept narrow for deterministic tests. */
export type LockStateReader = Pick<LockState, 'start' | 'stop' | 'isLocked' | 'refresh' | 'onChange'>

/**
 * Owns the render loop. It compares each new key description against the last
 * one it drew, and it writes only what changed. A full 8 key write costs USB
 * bandwidth, so this comparison is the difference between a smooth deck and a
 * laggy one.
 *
 * The render interval is per-page (`Page.tickMs`, default 1000 ms), because an
 * animating page such as Claude's session keys wants roughly 10 fps while a
 * page that changes every fifteen minutes would only waste CPU at that rate.
 * The dirty-key hash keeps this safe: a fast tick over unchanged content
 * writes nothing at all.
 */
export class Daemon {
  private lastKeys: (string | null)[] = new Array(NEO_KEY_COUNT).fill(null)
  private lastStrip: string | null = null
  private lastButtons: (string | null)[] = [null, null]
  private timer: NodeJS.Timeout | null = null
  /** The interval the live timer was armed at, so a tick can notice a change. */
  private armedTickMs = 0
  private activeRender: Promise<void> | null = null
  private locked = false
  private lastTickAtMs: number | null = null
  private lockTransition: Promise<void> = Promise.resolve()
  /**
   * Set once by `stop()` and never cleared. `device.onPress`'s listener is
   * never unregistered, so a press can still arrive after `stop()` has
   * already run -- the real scenario is `SIGTERM` → `shutdown()` → `await
   * daemon.stop()`, then a press landing while the rest of shutdown (the
   * sources, the device) is still stopping. Without this flag, that press
   * called `armTimer()` and created a brand new interval, undoing `stop()`.
   * Checked at the top of both `handlePress` and `armTimer`, not just one,
   * since either could otherwise still arm a timer on its own.
   */
  private stopped = false

  constructor(
    private readonly device: DeckDevice,
    private readonly pages: PageManager,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly nowMs: () => number = () => Date.now(),
    private readonly lockState: LockStateReader | null = null,
  ) {}

  async start(): Promise<void> {
    this.device.onPress((i) => void this.handlePress(i))

    if (this.lockState) {
      await this.lockState.start()
      this.locked = this.lockState.isLocked()
      this.lockState.onChange(() => void this.queueLockTransition())
    }

    if (!this.device.isConnected()) await this.device.connect()
    if (this.locked) {
      this.pages.current().onLeave?.()
      await this.blankForLock()
      log.info('screen locked; deck blanked')
    } else {
      await this.device.setBrightness(DEFAULT_BRIGHTNESS)
      await this.renderOnce(this.now(), this.nowMs())
    }

    // Register the reconnect handler only after the first render. Registering
    // it earlier makes `connect()` fire `handleReconnect` while this method is
    // still rendering, and the two renders then race for the active frame.
    this.device.onConnect(() => void this.handleReconnect())

    this.lastTickAtMs = this.nowMs()
    if (!this.locked) this.armTimer()
  }

  /**
   * (Re)starts the render timer at the current page's `tickMs`. Called once
   * from `start()`, and again after every page change, because the new page
   * may want a different rate — an old, slower (or faster) timer left running
   * would either starve an animating page of ticks or burn CPU on a static
   * one.
   */
  private armTimer(): void {
    if (this.stopped) return
    if (this.timer) clearInterval(this.timer)
    const tickMs = this.pages.current().tickMs ?? DEFAULT_TICK_MS
    this.armedTickMs = tickMs
    this.timer = setInterval(() => {
      // A page may change its own rate WITHOUT a page change: the Spotify page
      // asks for 100 ms while it animates its idle state and the default rate
      // while a track is loaded. Reading `tickMs` only on a page switch would
      // leave that animation frozen until the user flipped pages — the same
      // "flip away and back to fix it" defect the user already reported once.
      // So compare every tick and re-arm when the page has changed its mind.
      if ((this.pages.current().tickMs ?? DEFAULT_TICK_MS) !== this.armedTickMs) {
        this.armTimer()
      }
      void this.handleTick()
    }, tickMs)
  }

  /**
   * Detects a clock jump before rendering. A large gap means the machine may
   * have slept, so the daemon forgets the device's pixels and re-probes the
   * screen lock instead of trusting pre-sleep state.
   */
  private async handleTick(): Promise<void> {
    const ms = this.nowMs()
    const previous = this.lastTickAtMs
    this.lastTickAtMs = ms
    const sleepGap = Math.max(SLEEP_GAP_MIN_MS, this.armedTickMs * 3)
    if (previous !== null && ms - previous > sleepGap) {
      this.invalidateFrame()
      if (this.lockState) {
        await this.lockState.refresh()
        await this.queueLockTransition()
      }
      if (this.locked) return
    }
    await this.renderOnce(Math.floor(ms / 1000), ms)
  }

  private async handlePress(index: number): Promise<void> {
    if (this.stopped || this.locked) return
    const key = `press-${index}`
    try {
      if (index === BUTTON_LEFT) {
        this.pages.prev()
        this.armTimer()
        await this.renderOnce(this.now(), this.nowMs())
        log.clearOnce(key)
        return
      }
      if (index === BUTTON_RIGHT) {
        this.pages.next()
        this.armTimer()
        await this.renderOnce(this.now(), this.nowMs())
        log.clearOnce(key)
        return
      }
      if (index < 0 || index >= NEO_KEY_COUNT) return
      await this.pages.onKeyPress(index)
      await this.renderOnce(this.now(), this.nowMs())
      log.clearOnce(key)
    } catch (e) {
      // `log.once`, not `log.error` (M2): a press repeats, and this is the
      // catch-all for every press failure. A broken page reader failing on
      // every press would otherwise write one line per press, with no
      // limit. Keyed per index, so a failure on key 3 does not suppress a
      // later, genuine failure on key 5. `clearOnce` above logs a later
      // failure again once a press on the same index succeeds.
      log.once(key, `press handler failed for index ${index}: ${String(e)}`)
    }
  }

  /** Forgets what is on the glass, so the next render writes everything. */
  async handleReconnect(): Promise<void> {
    log.clearOnce('render')
    this.invalidateFrame()
    if (this.locked) {
      await this.blankForLock()
    } else {
      await this.device.setBrightness(DEFAULT_BRIGHTNESS)
      await this.renderOnce(this.now(), this.nowMs())
    }
  }

  /**
   * Renders one frame. It writes only what changed.
   *
   * `nowMs` has no default on purpose — it used to be `now * 1000`, which
   * truncates the millisecond clock to whichever whole second `now` names.
   * Every caller that goes through the armed timer already passes a real
   * millisecond clock, but the five `change` listeners in `bin/deckd.ts` used
   * to call `renderOnce` with only `now` and rely on that default, which
   * rewound the clock by up to 999 ms on every source change: a press flash
   * anchored to the real clock a moment earlier could already read as
   * expired, and the crab animation jumped back up to about fourteen frames.
   * Requiring `nowMs` here makes that class of bug a compile error rather
   * than a silent truncation.
   */
  async renderOnce(now: number, nowMs: number): Promise<void> {
    if (this.locked || this.activeRender) return
    if (!this.device.isConnected()) return
    // Keep page rendering inside the promise too. A page that throws while it
    // builds its frame must take the same logged, non-fatal path as a failed
    // device write.
    const task = (async () => this.writeFrame(this.pages.current().render(now, nowMs)))()
    this.activeRender = task
    try {
      await task
    } catch (e) {
      // A write failure means the cable moved. The Device retries the open.
      // `log.once`, not `log.warn`. This loop runs once per second, so a
      // persistent failure such as an unplugged cable would otherwise write a
      // line every second without a limit. `handleReconnect` clears the key.
      log.once('render', `render failed: ${String(e)}`)
      this.invalidateFrame()
    } finally {
      if (this.activeRender === task) this.activeRender = null
    }
  }

  private async writeFrame(frame: DeckFrame): Promise<void> {
    for (let i = 0; i < NEO_KEY_COUNT; i++) {
      const spec = frame.keys[i]
      if (!spec) continue
      const hash = keyHash(spec)
      if (hash === this.lastKeys[i]) continue
      await this.device.setKeyImage(i, renderKey(spec))
      this.lastKeys[i] = hash
    }

    const sHash = stripHash(frame.strip)
    if (sHash !== this.lastStrip) {
      await this.device.setStrip(renderStrip(frame.strip))
      this.lastStrip = sHash
    }

    await this.writeButton(0, BUTTON_LEFT, frame.buttons[0])
    await this.writeButton(1, BUTTON_RIGHT, frame.buttons[1])
  }

  /** Serializes lock transitions so an unlock cannot overtake a lock blank. */
  private queueLockTransition(): Promise<void> {
    this.lockTransition = this.lockTransition
      .then(() => this.syncLockState())
      .catch((e) => {
        log.once('lock-transition', `screen lock transition failed: ${String(e)}`)
      })
    return this.lockTransition
  }

  private async syncLockState(): Promise<void> {
    if (this.stopped) return
    const next = this.lockState?.isLocked() ?? false
    if (next === this.locked) return
    if (next) {
      // Block presses and ordinary renders before waiting for a frame that was
      // already in progress. The blank is therefore the final frame written.
      this.locked = true
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      const active = this.activeRender
      if (active) await active.catch(() => {})
      this.pages.current().onLeave?.()
      await this.blankForLock()
    } else {
      this.locked = false
      await this.device.setBrightness(DEFAULT_BRIGHTNESS)
      this.invalidateFrame()
      this.pages.current().onEnter?.()
      this.lastTickAtMs = this.nowMs()
      this.armTimer()
      await this.renderOnce(this.now(), this.nowMs())
      log.info('screen unlocked; deck restored')
    }
    log.clearOnce('lock-transition')
  }

  private async blankForLock(): Promise<void> {
    if (!this.device.isConnected()) return
    this.invalidateFrame()
    try {
      await this.writeFrame({
        keys: Array.from({ length: NEO_KEY_COUNT }, () => ({ kind: 'blank' as const })),
        strip: { lines: [] },
        buttons: [[0, 0, 0], [0, 0, 0]],
      })
    } finally {
      // Brightness is the privacy backstop if a pixel write fails while the
      // cable or device is unstable. Pixel blanking still runs first.
      await this.device.setBrightness(0)
    }
  }

  private invalidateFrame(): void {
    this.lastKeys = new Array(NEO_KEY_COUNT).fill(null)
    this.lastStrip = null
    this.lastButtons = [null, null]
  }

  private async writeButton(slot: number, index: number, rgb: Rgb): Promise<void> {
    const hash = rgb.join(',')
    if (hash === this.lastButtons[slot]) return
    await this.device.setButtonColor(index, rgb)
    this.lastButtons[slot] = hash
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.lockState?.stop()
    await this.lockTransition
  }
}
