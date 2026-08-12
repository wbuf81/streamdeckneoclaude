# Stream Deck Neo Claude Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node daemon that drives an Elgato Stream Deck Neo. It shows live Claude Code sessions and Spotify playback.

**Architecture:** One process owns the USB device, because HID access is exclusive. Data flows one way. A `Source` reads one outside system. A `Page` turns that data into a `DeckFrame` description. The `Renderer` turns the description into pixel buffers. The `Device` writes them to hardware. Pages never touch canvas or HID, so tests need no device.

**Tech Stack:** Node 22, TypeScript, ESM, `@elgato-stream-deck/node`, `@napi-rs/canvas`, `vitest`, launchd.

**Spec:** `docs/superpowers/specs/2026-08-12-streamdeck-neo-claude-deck-design.md`

## Global Constraints

- Platform is macOS only. The project uses launchd and AppleScript.
- Device is Stream Deck Neo only. USB `0x0FD9:0x009A`. Model id `neo`.
- Keys are 96 × 96 px. There are 8 keys, index 0 to 7.
- The info strip is 248 × 58 px. Draw it as one image. `drawRegions` is `false`.
- Touch buttons are index 8 and 9. They have no screen. They accept one RGB color.
- Node 22 or later. ESM only. No CommonJS.
- Font is `Menlo`. Size 11 px for body text, 9 px for small labels.
- All prose in this repo uses ASD-STE100 (Simplified Technical English).
- Runtime state lives in `~/.local/state/deckd/`, mode `0700`. Never commit it.
- The daemon writes nothing to `~/.claude/daisy-statusbar/`. It reads only.
- Session state values are exactly: `idle`, `thinking`, `tool`, `permission`, `done`. Any other value maps to `unknown`.
- Stale session limit is 600 seconds. Stale usage limit is 900 seconds.
- Commit after every task. Use `feat:`, `test:`, `chore:`, or `docs:` prefixes.

## Deviations from the spec

Three refinements. Each one is deliberate.

1. The spec asks for full PNG snapshot tests. This plan uses pixel probes instead. A probe reads one coordinate and asserts its color. A full snapshot breaks when a font or canvas version changes, and that failure teaches nothing.
2. The spec asks for a bundled font. This plan uses `Menlo`. The project is macOS only, so `Menlo` always exists. A bundled file adds weight for no gain.
3. The spec names one `Renderer` module. This plan splits it into `theme.ts`, `text.ts`, and `canvas.ts`. Colors and text measurement are pure functions, and they deserve their own tests.

## File structure

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Build and test setup |
| `src/paths.ts` | Every filesystem path the daemon uses |
| `src/log.ts` | Log lines to file and stderr, with rotation |
| `src/render/specs.ts` | `KeySpec`, `StripSpec`, `DeckFrame` types, and `keyHash` |
| `src/render/theme.ts` | Named colors and the state colour map |
| `src/render/text.ts` | Truncation with an ellipsis |
| `src/render/canvas.ts` | `renderKey`, `renderStrip` |
| `src/device.ts` | `Device` wrapper over `@elgato-stream-deck/node` |
| `src/fake-device.ts` | `FakeDevice` that records writes, for tests |
| `src/sources/claude.ts` | Watch `state.d`, emit `Session[]` |
| `src/sources/usage.ts` | Read `usage.json` and per-session cache, compute pace |
| `src/sources/spotify-auth.ts` | OAuth PKCE flow and token refresh |
| `src/sources/spotify.ts` | Poll the player, control playback, cache art |
| `src/pages/types.ts` | The `Page` interface |
| `src/pages/key-assigner.ts` | Hold a session on its key |
| `src/pages/claude-page.ts` | The Claude page |
| `src/pages/spotify-page.ts` | The Spotify page |
| `src/page-manager.ts` | Page list, current index, press routing |
| `src/focus-window.ts` | Raise a terminal window with AppleScript |
| `src/daemon.ts` | Wire sources, pages, renderer, device. Dirty-key loop. |
| `src/install/statusline-wrapper.sh` | Tee `rate_limits` to cache, then run the real statusline |
| `src/install/install.ts` | launchd agent, state dir, statusline wrapper |
| `bin/deckd.ts` | CLI: `start`, `install`, `uninstall`, `auth`, `smoke` |
| `scripts/smoke.ts` | Draw a test pattern on real hardware |

## Milestones

- **Task 5** puts real pixels on the real device. It proves the output chain.
- **Task 10** gives a live Claude page. The deck becomes useful here.
- **Task 13** gives the Spotify page.
- **Task 14** makes it start at login.

---

### Task 1: Project scaffold, paths, and logging

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.editorconfig`
- Create: `src/paths.ts`, `src/log.ts`
- Test: `tests/paths.test.ts`, `tests/log.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `paths` object with `stateDir`, `sessionsDir`, `usageFile`, `uiFile`, `configFile`, `spotifyFile`, `artDir`, `logFile`, `claudeStateDir`, `claudeSettings`, `launchAgent`. Also `ensureStateDir(): void`. Also `log.info(msg)`, `log.warn(msg)`, `log.error(msg)`, `log.once(key, msg)`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "streamdeckneoclaude",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": { "deckd": "./dist/bin/deckd.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/bin/deckd.js start",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "smoke": "npm run build && node dist/scripts/smoke.js"
  },
  "dependencies": {
    "@elgato-stream-deck/node": "^7.1.2",
    "@napi-rs/canvas": "^0.1.60"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "declaration": false,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "bin/**/*.ts", "scripts/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: it completes with no vulnerabilities and no compile step. `@napi-rs/canvas` ships prebuilt binaries.

- [ ] **Step 5: Write the failing test for paths**

Create `tests/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { paths } from '../src/paths.js'
import { homedir } from 'node:os'

describe('paths', () => {
  it('puts runtime state under ~/.local/state/deckd', () => {
    expect(paths.stateDir).toBe(`${homedir()}/.local/state/deckd`)
    expect(paths.usageFile).toBe(`${paths.stateDir}/usage.json`)
    expect(paths.sessionsDir).toBe(`${paths.stateDir}/sessions`)
    expect(paths.spotifyFile).toBe(`${paths.stateDir}/spotify.json`)
    expect(paths.artDir).toBe(`${paths.stateDir}/art`)
  })

  it('reads Claude session state from the daisy-statusbar directory', () => {
    expect(paths.claudeStateDir).toBe(`${homedir()}/.claude/daisy-statusbar/state.d`)
    expect(paths.claudeSettings).toBe(`${homedir()}/.claude/settings.json`)
  })

  it('names the launchd agent with a reverse-domain label', () => {
    expect(paths.launchAgentLabel).toBe('com.wbard.deckd')
    expect(paths.launchAgent).toBe(
      `${homedir()}/Library/LaunchAgents/com.wbard.deckd.plist`,
    )
  })
})
```

- [ ] **Step 6: Run the test and confirm it fails**

Run: `npx vitest run tests/paths.test.ts`
Expected: FAIL. The error names a missing module `../src/paths.js`.

- [ ] **Step 7: Write `src/paths.ts`**

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const home = homedir()
const stateDir = join(home, '.local', 'state', 'deckd')
const claudeDir = join(home, '.claude')

export const paths = {
  stateDir,
  sessionsDir: join(stateDir, 'sessions'),
  usageFile: join(stateDir, 'usage.json'),
  uiFile: join(stateDir, 'ui.json'),
  configFile: join(stateDir, 'config.json'),
  spotifyFile: join(stateDir, 'spotify.json'),
  artDir: join(stateDir, 'art'),
  logFile: join(stateDir, 'deckd.log'),
  claudeStateDir: join(claudeDir, 'daisy-statusbar', 'state.d'),
  claudeSettings: join(claudeDir, 'settings.json'),
  launchAgentLabel: 'com.wbard.deckd',
  launchAgent: join(home, 'Library', 'LaunchAgents', 'com.wbard.deckd.plist'),
} as const

/** Creates the state directory tree. Mode 0700, because it holds a token. */
export function ensureStateDir(): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(paths.sessionsDir, { recursive: true, mode: 0o700 })
  mkdirSync(paths.artDir, { recursive: true, mode: 0o700 })
}
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `npx vitest run tests/paths.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 9: Write the failing test for the logger**

Create `tests/log.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createLogger } from '../src/log.js'

describe('createLogger', () => {
  let written: string[]

  beforeEach(() => {
    written = []
  })

  const sink = (line: string) => written.push(line)

  it('writes a level and a message', () => {
    const log = createLogger(sink)
    log.info('deck connected')
    expect(written).toHaveLength(1)
    expect(written[0]).toContain('INFO')
    expect(written[0]).toContain('deck connected')
  })

  it('writes a once-keyed message a single time', () => {
    const log = createLogger(sink)
    log.once('no-device', 'device absent')
    log.once('no-device', 'device absent')
    log.once('no-device', 'device absent')
    expect(written).toHaveLength(1)
  })

  it('lets a different key through', () => {
    const log = createLogger(sink)
    log.once('a', 'first')
    log.once('b', 'second')
    expect(written).toHaveLength(2)
  })

  it('clears a once key so the next event logs again', () => {
    const log = createLogger(sink)
    log.once('no-device', 'device absent')
    log.clearOnce('no-device')
    log.once('no-device', 'device absent')
    expect(written).toHaveLength(2)
  })
})
```

- [ ] **Step 10: Run the test and confirm it fails**

Run: `npx vitest run tests/log.test.ts`
Expected: FAIL. The error names a missing module `../src/log.js`.

- [ ] **Step 11: Write `src/log.ts`**

The `once` method exists for a reason. A disconnected device retries every 2 seconds, and an unguarded log fills the disk.

```ts
import { appendFileSync, statSync, renameSync } from 'node:fs'
import { paths, ensureStateDir } from './paths.js'

export type Sink = (line: string) => void
export type Level = 'INFO' | 'WARN' | 'ERROR'

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  /** Logs once per key. Later calls with the same key do nothing. */
  once(key: string, msg: string): void
  /** Forgets a key, so the next `once` call with it logs again. */
  clearOnce(key: string): void
}

const MAX_BYTES = 5 * 1024 * 1024

/** Appends to the log file. Rotates at 5 MB and keeps one old copy. */
export function fileSink(line: string): void {
  ensureStateDir()
  try {
    if (statSync(paths.logFile).size > MAX_BYTES) {
      renameSync(paths.logFile, `${paths.logFile}.1`)
    }
  } catch {
    // The file does not exist yet. Nothing to rotate.
  }
  appendFileSync(paths.logFile, line + '\n')
}

