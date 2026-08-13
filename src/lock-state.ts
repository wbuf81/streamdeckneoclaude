import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log, type Logger } from './log.js'

const run = promisify(execFile)
const POLL_MS = 2000
const LOG_COMMAND = 'lock-state-command'
const LOG_PARSE = 'lock-state-parse'

export type LockRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>

/**
 * Parses the ioreg console-lock property. `IOConsoleLocked` was measured on
 * the target Mac on macOS 26; the CGSession spelling is retained as a
 * compatibility fallback. An absent or unfamiliar value is unknown, because
 * treating an unverified value as locked could black out the product
 * permanently. The caller fails open but logs the failure.
 */
export function parseLockState(output: string): boolean | null {
  const line = output
    .split('\n')
    .find((candidate) => /"(?:IOConsoleLocked|CGSSessionScreenIsLocked)"/.test(candidate))
  if (!line) return null
  if (/"(?:IOConsoleLocked|CGSSessionScreenIsLocked)"\s*=\s*Yes\s*$/.test(line)) return true
  if (/"(?:IOConsoleLocked|CGSSessionScreenIsLocked)"\s*=\s*No\s*$/.test(line)) return false
  return null
}

/**
 * Polls macOS for the current screen-lock state. It fails open: a failed or
 * unparseable probe reads as unlocked, so a platform change cannot leave the
 * deck black forever. The daemon still logs that case once for diagnosis.
 */
export class LockState extends EventEmitter {
  private locked = false
  private stopped = true
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly runner: LockRunner = run,
    private readonly logger: Logger = log,
  ) {
    super()
  }

  isLocked(): boolean {
    return this.locked
  }

  onChange(cb: () => void): void {
    this.on('change', cb)
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.refresh()
    this.schedule()
  }

  /** Probes at once. Concurrent callers share one command invocation. */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const attempt = this.probe().finally(() => {
      this.inFlight = null
    })
    this.inFlight = attempt
    return attempt
  }

  private async probe(): Promise<void> {
    let next = false
    try {
      const { stdout } = await this.runner('/usr/sbin/ioreg', [
        '-n',
        'Root',
        '-d1',
        '-k',
        'IOConsoleLocked',
      ])
      this.logger.clearOnce(LOG_COMMAND)
      const parsed = parseLockState(stdout)
      if (parsed === null) {
        this.logger.once(LOG_PARSE, 'screen lock state was not recognized; treating it as unlocked.')
      } else {
        this.logger.clearOnce(LOG_PARSE)
        next = parsed
      }
    } catch (e) {
      this.logger.once(LOG_COMMAND, `screen lock probe failed; treating it as unlocked: ${String(e)}`)
    }

    if (next === this.locked) return
    this.locked = next
    this.emit('change')
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh().finally(() => this.schedule())
    }, POLL_MS)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
