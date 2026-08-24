import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DeviceModelId,
  type StreamDeck,
  type StreamDeckDeviceInfo,
} from '@elgato-stream-deck/node'
import { Device, NEO_KEY_COUNT } from '../src/device.js'
import { Daemon, type LockStateReader } from '../src/daemon.js'
import { PageManager } from '../src/page-manager.js'
import type { Page } from '../src/pages/types.js'
import type { DeckFrame } from '../src/render/specs.js'

/**
 * A stand-in for one opened handle, with every write `Device` performs.
 * `fail` flips a healthy handle into the wedged state measured live on
 * 2026-08-23: writes reject with an IOKit error while the handle stays open
 * and the library's `'error'` event -- the read loop's, the only thing that
 * used to trigger a reconnect -- never fires again.
 */
function fakeDeck(opts: { fail?: boolean } = {}): StreamDeck & { fail: boolean; closed: number } {
  const state = {
    fail: opts.fail ?? false,
    closed: 0,
  }
  const wedge = async () => {
    if (state.fail) {
      throw new Error(
        'Cannot write to hid device: IOHIDDeviceSetReport failed: (0xE00002C2) (iokit/common) invalid argument',
      )
    }
  }
  return Object.assign(state, {
    PRODUCT_NAME: 'Stream Deck Neo',
    on: vi.fn(),
    close: vi.fn(async () => {
      state.closed += 1
    }),
    fillKeyBuffer: vi.fn(wedge),
    fillLcd: vi.fn(wedge),
    fillKeyColor: vi.fn(wedge),
    setBrightness: vi.fn(wedge),
  }) as unknown as StreamDeck & { fail: boolean; closed: number }
}

/** Enumeration that always finds the Neo. */
const findsNeo = async (): Promise<StreamDeckDeviceInfo[]> => [
  { model: DeviceModelId.NEO, path: '/fake/neo' },
]

afterEach(() => {
  vi.useRealTimers()
})