export function createLogger(sink: Sink = fileSink): Logger {
  const seen = new Set<string>()

  const write = (level: Level, msg: string) => {
    sink(`${new Date().toISOString()} ${level} ${msg}`)
  }

  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    once(key, msg) {
      if (seen.has(key)) return
      seen.add(key)
      write('WARN', msg)
    },
    clearOnce(key) {
      seen.delete(key)
    },
  }
}

export const log = createLogger()
```

- [ ] **Step 12: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 7 tests. The typecheck prints nothing.

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/paths.ts src/log.ts tests/paths.test.ts tests/log.test.ts
git commit -m "chore: scaffold the project with paths and logging"
```

---

### Task 2: Render types, theme, and text truncation

**Files:**
- Create: `src/render/specs.ts`, `src/render/theme.ts`, `src/render/text.ts`
- Test: `tests/render/specs.test.ts`, `tests/render/theme.test.ts`, `tests/render/text.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types `Rgb`, `BarSpec`, `KeySpec`, `StripSpec`, `DeckFrame`.
  - `keyHash(spec: KeySpec): string` and `stripHash(spec: StripSpec): string`.
  - `blankKey(): KeySpec`.
  - `theme` with `bg`, `text`, `textDim`, `white`, `red`, `green`, `amber`, `blue`, `cyan`, `gray`.
  - `stateColor(state: SessionStateName): Rgb` and `stateLabel(state: SessionStateName): string`.
  - `barColor(fraction: number): Rgb`.
  - `truncate(s: string, max: number): string`.

- [ ] **Step 1: Write the failing test for the specs**

`keyHash` drives the dirty-key optimization. It must ignore the raw image bytes and use `imageKey` instead, because album art is a large buffer and a hash of it costs time on every frame.

Create `tests/render/specs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { keyHash, stripHash, blankKey } from '../../src/render/specs.js'
import type { KeySpec } from '../../src/render/specs.js'

