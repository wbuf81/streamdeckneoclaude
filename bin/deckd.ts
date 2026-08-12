#!/usr/bin/env node
import { Device, DeviceBusyError } from '../src/device.js'
import { Daemon } from '../src/daemon.js'
import { PageManager } from '../src/page-manager.js'
import { ClaudePage } from '../src/pages/claude-page.js'
import { ClaudeSource } from '../src/sources/claude.js'
import { UsageSource } from '../src/sources/usage.js'
import { focusWindow } from '../src/focus-window.js'
import { loadSprites } from '../src/render/sprites.js'
import { ensureStateDir, paths } from '../src/paths.js'
import { log } from '../src/log.js'
import { readFileSync, writeFileSync } from 'node:fs'

async function start(): Promise<void> {
  ensureStateDir()
  log.info('deckd starting')

  // Decode the sprites once, before the first render. The renderer cannot
  // decode, so a missing call here means the crab never appears.
  await loadSprites()

  const claude = new ClaudeSource()
  const usage = new UsageSource()
  await claude.start()
  await usage.start()

  const device = new Device()
  const pages = new PageManager()
  pages.add(new ClaudePage(claude, usage, focusWindow))

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

  const shutdown = async () => {
    log.info('deckd stopping')
    savePage(pages)
    await daemon.stop()
    await claude.stop()
    await usage.stop()
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

const cmd = process.argv[2]
switch (cmd) {
  case 'start':
    void start()
    break
  case undefined:
    usage()
    break
  default:
    console.error(`unknown command: ${cmd}`)
    usage()
}
