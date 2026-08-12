import {
  listStreamDecks,
  openStreamDeck,
  type StreamDeck,
} from '@elgato-stream-deck/node'
import type { Rgb } from './render/specs.js'
import { log } from './log.js'

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
      void this.connect()
    }, 2000)
  }

  private async tryOpen(): Promise<void> {
    let found
    try {
      found = await listStreamDecks()
    } catch (e) {
      log.once('enumerate', `cannot list devices: ${String(e)}`)
      return
    }
    const neo = found.find((d) => d.model === 'neo')
    if (!neo) {
      log.once('no-device', 'no Stream Deck Neo found. Retrying every 2 seconds.')
      return
    }
    try {
      this.deck = await openStreamDeck(neo.path)
    } catch (e) {
      // An open failure almost always means another process owns the device.
      throw new DeviceBusyError(
        'cannot open the Stream Deck Neo. Another process may own it. ' +
          'Quit the Elgato Stream Deck app or another deckd instance. ' +
          `Cause: ${String(e)}`,
      )
    }
    log.clearOnce('no-device')
    log.info(`connected to ${this.deck.PRODUCT_NAME}`)
    this.deck.on('down', (c) => this.pressCbs.forEach((cb) => cb(controlIndex(c))))
    this.deck.on('up', (c) => this.releaseCbs.forEach((cb) => cb(controlIndex(c))))
    this.deck.on('error', (e) => {
      log.error(`device error: ${String(e)}`)
      void this.handleLoss()
    })
    this.connectCbs.forEach((cb) => cb())
  }

  private async handleLoss(): Promise<void> {
    this.deck = null
    this.disconnectCbs.forEach((cb) => cb())
    this.scheduleRetry()
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const d = this.deck
    this.deck = null
    if (d) await d.close()
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
