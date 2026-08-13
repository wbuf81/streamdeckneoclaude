import type { DeckDevice } from './device.js'
import { BUTTON_LEFT, BUTTON_RIGHT, NEO_KEY_COUNT } from './device.js'
import type { PageManager } from './page-manager.js'
import { renderKey, renderStrip } from './render/canvas.js'
import { keyHash, stripHash, type DeckFrame, type KeySpec, type Rgb } from './render/specs.js'
import { theme } from './render/theme.js'
import { log } from './log.js'
import type { LockState } from './lock-state.js'
import type { PressOutcome } from './pages/types.js'

const DEFAULT_TICK_MS = 1000
export const DEFAULT_BRIGHTNESS = 100
const SLEEP_GAP_MIN_MS = 5000
/**
 * How long a press's flash stays visible before the key reverts to its own
 * content. Task 26 tuned 250 ms for a full-key fill on the Claude page.
 * Task 32 moved the mechanism into the daemon, unchanged. Task 36 shortens
 * it to 150 ms: real hardware feedback said the flash was "too bright" and
 * lingered too long, once it covered the whole key. Now that it is a thin
 * ring (see `KeySpec.flashRing`) rather than a fill, it needs less time on
 * screen to read as feedback — long enough to notice, short enough to feel
 * instant rather than like a state colour.
 */
const FLASH_MS = 150

/**
 * A transient press-feedback flash on one key, index 0 to 7 — never the two
 * round buttons (8, 9): they carry RGB backlights, not screens, and a page
 * flip is already its own visible feedback, so there is nothing to flash.
 *
 * `ok` is true for a `handled` press (white) and false for `ignored` or
 * `failed` (red) — see `PressOutcome`'s doc comment for why those two share
 * one colour instead of getting a third.
 *
 * `expiresAtMs` is `null` until the FIRST render that actually draws this
 * flash, which is the moment that anchors it. Anchoring at press time
 * instead (off whatever clock the daemon happened to see last) is what let a
 * flash arrive already expired: a stale clock from an unrelated
 * change-triggered render could sit hundreds of milliseconds behind real
 * time. Anchoring at first-draw time means a flash is impossible to be born
 * already expired, and it works even when a press lands before the current
 * page has ever been rendered at all.
 */
interface Flash {
  ok: boolean
  expiresAtMs: number | null
}

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
  /** One pending press-feedback flash per screen key, indices 0 to 7. `null`
   * means no flash. See `Flash` and `applyFlash`. */
  private flashes: (Flash | null)[] = new Array(NEO_KEY_COUNT).fill(null)

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
        // The two round buttons have RGB backlights, not screens: there is
        // nothing to flash, and flipping the page is already its own
        // visible feedback.
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

      const outcome = await this.callOnKeyPress(index, key)
      this.setFlash(index, outcome === 'handled')
      await this.renderOnce(this.now(), this.nowMs())
      // A `failed` outcome already logged inside `callOnKeyPress` below; do
      // not clear it here, or a repeating failure would log every time
      // instead of once (M2). Any other outcome means the press itself did
      // not throw, so a later genuine failure on this same key should log
      // again.
      if (outcome !== 'failed') log.clearOnce(key)
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

  /**
   * Calls the current page's `onKeyPress` and awaits it, even when the page
   * itself is synchronous — `await` on a plain value just returns it
   * unchanged, so this is the one place that needs to know which. A page
   * must never crash the daemon, so a thrown error becomes a `failed`
   * outcome instead of escaping: the press still gets its red flash, exactly
   * like a press that ran and failed cleanly, rather than silently doing
   * nothing at all.
   */
  private async callOnKeyPress(index: number, logKey: string): Promise<PressOutcome> {
    try {
      return await this.pages.current().onKeyPress(index)
    } catch (e) {
      log.once(logKey, `press handler failed for index ${index}: ${String(e)}`)
      return 'failed'
    }
  }

  /** Records a pending flash for `index`. Its expiry is anchored later, by
   * `applyFlash`, at the first render that actually draws it — see `Flash`'s
   * doc comment for why. */
  private setFlash(index: number, ok: boolean): void {
    this.flashes[index] = { ok, expiresAtMs: null }
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
    const task = (async () => {
      const frame = this.pages.current().render(now, nowMs)
      await this.writeFrame(this.overlayFlashes(frame, nowMs))
    })()
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

  /**
   * Applies every active press-feedback flash to `frame`'s keys, right
   * before writing. This runs LAST, after the current page has built its own
   * frame, so a flash wins over anything the page drew for that key — a
   * border, a pulse, an image — and nothing drawn afterwards can cover it up
   * in turn. `blankForLock`'s synthetic all-blank frame bypasses this
   * entirely (it calls `writeFrame` directly), so a flash never survives
   * into the privacy blank.
   */
  private overlayFlashes(frame: DeckFrame, nowMs: number): DeckFrame {
    return { ...frame, keys: frame.keys.map((key, i) => this.applyFlash(i, key, nowMs)) }
  }

  /**
   * Overlays the press-feedback flash for `index`, if one is still active,
   * by adding a thin ring around the key's whole perimeter (`flashRing`):
   * a muted white for `handled`, a muted red for `ignored` or `failed`.
   * Moved here from the Claude page (task 32) so every page gets the same
   * on-device feedback, not just the one page that happened to implement it
   * first.
   *
   * Task 32 replaced the key's own content with a solid fill. Real hardware
   * feedback (task 36) called that "too bright" and "jarring" — pure white
   * and saturated red at full brightness, covering the whole key, for
   * 250 ms. This keeps the key's own content (`...key`) and only ADDS the
   * ring on top, at a dimmer colour: the key stays legible underneath, and
   * `canvas.ts`'s `drawFlashRing` draws it last, so it still wins visually
   * over anything the page drew, including a pulsing border.
   *
   * The flash's `expiresAtMs` is set HERE, on the first render that reaches
   * this key while the flash is pending (`expiresAtMs === null`), using
   * THIS render's own `nowMs` — see `Flash`'s doc comment for why anchoring
   * at press time instead would let a flash arrive already expired.
   *
   * Once `nowMs` reaches the (now-anchored) expiry, the flash is discarded
   * and this returns `key` untouched, so the key's hash goes back to exactly
   * what it would have been with no flash ever recorded — letting the
   * dirty-key check in `writeFrame` stop redrawing it.
   */
  private applyFlash(index: number, key: KeySpec, nowMs: number): KeySpec {
    const flash = this.flashes[index]
    if (!flash) return key
    if (flash.expiresAtMs === null) {
      flash.expiresAtMs = nowMs + FLASH_MS
    } else if (nowMs >= flash.expiresAtMs) {
      this.flashes[index] = null
      return key
    }
    return { ...key, flashRing: flash.ok ? theme.flashWhite : theme.flashRed }
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
