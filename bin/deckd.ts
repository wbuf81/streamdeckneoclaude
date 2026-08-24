#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { Device, DeviceBusyError } from '../src/device.js'
import { Daemon } from '../src/daemon.js'
import { PageManager } from '../src/page-manager.js'
import { ClaudePage } from '../src/pages/claude-page.js'
import { CodexPage } from '../src/pages/codex-page.js'
import { SpotifyPage } from '../src/pages/spotify-page.js'
import { StocksPage } from '../src/pages/stocks-page.js'
import { WeatherPage } from '../src/pages/weather-page.js'
import { FootballPage } from '../src/pages/football-page.js'
import { SystemPage } from '../src/pages/system-page.js'
import { ClaudeSource } from '../src/sources/claude.js'
import { CodexSource } from '../src/sources/codex.js'
import { UsageSource } from '../src/sources/usage.js'
import { SpotifySource } from '../src/sources/spotify.js'
import { StockSource } from '../src/sources/stocks.js'
import { WeatherSource } from '../src/sources/weather.js'
import { FootballSource } from '../src/sources/football.js'
import { SystemSource } from '../src/sources/system.js'
import { focusWindow } from '../src/focus-window.js'
import { loadSprites } from '../src/render/sprites.js'
import { ensureStateDir, paths } from '../src/paths.js'
import { log } from '../src/log.js'
import { LockState } from '../src/lock-state.js'
import { reportUnrecoverable } from '../src/unrecoverable.js'
import { readFileSync, writeFileSync, chmodSync, realpathSync } from 'node:fs'
import { runAuthFlow, TokenStore } from '../src/sources/spotify-auth.js'
import { install, uninstall, refreshWrapper } from '../src/install/install.js'

/**
 * Builds the listener each source's `change` event uses to redraw at once,
 * rather than waiting for the next tick.
 *
 * Reads `clock()` exactly once and derives both the second clock and the
 * millisecond clock from that single value, rather than calling `Date.now()`
 * twice — the previous code called `daemon.renderOnce(Math.floor(Date.now() /
 * 1000))` with no second argument, and `Daemon.renderOnce` used to default
 * `nowMs` to `now * 1000`. That truncated the millisecond clock by up to 999
 * ms on every source change, one tick after a press: a flash timed off the
 * real clock a moment earlier could already read as expired (measured live:
 * `border: undefined` where a real clock gives `[230, 60, 60]`), and the crab
 * animation jumped back up to about fourteen frames. `renderOnce` no longer
 * accepts a default for `nowMs` at all, so this cannot regress silently —
 * omitting the second argument here is now a compile error, not a truncation.
 *
 * `clock` defaults to `Date.now`. A test injects a fixed one, so it can
 * assert the exact values `renderOnce` receives without waiting on real time.
 */
export function makeChangeHandler(daemon: Daemon, clock: () => number = Date.now): () => void {
  return () => {
    const ms = clock()
    void daemon.renderOnce(Math.floor(ms / 1000), ms)
  }
}

