import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { loadImage, type Image } from '@napi-rs/canvas'
import { log } from '../log.js'

const cache = new Map<string, Image>()

/**
 * Finds the `assets` directory from this module's own location. The module sits
 * at `src/render/` under `tsx` and at `dist/src/render/` after a build, so the
 * search walks up. `process.cwd()` cannot be used: launchd gives the daemon a
 * working directory that is not the project.
 */
function findAssetsDir(): string | null {
  let dir = import.meta.dirname
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'assets')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Decodes every sprite once, at startup. The renderer cannot decode, because
 * `@napi-rs/canvas` has no synchronous decode.
 */
export async function loadSprites(names: string[] = ['crab']): Promise<void> {
  const root = findAssetsDir()
  if (!root) {
    log.once('assets', 'assets directory not found. Sprites do not appear.')
    return
  }
  for (const name of names) {
    const file = join(root, name, 'idle.png')
    if (!existsSync(file)) {
      log.once(`sprite-${name}`, `sprite file absent: ${file}`)
      continue
    }
    try {
      cache.set(name, await loadImage(await readFile(file)))
    } catch (e) {
      log.once(`sprite-${name}`, `cannot decode sprite ${name}: ${String(e)}`)
    }
  }
}

/** Returns a decoded sprite, or null when it is absent. */
export function getSprite(name: string): Image | null {
  return cache.get(name) ?? null
}