describe('keyHash', () => {
  it('matches for two equal specs', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['5h', '62%'] }
    const b: KeySpec = { kind: 'gauge', lines: ['5h', '62%'] }
    expect(keyHash(a)).toBe(keyHash(b))
  })

  it('differs when a text line changes', () => {
    const a: KeySpec = { kind: 'gauge', lines: ['5h', '62%'] }
    const b: KeySpec = { kind: 'gauge', lines: ['5h', '63%'] }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('ignores the image bytes and uses imageKey', () => {
    const a: KeySpec = { kind: 'image', image: Buffer.from('aaaa'), imageKey: 'track-1' }
    const b: KeySpec = { kind: 'image', image: Buffer.from('bbbb'), imageKey: 'track-1' }
    expect(keyHash(a)).toBe(keyHash(b))
  })

  it('differs when imageKey changes', () => {
    const a: KeySpec = { kind: 'image', image: Buffer.from('aaaa'), imageKey: 'track-1' }
    const b: KeySpec = { kind: 'image', image: Buffer.from('aaaa'), imageKey: 'track-2' }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('differs when the border pulse phase changes', () => {
    const a: KeySpec = { kind: 'session', border: [255, 176, 0], pulseOn: true }
    const b: KeySpec = { kind: 'session', border: [255, 176, 0], pulseOn: false }
    expect(keyHash(a)).not.toBe(keyHash(b))
  })

  it('gives a blank key a stable hash', () => {
    expect(keyHash(blankKey())).toBe(keyHash(blankKey()))
  })
})

describe('stripHash', () => {
  it('differs when the bar value changes', () => {
    expect(stripHash({ lines: ['a'], bar: { value: 0.1, color: [0, 255, 0] } }))
      .not.toBe(stripHash({ lines: ['a'], bar: { value: 0.2, color: [0, 255, 0] } }))
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/render/specs.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 3: Write `src/render/specs.ts`**

```ts
export type Rgb = readonly [number, number, number]

export interface BarSpec {
  /** Fill fraction, 0 to 1. Values outside the range clamp. */
  value: number
  color: Rgb
  bg?: Rgb
}

export type KeyKind = 'blank' | 'session' | 'gauge' | 'control' | 'image'

export interface KeySpec {
  kind: KeyKind
  /** Up to 4 text lines, top to bottom. */
  lines?: string[]
  align?: 'left' | 'center'
  border?: Rgb
  /** True draws the border. False draws it dark. The page owns the phase. */
  pulseOn?: boolean
  bg?: Rgb
  bar?: BarSpec
  /** A large centred symbol, for a transport control. */
  glyph?: string
  /** An asset name, for example `crab`. */
  sprite?: string
  /** Decoded image bytes. `keyHash` ignores this field. */
  image?: Buffer
  /** Identity of `image`, for example a track id. `keyHash` uses this. */
  imageKey?: string
  dim?: boolean
}

export interface StripSpec {
  /** Up to 2 text lines. */
  lines: string[]
  bar?: BarSpec
  /** Right-aligned text on line 2, for example `2:14 / 4:32`. */
  right?: string
  dim?: boolean
}

export interface DeckFrame {
  /** Exactly 8 entries, for key index 0 to 7. */
  keys: KeySpec[]
  strip: StripSpec
  /** Colors for touch button 8 and 9. */
  buttons: [Rgb, Rgb]
}

export function blankKey(): KeySpec {
  return { kind: 'blank' }
}

/**
 * Serializes a key for change detection. It replaces `image` with `imageKey`,
 * because the buffer is large and its identity is enough.
 */
export function keyHash(spec: KeySpec): string {
  const { image, ...rest } = spec
  return JSON.stringify(rest, replacer)
}

export function stripHash(spec: StripSpec): string {
  return JSON.stringify(spec, replacer)
}

/** Sorts object keys, so key order cannot change a hash. */
function replacer(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)) {
    const o = v as Record<string, unknown>
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = o[k]
      return acc
    }, {})
  }
  return v
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/render/specs.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing test for the theme**

The state names and colors come straight from the spec, section 6.1.

Create `tests/render/theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { theme, stateColor, stateLabel, barColor } from '../../src/render/theme.js'

describe('stateLabel', () => {
  it('maps the five real states', () => {
    expect(stateLabel('idle')).toBe('IDLE')
    expect(stateLabel('thinking')).toBe('THINKING')
    expect(stateLabel('tool')).toBe('TOOL')
    expect(stateLabel('permission')).toBe('PERMIT?')
    expect(stateLabel('done')).toBe('DONE')
  })

  it('maps an unknown state to BUSY', () => {
    expect(stateLabel('unknown')).toBe('BUSY')
  })
})

describe('stateColor', () => {
  it('gives permission the amber colour', () => {
    expect(stateColor('permission')).toEqual(theme.amber)
  })

  it('gives an unknown state the dim gray colour', () => {
    expect(stateColor('unknown')).toEqual(theme.gray)
  })

  it('gives every state a colour', () => {
    for (const s of ['idle', 'thinking', 'tool', 'permission', 'done', 'unknown'] as const) {
      expect(stateColor(s)).toHaveLength(3)
    }
  })
})

describe('barColor', () => {
  it('is green below 60 percent', () => {
    expect(barColor(0.0)).toEqual(theme.green)
    expect(barColor(0.59)).toEqual(theme.green)
  })

  it('is amber from 60 to 85 percent', () => {
    expect(barColor(0.6)).toEqual(theme.amber)
    expect(barColor(0.85)).toEqual(theme.amber)
  })

  it('is red above 85 percent', () => {
    expect(barColor(0.86)).toEqual(theme.red)
    expect(barColor(1.0)).toEqual(theme.red)
  })
})
```

- [ ] **Step 6: Run the test and confirm it fails**

Run: `npx vitest run tests/render/theme.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 7: Write `src/render/theme.ts`**

```ts
import type { Rgb } from './specs.js'

export const theme = {
  bg: [10, 10, 12] as Rgb,
  text: [235, 235, 235] as Rgb,
  textDim: [120, 120, 128] as Rgb,
  white: [255, 255, 255] as Rgb,
  red: [230, 60, 60] as Rgb,
  green: [70, 200, 110] as Rgb,
  amber: [255, 176, 0] as Rgb,
  blue: [90, 150, 255] as Rgb,
  cyan: [80, 210, 220] as Rgb,
  gray: [80, 80, 88] as Rgb,
  barTrack: [40, 40, 46] as Rgb,
} as const

/** Every value the `state` field can hold, plus the fallback. */
export type SessionStateName =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'permission'
  | 'done'
  | 'unknown'

const LABELS: Record<SessionStateName, string> = {
  idle: 'IDLE',
  thinking: 'THINKING',
  tool: 'TOOL',
  permission: 'PERMIT?',
  done: 'DONE',
  unknown: 'BUSY',
}

const COLORS: Record<SessionStateName, Rgb> = {
  idle: theme.gray,
  thinking: theme.blue,
  tool: theme.cyan,
  permission: theme.amber,
  done: theme.green,
  unknown: theme.gray,
}

export function stateLabel(state: SessionStateName): string {
  return LABELS[state]
}

export function stateColor(state: SessionStateName): Rgb {
  return COLORS[state]
}

/** Green below 0.6. Amber from 0.6 to 0.85. Red above 0.85. */
export function barColor(fraction: number): Rgb {
  if (fraction > 0.85) return theme.red
  if (fraction >= 0.6) return theme.amber
  return theme.green
}
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `npx vitest run tests/render/theme.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 9: Write the failing test for truncation**

Create `tests/render/text.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { truncate, formatDuration, formatClock } from '../../src/render/text.js'

describe('truncate', () => {
  it('leaves a short string alone', () => {
    expect(truncate('daisy', 10)).toBe('daisy')
  })

  it('leaves an exact-length string alone', () => {
    expect(truncate('abcde', 5)).toBe('abcde')
  })

  it('cuts a long string and adds an ellipsis', () => {
    expect(truncate('streamdeckneoclaude', 10)).toBe('streamdec…')
  })

  it('never returns more characters than the limit', () => {
    expect(truncate('streamdeckneoclaude', 10)).toHaveLength(10)
  })

  it('handles a limit of 1', () => {
    expect(truncate('abc', 1)).toBe('…')
  })

  it('handles an empty string', () => {
    expect(truncate('', 5)).toBe('')
  })
})

describe('formatDuration', () => {
  it('shows minutes below an hour', () => {
    expect(formatDuration(14 * 60)).toBe('14m')
  })

  it('shows hours and minutes above an hour', () => {
    expect(formatDuration(2 * 3600 + 11 * 60)).toBe('2h11m')
  })

  it('shows days above a day', () => {
    expect(formatDuration(4 * 86400 + 3600)).toBe('4d1h')
  })

  it('shows 0m for zero', () => {
    expect(formatDuration(0)).toBe('0m')
  })

  it('shows 0m for a negative value', () => {
    expect(formatDuration(-30)).toBe('0m')
  })
})

describe('formatClock', () => {
  it('formats seconds as m:ss', () => {
    expect(formatClock(134)).toBe('2:14')
  })

  it('pads the seconds', () => {
    expect(formatClock(65)).toBe('1:05')
  })

  it('handles over an hour', () => {
    expect(formatClock(3725)).toBe('62:05')
  })
})
```

- [ ] **Step 10: Run the test and confirm it fails**

Run: `npx vitest run tests/render/text.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 11: Write `src/render/text.ts`**

```ts
const ELLIPSIS = '…'

/**
 * Cuts a string to `max` characters. The result never exceeds `max`, because
 * the ellipsis replaces the last kept character.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1) + ELLIPSIS
}

/** Formats a duration in seconds as `14m`, `2h11m`, or `4d1h`. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

/** Formats a playback position in seconds as `2:14`. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
```

- [ ] **Step 12: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 29 tests. The typecheck prints nothing.

- [ ] **Step 13: Commit**

```bash
git add src/render tests/render
git commit -m "feat: add render types, theme, and text helpers"
```

---

### Task 3: The renderer

**Files:**
- Create: `src/render/canvas.ts`
- Test: `tests/render/canvas.test.ts`

**Interfaces:**
- Consumes: `KeySpec`, `StripSpec`, `Rgb` from Task 2. `theme` from Task 2.
- Produces:
  - `renderKey(spec: KeySpec): Buffer` — a 96 × 96 raw BGRA-independent PNG buffer.
  - `renderStrip(spec: StripSpec): Buffer` — a 248 × 58 PNG buffer.
  - `KEY_SIZE = 96`, `STRIP_WIDTH = 248`, `STRIP_HEIGHT = 58`.
  - `probe(png: Buffer, x: number, y: number): Rgb` — a test helper for pixel probes.

Tests use pixel probes, not full-image snapshots. A probe reads one coordinate. It asserts intent, and a font update cannot break it.

- [ ] **Step 1: Write the failing test**

Create `tests/render/canvas.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  renderKey,
  renderStrip,
  probe,
  KEY_SIZE,
  STRIP_WIDTH,
  STRIP_HEIGHT,
} from '../../src/render/canvas.js'
import { theme } from '../../src/render/theme.js'

/** Allows a small difference, because canvas anti-aliases edges. */
function near(actual: readonly number[], expected: readonly number[], tol = 12) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(tol)
  }
}

describe('renderKey', () => {
  it('returns a 96 by 96 image', () => {
    const png = renderKey({ kind: 'blank' })
    expect(png.length).toBeGreaterThan(0)
    expect(probe(png, 0, 0)).toHaveLength(3)
    expect(KEY_SIZE).toBe(96)
  })

  it('fills a blank key with the background colour', () => {
    const png = renderKey({ kind: 'blank' })
    near(probe(png, 48, 48), theme.bg)
  })

  it('draws the border colour on the left edge', () => {
    const png = renderKey({ kind: 'session', border: theme.amber, pulseOn: true })
    near(probe(png, 1, 48), theme.amber)
  })

  it('draws a dark border when pulseOn is false', () => {
    const png = renderKey({ kind: 'session', border: theme.amber, pulseOn: false })
    const px = probe(png, 1, 48)
    expect(px[0]).toBeLessThan(theme.amber[0])
  })

  it('draws a solid border when pulseOn is absent', () => {
    const png = renderKey({ kind: 'session', border: theme.cyan })
    near(probe(png, 1, 48), theme.cyan)
  })

  it('draws a bar filled to the given fraction', () => {
    const png = renderKey({
      kind: 'gauge',
      bar: { value: 1.0, color: theme.green },
    })
    // The bar spans the key width at y = 70. A full bar paints the right end.
    near(probe(png, 80, 70), theme.green)
  })

  it('leaves the bar track unpainted past the fill', () => {
    const png = renderKey({
      kind: 'gauge',
      bar: { value: 0.1, color: theme.green },
    })
    near(probe(png, 80, 70), theme.barTrack)
  })

  it('clamps a bar value above 1', () => {
    const png = renderKey({ kind: 'gauge', bar: { value: 5, color: theme.green } })
    near(probe(png, 88, 70), theme.green)
  })

  it('clamps a bar value below 0', () => {
    const png = renderKey({ kind: 'gauge', bar: { value: -5, color: theme.green } })
    near(probe(png, 12, 70), theme.barTrack)
  })

  it('paints text pixels somewhere on the key', () => {
    const blank = renderKey({ kind: 'gauge' })
    const withText = renderKey({ kind: 'gauge', lines: ['HELLO'] })
    expect(withText.equals(blank)).toBe(false)
  })

  it('renders an image key from raw pixels', () => {
    const solid = solidPng(255, 0, 0)
    const png = renderKey({ kind: 'image', image: solid, imageKey: 'x' })
    near(probe(png, 48, 48), [255, 0, 0], 20)
  })
})

describe('renderStrip', () => {
  it('returns a 248 by 58 image', () => {
    expect(STRIP_WIDTH).toBe(248)
    expect(STRIP_HEIGHT).toBe(58)
    const png = renderStrip({ lines: ['hello'] })
    near(probe(png, 240, 4), theme.bg)
  })

  it('draws a progress bar filled to the fraction', () => {
    const png = renderStrip({
      lines: ['a', 'b'],
      bar: { value: 1.0, color: theme.green },
    })
    near(probe(png, 200, 50), theme.green)
  })
})

/** Builds a 96 by 96 solid-colour PNG, for the image test. */
function solidPng(r: number, g: number, b: number): Buffer {
  // Implemented in the test file with @napi-rs/canvas.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCanvas } = require('@napi-rs/canvas')
  const c = createCanvas(96, 96)
  const ctx = c.getContext('2d')
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.fillRect(0, 0, 96, 96)
  return c.toBuffer('image/png')
}
```

- [ ] **Step 2: Fix the helper to use ESM, then run the test and confirm it fails**

Replace the `require` call in `solidPng` with a top-level import, because the project is ESM only:

```ts
import { createCanvas } from '@napi-rs/canvas'

function solidPng(r: number, g: number, b: number): Buffer {
  const c = createCanvas(96, 96)
  const ctx = c.getContext('2d')
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.fillRect(0, 0, 96, 96)
  return c.toBuffer('image/png')
}
```

Run: `npx vitest run tests/render/canvas.test.ts`
Expected: FAIL. The error names a missing module `../../src/render/canvas.js`.

- [ ] **Step 3: Write `src/render/canvas.ts`**

```ts
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import type { KeySpec, StripSpec, Rgb, BarSpec } from './specs.js'
import { theme } from './theme.js'

export const KEY_SIZE = 96
export const STRIP_WIDTH = 248
export const STRIP_HEIGHT = 58

const FONT = 'Menlo'
const PAD = 6
const BORDER = 3
const BAR_Y = 66
const BAR_H = 8

function css(c: Rgb, dim = false): string {
  const f = dim ? 0.45 : 1
  return `rgb(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)})`
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function drawBar(
  ctx: SKRSContext2D,
  bar: BarSpec,
  x: number,
  y: number,
  w: number,
  h: number,
  dim: boolean,
): void {
  ctx.fillStyle = css(bar.bg ?? theme.barTrack, dim)
  ctx.fillRect(x, y, w, h)
  const fill = Math.round(w * clamp01(bar.value))
  if (fill > 0) {
    ctx.fillStyle = css(bar.color, dim)
    ctx.fillRect(x, y, fill, h)
  }
}

/** Renders one 96 by 96 key. The result is a PNG buffer. */
export function renderKey(spec: KeySpec): Buffer {
  const canvas = createCanvas(KEY_SIZE, KEY_SIZE)
  const ctx = canvas.getContext('2d')
  const dim = spec.dim === true

  ctx.fillStyle = css(spec.bg ?? theme.bg)
  ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE)

  if (spec.image) {
    // The caller supplies a decoded, pre-scaled image. Draw it edge to edge.
    const img = decodeSync(spec.image)
    if (img) ctx.drawImage(img, 0, 0, KEY_SIZE, KEY_SIZE)
  }

  if (spec.border) {
    const on = spec.pulseOn !== false
    ctx.fillStyle = on ? css(spec.border, dim) : css(spec.border, true)
    ctx.fillRect(0, 0, BORDER, KEY_SIZE)
  }

  if (spec.glyph) {
    ctx.fillStyle = css(theme.text, dim)
    ctx.font = `28px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(spec.glyph, KEY_SIZE / 2, KEY_SIZE / 2)
  }

  if (spec.lines?.length) {
    const centered = spec.align === 'center'
    ctx.fillStyle = css(theme.text, dim)
    ctx.font = `11px ${FONT}`
    ctx.textAlign = centered ? 'center' : 'left'
    ctx.textBaseline = 'top'
    const x = centered ? KEY_SIZE / 2 : BORDER + PAD
    let y = PAD
    for (const line of spec.lines) {
      ctx.fillText(line, x, y)
      y += 14
    }
  }

  if (spec.bar) {
    drawBar(ctx, spec.bar, BORDER + PAD, BAR_Y, KEY_SIZE - BORDER - PAD * 2, BAR_H, dim)
  }

  return canvas.toBuffer('image/png')
}

/** Renders the 248 by 58 info strip as one image. */
export function renderStrip(spec: StripSpec): Buffer {
  const canvas = createCanvas(STRIP_WIDTH, STRIP_HEIGHT)
  const ctx = canvas.getContext('2d')
  const dim = spec.dim === true

  ctx.fillStyle = css(theme.bg)
  ctx.fillRect(0, 0, STRIP_WIDTH, STRIP_HEIGHT)

  ctx.fillStyle = css(theme.text, dim)
  ctx.font = `13px ${FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  let y = 4
  for (const line of spec.lines.slice(0, 2)) {
    ctx.fillText(line, PAD, y)
    y += 17
  }

  if (spec.right) {
    ctx.textAlign = 'right'
    ctx.fillStyle = css(theme.textDim, dim)
    ctx.fillText(spec.right, STRIP_WIDTH - PAD, 4)
    ctx.textAlign = 'left'
  }

  if (spec.bar) {
    drawBar(ctx, spec.bar, PAD, 46, STRIP_WIDTH - PAD * 2, 6, dim)
  }

  return canvas.toBuffer('image/png')
}

/**
 * Reads one pixel from a PNG buffer. Tests use it for pixel probes.
 * It decodes the image every call, so it suits tests and not the render loop.
 */
export function probe(png: Buffer, x: number, y: number): Rgb {
  const img = decodeSync(png)
  if (!img) throw new Error('probe could not decode the image')
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(x, y, 1, 1).data
  return [d[0]!, d[1]!, d[2]!]
}

/**
 * Decodes an image buffer. `@napi-rs/canvas` exposes an async `loadImage`, and
 * the render loop must stay synchronous, so this uses the sync path when the
 * library offers it and falls back to a cached async decode.
 */
function decodeSync(buf: Buffer): Awaited<ReturnType<typeof loadImage>> | null {
  try {
    // `Image` accepts a buffer assignment and decodes at once.
    const { Image } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
    const img = new Image()
    img.src = buf
    return img as unknown as Awaited<ReturnType<typeof loadImage>>
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Replace the `require` in `decodeSync` with a static import**

The project is ESM only, so `require` fails at runtime. Change the top import line and the function body:

```ts
import { createCanvas, Image, type SKRSContext2D } from '@napi-rs/canvas'

function decodeSync(buf: Buffer): Image | null {
  try {
    const img = new Image()
    img.src = buf
    return img
  } catch {
    return null
  }
}
```

Delete the `loadImage` import. Change the `drawImage` call and `probe` to use the `Image` type.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/render/canvas.test.ts`
Expected: PASS, 13 tests.

If a bar probe fails, print the real pixel first. Adjust the probe coordinate to match `BAR_Y` and `BAR_H`, and do not change the tolerance. The coordinate is the thing under test.

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 42 tests. The typecheck prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/render/canvas.ts tests/render/canvas.test.ts
git commit -m "feat: render keys and the info strip with canvas"
```

---

### Task 4: The device wrapper and the fake device

**Files:**
- Create: `src/device.ts`, `src/fake-device.ts`
- Test: `tests/fake-device.test.ts`

**Interfaces:**
- Consumes: `Rgb` from Task 2. `log` from Task 1.
- Produces:
  - `interface DeckDevice` with `connect`, `disconnect`, `setKeyImage`, `setStrip`, `setButtonColor`, `setBrightness`, `onPress`, `onRelease`, `onConnect`, `onDisconnect`, `isConnected`.
  - `class Device implements DeckDevice` — the real hardware.
  - `class FakeDevice implements DeckDevice` — records every write.
  - `NEO_KEY_COUNT = 8`, `BUTTON_LEFT = 8`, `BUTTON_RIGHT = 9`.

- [ ] **Step 1: Write the failing test for the fake device**

The fake device exists to prove the dirty-key optimization in Task 10. It must count writes.

Create `tests/fake-device.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { FakeDevice, BUTTON_LEFT, BUTTON_RIGHT, NEO_KEY_COUNT } from '../src/fake-device.js'

describe('FakeDevice', () => {
  it('names the Neo control indexes', () => {
    expect(NEO_KEY_COUNT).toBe(8)
    expect(BUTTON_LEFT).toBe(8)
    expect(BUTTON_RIGHT).toBe(9)
  })

  it('records a key write', async () => {
    const d = new FakeDevice()
    await d.connect()
    await d.setKeyImage(3, Buffer.from('img'))
    expect(d.keyWrites).toEqual([{ index: 3, bytes: 3 }])
  })

  it('records the strip and the button colours', async () => {
    const d = new FakeDevice()
    await d.connect()
    await d.setStrip(Buffer.from('strip'))
    await d.setButtonColor(BUTTON_LEFT, [1, 2, 3])
    expect(d.stripWrites).toBe(1)
    expect(d.buttonColors.get(BUTTON_LEFT)).toEqual([1, 2, 3])
  })

  it('rejects a key index outside 0 to 7', async () => {
    const d = new FakeDevice()
    await d.connect()
    await expect(d.setKeyImage(8, Buffer.from('x'))).rejects.toThrow(/index/i)
  })

  it('rejects a write before connect', async () => {
    const d = new FakeDevice()
    await expect(d.setKeyImage(0, Buffer.from('x'))).rejects.toThrow(/connect/i)
  })

  it('delivers a simulated press to the handler', async () => {
    const d = new FakeDevice()
    const seen: number[] = []
    d.onPress((i) => seen.push(i))
    await d.connect()
    d.simulatePress(5)
    expect(seen).toEqual([5])
  })

  it('reports connection state', async () => {
    const d = new FakeDevice()
    expect(d.isConnected()).toBe(false)
    await d.connect()
    expect(d.isConnected()).toBe(true)
    await d.disconnect()
    expect(d.isConnected()).toBe(false)
  })

  it('clears its records on demand', async () => {
    const d = new FakeDevice()
    await d.connect()
    await d.setKeyImage(0, Buffer.from('x'))
    d.reset()
    expect(d.keyWrites).toEqual([])
    expect(d.stripWrites).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/fake-device.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 3: Write `src/device.ts` with the interface and the real device**

```ts
import {
  listStreamDecks,
  openStreamDeck,
  type StreamDeck,
} from '@elgato-stream-deck/node'
import type { Rgb } from './render/specs.js'
import { log } from './log.js'

export const NEO_KEY_COUNT = 8
export const BUTTON_LEFT = 8
export const BUTTON_RIGHT = 9

export interface DeckDevice {
  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  setKeyImage(index: number, png: Buffer): Promise<void>
  setStrip(png: Buffer): Promise<void>
  setButtonColor(index: number, rgb: Rgb): Promise<void>
  setBrightness(percent: number): Promise<void>
  onPress(cb: (index: number) => void): void
  onRelease(cb: (index: number) => void): void
  onConnect(cb: () => void): void
  onDisconnect(cb: () => void): void
}

/** Thrown when another process already holds the device. */
export class DeviceBusyError extends Error {}

/**
 * The real Stream Deck Neo. It is the only module that imports the Elgato
 * library. It retries enumeration, so an unplugged cable is not fatal.
 */
export class Device implements DeckDevice {
  private deck: StreamDeck | null = null
  private pressCbs: ((i: number) => void)[] = []
  private releaseCbs: ((i: number) => void)[] = []
  private connectCbs: (() => void)[] = []
  private disconnectCbs: (() => void)[] = []
  private retry: NodeJS.Timeout | null = null
  private stopped = false

  isConnected(): boolean {
    return this.deck !== null
  }

  async connect(): Promise<void> {
    this.stopped = false
    await this.tryOpen()
    if (!this.deck) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      void this.connect()
    }, 2000)
  }

  private async tryOpen(): Promise<void> {
    let found
    try {
      found = await listStreamDecks()
    } catch (e) {
      log.once('enumerate', `cannot list devices: ${String(e)}`)
      return
    }
    const neo = found.find((d) => d.model === 'neo')
    if (!neo) {
      log.once('no-device', 'no Stream Deck Neo found. Retrying every 2 seconds.')
      return
    }
    try {
      this.deck = await openStreamDeck(neo.path)
    } catch (e) {
      // An open failure almost always means another process owns the device.
      throw new DeviceBusyError(
        'cannot open the Stream Deck Neo. Another process may own it. ' +
          'Quit the Elgato Stream Deck app or another deckd instance. ' +
          `Cause: ${String(e)}`,
      )
    }
    log.clearOnce('no-device')
    log.info(`connected to ${this.deck.PRODUCT_NAME}`)
    this.deck.on('down', (c) => this.pressCbs.forEach((cb) => cb(controlIndex(c))))
    this.deck.on('up', (c) => this.releaseCbs.forEach((cb) => cb(controlIndex(c))))
    this.deck.on('error', (e) => {
      log.error(`device error: ${String(e)}`)
      void this.handleLoss()
    })
    this.connectCbs.forEach((cb) => cb())
  }

  private async handleLoss(): Promise<void> {
    this.deck = null
    this.disconnectCbs.forEach((cb) => cb())
    this.scheduleRetry()
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const d = this.deck
    this.deck = null
    if (d) await d.close()
  }

  private require(): StreamDeck {
    if (!this.deck) throw new Error('device is not connected')
    return this.deck
  }

  async setKeyImage(index: number, png: Buffer): Promise<void> {
    if (index < 0 || index >= NEO_KEY_COUNT) {
      throw new Error(`key index ${index} is outside 0 to 7`)
    }
    await this.require().fillKeyBuffer(index, png, { format: 'png' })
  }

  async setStrip(png: Buffer): Promise<void> {
    await this.require().fillLcdRegion(0, 0, 0, png, {
      format: 'png',
      width: 248,
      height: 58,
    })
  }

  async setButtonColor(index: number, rgb: Rgb): Promise<void> {
    if (index !== BUTTON_LEFT && index !== BUTTON_RIGHT) {
      throw new Error(`button index ${index} is not 8 or 9`)
    }
    await this.require().setButtonColor(index, rgb[0], rgb[1], rgb[2])
  }

  async setBrightness(percent: number): Promise<void> {
    await this.require().setBrightness(Math.min(100, Math.max(0, percent)))
  }

  onPress(cb: (i: number) => void): void {
    this.pressCbs.push(cb)
  }
  onRelease(cb: (i: number) => void): void {
    this.releaseCbs.push(cb)
  }
  onConnect(cb: () => void): void {
    this.connectCbs.push(cb)
  }
  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb)
  }
}

/** Maps a library control event to a flat index. */
function controlIndex(control: { index?: number }): number {
  return control.index ?? -1
}
```

- [ ] **Step 4: Write `src/fake-device.ts`**

```ts
import type { Rgb } from './render/specs.js'
import type { DeckDevice } from './device.js'

export { NEO_KEY_COUNT, BUTTON_LEFT, BUTTON_RIGHT } from './device.js'
import { NEO_KEY_COUNT, BUTTON_LEFT, BUTTON_RIGHT } from './device.js'

export interface KeyWrite {
  index: number
  bytes: number
}

/** Records every write, so a test can count them. */
export class FakeDevice implements DeckDevice {
  keyWrites: KeyWrite[] = []
  stripWrites = 0
  buttonColors = new Map<number, Rgb>()
  brightness = 100

  private connected = false
  private pressCbs: ((i: number) => void)[] = []
  private releaseCbs: ((i: number) => void)[] = []
  private connectCbs: (() => void)[] = []
  private disconnectCbs: (() => void)[] = []

  isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<void> {
    this.connected = true
    this.connectCbs.forEach((cb) => cb())
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.disconnectCbs.forEach((cb) => cb())
  }

  private check(): void {
    if (!this.connected) throw new Error('device is not connected')
  }

  async setKeyImage(index: number, png: Buffer): Promise<void> {
    this.check()
    if (index < 0 || index >= NEO_KEY_COUNT) {
      throw new Error(`key index ${index} is outside 0 to 7`)
    }
    this.keyWrites.push({ index, bytes: png.length })
  }

  async setStrip(_png: Buffer): Promise<void> {
    this.check()
    this.stripWrites += 1
  }

  async setButtonColor(index: number, rgb: Rgb): Promise<void> {
    this.check()
    if (index !== BUTTON_LEFT && index !== BUTTON_RIGHT) {
      throw new Error(`button index ${index} is not 8 or 9`)
    }
    this.buttonColors.set(index, rgb)
  }

  async setBrightness(percent: number): Promise<void> {
    this.check()
    this.brightness = percent
  }

  onPress(cb: (i: number) => void): void {
    this.pressCbs.push(cb)
  }
  onRelease(cb: (i: number) => void): void {
    this.releaseCbs.push(cb)
  }
  onConnect(cb: () => void): void {
    this.connectCbs.push(cb)
  }
  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb)
  }

  /** Test helper. Fires a press on the given index. */
  simulatePress(index: number): void {
    this.pressCbs.forEach((cb) => cb(index))
  }

  /** Test helper. Fires a release on the given index. */
  simulateRelease(index: number): void {
    this.releaseCbs.forEach((cb) => cb(index))
  }

  /** Test helper. Clears every record. */
  reset(): void {
    this.keyWrites = []
    this.stripWrites = 0
    this.buttonColors.clear()
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/fake-device.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Verify the real library method names against the installed package**

The `Device` class calls `fillKeyBuffer`, `fillLcdRegion`, `setButtonColor`, and `setBrightness`. Confirm each name exists before Task 5 runs on hardware.

Run:
```bash
node -e "import('@elgato-stream-deck/node').then(async m => {
  const [d] = await m.listStreamDecks();
  const deck = await m.openStreamDeck(d.path);
  const proto = Object.getPrototypeOf(deck);
  console.log(Object.getOwnPropertyNames(proto).filter(n => /fill|Button|Bright|lcd|Lcd/i.test(n)));
  await deck.close();
})"
```
Expected: the list contains `fillKeyBuffer`, `setBrightness`, and an LCD fill method. Correct `src/device.ts` to match the real names. Note the exact names in a comment above each call.

- [ ] **Step 7: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 50 tests. The typecheck prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src/device.ts src/fake-device.ts tests/fake-device.test.ts
git commit -m "feat: wrap the Stream Deck device behind one interface"
```

---

### Task 5: Smoke test on real hardware — milestone 1

**Files:**
- Create: `scripts/smoke.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `Device` from Task 4. `renderKey`, `renderStrip` from Task 3. `theme` from Task 2.
- Produces: `npm run smoke`. It needs the real device.

This task has no unit test. It is the test. It proves the render chain reaches the glass before any page logic exists.

- [ ] **Step 1: Write `scripts/smoke.ts`**

```ts
import { Device, BUTTON_LEFT, BUTTON_RIGHT } from '../src/device.js'
import { renderKey, renderStrip } from '../src/render/canvas.js'
import { theme } from '../src/render/theme.js'

const COLORS = [
  theme.red, theme.amber, theme.green, theme.cyan,
  theme.blue, theme.gray, theme.white, theme.textDim,
]

async function main(): Promise<void> {
  const device = new Device()
  await device.connect()
  if (!device.isConnected()) {
    console.error('no Stream Deck Neo found. Plug it in and try again.')
    process.exit(1)
  }

  await device.setBrightness(80)

  for (let i = 0; i < 8; i++) {
    const png = renderKey({
      kind: 'gauge',
      lines: [`KEY ${i}`, i < 4 ? 'row 0' : 'row 1'],
      border: COLORS[i],
      bar: { value: (i + 1) / 8, color: COLORS[i]! },
    })
    await device.setKeyImage(i, png)
  }

  await device.setStrip(
    renderStrip({
      lines: ['deckd smoke test', 'press any key. ctrl-c to quit.'],
      bar: { value: 0.5, color: theme.green },
      right: '8/8',
    }),
  )

  await device.setButtonColor(BUTTON_LEFT, theme.red)
  await device.setButtonColor(BUTTON_RIGHT, theme.green)

  device.onPress((i) => console.log(`press  index=${i}`))
  device.onRelease((i) => console.log(`release index=${i}`))

  console.log('Test pattern drawn. Confirm all 8 keys, the strip, and both buttons.')
  console.log('Press keys to confirm the index mapping. Ctrl-C to quit.')

  const quit = async () => {
    await device.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', () => void quit())
}

void main()
```

- [ ] **Step 2: Build and run it on the real device**

Run: `npm run smoke`
Expected on the hardware:
- All 8 keys show `KEY 0` to `KEY 7`, with a coloured left border and a bar that grows across the keys.
- Key 0 to 3 read `row 0`. Key 4 to 7 read `row 1`. This confirms the index-to-position mapping.
- The strip shows two text lines and a half-filled bar.
- The left touch button glows red. The right glows green.

- [ ] **Step 3: Confirm the press indexes**

Press every key and both touch buttons. Watch the console.
Expected: keys report `index=0` to `index=7`. The left touch button reports `index=8`. The right reports `index=9`.

Record the real numbers in a comment at the top of `src/device.ts` if any differ. The spec's control table is the reference, and the hardware is the authority.

- [ ] **Step 4: Fix any mapping or rendering fault now**

Any wrong index, clipped text, or wrong strip size is cheaper to fix here than in Task 10. Do not continue with a known fault.

- [ ] **Step 5: Add a Development section to `README.md`**

```markdown
## Development

Requires macOS and Node 22 or later.

```bash
npm install
npm test          # unit tests, no hardware needed
npm run typecheck
npm run smoke     # draws a test pattern, needs the real device
```

`npm run smoke` is the fastest way to confirm the device works. It draws a
labelled pattern on all 8 keys, the info strip, and both touch buttons. It then
prints every press index.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke.ts README.md
git commit -m "feat: add a hardware smoke test"
```

---

### Task 6: The Claude session source

**Files:**
- Create: `src/sources/claude.ts`
- Test: `tests/sources/claude.test.ts`

**Interfaces:**
- Consumes: `paths` and `log` from Task 1. `SessionStateName` from Task 2.
- Produces:
  - `interface Session` with `sessionId`, `state: SessionStateName`, `label`, `tool`, `project`, `cwd`, `termProgram`, `pid`, `startedAt`, `ts`.
  - `class ClaudeSource` with `start()`, `stop()`, `getSessions(): Session[]`, `on('change', cb)`.
  - `parseSessionFile(json: string, now: number): Session | null`.
  - `STALE_SECONDS = 600`.

`getSessions` returns live sessions sorted by `ts`, newest first. Task 8 owns key assignment, so this source does no assignment.

- [ ] **Step 1: Write the failing test**

Create `tests/sources/claude.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeSource, parseSessionFile, STALE_SECONDS } from '../../src/sources/claude.js'

const NOW = 1786549560

function fileFor(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: 'tool',
    label: 'Running command',
    tool: 'Bash',
    project: 'streamdeckneoclaude',
    cwd: '/Users/you/Vibecoding/streamdeckneoclaude',
    sessionId: 'aaaa',
    transcript: '/tmp/t.jsonl',
    entrypoint: 'cli',
    term_program: 'ghostty',
    pid: 39894,
    started: true,
    startedAt: NOW - 840,
    ts: NOW,
    ...overrides,
  })
}

describe('parseSessionFile', () => {
  it('reads every field the deck needs', () => {
    const s = parseSessionFile(fileFor(), NOW)!
    expect(s.sessionId).toBe('aaaa')
    expect(s.state).toBe('tool')
    expect(s.label).toBe('Running command')
    expect(s.tool).toBe('Bash')
    expect(s.project).toBe('streamdeckneoclaude')
    expect(s.termProgram).toBe('ghostty')
    expect(s.pid).toBe(39894)
    expect(s.startedAt).toBe(NOW - 840)
    expect(s.ts).toBe(NOW)
  })

  it('accepts all five real state values', () => {
    for (const v of ['idle', 'thinking', 'tool', 'permission', 'done'] as const) {
      expect(parseSessionFile(fileFor({ state: v }), NOW)!.state).toBe(v)
    }
  })

  it('maps an unrecognised state to unknown', () => {
    expect(parseSessionFile(fileFor({ state: 'juggling' }), NOW)!.state).toBe('unknown')
  })

  it('maps a missing state to unknown', () => {
    expect(parseSessionFile(fileFor({ state: undefined }), NOW)!.state).toBe('unknown')
  })

  it('returns null for a stale session', () => {
    expect(parseSessionFile(fileFor({ ts: NOW - STALE_SECONDS - 1 }), NOW)).toBeNull()
  })

  it('keeps a session exactly at the stale limit', () => {
    expect(parseSessionFile(fileFor({ ts: NOW - STALE_SECONDS }), NOW)).not.toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseSessionFile('{ not json', NOW)).toBeNull()
  })

  it('returns null when sessionId is absent', () => {
    expect(parseSessionFile(fileFor({ sessionId: '' }), NOW)).toBeNull()
  })

  it('defaults a missing project to a dash', () => {
    expect(parseSessionFile(fileFor({ project: undefined }), NOW)!.project).toBe('—')
  })
})

describe('ClaudeSource', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-state-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads every session file in the directory', async () => {
    writeFileSync(join(dir, 'aaaa.json'), fileFor({ sessionId: 'aaaa', ts: NOW }))
    writeFileSync(join(dir, 'bbbb.json'), fileFor({ sessionId: 'bbbb', ts: NOW }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    expect(src.getSessions()).toHaveLength(2)
    await src.stop()
  })

  it('sorts sessions by ts, newest first', async () => {
    writeFileSync(join(dir, 'old.json'), fileFor({ sessionId: 'old', ts: NOW - 100 }))
    writeFileSync(join(dir, 'new.json'), fileFor({ sessionId: 'new', ts: NOW }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    expect(src.getSessions().map((s) => s.sessionId)).toEqual(['new', 'old'])
    await src.stop()
  })

  it('hides a stale session', async () => {
    writeFileSync(join(dir, 'a.json'), fileFor({ sessionId: 'a', ts: NOW }))
    writeFileSync(join(dir, 'b.json'), fileFor({ sessionId: 'b', ts: NOW - 9999 }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    expect(src.getSessions().map((s) => s.sessionId)).toEqual(['a'])
    await src.stop()
  })

  it('skips a corrupt file and keeps the good ones', async () => {
    writeFileSync(join(dir, 'good.json'), fileFor({ sessionId: 'good', ts: NOW }))
    writeFileSync(join(dir, 'bad.json'), '{ truncated')
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    expect(src.getSessions().map((s) => s.sessionId)).toEqual(['good'])
    await src.stop()
  })

  it('ignores a file that is not .json', async () => {
    writeFileSync(join(dir, 'a.json'), fileFor({ sessionId: 'a', ts: NOW }))
    writeFileSync(join(dir, 'a.json.4242.tmp'), fileFor({ sessionId: 'tmp', ts: NOW }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    expect(src.getSessions().map((s) => s.sessionId)).toEqual(['a'])
    await src.stop()
  })

  it('reports an empty list when the directory is absent', async () => {
    const src = new ClaudeSource(join(dir, 'nope'), () => NOW)
    await src.start()
    expect(src.getSessions()).toEqual([])
    expect(src.directoryExists()).toBe(false)
    await src.stop()
  })

  it('emits change when a session file appears', async () => {
    const src = new ClaudeSource(dir, () => NOW)
    let changes = 0
    src.on('change', () => { changes += 1 })
    await src.start()
    const before = changes
    writeFileSync(join(dir, 'new.json'), fileFor({ sessionId: 'new', ts: NOW }))
    await src.refresh()
    expect(changes).toBeGreaterThan(before)
    expect(src.getSessions()).toHaveLength(1)
    await src.stop()
  })

  it('does not emit change when nothing changed', async () => {
    writeFileSync(join(dir, 'a.json'), fileFor({ sessionId: 'a', ts: NOW }))
    const src = new ClaudeSource(dir, () => NOW)
    await src.start()
    let changes = 0
    src.on('change', () => { changes += 1 })
    await src.refresh()
    await src.refresh()
    expect(changes).toBe(0)
    await src.stop()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/sources/claude.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 3: Write `src/sources/claude.ts`**

The constructor takes the directory and a clock. Both are injected, so tests need no real home directory and no real time.

```ts
import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync, existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../paths.js'
import { log } from '../log.js'
import type { SessionStateName } from '../render/theme.js'

export const STALE_SECONDS = 600
const POLL_MS = 5000

const KNOWN: SessionStateName[] = ['idle', 'thinking', 'tool', 'permission', 'done']

export interface Session {
  sessionId: string
  state: SessionStateName
  label: string
  tool: string
  project: string
  cwd: string
  termProgram: string
  pid: number
  startedAt: number
  ts: number
}

/**
 * Parses one state file. Returns null for a stale session, a corrupt file, or a
 * file with no session id.
 */
export function parseSessionFile(json: string, now: number): Session | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  const sessionId = str(raw.sessionId)
  if (!sessionId) return null
  const ts = num(raw.ts)
  if (now - ts > STALE_SECONDS) return null

  const stateRaw = str(raw.state)
  const state = (KNOWN as string[]).includes(stateRaw)
    ? (stateRaw as SessionStateName)
    : 'unknown'

  return {
    sessionId,
    state,
    label: str(raw.label),
    tool: str(raw.tool),
    project: str(raw.project) || '—',
    cwd: str(raw.cwd),
    termProgram: str(raw.term_program),
    pid: num(raw.pid),
    startedAt: num(raw.startedAt),
    ts,
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Watches the daisy-statusbar state directory. It reads only, and it writes
 * nothing. `fs.watch` drops events on some file systems, so a 5 second poll
 * acts as a backstop.
 */
export class ClaudeSource extends EventEmitter {
  private sessions: Session[] = []
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private lastKey = ''
  private debounce: NodeJS.Timeout | null = null

  constructor(
    private readonly dir: string = paths.claudeStateDir,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super()
  }

  directoryExists(): boolean {
    return existsSync(this.dir)
  }

  async start(): Promise<void> {
    if (!this.directoryExists()) {
      log.once(
        'no-state-dir',
        `session state directory absent: ${this.dir}. The Claude page shows no sessions.`,
      )
    }
    await this.refresh()
    this.attachWatcher()
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  private attachWatcher(): void {
    if (!this.directoryExists()) return
    try {
      this.watcher = watch(this.dir, () => this.scheduleRefresh())
    } catch (e) {
      log.once('watch-failed', `fs.watch failed, polling only: ${String(e)}`)
    }
  }

  /** Coalesces a burst of events, because a rename fires more than once. */
  private scheduleRefresh(): void {
    if (this.debounce) return
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.refresh()
    }, 60)
  }

  /** Re-reads the directory. Emits `change` only when the result differs. */
  async refresh(): Promise<void> {
    const next = this.read()
    const key = next.map((s) => `${s.sessionId}:${s.state}:${s.ts}:${s.tool}`).join('|')
    if (key === this.lastKey) return
    this.lastKey = key
    this.sessions = next
    this.emit('change')
  }

  private read(): Session[] {
    if (!this.directoryExists()) return []
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch (e) {
      log.once('readdir', `cannot read ${this.dir}: ${String(e)}`)
      return []
    }
    const now = this.now()
    const out: Session[] = []
    for (const name of names) {
      // update.js writes `<id>.json.<pid>.tmp` and renames it. Skip the temps.
      if (!name.endsWith('.json')) continue
      let text: string
      try {
        text = readFileSync(join(this.dir, name), 'utf8')
      } catch {
        continue
      }
      const s = parseSessionFile(text, now)
      if (s) out.push(s)
    }
    return out.sort((a, b) => b.ts - a.ts)
  }

  getSessions(): Session[] {
    return this.sessions
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.watcher?.close()
    this.timer = null
    this.debounce = null
    this.watcher = null
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/sources/claude.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Confirm the source reads your real sessions**

Run:
```bash
npx tsx --version >/dev/null 2>&1 || npm i -D tsx
npx tsx -e "
import { ClaudeSource } from './src/sources/claude.js'
const s = new ClaudeSource()
await s.start()
console.log(JSON.stringify(s.getSessions(), null, 2))
await s.stop()
"
```
Expected: it prints at least one session, and that session is this one. Confirm `project`, `state`, `pid`, and `termProgram` hold real values.

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 67 tests. The typecheck prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/sources/claude.ts tests/sources/claude.test.ts package.json package-lock.json
git commit -m "feat: read live Claude session state"
```

---

### Task 7: The usage source and the statusline wrapper

**Files:**
- Create: `src/sources/usage.ts`, `src/install/statusline-wrapper.sh`
- Test: `tests/sources/usage.test.ts`, `tests/install/statusline-wrapper.test.ts`

**Interfaces:**
- Consumes: `paths`, `log` from Task 1.
- Produces:
  - `interface UsageSnapshot` with `fiveHourPct`, `fiveHourResetsAt`, `sevenDayPct`, `sevenDayResetsAt`, `ts`.
  - `interface SessionMeta` with `model`, `ctxPct`, `costUsd`, `ts`.
  - `class UsageSource` with `start()`, `stop()`, `getUsage(): UsageSnapshot | null`, `isStale(): boolean`, `getMeta(sessionId): SessionMeta | null`, `on('change', cb)`.
  - `computePace(usedPct, resetsAt, windowSeconds, now): Pace` where `Pace` is `'fast' | 'slow' | 'even'`.
  - `STALE_USAGE_SECONDS = 900`.

The wrapper is a shell script, because Claude Code runs the statusline command as a shell command. It must pass stdin through unchanged.

- [ ] **Step 1: Write the failing test for pace and parsing**

Create `tests/sources/usage.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UsageSource,
  computePace,
  parseUsage,
  STALE_USAGE_SECONDS,
} from '../../src/sources/usage.js'

const FIVE_HOURS = 5 * 3600
const NOW = 1786549560

describe('computePace', () => {
  it('is fast when usage leads elapsed time', () => {
    // Half the window is gone, so elapsed is 50 percent. Usage is 80 percent.
    const resetsAt = NOW + FIVE_HOURS / 2
    expect(computePace(80, resetsAt, FIVE_HOURS, NOW)).toBe('fast')
  })

  it('is slow when usage trails elapsed time', () => {
    const resetsAt = NOW + FIVE_HOURS / 2
    expect(computePace(20, resetsAt, FIVE_HOURS, NOW)).toBe('slow')
  })

  it('is even inside the 5 point band', () => {
    const resetsAt = NOW + FIVE_HOURS / 2
    expect(computePace(52, resetsAt, FIVE_HOURS, NOW)).toBe('even')
    expect(computePace(48, resetsAt, FIVE_HOURS, NOW)).toBe('even')
  })

  it('is even when resetsAt is missing', () => {
    expect(computePace(50, 0, FIVE_HOURS, NOW)).toBe('even')
  })

  it('is even at the very start of a window', () => {
    expect(computePace(0, NOW + FIVE_HOURS, FIVE_HOURS, NOW)).toBe('even')
  })
})

describe('parseUsage', () => {
  it('reads the four rate limit fields', () => {
    const u = parseUsage(JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 62.4, resets_at: NOW + 7860 },
        seven_day: { used_percentage: 34, resets_at: NOW + 345600 },
      },
      ts: NOW,
    }))!
    expect(u.fiveHourPct).toBe(62.4)
    expect(u.fiveHourResetsAt).toBe(NOW + 7860)
    expect(u.sevenDayPct).toBe(34)
    expect(u.ts).toBe(NOW)
  })

  it('returns null percentages when the fields are absent', () => {
    const u = parseUsage(JSON.stringify({ rate_limits: {}, ts: NOW }))!
    expect(u.fiveHourPct).toBeNull()
    expect(u.sevenDayPct).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseUsage('{ nope')).toBeNull()
  })
})

