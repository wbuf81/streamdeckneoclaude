import { describe, it, expect } from 'vitest'
import { FakeDevice, BUTTON_LEFT, BUTTON_RIGHT, NEO_KEY_COUNT } from '../src/fake-device.js'

describe('FakeDevice', () => {
  it('names the Neo control indexes', () => {
    expect(NEO_KEY_COUNT).toBe(8)
    expect(BUTTON_LEFT).toBe(8)
    expect(BUTTON_RIGHT).toBe(9)
  })

  it('records a key write', async () => {
    const d = new FakeDevice()
    await d.connect()
    await d.setKeyImage(3, Buffer.from('img'))
    expect(d.keyWrites).toEqual([{ index: 3, bytes: 3 }])
  })

  it('records the strip and the button colours', async () => {
    const d = new FakeDevice()
    await d.connect()
    await d.setStrip(Buffer.from('strip'))
    await d.setButtonColor(BUTTON_LEFT, [1, 2, 3])
    expect(d.stripWrites).toBe(1)
    expect(d.buttonColors.get(BUTTON_LEFT)).toEqual([1, 2, 3])
  })

  it('rejects a key index outside 0 to 7', async () => {
    const d = new FakeDevice()
    await d.connect()
    await expect(d.setKeyImage(8, Buffer.from('x'))).rejects.toThrow(/index/i)
  })

  it('rejects a write before connect', async () => {
    const d = new FakeDevice()
    await expect(d.setKeyImage(0, Buffer.from('x'))).rejects.toThrow(/connect/i)
  })

  it('delivers a simulated press to the handler', async () => {
    const d = new FakeDevice()
    const seen: number[] = []
    d.onPress((i) => seen.push(i))
    await d.connect()
    d.simulatePress(5)
    expect(seen).toEqual([5])
  })

  it('reports connection state', async () => {
    const d = new FakeDevice()
    expect(d.isConnected()).toBe(false)
    await d.connect()
    expect(d.isConnected()).toBe(true)
    await d.disconnect()
    expect(d.isConnected()).toBe(false)
  })

  it('clears its records on demand', async () => {
    const d = new FakeDevice()
    await d.connect()
    await d.setKeyImage(0, Buffer.from('x'))
    d.reset()
    expect(d.keyWrites).toEqual([])
    expect(d.stripWrites).toBe(0)
  })

  it('fires onDisconnect on an explicit disconnect, like Device does', async () => {
    const d = new FakeDevice()
    let fired = false
    d.onDisconnect(() => {
      fired = true
    })
    await d.connect()
    await d.disconnect()
    expect(fired).toBe(true)
  })
})
