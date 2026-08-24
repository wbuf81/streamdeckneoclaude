import { log, type Logger } from './log.js'

/**
 * The knob display's mDNS name. It advertises `_http._tcp` and answers two
 * paths, `/awake` and `/locked`, with 204.
 */
const DEFAULT_HOST = 'knob.local'

/**
 * How often the state is repeated. The device treats silence as sleep, so this
 * is a heartbeat and not only a change notification: a Mac going to sleep
 * cannot send "I am asleep", it simply stops sending. The device's own timeout
 * is 25 s, comfortably more than three of these, so one lost packet is not a
 * blackout.
 */
const DEFAULT_INTERVAL_MS = 5000

/** A wedged request must not delay the next heartbeat. */
const REQUEST_TIMEOUT_MS = 2000

const LOG_UNREACHABLE = 'knob-notify-unreachable'

export type KnobFetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>

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

  constructor(
    private readonly host: string = DEFAULT_HOST,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly fetcher: KnobFetcher = realFetcher,
    private readonly logger: Logger = log,
  ) {}

  /** Sends at once, then repeats on the heartbeat interval. */
  start(locked: boolean): void {
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
    const url = `http://${this.host}/${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    const attempt = (async () => {
      try {
        const res = await this.fetcher(url, { signal: controller.signal })
        if (this.stopped) return
        if (res.ok) {
          this.logger.clearOnce(LOG_UNREACHABLE)
        } else {
          this.logger.once(LOG_UNREACHABLE, `knob-notify: ${url} answered ${res.status}`)
        }
      } catch (e) {
        if (this.stopped) return
        const why = e instanceof Error ? e.message : String(e)
        // Once per outage. An unreachable display is the normal state when the
        // device is unplugged, and this daemon must not fill its log with it.
        this.logger.once(LOG_UNREACHABLE, `knob-notify: ${url} unreachable (${why})`)
      } finally {
        clearTimeout(timeout)
      }
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
