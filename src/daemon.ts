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
 * Task 32 moved the mechanism into the daemon, unchanged. Task 36 replaced
 * the full-key fill with a thin perimeter ring and shortened this to 90 ms:
 * real hardware feedback said the fill was "too bright" and lingered too
 * long. A ring needs less time on screen to read as feedback than a fill
 * did — long enough to notice, short enough to feel instant rather than
 * like a state colour.
 *
 * This value has drifted from its own docs twice in opposite directions —
 * see `docs/PROJECT-STATE.md`'s note on the flash being wrong both ways —
 * so a comment or a doc page claiming any OTHER number here is the stale
 * one; trust this constant.
 */
const FLASH_MS = 90

/**
 * How long a flash may sit PENDING (earned by a press, but never yet drawn)
 * before it is discarded outright instead of being anchored late. Generous
 * relative to `FLASH_MS` and to one ordinary render cycle, so it never
 * fires under ordinary load — it exists only to bound the rare case where a
 * press's own render never got a chance to run at all (the screen locks or
 * the device disconnects moments after the press), so a ring cannot
 * resurface minutes later at unlock or reconnect, looking like fresh
 * feedback for a press the user has long forgotten (M3's longer-lived
 * bleed variant).
 */
const FLASH_MAX_PENDING_MS = 5000

/**
 * Backoff step for `scheduleFlashPump`'s re-arm delay while `render()` keeps
 * failing (C2). A page that throws never reaches `applyFlash`, so a flash
 * already past its anchored expiry stays exactly that far past it on every
 * subsequent attempt — with no floor, the pump re-armed at delay 0 every
 * time, an unbounded loop measured at about 850 renders per second. Growing
 * this with `renderFailureStreak`, capped at `FLASH_PUMP_MAX_BACKOFF_MS`,
 * means a persistently broken page still gets retried (so it can recover),
 * just not in a tight loop.
 */
const FLASH_PUMP_BACKOFF_STEP_MS = 50
const FLASH_PUMP_MAX_BACKOFF_MS = 1000

/**
 * A transient press-feedback flash on one key, index 0 to 7 — never the two
 * round buttons (8, 9): they carry RGB backlights, not screens, and a page
 * flip is already its own visible feedback, so there is nothing to flash.
 *
 * `ok` is true for a `handled` press (white) and false for `ignored` or
 * `failed` (red) — see `PressOutcome`'s doc comment for why those two share
 * one colour instead of getting a third.
 *
 * `page` is the name of the page that was current at press time. A flash
 * whose `page` no longer matches the page being rendered is discarded
 * rather than drawn: without this, flipping pages while a flash is still
 * pending or still active bleeds the ring onto a DIFFERENT page's same key
 * index — a key the user never pressed, proven by probe (M3).
 *
 * `expiresAtMs` is `null` until the FIRST render that actually draws this
 * flash, which is the moment that anchors it. Anchoring at press time
 * instead (off whatever clock the daemon happened to see last) is what let a
 * flash arrive already expired: a stale clock from an unrelated
 * change-triggered render could sit hundreds of milliseconds behind real
 * time. Anchoring at first-draw time means a flash is impossible to be born
 * already expired, and it works even when a press lands before the current
 * page has ever been rendered at all.
 *
 * `createdAtMs` is `nowMs` at press time, used only to bound how long a
 * flash may sit pending (see `FLASH_MAX_PENDING_MS`) before it is discarded
 * rather than anchored late.
 */
