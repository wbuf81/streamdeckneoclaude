import type { DeckDevice } from './device.js'
import { BUTTON_LEFT, BUTTON_RIGHT, NEO_KEY_COUNT } from './device.js'
import type { PageManager } from './page-manager.js'
import { renderKey, renderStrip } from './render/canvas.js'
import { keyHash, stripHash, type Rgb } from './render/specs.js'
import { log } from './log.js'

const DEFAULT_TICK_MS = 1000

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
  private rendering = false
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
  ) {}

  async start(): Promise<void> {
    this.device.onPress((i) => void this.handlePress(i))

    if (!this.device.isConnected()) await this.device.connect()
    await this.renderOnce(this.now(), this.nowMs())

    // Register the reconnect handler only after the first render. Registering
    // it earlier makes `connect()` fire `handleReconnect` while this method is
    // still rendering, and the two renders then race for the `rendering` flag.
    this.device.onConnect(() => void this.handleReconnect())

    this.armTimer()
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
      void this.renderOnce(this.now(), this.nowMs())
    }, tickMs)
  }

  private async handlePress(index: number): Promise<void> {
    if (this.stopped) return
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
    this.lastKeys = new Array(NEO_KEY_COUNT).fill(null)
    this.lastStrip = null
    this.lastButtons = [null, null]
    await this.renderOnce(this.now(), this.nowMs())
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
    if (this.rendering) return
    if (!this.device.isConnected()) return
    this.rendering = true
    try {
      const frame = this.pages.current().render(now, nowMs)

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
    } catch (e) {
      // A write failure means the cable moved. The Device retries the open.
      // `log.once`, not `log.warn`. This loop runs once per second, so a
      // persistent failure such as an unplugged cable would otherwise write a
      // line every second without a limit. `handleReconnect` clears the key.
      log.once('render', `render failed: ${String(e)}`)
      this.lastKeys = new Array(NEO_KEY_COUNT).fill(null)
      this.lastStrip = null
      this.lastButtons = [null, null]
    } finally {
      this.rendering = false
    }
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
  }
}