describe('a failed write recycles the handle', () => {
  it('drops the handle and reconnects when a write rejects', async () => {
    vi.useFakeTimers()
    const wedged = fakeDeck({ fail: true })
    const healthy = fakeDeck()
    let opens = 0
    const openStreamDeck = vi.fn(async (): Promise<StreamDeck> => {
      opens += 1
      return opens === 1 ? wedged : healthy
    })

    const device = new Device({ listStreamDecks: findsNeo, openStreamDeck })
    await device.connect()
    expect(device.isConnected()).toBe(true)

    // The write rejects to its caller, exactly as before -- the daemon still
    // logs "render failed" and invalidates its frame cache.
    await expect(device.setBrightness(100)).rejects.toThrow('0xE00002C2')

    // ...but the handle must now be considered lost. Before this fix,
    // `isConnected()` stayed true forever and no retry was ever scheduled:
    // the daemon sat wedged for three hours with no input and no output.
    expect(device.isConnected()).toBe(false)
    expect(wedged.closed).toBe(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(device.isConnected()).toBe(true)
    expect(opens).toBe(2)
  })

  it('fires the disconnect callbacks so the daemon learns about the loss', async () => {
    vi.useFakeTimers()
    const wedged = fakeDeck({ fail: true })
    const device = new Device({
      listStreamDecks: findsNeo,
      openStreamDeck: async () => wedged,
    })
    let disconnects = 0
    device.onDisconnect(() => {
      disconnects += 1
    })

    await device.connect()
    await expect(device.setStrip(Buffer.alloc(4))).rejects.toThrow()

    expect(disconnects).toBe(1)
  })

  it('does not recycle a healthy handle when the key index is out of range', async () => {
    vi.useFakeTimers()
    const healthy = fakeDeck()
    const device = new Device({
      listStreamDecks: findsNeo,
      openStreamDeck: async () => healthy,
    })
    await device.connect()

    // An argument the caller got wrong says nothing about the device. Tearing
    // the connection down here would let one bad frame cost a real reconnect.
    await expect(device.setKeyImage(NEO_KEY_COUNT, Buffer.alloc(4))).rejects.toThrow(
      'outside 0 to 7',
    )

    expect(device.isConnected()).toBe(true)
    expect(healthy.closed).toBe(0)
  })
})

describe('the liveness heartbeat', () => {
  it('re-sends the current brightness when nothing has been written for a while', async () => {
    vi.useFakeTimers()
    const healthy = fakeDeck()
    const device = new Device(
      { listStreamDecks: findsNeo, openStreamDeck: async () => healthy },
      { heartbeatMs: 1000 },
    )
    await device.connect()
    await device.setBrightness(70)
    const writesAfterSetup = (healthy.setBrightness as ReturnType<typeof vi.fn>).mock.calls.length

    await vi.advanceTimersByTimeAsync(2500)

    const calls = (healthy.setBrightness as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBeGreaterThan(writesAfterSetup)
    // The probe must be invisible: it re-sends the value already on the
    // device. Probing with anything else would light a locked, blanked deck.
    expect(calls[calls.length - 1]?.[0]).toBe(70)
  })

  it('recycles the handle when the probe fails', async () => {
    vi.useFakeTimers()
    const deck = fakeDeck()
    const device = new Device(
      { listStreamDecks: findsNeo, openStreamDeck: async () => deck },
      { heartbeatMs: 1000 },
    )
    await device.connect()
    await device.setBrightness(70)

    // The handle wedges with no further reads and no error event -- nothing
    // the old code could ever notice, because the daemon writes nothing at
    // all while a static page is showing.
    deck.fail = true
    await vi.advanceTimersByTimeAsync(1500)

    expect(device.isConnected()).toBe(false)
  })

  it('stays quiet while ordinary writes are succeeding', async () => {
    vi.useFakeTimers()
    const healthy = fakeDeck()
    const device = new Device(
      { listStreamDecks: findsNeo, openStreamDeck: async () => healthy },
      { heartbeatMs: 1000 },
    )
    await device.connect()
    await device.setBrightness(70)

    const before = (healthy.setBrightness as ReturnType<typeof vi.fn>).mock.calls.length
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(400)
      await device.setKeyImage(0, Buffer.alloc(4))
    }

    // A page that renders every second already proves the handle is alive.
    expect((healthy.setBrightness as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before)
  })
})

describe('escalation when recycling does not help', () => {
  it('reports unrecoverable after repeated sessions that never write', async () => {
    vi.useFakeTimers()
    const onUnrecoverable = vi.fn()
    const wedging = new Device(
      { listStreamDecks: findsNeo, openStreamDeck: async () => fakeDeck({ fail: true }) },
      { maxFailedSessions: 3, onUnrecoverable },
    )

    await wedging.connect()
    for (let i = 0; i < 3; i += 1) {
      await wedging.setBrightness(100).catch(() => {})
      await vi.advanceTimersByTimeAsync(2000)
    }

    expect(onUnrecoverable).toHaveBeenCalledTimes(1)
  })

  it('never reports unrecoverable while the deck is simply unplugged', async () => {
    vi.useFakeTimers()
    const onUnrecoverable = vi.fn()
    const device = new Device(
      { listStreamDecks: async () => [], openStreamDeck: async () => fakeDeck() },
      { maxFailedSessions: 3, onUnrecoverable },
    )

    await device.connect()
    await vi.advanceTimersByTimeAsync(30000)

    // An absent device is a correct, documented state: the retry loop waits
    // for the cable. Exiting here would make launchd respawn us forever.
    expect(onUnrecoverable).not.toHaveBeenCalled()
    expect(device.isConnected()).toBe(false)
  })

  it('forgets earlier failed sessions once a write succeeds', async () => {
    vi.useFakeTimers()
    const onUnrecoverable = vi.fn()
    const wedged = fakeDeck({ fail: true })
    const healthy = fakeDeck()
    let opens = 0
    const device = new Device(
      {
        listStreamDecks: findsNeo,
        openStreamDeck: async () => {
          opens += 1
          return opens <= 2 ? wedged : healthy
        },
      },
      { maxFailedSessions: 3, onUnrecoverable },
    )

    await device.connect()
    // Two wedged sessions, then a healthy one that writes successfully.
    await device.setBrightness(100).catch(() => {})
    await vi.advanceTimersByTimeAsync(2000)
    await device.setBrightness(100).catch(() => {})
    await vi.advanceTimersByTimeAsync(2000)
    await device.setBrightness(100)

    // A third wedged session AFTER a good write must not trip the counter,
    // or an intermittent cable would eventually be called unrecoverable.
    expect(onUnrecoverable).not.toHaveBeenCalled()
  })
})

/** The least page `Daemon` needs to start. */
class QuietPage implements Page {
  readonly name = 'quiet'
  onKeyPress(): 'ignored' {
    return 'ignored'
  }
  render(): DeckFrame {
    return {
      keys: Array.from({ length: NEO_KEY_COUNT }, () => ({ kind: 'blank' as const })),
      strip: { lines: [] },
      buttons: [[0, 0, 0], [0, 0, 0]],
    }
  }
}

/** A screen lock whose state the test sets directly. */
class StuckLock implements LockStateReader {
  constructor(private locked: boolean) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async refresh(): Promise<void> {}
  isLocked(): boolean {
    return this.locked
  }
  onChange(): void {}
}

describe('the privacy blank survives a wedged handle', () => {
  it('re-blanks the locked deck on the handle it reconnects to', async () => {
    vi.useFakeTimers()
    const wedged = fakeDeck({ fail: true })
    const healthy = fakeDeck()
    let opens = 0
    const device = new Device({
      listStreamDecks: findsNeo,
      openStreamDeck: async () => {
        opens += 1
        return opens === 1 ? wedged : healthy
      },
    })
    const pages = new PageManager()
    pages.add(new QuietPage())
    const daemon = new Daemon(device, pages, () => 0, () => 0, new StuckLock(true))

    // The screen is already locked, so `start()` goes straight to the privacy
    // blank -- and every write of it fails on the wedged handle, exactly as
    // the 23:12:42 line in the live log records. Before this fix that was the
    // end of it: session names stayed lit on a locked Mac with nothing left
    // that could ever blank them.
    await daemon.start()
    expect(device.isConnected()).toBe(false)

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(0)

    // The reconnect lands while still locked, so it must re-blank rather than
    // repaint the page.
    const blanked = (healthy.setBrightness as ReturnType<typeof vi.fn>).mock.calls
    expect(blanked.some((c) => c[0] === 0)).toBe(true)
    expect((healthy.fillKeyBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      NEO_KEY_COUNT,
    )

    await daemon.stop()
    await device.disconnect()
  })
})
