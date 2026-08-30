import { log, type Logger } from './log.js'

/**
 * How the knob display is addressed.
 *
 * There is NO default any more. The list used to hold the author's own
 * hostname and LAN address, which is nobody else's device and does not belong
 * in a public source tree. An empty list disables the heartbeat entirely, and
 * that is the correct behaviour for anyone who does not own one of these.
 *
 * Configure it under `knob.hosts` in `config.json`, or override with the
 * `KNOB_HOSTS` environment variable as a comma-separated list. Order matters:
 * put the most likely address first. More than one entry is worth having
 * because mDNS alone was not reliable enough — measured on the author's Mac,
 * `ping <name>.local` resolves, but resolution from Node repeatedly failed or
 * took longer than any sane request timeout, so the heartbeat never arrived
 * and the device sat on a stale state. A plain IP is the fallback, and the
 * first candidate that answers is remembered and tried first from then on, so
 * a DHCP change costs one failed beat rather than a permanent outage.
 *
 * The device advertises `_http._tcp` and answers `/awake` and `/locked` with
 * 204.
 */

/**
 * How often the state is repeated. The device treats silence as sleep, so this
 * is a heartbeat and not only a change notification: a Mac going to sleep
 * cannot send "I am asleep", it simply stops sending. The device's own timeout
 * is 25 s, comfortably more than three of these, so one lost packet is not a
 * blackout.
 */
const DEFAULT_INTERVAL_MS = 5000

/**
 * A wedged request must not delay the next heartbeat, but this also has to
 * survive a cold mDNS lookup. At 2000 ms the very first beat after a daemon
 * restart aborted every time - macOS `.local` resolution from Node is slow
 * until the name is cached - which logged an outage for a device that was
 * answering fine a second later.
 */
const REQUEST_TIMEOUT_MS = 6000

const LOG_UNREACHABLE = 'knob-notify-unreachable'

export type KnobFetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>

/** `KNOB_HOSTS`, split and trimmed, or null when it is unset or holds nothing
 * usable. Null means "the environment said nothing", which lets the caller's
 * configured list through — distinct from an empty list, which means
 * "configured off". */
export function envHosts(): readonly string[] | null {
  const raw = process.env['KNOB_HOSTS']
  if (!raw) return null
  const parsed = raw.split(',').map((h) => h.trim()).filter((h) => h.length > 0)
  return parsed.length > 0 ? parsed : null
}

const realFetcher: KnobFetcher = async (url, init) => {
  const res = await fetch(url, init)
  return { ok: res.ok, status: res.status }
}

/**
 * Tells a knob display whether this Mac is awake.
 *
 * Best-effort by design. The device fails open — it treats "never heard from"
 * as awake — so a missing or unreachable display must never affect this daemon.
 * Every send is caught, and a repeating failure is logged once per outage
 * rather than once per attempt.
 */
export class KnobNotifier {
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private locked = false
  private inFlight: Promise<void> | null = null
  /**
   * Set when a send is wanted while one is already in flight. The in-flight
   * send's own completion drains it, instead of the request being dropped.
   *
   * Without this, a lock change arriving during a heartbeat was lost entirely
   * and the device did not learn about it until the next interval — the same
   * defect, and the same fix, as `Daemon.renderRequested`.
   */
  private pending = false

  /** Index into `hosts` that answered last. Tried first next time. */
  private preferred = 0

  constructor(
    private readonly hosts: readonly string[] = envHosts() ?? [],
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly fetcher: KnobFetcher = realFetcher,
    private readonly logger: Logger = log,
  ) {}

  /** True when a display is configured. `start` is a no-op without one, so
   * an unconfigured deck never opens a socket or logs an outage for a device
   * that was never claimed to exist. */
  isConfigured(): boolean {
    return this.hosts.length > 0
  }

  /** Sends at once, then repeats on the heartbeat interval. Does nothing when
   * no host is configured. */
  start(locked: boolean): void {
    if (!this.isConfigured()) return
    this.stopped = false
    this.locked = locked
    void this.send()
    this.timer = setInterval(() => void this.send(), this.intervalMs)
    // Never let the heartbeat hold the process open. launchd owns this
    // daemon's lifetime, and a stray interval would delay shutdown.
    this.timer.unref?.()
  }

  /** Called when the lock state changes, so the device reacts within a second. */
  setLocked(locked: boolean): void {
    if (!this.isConfigured()) return
    this.locked = locked
    void this.send()
  }

  /**
   * Stops the heartbeat and waits for a send already in flight. A test holds a
   * fetch unresolved, calls `stop()`, then resolves — so an in-flight send must
   * not log or throw after stop.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.inFlight) await this.inFlight
  }

  private async send(): Promise<void> {
    if (this.stopped) return
    // One at a time, but never dropped: a slow device must not build a queue of
    // overlapping requests, and a state change must not be lost because one was
    // in flight when it arrived.
    if (this.inFlight) {
      this.pending = true
      return this.inFlight
    }
    const path = this.locked ? 'locked' : 'awake'

    const attempt = (async () => {
      let lastWhy = 'no candidates'
      // Every candidate is tried before this counts as an outage, starting with
      // whichever answered last.
      for (let i = 0; i < this.hosts.length; i += 1) {
        if (this.stopped) return
        const idx = (this.preferred + i) % this.hosts.length
        const host = this.hosts[idx]
        if (!host) continue
        const url = `http://${host}/${path}`
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
          const res = await this.fetcher(url, { signal: controller.signal })
          if (this.stopped) return
          if (res.ok) {
            this.preferred = idx
            this.logger.clearOnce(LOG_UNREACHABLE)
            return
          }
          lastWhy = `${url} answered ${res.status}`
        } catch (e) {
          lastWhy = `${url} unreachable (${e instanceof Error ? e.message : String(e)})`
        } finally {
          clearTimeout(timeout)
        }
      }
      if (this.stopped) return
      // Once per outage. An unplugged display is a normal state and must not
      // fill this daemon's log.
      this.logger.once(LOG_UNREACHABLE, `knob-notify: ${lastWhy}`)
    })().finally(() => {
      this.inFlight = null
    })

    this.inFlight = attempt
    await attempt
    // Drained here rather than by the next heartbeat, so a change that arrived
    // mid-flight reaches the device within a request rather than an interval.
    if (this.pending && !this.stopped) {
      this.pending = false
      await this.send()
    }
  }
}
