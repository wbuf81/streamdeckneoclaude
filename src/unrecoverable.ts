import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './log.js'
import { paths } from './paths.js'

/**
 * How long after a banner before another one is allowed. The rate limit is
 * PERSISTED rather than held in memory, because the whole point of this
 * module is to end the process: an in-memory limiter would reset on every
 * launchd respawn and so limit nothing at all. A deck that wedges the moment
 * it opens would then produce a banner every ten seconds, forever.
 */
export const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000

const HEALTH_FILE = join(paths.stateDir, 'health.json')

export interface UnrecoverableDeps {
  notify: (title: string, message: string) => void
  readState: () => string
  writeState: (data: string) => void
  now: () => number
  exit: (code: number) => void
}

/** Shows a macOS notification banner. */
function notifyReal(title: string, message: string): void {
  // Detached and unawaited: this runs microseconds before `process.exit`, and
  // waiting on osascript would only delay the restart that actually fixes
  // things. The banner is a courtesy; the exit is the repair.
  const child = execFile('/usr/bin/osascript', [
    '-e',
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
  ])
  child.unref()
  // An `execFile` child that fails to spawn emits `'error'`. With no listener
  // that becomes an uncaught exception on the process we are about to exit
  // from, which would turn a clean exit(1) into a stack trace in launchd.log.
  child.on('error', () => {})
}

const realDeps: UnrecoverableDeps = {
  notify: notifyReal,
  readState: () => readFileSync(HEALTH_FILE, 'utf8'),
  writeState: (data) => writeFileSync(HEALTH_FILE, data, { mode: 0o600 }),
  now: () => Date.now(),
  exit: (code) => process.exit(code),
}

/** Reads the last notification time. Any failure reads as "never notified". */
function lastNotifiedMs(deps: UnrecoverableDeps): number {
  try {
    const raw = JSON.parse(deps.readState()) as { lastNotifiedMs?: unknown }
    return typeof raw.lastNotifiedMs === 'number' ? raw.lastNotifiedMs : 0
  } catch {
    // No file yet, or a corrupt one. Failing OPEN is deliberate: a damaged
    // state file must not be able to silence every future alert.
    return 0
  }
}

/**
 * The last rung of the device-health ladder. Recycling the handle has
 * stopped helping, so hand the problem to launchd: `KeepAlive` is `true` in
 * `com.wbard.deckd.plist`, and a fresh process gets a fresh USB handle. That
 * is exactly the manual `launchctl kickstart -k` that recovered the wedge
 * measured on 2026-08-23 -- this just stops it needing a person.
 *
 * Exiting is safe to repeat: launchd enforces a ten-second minimum runtime,
 * so a deck that is genuinely broken restarts slowly rather than spinning.
 * The user hears about it at most once an hour.
 */
export function reportUnrecoverable(
  reason: string,
  deps: UnrecoverableDeps = realDeps,
): void {
  log.error(`deckd is restarting itself: ${reason}`)
  const now = deps.now()
  if (now - lastNotifiedMs(deps) >= NOTIFY_COOLDOWN_MS) {
    try {
      deps.notify(
        'Stream Deck',
        'The deck stopped responding. deckd is restarting it. If this keeps happening, ' +
          'check the USB cable.',
      )
      deps.writeState(JSON.stringify({ lastNotifiedMs: now }))
    } catch (e) {
      // Neither the banner nor the bookkeeping may stand between a wedged
      // deck and the restart that fixes it.
      log.error(`could not report the device failure: ${String(e)}`)
    }
  }
  deps.exit(1)
}