interface Flash {
  ok: boolean
  page: string
  expiresAtMs: number | null
  createdAtMs: number
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
  /** Timer that renders a flash away on time, or anchors one that is still
   * pending. See `scheduleFlashPump`. */
  private flashPumpTimer: NodeJS.Timeout | null = null
  private activeRender: Promise<void> | null = null
  /**
   * Set when `renderOnce` is called while `activeRender` is already busy.
   * The busy render's own completion (inside `renderOnce`'s own retry loop)
   * drains this immediately, instead of the call being silently dropped
   * until whatever render happens to come next — up to a full second on a
   * 1000 ms page. This is what lets a press's flash reach the glass
   * promptly even when its own render landed mid-write (I1).
   */
  private renderRequested = false
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
  /**
   * Consecutive `page.render()` failures, reset to 0 on any success. Used
   * only to back off `scheduleFlashPump`'s own re-arm delay (C2) — a page
   * that throws never reaches `applyFlash`, so a flash already past its
   * anchored expiry stays past it on every following attempt too, and this
   * is what stops that from re-arming at delay 0 forever.
   */
  private renderFailureStreak = 0
  /**
   * Whether the current page believes it is on screen (has had `onEnter`
   * without a later `onLeave`). `PageManager.add` already calls `onEnter`
   * for the first page, so this starts `true`. Used only to keep the
   * daemon's own enter/leave calls idempotent: `start()`'s locked branch and
   * `syncLockState`'s lock branch can both decide to leave the page when the
   * lock changes mid-`connect()` (M2) -- without this, the page's `onLeave`
   * fired twice with no `onEnter` between, a contract no page implementation
   * should have to tolerate.
   */
  private pageVisible = true

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
      this.leavePage()
      await this.blankForLock()
      log.info('screen locked; deck blanked')
    } else {
      // Guarded (C1): `connect()` above resolves WITHOUT a handle when no
      // deck is plugged in -- that is its documented, correct behaviour, and
      // the retry loop it already armed is what is supposed to paint the
      // first frame once one appears. An unguarded `setBrightness` here
      // threw straight out of `start()`, which `bin/deckd.ts` had no
      // special case for beyond `DeviceBusyError`: `exit(1)`, launchd
      // respawns, forever, and `onConnect` below -- the only thing that
      // could ever recover -- was never even reached. `renderOnce` already
      // guards its own `isConnected()` check, so only this one call needed
      // it.
      await this.setBrightnessSafe(DEFAULT_BRIGHTNESS)
      await this.renderNow()
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
    // Absolute value (M3): a FORWARD jump this large means the machine
    // slept. A BACKWARD jump of the same size -- an NTP correction, a
    // manual clock change -- used to skip both `invalidateFrame()` and the
    // lock re-probe, and it also made every later tick's own gap compute
    // against a `previous` that is now in the machine's future, hiding a
    // real forward jump behind it too.
    if (previous !== null && Math.abs(ms - previous) > sleepGap) {
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
        await this.renderNow()
        log.clearOnce(key)
        return
      }
      if (index === BUTTON_RIGHT) {
        this.pages.next()
        this.armTimer()
        await this.renderNow()
        log.clearOnce(key)
        return
      }
      if (index < 0 || index >= NEO_KEY_COUNT) return

      // Captured BEFORE the await, not after (C1). `onKeyPress` can hold this
      // open for hundreds of milliseconds — Spotify's awaits an HTTP call,
      // Claude's awaits `osascript` — and the page (or clock) at the moment
      // the press LANDED is what the flash must be tagged with. Reading
      // either one after the await let an ordinary "press play, then flip to
      // Stocks" sequence tag the flash with the NEW page and draw the ring on
      // a key of a page that was not even visible at press time — the exact
      // bleed the per-page tagging (M3) was added to prevent, reachable
      // through a different door.
      const pressPage = this.pages.current().name
      const pressAtMs = this.nowMs()
      const outcome = await this.callOnKeyPress(index, key)
      this.setFlash(index, outcome === 'handled', pressPage, pressAtMs)
      await this.renderNow()
    } catch (e) {
      // `log.once`, not `log.error`: a press repeats, and this is the
      // catch-all for a failure that reaches here WITHOUT going through
      // `callOnKeyPress`'s own try/catch below — in practice only
      // `pages.prev()`/`pages.next()`/`pages.current()` throwing "no page
      // has been added" on the round-button branches above, since
      // `callOnKeyPress` already catches every page-press throw itself and
      // `renderOnce` catches its own failures. Kept as a backstop rather
      // than removed, because this runs from a fire-and-forget device
      // callback: an escaping throw here would surface as an unhandled
      // rejection instead of a logged line. Distinct message text from
      // `callOnKeyPress`'s, so the two logged shapes never look like the
      // same defect drifting (M2).
      log.once(key, `press handling crashed unexpectedly for index ${index}: ${String(e)}`)
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
   *
   * `failed` is an ordinary, EXPECTED outcome (a focus call that returned
   * false, a source method that returned false) and must not hold this
   * key's log open — only a real throw should (M1). So the log key clears
   * on every normal return, whatever the outcome, and is held open only
   * inside the `catch`, until a LATER press on the same key returns
   * normally again.
   */
  private async callOnKeyPress(index: number, logKey: string): Promise<PressOutcome> {
    try {
      const outcome = await this.pages.current().onKeyPress(index)
      log.clearOnce(logKey)
      return outcome
    } catch (e) {
      log.once(logKey, `press handler failed for index ${index}: ${String(e)}`)
      return 'failed'
    }
  }

  /** Records a pending flash for `index`, tagged with the page and clock
   * reading the CALLER captured at press time (C1) — never read here, which
   * would be after `onKeyPress`'s own await and could already belong to a
   * different page. Its expiry is anchored later, by `applyFlash`, at the
   * first render that actually draws it — see `Flash`'s doc comment for why. */
  private setFlash(index: number, ok: boolean, page: string, createdAtMs: number): void {
    this.flashes[index] = {
      ok,
      page,
      expiresAtMs: null,
      createdAtMs,
    }
  }

  /**
   * Forgets what is on the glass, so the next render writes everything.
   *
   * Guarded by `stopped` (I3): every other entry point checks it --
   * `renderOnce`, `armTimer`, `scheduleFlashPump`, `handlePress`,
   * `syncLockState` -- but this one did not, so a reconnect after
   * `daemon.stop()` (a retry racing shutdown, or `Device.connect()`'s I2
   * hole reopening a handle post-`disconnect()`) still pushed brightness to
   * `DEFAULT_BRIGHTNESS` against a stopped daemon that would never render
   * over it: a bright, stale, stopped deck.
   */
  async handleReconnect(): Promise<void> {
    if (this.stopped) return
    log.clearOnce('render')
    this.invalidateFrame()
    if (this.locked) {
      await this.blankForLock()
    } else {
      await this.setBrightnessSafe(DEFAULT_BRIGHTNESS)
      // Self-healing (C2): `syncLockState`'s unlock branch can fail before
      // it ever reaches `armTimer()`, leaving a running, unlocked daemon
      // with no live render loop -- a permanently frozen deck until another
      // full lock/unlock cycle or a press. A reconnect is the moment the
      // user (or the retry loop) proves the device is reachable again, so
      // it re-arms unconditionally rather than trusting whatever state an
      // earlier failed transition left behind. `armTimer` already clears
      // any existing interval before creating a new one, so this is a
      // harmless no-op on the ordinary path where nothing was ever broken.
      this.armTimer()
      await this.renderNow()
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
    // Checked first, and unconditionally (M1): `armTimer` already refuses to
    // arm after `stop()`, but this method has an independent entry point — a
    // press whose `onKeyPress` was still in flight when `stop()` ran resumes
    // here once it resolves, with no other guard in its path. Without this,
    // that resumed press could still write a ring to the device after
    // shutdown, and nothing would ever clear it.
    if (this.stopped) return
    if (this.locked) {
      // A stale request from before the lock must not survive it: the next
      // call after unlock already forces a full repaint of its own (M6), so
      // carrying this flag forward would only cost one duplicate frame.
      this.renderRequested = false
      return
    }
    if (this.activeRender) {
      // A render is already in flight — the several awaited device writes
      // in `writeFrame`, or (on the Spotify page) a press's own outcome
      // awaiting an HTTP call before it even gets here. A press's flash,
      // already recorded in `this.flashes` by `setFlash`, used to have no
      // way back onto the glass until whatever render happened to come
      // next — up to a full second on a 1000 ms page (I1). Remembering that
      // another render is owed, instead of silently dropping this call,
      // means the in-flight render's own completion below runs it
      // immediately, with a fresh clock reading, rather than losing it
      // until the next tick.
      this.renderRequested = true
      return
    }
    if (!this.device.isConnected()) {
      this.renderRequested = false // same reasoning as the locked branch above (M6)
      return
    }
    await this.runRender(now, nowMs)
    // Drains a request that arrived while the render above was busy. Guarded
    // by the same three conditions `renderOnce` itself checks, so this can
    // never keep working after `stop()`, while locked, or once disconnected.
    while (this.renderRequested && !this.stopped && !this.locked && this.device.isConnected()) {
      this.renderRequested = false
      const retry = this.clockNow()
      await this.runRender(retry.now, retry.nowMs)
    }
  }

  /**
   * Reads the millisecond clock exactly once and derives the second clock
   * from it, the same rule `handleTick` and `bin/deckd.ts`'s
   * `makeChangeHandler` already held. Every OTHER call site used to spell
   * `this.now()` and `this.nowMs()` as two independent reads (M1) — probed,
   * measured `now` a full second behind `nowMs` in the same frame, because
   * nothing guarantees which side of a millisecond boundary two separate
   * clock calls land on. `this.now` stays a constructor parameter (tests
   * inject it directly, and it is still the default `renderOnce` documents
   * for a caller with only a whole-second clock available), but nothing
   * inside this class calls it anymore.
   */
  private clockNow(): { now: number; nowMs: number } {
    const nowMs = this.nowMs()
    return { now: Math.floor(nowMs / 1000), nowMs }
  }

  /** Renders one frame at the current instant, reading the clock exactly
   * once (M1). */
  private async renderNow(): Promise<void> {
    const { now, nowMs } = this.clockNow()
    await this.renderOnce(now, nowMs)
  }

  /**
   * Sets brightness without letting a disconnected device -- or any other
   * device failure -- escape to the caller. The render loop's survival must
   * never depend on this succeeding (lesson 21): `start()`'s unlocked
   * branch, `handleReconnect`, and `syncLockState`'s unlock branch all call
   * this with essential bookkeeping (arming the timer, the retry loop
   * getting a chance to run) that must happen regardless of whether a
   * device write succeeds. C1 was `start()` letting this throw with no
   * `isConnected()` guard at all; C2 was `syncLockState` letting it throw
   * BEFORE `armTimer()`. Both are fixed at their call sites too, but routing
   * every startup/reconnect/unlock brightness write through here as well
   * means a device failure of any OTHER shape (not just "never connected")
   * cannot reopen either hole.
   */
  private async setBrightnessSafe(percent: number): Promise<void> {
    if (!this.device.isConnected()) return
    try {
      await this.device.setBrightness(percent)
    } catch (e) {
      log.once('brightness', `setBrightness failed: ${String(e)}`)
    }
  }

  /**
   * Calls the current page's `onLeave`, at most once between two matching
   * `enterPage()` calls (M2), and never lets a throw from it escape (C2's
   * second route): a lock transition's remaining bookkeeping -- clearing
   * the timer, blanking the device -- must not depend on a page hook
   * succeeding, or even running just once.
   */
  private leavePage(): void {
    if (!this.pageVisible) return
    this.pageVisible = false
    try {
      this.pages.current().onLeave?.()
    } catch (e) {
      log.once('page-onleave', `onLeave failed: ${String(e)}`)
    }
  }

  /** The `onEnter` counterpart to `leavePage`. See its doc comment. */
  private enterPage(): void {
    if (this.pageVisible) return
    this.pageVisible = true
    try {
      this.pages.current().onEnter?.()
    } catch (e) {
      log.once('page-onenter', `onEnter failed: ${String(e)}`)
    }
  }

  /**
   * Builds one frame, writes what changed, and afterward always re-checks
   * whether a press-feedback flash still needs a future render — to anchor
   * one that just appeared, or to clear one whose time has come. Running
   * this after EVERY render, not only the one that first anchors a flash,
   * and always against the CURRENT earliest pending expiry rather than a
   * timer armed once and never revisited, is what lets a dropped render
   * always get a replacement (I2) and what stops a later press from
   * extending an earlier key's ring past its own schedule (I3).
   */
  private async runRender(now: number, nowMs: number): Promise<void> {
    // Keep page rendering inside the promise too. A page that throws while it
    // builds its frame must take the same logged, non-fatal path as a failed
    // device write.
    const task = (async () => {
      const page = this.pages.current()
      const frame = page.render(now, nowMs)
      await this.writeFrame(this.overlayFlashes(frame, nowMs, page.name))
    })()
    this.activeRender = task
    try {
      await task
      this.renderFailureStreak = 0
    } catch (e) {
      // A write failure means the cable moved. The Device retries the open.
      // `log.once`, not `log.warn`. This loop runs once per second, so a
      // persistent failure such as an unplugged cable would otherwise write a
      // line every second without a limit. `handleReconnect` clears the key.
      log.once('render', `render failed: ${String(e)}`)
      this.invalidateFrame()
      this.renderFailureStreak += 1
    } finally {
      if (this.activeRender === task) this.activeRender = null
    }
    try {
      // Never let a failure inside the pump's own bookkeeping escape as a
      // rejection from `runRender` (M5): `renderOnce` awaits `runRender` with
      // no `try`/`catch` of its own, and the flash pump's timer callback
      // fires `renderOnce` fire-and-forget with `void` — a rejection from
      // there would surface as an unhandled promise rejection, which Node
      // terminates on by default. `scheduleFlashPump` reads `pages.current()`
      // and could in principle throw before every page is added; kept as a
      // backstop rather than a proof that it currently can, the same
      // reasoning `handlePress`'s own outer catch already uses.
      this.scheduleFlashPump()
    } catch (e) {
      log.once('flash-pump', `flash pump scheduling failed: ${String(e)}`)
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
  private overlayFlashes(frame: DeckFrame, nowMs: number, pageName: string): DeckFrame {
    return { ...frame, keys: frame.keys.map((key, i) => this.applyFlash(i, key, nowMs, pageName)) }
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
   * `pageName` is the page this frame was actually built from. A flash
   * whose own `page` disagrees belongs to a press on a DIFFERENT page —
   * the user flipped away before it was ever drawn, or before it expired —
   * so it is discarded outright rather than drawn on a key the press never
   * touched (M3).
   *
   * The flash's `expiresAtMs` is set HERE, on the first render that reaches
   * this key while the flash is pending (`expiresAtMs === null`), using
   * THIS render's own `nowMs` — see `Flash`'s doc comment for why anchoring
   * at press time instead would let a flash arrive already expired. A flash
   * that has sat pending for longer than `FLASH_MAX_PENDING_MS` is instead
   * discarded unanchored, so a press whose render never got a chance to run
   * at all cannot resurface as a ring minutes later.
   *
   * Once `nowMs` reaches the (now-anchored) expiry, the flash is discarded
   * and this returns `key` untouched, so the key's hash goes back to exactly
   * what it would have been with no flash ever recorded — letting the
   * dirty-key check in `writeFrame` stop redrawing it.
   */
  private applyFlash(index: number, key: KeySpec, nowMs: number, pageName: string): KeySpec {
    const flash = this.flashes[index]
    if (!flash) return key
    if (flash.page !== pageName) {
      this.flashes[index] = null
      return key
    }
    if (flash.expiresAtMs === null) {
      if (nowMs - flash.createdAtMs > FLASH_MAX_PENDING_MS) {
        this.flashes[index] = null
        return key
      }
      flash.expiresAtMs = nowMs + FLASH_MS
    } else if (nowMs >= flash.expiresAtMs) {
      this.flashes[index] = null
      return key
    }
    return { ...key, flashRing: flash.ok ? theme.flashWhite : theme.flashRed }
  }

  /**
   * Arms (or re-arms) the ONE timer that renders a flash away on time,
   * targeting the EARLIEST still-active expiry on the current page,
   * recomputed from scratch after every render (`runRender`'s last step) —
   * never only at the moment a flash is first anchored. A later press's own
   * anchor can only ever LOWER this timer's target, never raise it, so an
   * earlier key's ring is always cleared on its own schedule, even when a
   * second press lands before the first one expires (I3). And because this
   * runs after every render — including the retry `renderOnce` performs for
   * a request that arrived while busy — a clearing attempt that itself gets
   * dropped for being busy is still followed by a fresh render (via that
   * same retry) that reschedules this timer correctly (I2).
   */
  private scheduleFlashPump(): void {
    if (this.flashPumpTimer) {
      clearTimeout(this.flashPumpTimer)
      this.flashPumpTimer = null
    }
    if (this.stopped) return
    const nowMs = this.nowMs()
    // Age out expired (or overlong-pending) flashes on the CLOCK, before
    // computing the next delay — never only inside `applyFlash` (C2).
    // `applyFlash` runs only when a render's page-building step succeeds far
    // enough to reach `overlayFlashes`; a page that keeps throwing never gets
    // there, so a flash that was already anchored (its `expiresAtMs` already
    // in the past) would otherwise sit forever, with this method re-arming at
    // delay 0 on every single call — an unbounded loop with no dependency on
    // any render ever succeeding. Pruning here, independent of `applyFlash`,
    // closes that regardless of whether the page recovers.
    this.pruneFlashes(nowMs)
    const pageName = this.pages.current().name
    let earliest: number | null = null
    for (const flash of this.flashes) {
      if (!flash || flash.page !== pageName || flash.expiresAtMs === null) continue
      if (earliest === null || flash.expiresAtMs < earliest) earliest = flash.expiresAtMs
    }
    if (earliest === null) return
    let delay = Math.max(0, earliest - nowMs)
    if (this.renderFailureStreak > 0) {
      // Belt and suspenders on top of the pruning above: even if some future
      // change left a flash whose expiry keeps landing at or before "now",
      // this refuses to let the pump re-arm in a tight loop while renders
      // are actively failing. Grows with consecutive failures, capped, so a
      // page that recovers is still retried promptly once it does.
      delay = Math.max(
        delay,
        Math.min(FLASH_PUMP_MAX_BACKOFF_MS, FLASH_PUMP_BACKOFF_STEP_MS * this.renderFailureStreak),
      )
    }
    this.flashPumpTimer = setTimeout(() => {
      this.flashPumpTimer = null
      if (this.stopped) return
      void this.renderNow()
    }, delay)
  }

  /**
   * Clears any flash that is due, purely by the clock: an anchored flash
   * (`expiresAtMs` set) whose expiry has passed, or a pending flash
   * (`expiresAtMs` still `null`) that has sat unanchored for longer than
   * `FLASH_MAX_PENDING_MS`. This is the SAME two rules `applyFlash` already
   * enforces — duplicated here rather than shared, because `applyFlash` also
   * needs `pageName` to decide whether to ANCHOR a still-live flash in the
   * first place, which is not this method's job. Called from
   * `scheduleFlashPump` so a flash's own clock-driven expiry never depends on
   * a render actually reaching `applyFlash` to notice it (C2).
   */
  private pruneFlashes(nowMs: number): void {
    for (let i = 0; i < this.flashes.length; i++) {
      const flash = this.flashes[i]
      if (!flash) continue
      const due =
        flash.expiresAtMs === null
          ? nowMs - flash.createdAtMs > FLASH_MAX_PENDING_MS
          : nowMs >= flash.expiresAtMs
      if (due) this.flashes[i] = null
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
      this.leavePage()
      await this.blankForLock()
    } else {
      this.locked = false
      this.lastTickAtMs = this.nowMs()
      // Armed FIRST (C2), before any other unlock step. Every step below --
      // the brightness write, `onEnter`, the render -- is now best-effort:
      // `setBrightnessSafe` and `enterPage` never throw, and `renderOnce`
      // catches its own failures, so nothing left below CAN reach
      // `queueLockTransition`'s catch anymore. Arming first anyway is the
      // "prefer impossible over unreachable" fix (lesson 21): it makes the
      // render loop's survival structurally independent of whatever runs
      // after it, rather than relying on every one of those calls staying
      // safe forever. The old order -- arm LAST -- let a throw from
      // `setBrightness` (a disconnected device) or a page's `onEnter` reach
      // the catch with `locked = false` and `timer = null`: the deck then
      // froze on its last frame until another full lock/unlock cycle or a
      // press, with no discoverable recovery in between.
      this.armTimer()
      await this.setBrightnessSafe(DEFAULT_BRIGHTNESS)
      this.invalidateFrame()
      this.enterPage()
      await this.renderNow()
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
    } catch (e) {
      // A privacy blank must never throw out of this method (lesson 21):
      // `start()`'s locked branch and `handleReconnect`'s locked branch both
      // call this with nothing downstream to catch a throw. Before this, a
      // pixel write failing here (device connected at entry, then lost
      // mid-write) could reject `start()` outright -- the same crash-loop
      // shape as C1, reached through the locked branch instead of the
      // unlocked one. The brightness backstop below still runs regardless.
      log.once('blank-for-lock', `privacy blank failed: ${String(e)}`)
    } finally {
      // Brightness is the privacy backstop if a pixel write fails while the
      // cable or device is unstable. Pixel blanking still runs first. Routed
      // through `setBrightnessSafe` so a disconnect discovered mid-write
      // cannot itself throw out of this `finally`.
      await this.setBrightnessSafe(0)
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
    if (this.flashPumpTimer) clearTimeout(this.flashPumpTimer)
    this.flashPumpTimer = null
    await this.lockState?.stop()
    await this.lockTransition
    // I1: a render already in flight when `stop()` was called must finish
    // before `stop()` resolves. Measured: without this, a held device write
    // completed AFTER `await daemon.stop()` had already returned, and
    // `bin/deckd.ts`'s shutdown had already gone on to call
    // `device.disconnect()` -- the resumed write then hit a closing or
    // closed handle and logged the "render failed" WARN, a real unawaited
    // operation, not cosmetic noise. `runRender` already catches every
    // failure of its own, so this can only ever wait, never reject; the
    // `.catch` is defensive only, matching the pattern `syncLockState`'s own
    // lock branch already uses when it awaits `activeRender` above.
    await this.activeRender?.catch(() => {})
  }

  /**
   * Best-effort privacy blank for orderly shutdown (I4). Callable only after
   * `stop()`. `bin/deckd.ts`'s shutdown used to blank nothing: the
   * documented `launchctl bootout` recovery path, or the few seconds
   * between a `pkill` and launchd's respawn, left the last frame lit at full
   * brightness -- session names, task tiles -- on a Mac that might then be
   * locked with the daemon no longer running to blank it. Reuses
   * `blankForLock`'s guards, so a failing write here can never block process
   * exit: it checks `isConnected()` itself and never throws.
   */
  async shutdownBlank(): Promise<void> {
    await this.blankForLock()
  }
}