async function start(): Promise<void> {
  ensureStateDir()
  log.info('deckd starting')

  // Decode the sprites once, before the first render. The renderer cannot
  // decode, so a missing call here means the crab never appears.
  await loadSprites()

  const claude = new ClaudeSource()
  const usage = new UsageSource()
  const codex = new CodexSource()
  const clientId = readClientId()
  const spotify = new SpotifySource(clientId)
  const stocks = new StockSource()
  const weather = new WeatherSource()
  const football = new FootballSource()
  const system = new SystemSource()
  await claude.start()
  await usage.start()
  await codex.start()
  await spotify.start()
  await stocks.start()
  await weather.start()
  await football.start()
  await system.start()

  // The last rung of the device-health ladder. `Device` recycles a handle
  // whose writes fail, and retries; when that stops helping it calls this,
  // which restarts the process through launchd's `KeepAlive`. See
  // `src/unrecoverable.ts` and `Device`'s health docblock.
  const device = new Device(undefined, { onUnrecoverable: reportUnrecoverable })
  const pages = new PageManager()
  pages.add(new ClaudePage(claude, usage, focusWindow))
  pages.add(new CodexPage(codex))
  pages.add(new SpotifyPage(spotify))
  pages.add(new StocksPage(stocks))
  pages.add(new WeatherPage(weather))
  pages.add(new FootballPage(football))
  pages.add(new SystemPage(system))

  // Only now, with all seven pages present, may a saved page be restored.
  // `PageManager.setIndex` silently ignores an index outside the current
  // page count, so restoring before every page exists would strand the deck
  // on an earlier page with no error and no log line.
  restorePage(pages)

  const lockState = new LockState()
  const daemon = new Daemon(device, pages, undefined, undefined, lockState)
  try {
    await daemon.start()
  } catch (e) {
    if (e instanceof DeviceBusyError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  // A source change redraws at once, rather than at the next tick.
  const onChange = makeChangeHandler(daemon)
  claude.on('change', onChange)
  usage.on('change', onChange)
  codex.on('change', onChange)
  spotify.on('change', onChange)
  stocks.on('change', onChange)
  weather.on('change', onChange)
  football.on('change', onChange)
  system.on('change', onChange)

  const shutdown = async () => {
    log.info('deckd stopping')
    savePage(pages)
    await daemon.stop()
    // I4: an orderly shutdown used to disconnect with the last frame still
    // lit at full brightness. The documented `launchctl bootout` recovery
    // path, or the few seconds between a `pkill` and launchd's respawn,
    // then left session names and task tiles on the glass with nothing
    // running to blank them -- on a Mac that might be locked moments later.
    // `shutdownBlank` is best-effort and never throws, so it cannot block
    // the rest of shutdown even if the device is already gone.
    await daemon.shutdownBlank()
    await claude.stop()
    await usage.stop()
    await codex.stop()
    await spotify.stop()
    await stocks.stop()
    await weather.stop()
    await football.stop()
    await system.stop()
    await device.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

/**
 * Restores the page saved by `savePage`. `readFile` is injectable so a test
 * can supply an in-memory implementation — this must never read the real
 * `ui.json` under `~` from a test.
 *
 * The legacy `+1` migration below is a ONE-SHOT correctness rule: it may run
 * ONLY when `pageName` is entirely absent, meaning the file predates stable
 * page names altogether (lesson 19). It must NOT run merely because a
 * present `pageName` failed to resolve — that is a DIFFERENT case (a page
 * renamed or removed since the file was written by today's own `savePage`),
 * and applying the numeric shift to it silently opens a different, wrong
 * page. `{page: 1, pageName: 'codex'}` after a hypothetical rename to
 * `openai-codex` must fall back to the first page, not jump to Spotify at
 * `1 + 1`.
 */
export function restorePage(
  pages: PageManager,
  readFile: (path: string, encoding: 'utf8') => string = readFileSync,
): void {
  try {
    const raw = JSON.parse(readFile(paths.uiFile, 'utf8')) as { page?: number; pageName?: string }
    if (typeof raw.pageName === 'string') {
      const idx = pages.indexOf(raw.pageName)
      // A name that does not resolve (renamed, removed, or simply unknown)
      // falls back to whichever page is already current — page 0, since
      // `PageManager.add` fires `onEnter` for the first page and nothing
      // here has moved it — rather than guessing at a numeric index that
      // means something else entirely.
      if (idx !== -1) pages.setIndex(idx)
      return
    }
    if (typeof raw.page === 'number' && Number.isInteger(raw.page)) {
      // ui.json predates stable page names. Its old order was Claude,
      // Spotify, Stocks, Weather; Codex is now inserted at index 1.
      pages.setIndex(raw.page > 0 ? raw.page + 1 : raw.page)
    }
  } catch {
    // No saved page. Start on the first one.
  }
}

/**
 * Persists the current page's stable name (and, for the legacy reader, its
 * current numeric index) so a later `restorePage` can find it again even if
 * an earlier release's insertion changed everyone's numeric position.
 * `writeFile` is injectable for the same reason `readFile` is above.
 */
export function savePage(
  pages: PageManager,
  writeFile: (path: string, data: string) => void = writeFileSync,
): void {
  try {
    writeFile(paths.uiFile, JSON.stringify({ page: pages.index, pageName: pages.current().name }))
  } catch {
    // A lost page index is not worth a failure.
  }
}

const USAGE = 'usage: deckd <start|install|uninstall|refresh-wrapper|auth>'

/** Reads the client id from the CLI flag or the config file. */
function readClientId(): string {
  const flag = process.argv.indexOf('--client-id')
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1]!
  try {
    const raw = JSON.parse(readFileSync(paths.configFile, 'utf8'))
    return typeof raw?.spotify?.clientId === 'string' ? raw.spotify.clientId : ''
  } catch {
    return ''
  }
}

async function authSpotify(): Promise<void> {
  ensureStateDir()
  const clientId = process.env.SPOTIFY_CLIENT_ID ?? readClientId()
  if (!clientId) {
    console.error(
      'No Spotify client id.\n\n' +
        '1. Open https://developer.spotify.com/dashboard and create an app.\n' +
        '2. Add this redirect URI exactly:\n' +
        '     http://127.0.0.1:8888/callback\n' +
        '3. Copy the client id, then run:\n' +
        '     deckd auth spotify --client-id <ID>\n',
    )
    process.exit(2)
  }
  const tokens = await runAuthFlow(clientId)
  new TokenStore().save(tokens)
  // Merge, do not overwrite. The config file may already hold other settings,
  // and a wholesale write would silently drop them.
  let config: Record<string, any> = {}
  try {
    config = JSON.parse(readFileSync(paths.configFile, 'utf8'))
  } catch {
    // No config yet, or it is unreadable. Start from an empty object.
  }
  config.spotify = { ...(config.spotify ?? {}), clientId }
  writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  chmodSync(paths.configFile, 0o600)
  console.log('Spotify is connected. Restart deckd to pick it up.')
}

/**
 * True only when this file is the process's entry point (`node bin/deckd.js
 * start`, exactly how launchd and a person on the command line both invoke
 * it) rather than a module some other code imports. Without this guard, a
 * test importing `makeChangeHandler` above would also run this whole
 * dispatch block against whatever `process.argv` the TEST runner happened to
 * have -- landing on `default` or `undefined` and printing usage with an
 * exit code, which would kill the entire test process.
 *
 * Pulled apart into a pure `isEntryPoint` (this doc comment's actual logic,
 * parameterized so a test can supply synthetic paths) and a thin `isMain`
 * wrapper that reads the two real global values. Before this split, nothing
 * exercised the `realpathSync` branch at all: a test would have had to
 * mutate the real `process.argv`, which risks corrupting the test runner's
 * own process state.
 *
 * `here` is this file's RESOLVED real path. `argv1` is the literal string
 * the caller passed, which is only the same string in the two cases above.
 * `package.json` also declares `"bin": { "deckd": "./dist/bin/deckd.js" }`,
 * so after `npm link` or a global install, `argv1` is a SYMLINK in some bin
 * directory instead — a different string pointing at the same real file,
 * which would make a plain string compare return false and `deckd start`
 * exit 0 having done nothing at all (M11). Resolving `argv1` through
 * `realpath` first removes that whole class of mismatch; a path that does
 * not exist at all (any other invocation shape) falls back to the direct
 * string compare, which can only ever be false in that case anyway.
 */
export function isEntryPoint(
  argv1: string | undefined,
  here: string,
  realpath: (p: string) => string = realpathSync,
): boolean {
  if (!argv1) return false
  if (here === argv1) return true
  try {
    return here === realpath(argv1)
  } catch {
    return false
  }
}

function isMain(): boolean {
  return isEntryPoint(process.argv[1], fileURLToPath(import.meta.url))
}

/** The real command implementations `dispatch` routes to in production. */
export interface CliHandlers {
  start: () => Promise<void>
  install: () => Promise<void>
  uninstall: () => Promise<void>
  refreshWrapper: () => Promise<{ path: string }>
  authSpotify: () => Promise<void>
}

/**
 * Routes one CLI invocation to the right handler and picks the right exit
 * code. Pulled out of the `isMain()` block (I-6: this dispatch had zero
 * tests) so a test can drive every verb, the missing-verb case, and the
 * unknown-verb case directly — injecting a spy for each handler and a
 * non-real `exit` — without spawning a process, running a real
 * install/uninstall, or touching `~`.
 *
 * `argv` is the full `process.argv`-shaped array: `argv[2]` is the verb,
 * `argv[3]` is `auth`'s required sub-verb. `exit`, `err`, and `out` default
 * to the real `process.exit`, `console.error`, and `console.log`, matching
 * this file's behaviour before the split exactly.
 */
export function dispatch(
  argv: readonly string[],
  handlers: CliHandlers,
  exit: (code: number) => void = process.exit,
  err: (message: string) => void = console.error,
  out: (message: string) => void = console.log,
): void {
  const cmd = argv[2]
  switch (cmd) {
    case 'start':
      void handlers.start().catch((e: unknown) => {
        err(String(e))
        exit(1)
      })
      break
    case 'install':
      handlers.install().catch((e: unknown) => {
        err(String(e))
        exit(1)
      })
      break
    case 'uninstall':
      handlers.uninstall().catch((e: unknown) => {
        err(String(e))
        exit(1)
      })
      break
    case 'refresh-wrapper':
      // I-5: re-copies the wrapper script from this repository into the
      // state directory and re-verifies it, without touching settings.json
      // or launchd. This is the ONLY way an already-installed user gets a
      // wrapper fix without a full uninstall/install cycle -- and that
      // cycle is exactly the path C-1 lived on. Safe to run repeatedly.
      handlers
        .refreshWrapper()
        .then((r) => {
          out(`refreshed the wrapper at ${r.path}.`)
        })
        .catch((e: unknown) => {
          err(String(e))
          exit(1)
        })
      break
    case 'auth':
      if (argv[3] === 'spotify') {
        // Catch the rejection. The flow can time out, or the callback state can
        // mismatch, and an unhandled rejection would print a stack trace instead
        // of the reason.
        handlers.authSpotify().catch((e) => {
          err(String(e))
          exit(1)
        })
      } else {
        err('usage: deckd auth spotify')
        exit(2)
      }
      break
    case undefined:
      err(USAGE)
      exit(2)
      break
    default:
      err(`unknown command: ${cmd}`)
      err(USAGE)
      exit(2)
  }
}

if (isMain()) {
  dispatch(process.argv, { start, install, uninstall, refreshWrapper, authSpotify })
}
