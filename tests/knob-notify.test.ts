import { describe, it, expect, vi, afterEach } from 'vitest'
import { createLogger } from '../src/log.js'
import { KnobNotifier, type KnobFetcher } from '../src/knob-notify.js'

const quietLogger = () => createLogger(() => {})

describe('KnobNotifier', () => {
  afterEach(() => vi.useRealTimers())

  it('sends awake or locked on the path the device answers', async () => {
    const urls: string[] = []
    const fetcher = vi.fn<KnobFetcher>(async (url) => {
      urls.push(url)
      return { ok: true, status: 204 }
    })
    const n = new KnobNotifier('knob.test', 5000, fetcher, quietLogger())
    n.start(false)
    await n.stop()
    expect(urls).toEqual(['http://knob.test/awake'])

    urls.length = 0
    const m = new KnobNotifier('knob.test', 5000, fetcher, quietLogger())
    m.start(true)
    await m.stop()
    expect(urls).toEqual(['http://knob.test/locked'])
  })

  it('repeats on the interval, because the device treats silence as sleep', async () => {
    vi.useFakeTimers()
    let sent = 0
    const fetcher = vi.fn<KnobFetcher>(async () => {
      sent += 1
      return { ok: true, status: 204 }
    })
    const n = new KnobNotifier('knob.test', 1000, fetcher, quietLogger())
    n.start(false)
    await vi.advanceTimersByTimeAsync(3500)
    await n.stop()
    // One at start, then one per interval. A change notification alone would
    // leave a sleeping Mac indistinguishable from a stopped daemon.
    expect(sent).toBeGreaterThanOrEqual(4)
  })

  it('does not lose a lock change that arrives during a heartbeat', async () => {
    // The change is requested while the opening send is still in flight, which
    // is the case that used to drop it silently and leave the device wrong for
    // a whole interval. `stop()` deliberately does NOT flush a pending send —
    // that is right for shutdown — so the wait here is for the send itself.
    const urls: string[] = []
    const fetcher = vi.fn<KnobFetcher>(async (url) => {
      urls.push(url)
      return { ok: true, status: 204 }
    })
    const n = new KnobNotifier('knob.test', 60_000, fetcher, quietLogger())
    n.start(false)
    n.setLocked(true)
    await vi.waitFor(() => expect(urls).toContain('http://knob.test/locked'))
    expect(urls.at(-1)).toBe('http://knob.test/locked')
    await n.stop()
  })

  it('logs an unreachable device once per outage, not once per beat', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const fetcher = vi.fn<KnobFetcher>(async () => {
      throw new Error('ENOTFOUND')
    })
    const n = new KnobNotifier('knob.test', 1000, fetcher, createLogger((l) => lines.push(l)))
    n.start(false)
    await vi.advanceTimersByTimeAsync(5000)
    await n.stop()
    const complaints = lines.filter((l) => l.includes('unreachable'))
    // An unplugged display is a normal state. It must not fill the log.
    expect(complaints.length).toBe(1)
  })

  it('logs again after a recovery and a second outage', async () => {
    vi.useFakeTimers()
    const lines: string[] = []
    let up = false
    const fetcher = vi.fn<KnobFetcher>(async () => {
      if (!up) throw new Error('ENOTFOUND')
      return { ok: true, status: 204 }
    })
    const n = new KnobNotifier('knob.test', 1000, fetcher, createLogger((l) => lines.push(l)))
    n.start(false)
    await vi.advanceTimersByTimeAsync(1500)
    up = true
    await vi.advanceTimersByTimeAsync(1500)
    up = false
    await vi.advanceTimersByTimeAsync(1500)
    await n.stop()
    // Two outages, so two lines: the key is cleared on recovery.
    expect(lines.filter((l) => l.includes('unreachable')).length).toBe(2)
  })

  it('does not overlap requests while one is in flight', async () => {
    vi.useFakeTimers()
    let started = 0
    // A holder, not a bare `let`: TypeScript narrows a variable only assigned
    // inside a callback to `never`, and the project's typecheck is strict.
    const gate: { release: (() => void) | null } = { release: null }
    const fetcher = vi.fn<KnobFetcher>(async () => {
      started += 1
      await new Promise<void>((r) => {
        gate.release = r
      })
      return { ok: true, status: 204 }
    })
    const n = new KnobNotifier('knob.test', 500, fetcher, quietLogger())
    n.start(false)
    await vi.advanceTimersByTimeAsync(2000)
    // A slow device must not accumulate one request per beat for as long as it
    // stays slow.
    expect(started).toBe(1)
    gate.release?.()
    await n.stop()
  })

  it('stays silent when a send resolves after stop', async () => {
    const lines: string[] = []
    const gate: { release: ((v: { ok: boolean; status: number }) => void) | null } = {
      release: null,
    }
    const fetcher = vi.fn<KnobFetcher>(
      () =>
        new Promise((r) => {
          gate.release = r
        }),
    )
    const n = new KnobNotifier('knob.test', 60_000, fetcher, createLogger((l) => lines.push(l)))
    n.start(false)
    await Promise.resolve()
    const stopping = n.stop()
    gate.release?.({ ok: false, status: 500 })
    await stopping
    expect(lines).toEqual([])
  })
})
