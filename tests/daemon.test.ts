import { describe, it, expect } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { FakeDevice } from '../src/fake-device.js'
import { PageManager } from '../src/page-manager.js'
import type { Page } from '../src/pages/types.js'
import type { DeckFrame, KeySpec } from '../src/render/specs.js'

/** A page whose content the test controls. */
class ControlPage implements Page {
  readonly name = 'test'
  lines = ['A']
  stripText = 'strip A'
  presses: number[] = []

  render(): DeckFrame {
    const keys: KeySpec[] = Array.from({ length: 8 }, (_, i) =>
      i === 0 ? { kind: 'gauge', lines: this.lines } : { kind: 'blank' })
    return {
      keys,
      strip: { lines: [this.stripText] },
      buttons: [[10, 10, 10], [20, 20, 20]],
    }
  }

  onKeyPress(i: number): void {
    this.presses.push(i)
  }
}

function build() {
  const device = new FakeDevice()
  const page = new ControlPage()
  const manager = new PageManager()
  manager.add(page)
  const daemon = new Daemon(device, manager)
  return { device, page, manager, daemon }
}

describe('Daemon', () => {
  it('writes all 8 keys and the strip on the first render', async () => {
    const { device, daemon } = build()
    await daemon.start()
    expect(device.keyWrites).toHaveLength(8)
    expect(device.stripWrites).toBe(1)
    await daemon.stop()
  })

  it('sets both touch button colours on the first render', async () => {
    const { device, daemon } = build()
    await daemon.start()
    expect(device.buttonColors.get(8)).toEqual([10, 10, 10])
    expect(device.buttonColors.get(9)).toEqual([20, 20, 20])
    await daemon.stop()
  })

  it('writes nothing on a second render with no change', async () => {
    const { device, daemon } = build()
    await daemon.start()
    device.reset()
    await daemon.renderOnce(1)
    expect(device.keyWrites).toHaveLength(0)
    expect(device.stripWrites).toBe(0)
    await daemon.stop()
  })

  it('writes only the changed key', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.reset()
    page.lines = ['B']
    await daemon.renderOnce(1)
    expect(device.keyWrites).toEqual([{ index: 0, bytes: expect.any(Number) }])
    await daemon.stop()
  })

  it('writes only the strip when only the strip changed', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.reset()
    page.stripText = 'strip B'
    await daemon.renderOnce(1)
    expect(device.keyWrites).toHaveLength(0)
    expect(device.stripWrites).toBe(1)
    await daemon.stop()
  })

  it('routes a key press to the page', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.simulatePress(3)
    await Promise.resolve()
    expect(page.presses).toContain(3)
    await daemon.stop()
  })

  it('does not route a touch button press to the page', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.simulatePress(8)
    device.simulatePress(9)
    await Promise.resolve()
    expect(page.presses).toEqual([])
    await daemon.stop()
  })

  it('redraws every key after a reconnect', async () => {
    const { device, daemon } = build()
    await daemon.start()
    device.reset()
    await daemon.handleReconnect()
    expect(device.keyWrites).toHaveLength(8)
    await daemon.stop()
  })

  it('survives a write failure and keeps running', async () => {
    const { device, daemon } = build()
    await daemon.start()
    const original = device.setKeyImage.bind(device)
    device.setKeyImage = async () => { throw new Error('usb gone') }
    await expect(daemon.renderOnce(2)).resolves.not.toThrow()
    device.setKeyImage = original
    await daemon.stop()
  })
})
