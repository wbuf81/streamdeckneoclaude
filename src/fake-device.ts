import type { Rgb } from './render/specs.js'
import type { DeckDevice } from './device.js'

export { NEO_KEY_COUNT, BUTTON_LEFT, BUTTON_RIGHT } from './device.js'
import { NEO_KEY_COUNT, BUTTON_LEFT, BUTTON_RIGHT } from './device.js'

export interface KeyWrite {
  index: number
  bytes: number
}

/** Records every write, so a test can count them. */
export class FakeDevice implements DeckDevice {
  keyWrites: KeyWrite[] = []
  keyImages = new Map<number, Buffer>()
  stripWrites = 0
  stripImage: Buffer | null = null
  buttonColors = new Map<number, Rgb>()
  brightness = 100

  private connected = false
  private pressCbs: ((i: number) => void)[] = []
  private releaseCbs: ((i: number) => void)[] = []
  private connectCbs: (() => void)[] = []
  private disconnectCbs: (() => void)[] = []

  isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<void> {
    this.connected = true
    this.connectCbs.forEach((cb) => cb())
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.disconnectCbs.forEach((cb) => cb())
  }

  private check(): void {
    if (!this.connected) throw new Error('device is not connected')
  }

  async setKeyImage(index: number, png: Buffer): Promise<void> {
    this.check()
    if (index < 0 || index >= NEO_KEY_COUNT) {
      throw new Error(`key index ${index} is outside 0 to 7`)
    }
    this.keyWrites.push({ index, bytes: png.length })
    this.keyImages.set(index, Buffer.from(png))
  }

  async setStrip(_png: Buffer): Promise<void> {
    this.check()
    this.stripWrites += 1
    this.stripImage = Buffer.from(_png)
  }

  async setButtonColor(index: number, rgb: Rgb): Promise<void> {
    this.check()
    if (index !== BUTTON_LEFT && index !== BUTTON_RIGHT) {
      throw new Error(`button index ${index} is not 8 or 9`)
    }
    this.buttonColors.set(index, rgb)
  }

  async setBrightness(percent: number): Promise<void> {
    this.check()
    this.brightness = percent
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

  /** Test helper. Fires a press on the given index. */
  simulatePress(index: number): void {
    this.pressCbs.forEach((cb) => cb(index))
  }

  /** Test helper. Fires a release on the given index. */
  simulateRelease(index: number): void {
    this.releaseCbs.forEach((cb) => cb(index))
  }

  /** Test helper. Clears every record. */
  reset(): void {
    this.keyWrites = []
    this.keyImages.clear()
    this.stripWrites = 0
    this.stripImage = null
    this.buttonColors.clear()
  }
}
