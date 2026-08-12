#!/usr/bin/env node
import { Device, DeviceBusyError } from '../src/device.js'
import { Daemon } from '../src/daemon.js'
import { PageManager } from '../src/page-manager.js'
import { ClaudePage } from '../src/pages/claude-page.js'
import { SpotifyPage } from '../src/pages/spotify-page.js'
import { StocksPage } from '../src/pages/stocks-page.js'
import { WeatherPage } from '../src/pages/weather-page.js'
import { ClaudeSource } from '../src/sources/claude.js'
import { UsageSource } from '../src/sources/usage.js'
import { SpotifySource } from '../src/sources/spotify.js'
import { StockSource } from '../src/sources/stocks.js'
import { WeatherSource } from '../src/sources/weather.js'
import { focusWindow } from '../src/focus-window.js'
import { loadSprites } from '../src/render/sprites.js'
import { ensureStateDir, paths } from '../src/paths.js'
import { log } from '../src/log.js'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { runAuthFlow, TokenStore } from '../src/sources/spotify-auth.js'
import { install, uninstall } from '../src/install/install.js'

async function start(): Promise<void> {
  ensureStateDir()
  log.info('deckd starting')

  // Decode the sprites once, before the first render. The renderer cannot
  // decode, so a missing call here means the crab never appears.
  await loadSprites()

  const claude = new ClaudeSource()
  const usage = new UsageSource()
  const clientId = readClientId()
  const spotify = new SpotifySource(clientId)
  const stocks = new StockSource()
  const weather = new WeatherSource()
  await claude.start()
  await usage.start()
  await spotify.start()
  await stocks.start()
  await weather.start()

  const device = new Device()
  const pages = new PageManager()
  pages.add(new ClaudePage(claude, usage, focusWindow))
  pages.add(new SpotifyPage(spotify))
  pages.add(new StocksPage(stocks))
  pages.add(new WeatherPage(weather))

  // Only now, with all four pages present, may a saved index be restored.
  // `PageManager.setIndex` silently ignores an index outside the current
  // page count, so restoring before every page exists would strand the deck
  // on an earlier page with no error and no log line.
  restorePage(pages)

  const daemon = new Daemon(device, pages)
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
  claude.on('change', () => void daemon.renderOnce(Math.floor(Date.now() / 1000)))
  usage.on('change', () => void daemon.renderOnce(Math.floor(Date.now() / 1000)))
  spotify.on('change', () => void daemon.renderOnce(Math.floor(Date.now() / 1000)))
  stocks.on('change', () => void daemon.renderOnce(Math.floor(Date.now() / 1000)))
  weather.on('change', () => void daemon.renderOnce(Math.floor(Date.now() / 1000)))

  const shutdown = async () => {
    log.info('deckd stopping')
    savePage(pages)
    await daemon.stop()
    await claude.stop()
    await usage.stop()
    await spotify.stop()
    await stocks.stop()
    await weather.stop()
    await device.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

function restorePage(pages: PageManager): void {
  try {
    const raw = JSON.parse(readFileSync(paths.uiFile, 'utf8')) as { page?: number }
    if (typeof raw.page === 'number') pages.setIndex(raw.page)
  } catch {
    // No saved page. Start on the first one.
  }
}

function savePage(pages: PageManager): void {
  try {
    writeFileSync(paths.uiFile, JSON.stringify({ page: pages.index }))
  } catch {
    // A lost page index is not worth a failure.
  }
}

function usage(): never {
  console.error('usage: deckd <start|install|uninstall|auth>')
  process.exit(2)
}

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

const cmd = process.argv[2]
switch (cmd) {
  case 'start':
    void start()
    break
  case 'install':
    install().catch((e: unknown) => {
      console.error(String(e))
      process.exit(1)
    })
    break
  case 'uninstall':
    uninstall().catch((e: unknown) => {
      console.error(String(e))
      process.exit(1)
    })
    break
  case 'auth':
    if (process.argv[3] === 'spotify') {
      // Catch the rejection. The flow can time out, or the callback state can
      // mismatch, and an unhandled rejection would print a stack trace instead
      // of the reason.
      authSpotify().catch((e) => {
        console.error(String(e))
        process.exit(1)
      })
    } else {
      console.error('usage: deckd auth spotify')
      process.exit(2)
    }
    break
  case undefined:
    usage()
    break
  default:
    console.error(`unknown command: ${cmd}`)
    usage()
}
