import {
  listStreamDecks,
  openStreamDeck,
  type StreamDeck,
} from '@elgato-stream-deck/node'
import type { Rgb } from './render/specs.js'
import { log } from './log.js'

/**
 * The two library calls `Device` needs, factored out so a test can inject a
 * fake enumeration and a fake open. Defaults to the real library.
 */
export interface DeviceDeps {
  listStreamDecks: typeof listStreamDecks
  openStreamDeck: typeof openStreamDeck
}

const realDeps: DeviceDeps = { listStreamDecks, openStreamDeck }

/** How long a connected handle may go without a successful write before the
 *  heartbeat probes it. */
const HEARTBEAT_MS = 15000
/** Consecutive opened-then-never-wrote sessions before this gives up. */
const MAX_FAILED_SESSIONS = 5

/**
 * Health policy, all injectable so a test can drive it without waiting on
 * real time. The defaults are the production values.
 */
export interface DeviceOptions {
  heartbeatMs?: number
  maxFailedSessions?: number
  /**
   * Called at most once, when recycling the handle has stopped helping.
   * `bin/deckd.ts` supplies the escalation: notify the user, then exit so
   * launchd's `KeepAlive` starts a clean process. Kept as a callback rather
   * than a `process.exit` in here so the policy stays out of the library and
   * a test can observe it.
   */
  onUnrecoverable?: (reason: string) => void
}

export const NEO_KEY_COUNT = 8
export const BUTTON_LEFT = 8
export const BUTTON_RIGHT = 9

export interface DeckDevice {
  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  setKeyImage(index: number, png: Buffer): Promise<void>
  setStrip(png: Buffer): Promise<void>
  setButtonColor(index: number, rgb: Rgb): Promise<void>
  setBrightness(percent: number): Promise<void>
  onPress(cb: (index: number) => void): void
  onRelease(cb: (index: number) => void): void
  onConnect(cb: () => void): void
  onDisconnect(cb: () => void): void
}

/** Thrown when another process already holds the device. */
export class DeviceBusyError extends Error {}

/**
 * The real Stream Deck Neo. It is the only module that imports the Elgato
 * library. It retries enumeration, so an unplugged cable is not fatal.
 */
export class Device implements DeckDevice {
  private deck: StreamDeck | null = null
  private pressCbs: ((i: number) => void)[] = []
  private releaseCbs: ((i: number) => void)[] = []
  private connectCbs: (() => void)[] = []
  private disconnectCbs: (() => void)[] = []
  private retry: NodeJS.Timeout | null = null
  private stopped = false

  /**
   * Device health. The invariant these four fields exist to hold:
   *
   *   **connected means the handle accepted a write recently.**
   *
   * Measured on 2026-08-23: after a run of USB drops, `openStreamDeck`
   * returned a handle whose every write rejected with `0xE00002C2` while the
   * library's `'error'` event -- raised by the READ loop, and until now the
   * only thing that called `handleLoss` -- never fired again. `isConnected()`
   * stayed true, no retry was ever scheduled, and no `down` events arrived
   * either, so the deck had neither input nor output for three hours. The
   * privacy blank at 23:12:42 failed on that handle and left the locked
   * Mac's last frame lit.
   *
   * The fix deliberately does NOT classify IOKit error codes. A taxonomy
   * only ever covers the failures already seen; the next unknown code wedges
   * us again exactly as this one did (lesson 21 -- fixes aimed at the repro
   * leave the harm reachable). Any failed write means the handle is suspect,
   * and a needless reconnect costs two seconds.
   */
  private lastWriteOkMs = 0
  private lastBrightness: number | null = null
  private sessionWrote = false
  private failedSessions = 0
  private gaveUp = false
  private degradedSinceMs: number | null = null
  private heartbeat: NodeJS.Timeout | null = null

  private readonly heartbeatMs: number
  private readonly maxFailedSessions: number
  private readonly onUnrecoverable: ((reason: string) => void) | null

  constructor(
    private deps: DeviceDeps = realDeps,
    options: DeviceOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
    this.maxFailedSessions = options.maxFailedSessions ?? MAX_FAILED_SESSIONS
    this.onUnrecoverable = options.onUnrecoverable ?? null
  }

  isConnected(): boolean {
    return this.deck !== null
  }

  /**
   * A fresh, EXTERNALLY requested connect. Only this resets `stopped`
   * (lesson 8: `stopped` must be one-way for the retry path) — the internal
   * retry loop below calls `attemptConnect` directly, never this method, so
   * an in-flight retry can never undo a concurrent `disconnect()`'s
   * `stopped = true` (I2).
   */
  async connect(): Promise<void> {
    this.stopped = false
    await this.attemptConnect()
  }

