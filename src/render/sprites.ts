import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { loadImage, type Image } from '@napi-rs/canvas'
import { log } from '../log.js'

/** A decoded frame sequence for one animated state, plus its own delay. */
interface FrameSet {
  frames: Image[]
  delayMs: number
}

const frameCache = new Map<string, FrameSet>()

/**
 * The lowest delay this module honours. A `meta.json` with `delayMs` of zero
 * or negative would divide by zero in the frame-index modulo, so it is
 * floored here, once, at load time — `getSpriteFrame` never has to guard it.
 */
export const MIN_DELAY_MS = 40

/** The six states `daisy-statusbar` can report, plus the `unknown` fallback. */
export const CRAB_STATES: readonly string[] = [
  'idle',
  'thinking',
  'tool',
  'permission',
  'done',
  'unknown',
]

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
 * Decodes every frame of one state's animation and caches the ordered array
 * plus its floored `delayMs`. Any failure — an absent directory, an absent or
 * unparsable `meta.json`, or a frame count of zero — degrades to "no frames
 * cached for this state" and logs once, rather than throwing. The render loop
 * then simply draws no crab for that state, which is graceful.
 */
async function loadStateFrames(assetsRoot: string, state: string): Promise<void> {
  const dir = join(assetsRoot, 'crab', state)
  const metaFile = join(dir, 'meta.json')
  const logKey = `crab-meta-${state}`

  if (!existsSync(metaFile)) {
    log.once(logKey, `crab meta.json absent for state "${state}": ${metaFile}`)
    return
  }

  let meta: { frameCount?: unknown; delayMs?: unknown }
  try {
    meta = JSON.parse(await readFile(metaFile, 'utf8')) as typeof meta
  } catch (e) {
    log.once(logKey, `crab meta.json for state "${state}" is not valid JSON: ${String(e)}`)
    return
  }

  const frameCount =
    typeof meta.frameCount === 'number' && meta.frameCount > 0 ? Math.floor(meta.frameCount) : 0
  if (frameCount <= 0) {
    log.once(logKey, `crab meta.json for state "${state}" has no frames`)
    return
  }

  const rawDelay = typeof meta.delayMs === 'number' ? meta.delayMs : 0
  const delayMs = rawDelay > 0 ? rawDelay : MIN_DELAY_MS

  const frames: Image[] = []
  for (let i = 0; i < frameCount; i++) {
    const file = join(dir, `${String(i).padStart(2, '0')}.png`)
    if (!existsSync(file)) continue
    try {
      frames.push(await loadImage(await readFile(file)))
    } catch (e) {
      log.once(`crab-frame-${state}-${i}`, `cannot decode crab frame ${state}/${i}: ${String(e)}`)
    }
  }

  if (frames.length === 0) {
    log.once(logKey, `crab state "${state}" decoded zero frames`)
    return
  }

  frameCache.set(state, { frames, delayMs })
}

/**
 * Decodes every crab animation frame, for every state under `assetsRoot`,
 * once. `assetsRoot` is the directory that directly contains `crab/`, exactly
 * what `findAssetsDir` returns — passed explicitly (rather than resolved
 * again inside this function) so a test can point it at a temporary fixture
 * without touching the real `assets/` tree.
 */
export async function loadCrabFrames(
  assetsRoot: string,
  states: readonly string[] = CRAB_STATES,
): Promise<void> {
  for (const state of states) {
    await loadStateFrames(assetsRoot, state)
  }
}

/**
 * Decodes every crab animation frame once, at startup. The renderer cannot
 * decode, because `@napi-rs/canvas` has no synchronous decode.
 *
 * This used to also fill a legacy single-decoded-image lookup, keyed by
 * sprite name. That whole path was removed once the Claude page's crab
 * animation moved entirely onto `KeySpec.image`/`imageKey`, leaving no
 * caller. `names` is unused now, kept only so an existing caller
 * (`bin/deckd.ts`) does not need an argument-count change for a parameter
 * with no live use.
 */
export async function loadSprites(_names: string[] = ['crab']): Promise<void> {
  const root = findAssetsDir()
  if (!root) {
    log.once('assets', 'assets directory not found. Sprites do not appear.')
    return
  }
  await loadCrabFrames(root)
}

/**
 * Returns the frame index `state` would draw at `nowMs`, or null when `state`
 * has no cached frames. Exposed separately from `getSpriteFrame` so a caller
 * (the Claude page) can build a change-detection key — `image` is excluded
 * from `keyHash`, so the frame's identity must travel through a plain field
 * such as `imageKey`, and that plain field needs the index, not the `Image`.
 */
export function getSpriteFrameIndex(state: string, nowMs: number): number | null {
  const entry = frameCache.get(state)
  if (!entry || entry.frames.length === 0) return null
  return Math.floor(nowMs / entry.delayMs) % entry.frames.length
}

/**
 * Picks the decoded frame for `state` at `nowMs`, or null when `state` has no
 * cached frames. `delayMs` is floored to `MIN_DELAY_MS` at load time, so this
 * never divides by zero.
 */
export function getSpriteFrame(state: string, nowMs: number): Image | null {
  const entry = frameCache.get(state)
  const idx = getSpriteFrameIndex(state, nowMs)
  if (!entry || idx === null) return null
  return entry.frames[idx] ?? null
}
