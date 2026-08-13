import { describe, it, expect, vi } from 'vitest'
import {
  DeviceModelId,
  type StreamDeck,
  type StreamDeckDeviceInfo,
} from '@elgato-stream-deck/node'
import { Device } from '../src/device.js'

/** A minimal stand-in for the opened device. Only the members `Device` touches. */
function fakeDeck(): StreamDeck {
  return {
    PRODUCT_NAME: 'Stream Deck Neo',
    on: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as StreamDeck
}

describe('Device retry loop', () => {
  it('keeps retrying after a scheduled retry finds the device busy', async () => {
    vi.useFakeTimers()
    try {
      let listCalls = 0
      let openCalls = 0
      const deck = fakeDeck()

      // First enumeration: nothing plugged in. Every later enumeration finds
      // the Neo, so the busy failure comes from `openStreamDeck`, not from
      // enumeration.
      const listStreamDecks = vi.fn(async (): Promise<StreamDeckDeviceInfo[]> => {
        listCalls += 1
        if (listCalls === 1) return []
        return [{ model: DeviceModelId.NEO, path: '/fake/neo' }]
      })

      // First open attempt (on the first scheduled retry): busy, throws.
      // Second open attempt (on the next scheduled retry): succeeds.
      const openStreamDeck = vi.fn(async (): Promise<StreamDeck> => {
        openCalls += 1
        if (openCalls === 1) throw new Error('device busy (simulated)')
        return deck
      })

      const device = new Device({ listStreamDecks, openStreamDeck })

      await device.connect()
      expect(device.isConnected()).toBe(false)
      expect(listCalls).toBe(1)

      // The scheduled retry finds the device but fails to open it. Without the
      // fix, this throws into an unhandled rejection and the retry loop dies,
      // so no further timer is ever scheduled.
      await vi.advanceTimersByTimeAsync(2000)
      expect(device.isConnected()).toBe(false)
      expect(openCalls).toBe(1)

      // A further retry must still happen. This only fires if the busy
      // rejection above was caught and `scheduleRetry` was called again.
      await vi.advanceTimersByTimeAsync(2000)
      expect(device.isConnected()).toBe(true)
      expect(openCalls).toBe(2)

      await device.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Device onDisconnect parity', () => {
  it('fires onDisconnect on an explicit disconnect, like FakeDevice does', async () => {
    const deck = fakeDeck()
    const listStreamDecks = vi.fn(
      async (): Promise<StreamDeckDeviceInfo[]> => [{ model: DeviceModelId.NEO, path: '/fake/neo' }],
    )
    const openStreamDeck = vi.fn(async (): Promise<StreamDeck> => deck)
    const device = new Device({ listStreamDecks, openStreamDeck })

    let fired = false
    device.onDisconnect(() => {
      fired = true
    })

    await device.connect()
    expect(device.isConnected()).toBe(true)

    await device.disconnect()
    expect(fired).toBe(true)
  })
})

describe('Device loss ownership', () => {
  it('closes a failed handle and reconnects', async () => {
    vi.useFakeTimers()
    try {
      let errorHandler: ((error: Error) => void) | undefined
      const first = {
        ...fakeDeck(),
        on: vi.fn((event: string, cb: (error: Error) => void) => {
          if (event === 'error') errorHandler = cb
        }),
        close: vi.fn(async () => {}),
      } as unknown as StreamDeck
      const second = fakeDeck()
      let opens = 0
      const device = new Device({
        listStreamDecks: vi.fn(async () => [{ model: DeviceModelId.NEO, path: '/fake/neo' }]),
        openStreamDeck: vi.fn(async () => (++opens === 1 ? first : second)),
      })

      await device.connect()
      errorHandler?.(new Error('cable moved'))
      await Promise.resolve()
      expect(device.isConnected()).toBe(false)
      expect(first.close).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2000)
      expect(device.isConnected()).toBe(true)
      await device.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a late error from an older handle after reconnect', async () => {
    vi.useFakeTimers()
    try {
      let firstError: ((error: Error) => void) | undefined
      const first = {
        ...fakeDeck(),
        on: vi.fn((event: string, cb: (error: Error) => void) => {
          if (event === 'error') firstError = cb
        }),
        close: vi.fn(async () => {}),
      } as unknown as StreamDeck
      const second = fakeDeck()
      let opens = 0
      const device = new Device({
        listStreamDecks: vi.fn(async () => [{ model: DeviceModelId.NEO, path: '/fake/neo' }]),
        openStreamDeck: vi.fn(async () => (++opens === 1 ? first : second)),
      })

      await device.connect()
      firstError?.(new Error('first loss'))
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2000)
      expect(device.isConnected()).toBe(true)

      firstError?.(new Error('late stale error'))
      await Promise.resolve()
      expect(device.isConnected()).toBe(true)
      expect(second.close).not.toHaveBeenCalled()
      await device.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})