describe('UsageSource', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-usage-'))
    mkdirSync(join(dir, 'sessions'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (obj: unknown) =>
    writeFileSync(join(dir, 'usage.json'), JSON.stringify(obj))

  it('returns null when the usage file is absent', async () => {
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.getUsage()).toBeNull()
    await s.stop()
  })

  it('reads a fresh usage file', async () => {
    write({
      rate_limits: {
        five_hour: { used_percentage: 62, resets_at: NOW + 100 },
        seven_day: { used_percentage: 34, resets_at: NOW + 200 },
      },
      ts: NOW,
    })
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.getUsage()!.fiveHourPct).toBe(62)
    expect(s.isStale()).toBe(false)
    await s.stop()
  })

  it('reports stale past the limit', async () => {
    write({ rate_limits: {}, ts: NOW - STALE_USAGE_SECONDS - 1 })
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.isStale()).toBe(true)
    await s.stop()
  })

  it('is not stale exactly at the limit', async () => {
    write({ rate_limits: {}, ts: NOW - STALE_USAGE_SECONDS })
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.isStale()).toBe(false)
    await s.stop()
  })

  it('reads a per-session model name', async () => {
    writeFileSync(
      join(dir, 'sessions', 'aaaa.json'),
      JSON.stringify({ model: 'Opus 5', ctxPct: 41, costUsd: 1.23, ts: NOW }),
    )
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.getMeta('aaaa')!.model).toBe('Opus 5')
    await s.stop()
  })

  it('returns null meta for an unknown session', async () => {
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.getMeta('nope')).toBeNull()
    await s.stop()
  })

  it('ignores a corrupt per-session file', async () => {
    writeFileSync(join(dir, 'sessions', 'bad.json'), '{ truncated')
    const s = new UsageSource(dir, () => NOW)
    await s.start()
    expect(s.getMeta('bad')).toBeNull()
    await s.stop()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/sources/usage.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 3: Write `src/sources/usage.ts`**

```ts
import { EventEmitter } from 'node:events'
import { readFileSync, existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../paths.js'
import { log } from '../log.js'

export const STALE_USAGE_SECONDS = 900
const POLL_MS = 10000
const PACE_BAND = 5

export type Pace = 'fast' | 'slow' | 'even'

export interface UsageSnapshot {
  fiveHourPct: number | null
  fiveHourResetsAt: number
  sevenDayPct: number | null
  sevenDayResetsAt: number
  ts: number
}

export interface SessionMeta {
  model: string
  ctxPct: number | null
  costUsd: number | null
  ts: number
}

/**
 * Compares usage against elapsed window time. `fast` means usage leads the
 * clock. A missing `resetsAt` gives `even`, because elapsed time is unknown.
 */
export function computePace(
  usedPct: number,
  resetsAt: number,
  windowSeconds: number,
  now: number,
): Pace {
  if (!resetsAt || windowSeconds <= 0) return 'even'
  const remaining = resetsAt - now
  const elapsed = windowSeconds - remaining
  if (elapsed <= 0) return 'even'
  const elapsedPct = (elapsed / windowSeconds) * 100
  const delta = usedPct - elapsedPct
  if (delta > PACE_BAND) return 'fast'
  if (delta < -PACE_BAND) return 'slow'
  return 'even'
}

export function parseUsage(json: string): UsageSnapshot | null {
  let raw: Record<string, any>
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const rl = raw.rate_limits ?? {}
  return {
    fiveHourPct: pct(rl.five_hour?.used_percentage),
    fiveHourResetsAt: num(rl.five_hour?.resets_at),
    sevenDayPct: pct(rl.seven_day?.used_percentage),
    sevenDayResetsAt: num(rl.seven_day?.resets_at),
    ts: num(raw.ts),
  }
}

function pct(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Reads the cache that the statusline wrapper writes. The daemon cannot read
 * rate limits directly, because Claude Code sends them to the statusline
 * command on stdin.
 */
export class UsageSource extends EventEmitter {
  private usage: UsageSnapshot | null = null
  private meta = new Map<string, SessionMeta>()
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private lastKey = ''

  constructor(
    private readonly stateDir: string = paths.stateDir,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super()
  }

  private get usageFile(): string {
    return join(this.stateDir, 'usage.json')
  }

  private get sessionsDir(): string {
    return join(this.stateDir, 'sessions')
  }

  async start(): Promise<void> {
    await this.refresh()
    try {
      if (existsSync(this.stateDir)) {
        this.watcher = watch(this.stateDir, () => void this.refresh())
      }
    } catch {
      // Polling covers it.
    }
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  async refresh(): Promise<void> {
    const next = this.readUsage()
    this.readMeta()
    const key = JSON.stringify(next)
    if (key === this.lastKey) return
    this.lastKey = key
    this.usage = next
    this.emit('change')
  }

  private readUsage(): UsageSnapshot | null {
    if (!existsSync(this.usageFile)) return null
    try {
      return parseUsage(readFileSync(this.usageFile, 'utf8'))
    } catch {
      return null
    }
  }

  private readMeta(): void {
    if (!existsSync(this.sessionsDir)) return
    let names: string[]
    try {
      const { readdirSync } = require('node:fs') as typeof import('node:fs')
      names = readdirSync(this.sessionsDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      try {
        const raw = JSON.parse(readFileSync(join(this.sessionsDir, name), 'utf8'))
        this.meta.set(id, {
          model: typeof raw.model === 'string' ? raw.model : '',
          ctxPct: pct(raw.ctxPct),
          costUsd: pct(raw.costUsd),
          ts: num(raw.ts),
        })
      } catch {
        // Skip a corrupt file. The model line simply does not appear.
      }
    }
  }

  getUsage(): UsageSnapshot | null {
    return this.usage
  }

  /** True when the newest usage value is older than 15 minutes. */
  isStale(): boolean {
    if (!this.usage) return true
    return this.now() - this.usage.ts > STALE_USAGE_SECONDS
  }

  getMeta(sessionId: string): SessionMeta | null {
    return this.meta.get(sessionId) ?? null
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.watcher?.close()
    this.timer = null
    this.watcher = null
  }
}
```

- [ ] **Step 4: Replace the `require` in `readMeta` with a static import**

The project is ESM only. Add `readdirSync` to the top import and delete the inline `require`:

```ts
import { readFileSync, readdirSync, existsSync, watch, type FSWatcher } from 'node:fs'
```

```ts
    let names: string[]
    try {
      names = readdirSync(this.sessionsDir)
    } catch {
      return
    }
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/sources/usage.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Write the failing test for the wrapper script**

The wrapper is the one piece that touches something the user already relies on. Its stdin pass-through needs a real test.

Create `tests/install/statusline-wrapper.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WRAPPER = join(process.cwd(), 'src/install/statusline-wrapper.sh')

const PAYLOAD = JSON.stringify({
  session_id: 'aaaa-bbbb',
  model: { display_name: 'Opus 5' },
  context_window: { used_percentage: 41.2 },
  cost: { total_cost_usd: 1.23 },
  rate_limits: {
    five_hour: { used_percentage: 62, resets_at: 1786557420 },
    seven_day: { used_percentage: 34, resets_at: 1786895160 },
  },
  workspace: { project_dir: '/Users/you/Vibecoding/streamdeckneoclaude' },
})

describe('statusline-wrapper.sh', () => {
  let dir: string
  let inner: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deckd-wrap-'))
    inner = join(dir, 'inner.sh')
    // The inner script proves stdin passes through unchanged.
    writeFileSync(inner, '#!/bin/sh\ncat > "$1"\necho "INNER OUTPUT"\n')
    chmodSync(inner, 0o755)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const run = () =>
    execFileSync('/bin/sh', [WRAPPER], {
      input: PAYLOAD,
      env: {
        ...process.env,
        DECKD_STATE_DIR: dir,
        DECKD_INNER: `${inner} ${join(dir, 'seen.json')}`,
      },
      encoding: 'utf8',
    })

  it('prints the inner statusline output unchanged', () => {
    expect(run()).toContain('INNER OUTPUT')
  })

  it('passes stdin to the inner command byte for byte', () => {
    run()
    expect(readFileSync(join(dir, 'seen.json'), 'utf8')).toBe(PAYLOAD)
  })

  it('writes usage.json with the rate limits and a timestamp', () => {
    run()
    const u = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'))
    expect(u.rate_limits.five_hour.used_percentage).toBe(62)
    expect(u.rate_limits.seven_day.resets_at).toBe(1786895160)
    expect(typeof u.ts).toBe('number')
    expect(u.ts).toBeGreaterThan(1700000000)
  })

  it('writes a per-session file keyed by session_id', () => {
    run()
    const f = join(dir, 'sessions', 'aaaa-bbbb.json')
    expect(existsSync(f)).toBe(true)
    const m = JSON.parse(readFileSync(f, 'utf8'))
    expect(m.model).toBe('Opus 5')
    expect(m.ctxPct).toBe(41.2)
    expect(m.costUsd).toBe(1.23)
  })

  it('still writes usage.json when session_id is absent', () => {
    execFileSync('/bin/sh', [WRAPPER], {
      input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } } }),
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: `${inner} ${join(dir, 'seen.json')}` },
      encoding: 'utf8',
    })
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
  })

  it('prints the inner output even when the payload is not JSON', () => {
    const out = execFileSync('/bin/sh', [WRAPPER], {
      input: 'not json at all',
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: `${inner} ${join(dir, 'seen.json')}` },
      encoding: 'utf8',
    })
    expect(out).toContain('INNER OUTPUT')
  })

  it('prints nothing extra when no inner command is set', () => {
    const out = execFileSync('/bin/sh', [WRAPPER], {
      input: PAYLOAD,
      env: { ...process.env, DECKD_STATE_DIR: dir, DECKD_INNER: '' },
      encoding: 'utf8',
    })
    expect(out.trim()).toBe('')
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
  })
})
```

- [ ] **Step 7: Run the test and confirm it fails**

Run: `npx vitest run tests/install/statusline-wrapper.test.ts`
Expected: FAIL. The wrapper script does not exist.

- [ ] **Step 8: Write `src/install/statusline-wrapper.sh`**

Two rules govern this script. It must never break the terminal statusline, and it must never lose stdin. So it reads stdin once into a variable, writes the cache, and then feeds the same bytes to the real command.

```sh
#!/bin/sh
# deckd statusline wrapper.
#
# Claude Code sends the statusline payload on stdin. It contains rate_limits,
# which no file on disk holds. This script saves the fields the Stream Deck
# needs, and then runs the real statusline command with the same stdin.
#
# The install command sets DECKD_INNER to the original statusLine command.
# It sets DECKD_STATE_DIR only in tests. The default is the real state dir.
#
# This script must never fail in a way that hides the statusline. Every cache
# step tolerates an error, and the inner command always runs.

