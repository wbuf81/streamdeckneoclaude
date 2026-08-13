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

  constructor(private deps: DeviceDeps = realDeps) {}

  isConnected(): boolean {
    return this.deck !== null
  }

  async connect(): Promise<void> {
    this.stopped = false
    await this.tryOpen()
    if (!this.deck) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      // A scheduled retry must never reject into nothing. A busy device throws
      // from `tryOpen`, and an unhandled rejection can end the process. The
      // throw also happens before `connect` reaches `scheduleRetry`, so without
      // this catch the retry loop stops for good and never reconnects.
      this.connect().catch((e) => {
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
    const neo = found.find((d) => d.model === 'neo')
    if (!neo) {
      log.once('no-device', 'no Stream Deck Neo found. Retrying every 2 seconds.')
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
    this.deck = opened
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

  private async handleLoss(failed: StreamDeck, error: unknown): Promise<void> {
    // An older native handle can report a late error after a replacement has
    // already connected. It must never clear or close the current handle.
    if (this.deck !== failed) return
    log.once('device-error', `device error: ${String(error)}`)
    this.deck = null
    this.disconnectCbs.forEach((cb) => cb())
    try {
      await failed.close()
    } catch (e) {
      log.once('device-close-failed', `failed to close lost device handle: ${String(e)}`)
    }
    this.scheduleRetry()
  }

  async disconnect(): Promise<void> {
    this.stopped = true
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
    await this.getDeck().fillKeyBuffer(index, rgba, { format: 'rgba' })
  }

  async setStrip(rgba: Buffer): Promise<void> {
    // `fillLcd` writes the whole segment. The strip cannot take a sub-region.
    await this.getDeck().fillLcd(0, rgba, { format: 'rgba' })
  }

  async setButtonColor(index: number, rgb: Rgb): Promise<void> {
    if (index !== BUTTON_LEFT && index !== BUTTON_RIGHT) {
      throw new Error(`button index ${index} is not 8 or 9`)
    }
    // There is no `setButtonColor` on the library. The RGB touch buttons take
    // `fillKeyColor` with their key index. `setButtonColor` is our own name.
    await this.getDeck().fillKeyColor(index, rgb[0], rgb[1], rgb[2])
  }

  async setBrightness(percent: number): Promise<void> {
    await this.getDeck().setBrightness(Math.min(100, Math.max(0, percent)))
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
