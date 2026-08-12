import type { DeckDevice } from './device.js'
import { BUTTON_LEFT, BUTTON_RIGHT, NEO_KEY_COUNT } from './device.js'
import type { PageManager } from './page-manager.js'
import { renderKey, renderStrip } from './render/canvas.js'
import { keyHash, stripHash, type Rgb } from './render/specs.js'
import { log } from './log.js'

const TICK_MS = 1000

/**
 * Owns the render loop. It compares each new key description against the last
 * one it drew, and it writes only what changed. A full 8 key write costs USB
 * bandwidth, so this comparison is the difference between a smooth deck and a
 * laggy one.
 */
export class Daemon {
  private lastKeys: (string | null)[] = new Array(NEO_KEY_COUNT).fill(null)
  private lastStrip: string | null = null
  private lastButtons: (string | null)[] = [null, null]
  private timer: NodeJS.Timeout | null = null
  private rendering = false

  constructor(
    private readonly device: DeckDevice,
    private readonly pages: PageManager,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async start(): Promise<void> {
    this.device.onPress((i) => void this.handlePress(i))

    if (!this.device.isConnected()) await this.device.connect()
    await this.renderOnce(this.now())

    // Register the reconnect handler only after the first render. Registering
    // it earlier makes `connect()` fire `handleReconnect` while this method is
    // still rendering, and the two renders then race for the `rendering` flag.
    this.device.onConnect(() => void this.handleReconnect())

    this.timer = setInterval(() => void this.renderOnce(this.now()), TICK_MS)
  }

  private async handlePress(index: number): Promise<void> {
    try {
      if (index === BUTTON_LEFT) {
        this.pages.prev()
        await this.renderOnce(this.now())
        return
      }
      if (index === BUTTON_RIGHT) {
        this.pages.next()
        await this.renderOnce(this.now())
        return
      }
      if (index < 0 || index >= NEO_KEY_COUNT) return
      await this.pages.onKeyPress(index)
      await this.renderOnce(this.now())
    } catch (e) {
      log.error(`press handler failed for index ${index}: ${String(e)}`)
    }
  }

  /** Forgets what is on the glass, so the next render writes everything. */
  async handleReconnect(): Promise<void> {
    log.clearOnce('render')
    this.lastKeys = new Array(NEO_KEY_COUNT).fill(null)
    this.lastStrip = null
    this.lastButtons = [null, null]
    await this.renderOnce(this.now())
  }

  /** Renders one frame. It writes only what changed. */
  async renderOnce(now: number): Promise<void> {
    if (this.rendering) return
    if (!this.device.isConnected()) return
    this.rendering = true
    try {
      const frame = this.pages.current().render(now)

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
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