set -u

STATE_DIR="${DECKD_STATE_DIR:-$HOME/.local/state/deckd}"
INNER="${DECKD_INNER:-}"

# Read all of stdin once. The inner command needs the same bytes.
PAYLOAD=$(cat)

if command -v jq >/dev/null 2>&1; then
  mkdir -p "$STATE_DIR/sessions" 2>/dev/null || true
  NOW=$(date +%s)

  # usage.json holds the newest rate limits. The gauge keys read it.
  printf '%s' "$PAYLOAD" | jq -c --argjson ts "$NOW" \
    '{rate_limits: (.rate_limits // {}), ts: $ts}' \
    > "$STATE_DIR/usage.json.tmp" 2>/dev/null \
    && mv "$STATE_DIR/usage.json.tmp" "$STATE_DIR/usage.json" 2>/dev/null || true

  # The per-session file carries the model name. state.d does not have it.
  SID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)
  if [ -n "$SID" ]; then
    printf '%s' "$PAYLOAD" | jq -c --argjson ts "$NOW" \
      '{model: (.model.display_name // ""),
        ctxPct: (.context_window.used_percentage // null),
        costUsd: (.cost.total_cost_usd // null),
        ts: $ts}' \
      > "$STATE_DIR/sessions/$SID.json.tmp" 2>/dev/null \
      && mv "$STATE_DIR/sessions/$SID.json.tmp" "$STATE_DIR/sessions/$SID.json" 2>/dev/null || true
  fi
fi

# Run the real statusline with the original stdin. Its output is the only
# output this script produces.
if [ -n "$INNER" ]; then
  printf '%s' "$PAYLOAD" | sh -c "$INNER"
fi
```

- [ ] **Step 9: Run the test and confirm it passes**

Run: `npx vitest run tests/install/statusline-wrapper.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 10: Settle the session id field against a real payload**

The spec flags this as the one unverified fact. Settle it now.

Run this, then look at your terminal statusline once so Claude Code renders it:
```bash
mkdir -p /tmp/deckd-probe
DECKD_STATE_DIR=/tmp/deckd-probe DECKD_INNER="$HOME/.claude/statusline.sh" \
  sh src/install/statusline-wrapper.sh < /dev/null
ls -la /tmp/deckd-probe /tmp/deckd-probe/sessions 2>/dev/null
```

Then capture one real payload:
```bash
cp ~/.claude/settings.json /tmp/settings.backup.json
node -e "
const fs=require('fs');const p=process.env.HOME+'/.claude/settings.json';
const s=JSON.parse(fs.readFileSync(p,'utf8'));
console.log('current statusLine:', JSON.stringify(s.statusLine));
"
```
Set the statusline to `tee /tmp/deckd-payload.json | ~/.claude/statusline.sh` by hand for one render, read the file, then restore `settings.json` from the backup.

Expected: `/tmp/deckd-payload.json` holds a `session_id` key at the top level. If the real key differs, correct the `jq` filter in the wrapper and the test payload. If no such key exists, leave the wrapper as it is. It already skips the per-session file, and the session keys omit the model line.

Record the finding in a comment at the top of the wrapper.

- [ ] **Step 11: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 89 tests. The typecheck prints nothing.

- [ ] **Step 12: Commit**

```bash
git add src/sources/usage.ts src/install/statusline-wrapper.sh tests/sources/usage.test.ts tests/install/statusline-wrapper.test.ts
git commit -m "feat: cache rate limit usage from the statusline payload"
```

---

### Task 8: The key assigner

**Files:**
- Create: `src/pages/key-assigner.ts`
- Test: `tests/pages/key-assigner.test.ts`

**Interfaces:**
- Consumes: `Session` from Task 6.
- Produces:
  - `class KeyAssigner` with `assign(sessions: Session[]): Assignment`.
  - `interface Assignment` with `slots: (string | null)[]` of length 4, and `overflow: number`.
  - `SESSION_SLOTS = 4`.

This is the spec's section 7.1, and it is the one piece of real logic on the Claude page. One algorithm covers the first call and every later call. A session holds its key, because a moving key defeats a glance.

- [ ] **Step 1: Write the failing test**

Create `tests/pages/key-assigner.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { KeyAssigner, SESSION_SLOTS } from '../../src/pages/key-assigner.js'
import type { Session } from '../../src/sources/claude.js'

function s(id: string, ts: number): Session {
  return {
    sessionId: id, state: 'idle', label: '', tool: '', project: id,
    cwd: '', termProgram: 'ghostty', pid: 1, startedAt: 0, ts,
  }
}

describe('KeyAssigner', () => {
  it('has four slots', () => {
    expect(SESSION_SLOTS).toBe(4)
  })

  it('fills slots by ts, newest first, on the first call', () => {
    const a = new KeyAssigner()
    const r = a.assign([s('old', 100), s('new', 300), s('mid', 200)])
    expect(r.slots).toEqual(['new', 'mid', 'old', null])
    expect(r.overflow).toBe(0)
  })

  it('keeps a session on its slot when its ts changes', () => {
    const a = new KeyAssigner()
    a.assign([s('x', 100), s('y', 200)])
    // y sorted first, so y is slot 0 and x is slot 1.
    const r = a.assign([s('x', 999), s('y', 200)])
    expect(r.slots).toEqual(['y', 'x', null, null])
  })

  it('gives a new session the lowest free slot', () => {
    const a = new KeyAssigner()
    a.assign([s('a', 300), s('b', 200), s('c', 100)])
    expect(a.assign([s('a', 300), s('b', 200), s('c', 100), s('d', 400)]).slots)
      .toEqual(['a', 'b', 'c', 'd'])
  })

  it('frees a slot when its session goes away', () => {
    const a = new KeyAssigner()
    a.assign([s('a', 300), s('b', 200)])
    expect(a.assign([s('b', 200)]).slots).toEqual([null, 'b', null, null])
  })

  it('reuses a freed slot for the next new session', () => {
    const a = new KeyAssigner()
    a.assign([s('a', 300), s('b', 200)])
    a.assign([s('b', 200)])
    expect(a.assign([s('b', 200), s('c', 400)]).slots)
      .toEqual(['c', 'b', null, null])
  })

  it('reports overflow past four sessions', () => {
    const a = new KeyAssigner()
    const r = a.assign([s('a', 600), s('b', 500), s('c', 400), s('d', 300), s('e', 200), s('f', 100)])
    expect(r.slots).toEqual(['a', 'b', 'c', 'd'])
    expect(r.overflow).toBe(2)
  })

  it('gives a freed slot to the waiting session with the newest ts', () => {
    const a = new KeyAssigner()
    const six = [s('a', 600), s('b', 500), s('c', 400), s('d', 300), s('e', 200), s('f', 100)]
    a.assign(six)
    // Drop 'b'. 'e' has a newer ts than 'f', so 'e' claims slot 1.
    const r = a.assign([s('a', 600), s('c', 400), s('d', 300), s('e', 200), s('f', 100)])
    expect(r.slots).toEqual(['a', 'e', 'c', 'd'])
    expect(r.overflow).toBe(1)
  })

  it('returns all nulls for no sessions', () => {
    const a = new KeyAssigner()
    expect(a.assign([]).slots).toEqual([null, null, null, null])
  })

  it('empties every slot after every session ends', () => {
    const a = new KeyAssigner()
    a.assign([s('a', 100), s('b', 200)])
    expect(a.assign([]).slots).toEqual([null, null, null, null])
  })

  it('is stable across repeated identical calls', () => {
    const a = new KeyAssigner()
    const list = [s('a', 300), s('b', 200)]
    const first = a.assign(list)
    expect(a.assign(list).slots).toEqual(first.slots)
    expect(a.assign(list).slots).toEqual(first.slots)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/pages/key-assigner.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 3: Write `src/pages/key-assigner.ts`**

```ts
import type { Session } from '../sources/claude.js'

export const SESSION_SLOTS = 4

export interface Assignment {
  /** Session id per key, index 0 to 3. `null` means the key is free. */
  slots: (string | null)[]
  /** Live sessions that got no key. */
  overflow: number
}

/**
 * Holds a session on its key. The deck must not reshuffle while the user reads
 * it, so a live session never moves. One algorithm covers the first call and
 * every later call:
 *
 *   1. Free a slot when its session is gone.
 *   2. Collect the sessions with no slot, newest `ts` first.
 *   3. Give each one the lowest free slot.
 *
 * On the first call every slot is free, so step 3 fills by `ts` order. That is
 * the spec's start rule, with no special case.
 */
export class KeyAssigner {
  private slots: (string | null)[] = new Array(SESSION_SLOTS).fill(null)

  assign(sessions: Session[]): Assignment {
    const live = new Set(sessions.map((s) => s.sessionId))

    for (let i = 0; i < SESSION_SLOTS; i++) {
      const id = this.slots[i]
      if (id !== null && !live.has(id)) this.slots[i] = null
    }

    const held = new Set(this.slots.filter((v): v is string => v !== null))
    const waiting = sessions
      .filter((s) => !held.has(s.sessionId))
      .sort((a, b) => b.ts - a.ts)

    let placed = 0
    for (const session of waiting) {
      const free = this.slots.indexOf(null)
      if (free === -1) break
      this.slots[free] = session.sessionId
      placed += 1
    }

    return { slots: [...this.slots], overflow: waiting.length - placed }
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/pages/key-assigner.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 100 tests. The typecheck prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/pages/key-assigner.ts tests/pages/key-assigner.test.ts
git commit -m "feat: hold a Claude session on its key"
```

---

**Tasks 9 to 15 continue in part 2 of this plan.** See
`docs/superpowers/plans/2026-08-12-streamdeck-neo-claude-deck-part2.md`.