  /**
   * Does the actual enumerate-and-open work, without ever resetting
   * `stopped`. Used by both `connect()` (after it resets the flag) and the
   * retry loop (which must not). Bails immediately if `disconnect()` has
   * already run — `tryOpen` also re-checks after each of its own awaits, so
   * a `disconnect()` that lands mid-enumeration or mid-open is caught there
   * too, not just at entry here.
   */
  private async attemptConnect(): Promise<void> {
    if (this.stopped) return
    await this.tryOpen()
    if (!this.deck) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      // A scheduled retry must never reject into nothing. A busy device throws
      // from `tryOpen`, and an unhandled rejection can end the process. The
      // throw also happens before `attemptConnect` reaches `scheduleRetry`, so
      // without this catch the retry loop stops for good and never reconnects.
      this.attemptConnect().catch((e) => {
        log.once('open-failed', String(e))
        this.scheduleRetry()
      })
    }, 2000)
  }

  private async tryOpen(): Promise<void> {
    let found
    try {
      found = await this.deps.listStreamDecks()
    } catch (e) {
      log.once('enumerate', `cannot list devices: ${String(e)}`)
      return
    }
    // `disconnect()` may have run while enumeration was in flight (I2). Bail
    // before touching `this.deck` or opening anything on its behalf.
    if (this.stopped) return
    const neo = found.find((d) => d.model === 'neo')
    if (!neo) {
      log.once('no-device', 'no Stream Deck Neo found. Retrying every 2 seconds.')
      // An absent deck is a correct, documented state, not a wedge: the user
      // unplugged the cable and the retry loop is supposed to wait for it.
      // Letting absence feed `failedSessions` would eventually call an
      // unplugged deck unrecoverable and have launchd respawn us forever.
      this.failedSessions = 0
      return
    }
    let opened: StreamDeck
    try {
      opened = await this.deps.openStreamDeck(neo.path)
    } catch (e) {
      // An open failure almost always means another process owns the device.
      throw new DeviceBusyError(
        'cannot open the Stream Deck Neo. Another process may own it. ' +
          'Quit the Elgato Stream Deck app or another deckd instance. ' +
          `Cause: ${String(e)}`,
      )
    }
    if (this.stopped) {
      // `disconnect()` ran while `openStreamDeck` was in flight (I2, the
      // probed case): a handle finished opening after shutdown already asked
      // for the device to be closed. Close it rather than adopting it, so
      // `isConnected()` cannot report `true` after `disconnect()` resolved.
      try {
        await opened.close()
      } catch (e) {
        log.once('device-close-failed', `failed to close a late-opened handle: ${String(e)}`)
      }
      return
    }
    this.deck = opened
    // A fresh session has written nothing yet. `handleLoss` reads this to
    // tell "opened and worked, then the cable moved" from "opened and never
    // accepted a byte", which is the signature of the wedge.
    this.sessionWrote = false
    this.startHeartbeat()
    log.clearOnce('no-device')
    log.clearOnce('open-failed')
    log.clearOnce('enumerate')
    log.clearOnce('device-error')
    log.clearOnce('device-close-failed')
    log.info(`connected to ${this.deck.PRODUCT_NAME}`)
    opened.on('down', (c) => this.pressCbs.forEach((cb) => cb(controlIndex(c))))
    opened.on('up', (c) => this.releaseCbs.forEach((cb) => cb(controlIndex(c))))
    opened.on('error', (e) => {
      void this.handleLoss(opened, e)
    })
    this.connectCbs.forEach((cb) => cb())
  }

  /**
   * `source` keeps the two logged shapes distinct, so a write-side wedge and
   * an ordinary read-side cable drop never look like one defect drifting.
   */
  private async handleLoss(
    failed: StreamDeck,
    error: unknown,
    source: 'read' | 'write' = 'read',
  ): Promise<void> {
    // An older native handle can report a late error after a replacement has
    // already connected. It must never clear or close the current handle.
    if (this.deck !== failed) return
    if (source === 'write') {
      log.once('device-write', `device write failed; recycling the handle: ${String(error)}`)
      if (this.degradedSinceMs === null) this.degradedSinceMs = Date.now()
    } else {
      log.once('device-error', `device error: ${String(error)}`)
    }
    this.deck = null
    this.stopHeartbeat()
    this.noteSessionEnded()
    this.disconnectCbs.forEach((cb) => cb())
    try {
      await failed.close()
    } catch (e) {
      log.once('device-close-failed', `failed to close lost device handle: ${String(e)}`)
    }
    this.scheduleRetry()
  }

  /**
   * Counts a session that opened but never accepted a single write, and
   * escalates once those stop being worth retrying. Only the never-wrote
   * case counts: a handle that worked and then lost its cable is the
   * ordinary, recoverable drop the retry loop already handles well.
   */
  private noteSessionEnded(): void {
    if (this.sessionWrote) return
    this.failedSessions += 1
    if (this.failedSessions < this.maxFailedSessions || this.gaveUp) return
    this.gaveUp = true
    const reason =
      `the deck opened ${this.failedSessions} times in a row without accepting a single write`
    log.error(`device unrecoverable: ${reason}`)
    this.onUnrecoverable?.(reason)
  }

  /** Records a write that the device actually accepted. */
  private noteWriteOk(): void {
    this.lastWriteOkMs = Date.now()
    this.sessionWrote = true
    this.failedSessions = 0
    log.clearOnce('device-write')
    if (this.degradedSinceMs !== null) {
      const seconds = Math.round((Date.now() - this.degradedSinceMs) / 1000)
      log.info(`device write path recovered after ${seconds}s`)
      this.degradedSinceMs = null
    }
  }

  /**
   * Runs one write against the current handle, and treats any failure as a
   * lost device. `getDeck()` throws BEFORE the try when nothing is
   * connected, and each caller validates its own arguments before getting
   * here, so neither of those can be mistaken for a device fault.
   *
   * `handleLoss` is deliberately NOT awaited: it closes the native handle,
   * and a wedged handle can be slow to close. The caller's rejection must
   * not wait on that. Everything `handleLoss` does that matters here --
   * clearing `deck`, firing the disconnect callbacks -- happens
   * synchronously before its first await, so `isConnected()` is already
   * false by the time this rethrows.
   */
  private async write<T>(fn: (deck: StreamDeck) => Promise<T>): Promise<T> {
    const deck = this.getDeck()
    try {
      const result = await fn(deck)
      this.noteWriteOk()
      return result
    } catch (e) {
      void this.handleLoss(deck, e, 'write')
      throw e
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat || this.stopped) return
    this.heartbeat = setInterval(() => void this.probe(), this.heartbeatMs)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  /**
   * Proves the handle is still writable when nothing else has needed it.
   *
   * `writeFrame` skips unchanged keys, so a static page -- Stocks after the
   * close, Weather between refreshes -- can go minutes without writing a
   * byte. Without this probe, "no write has failed" would mean nothing at
   * all during exactly those stretches, and a handle could wedge silently.
   *
   * The probe re-sends the brightness ALREADY on the device, so it is
   * invisible when it succeeds. Sending any other value would light a
   * locked, blanked deck -- a privacy failure caused by the health check
   * itself.
   */
  private async probe(): Promise<void> {
    if (this.stopped || !this.deck) return
    if (this.lastBrightness === null) return
    if (Date.now() - this.lastWriteOkMs < this.heartbeatMs) return
    try {
      await this.setBrightness(this.lastBrightness)
    } catch {
      // `write` has already recycled the handle and logged the reason.
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    this.stopHeartbeat()
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const d = this.deck
    this.deck = null
    if (d) await d.close()
    // Fire the callbacks here too. `FakeDevice` does, and a test written
    // against the fake must describe the real device. `stopped` is already
    // true, so no retry starts.
    this.disconnectCbs.forEach((cb) => cb())
  }

  private getDeck(): StreamDeck {
    if (!this.deck) throw new Error('device is not connected')
    return this.deck
  }

  // The method names and the format below are measured against the installed
  // library and the real device. See "Verified device and canvas API" above.
  // The device has no PNG support, so every buffer here is raw RGBA.

  async setKeyImage(index: number, rgba: Buffer): Promise<void> {
    if (index < 0 || index >= NEO_KEY_COUNT) {
      throw new Error(`key index ${index} is outside 0 to 7`)
    }
    await this.write((deck) => deck.fillKeyBuffer(index, rgba, { format: 'rgba' }))
  }

  async setStrip(rgba: Buffer): Promise<void> {
    // `fillLcd` writes the whole segment. The strip cannot take a sub-region.
    await this.write((deck) => deck.fillLcd(0, rgba, { format: 'rgba' }))
  }

  async setButtonColor(index: number, rgb: Rgb): Promise<void> {
    if (index !== BUTTON_LEFT && index !== BUTTON_RIGHT) {
      throw new Error(`button index ${index} is not 8 or 9`)
    }
    // There is no `setButtonColor` on the library. The RGB touch buttons take
    // `fillKeyColor` with their key index. `setButtonColor` is our own name.
    await this.write((deck) => deck.fillKeyColor(index, rgb[0], rgb[1], rgb[2]))
  }

  async setBrightness(percent: number): Promise<void> {
    const clamped = Math.min(100, Math.max(0, percent))
    await this.write((deck) => deck.setBrightness(clamped))
    // Remembered only after the device accepted it, so the heartbeat can
    // re-send a value the deck is genuinely already showing.
    this.lastBrightness = clamped
  }

  onPress(cb: (i: number) => void): void {
    this.pressCbs.push(cb)
  }
  onRelease(cb: (i: number) => void): void {
    this.releaseCbs.push(cb)
  }
  onConnect(cb: () => void): void {
    this.connectCbs.push(cb)
  }
  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb)
  }
}

/** Maps a library control event to a flat index. */
function controlIndex(control: { index?: number }): number {
  return control.index ?? -1
}
