# Stream Deck Neo Claude Deck Implementation Plan — Part 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Part 1:** `docs/superpowers/plans/2026-08-12-streamdeck-neo-claude-deck.md` holds the header, the global constraints, the file structure, and Tasks 1 to 8. Read its **Global Constraints** section first. Every task here inherits it.

**This part covers Tasks 9 to 15.**

| Task | Deliverable |
| --- | --- |
| 9 | Focus a terminal window |
| 10 | The Claude page |
| 11 | The daemon and the CLI — **milestone 2, a live deck** |
| 12 | Spotify OAuth |
| 13 | The Spotify source |
| 14 | The Spotify page — **milestone 3** |
| 15 | Install, uninstall, and launchd |

---

### Task 9: Focus a terminal window

**Files:**
- Create: `src/focus-window.ts`
- Test: `tests/focus-window.test.ts`

**Interfaces:**
- Consumes: `log` from Task 1.
- Produces:
  - `focusWindow(pid: number, termProgram: string): Promise<boolean>` — true on success.
  - `terminalAppName(termProgram: string): string | null`.
  - `buildFocusScript(app: string): string`.
  - `findTerminalPid(pid: number, readParent: (pid: number) => number | null): number`.

The `pid` in the state file is the hook process parent, not the terminal. So the code walks up the process tree to find a process the terminal owns. The walk has a depth cap, because a broken tree must not loop.

- [ ] **Step 1: Write the failing test**

The AppleScript itself needs a real desktop, so the test covers the pure parts: the app name map, the script text, and the process walk.

Create `tests/focus-window.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  terminalAppName,
  buildFocusScript,
  findTerminalPid,
  MAX_WALK,
} from '../src/focus-window.js'

describe('terminalAppName', () => {
  it('maps ghostty', () => {
    expect(terminalAppName('ghostty')).toBe('Ghostty')
  })

  it('is case insensitive', () => {
    expect(terminalAppName('Ghostty')).toBe('Ghostty')
    expect(terminalAppName('GHOSTTY')).toBe('Ghostty')
  })

  it('maps the other common terminals', () => {
    expect(terminalAppName('iTerm.app')).toBe('iTerm2')
    expect(terminalAppName('Apple_Terminal')).toBe('Terminal')
    expect(terminalAppName('WezTerm')).toBe('WezTerm')
    expect(terminalAppName('vscode')).toBe('Code')
  })

  it('returns null for an unknown terminal', () => {
    expect(terminalAppName('some-new-term')).toBeNull()
  })

  it('returns null for an empty value', () => {
    expect(terminalAppName('')).toBeNull()
  })
})

describe('buildFocusScript', () => {
  it('activates the named application', () => {
    const s = buildFocusScript('Ghostty')
    expect(s).toContain('Ghostty')
    expect(s).toContain('activate')
  })

  it('quotes the app name, so a space cannot break the script', () => {
    expect(buildFocusScript('Visual Studio Code')).toContain('"Visual Studio Code"')
  })

  it('refuses a name with a quote in it', () => {
    expect(() => buildFocusScript('bad"name')).toThrow(/name/i)
  })
})

describe('findTerminalPid', () => {
  it('returns the pid when it has no parent', () => {
    expect(findTerminalPid(100, () => null)).toBe(100)
  })

  it('walks up to the top of the tree', () => {
    // 100 -> 50 -> 1. The walk stops at 1, because 1 is launchd.
    const parents = new Map([[100, 50], [50, 1]])
    expect(findTerminalPid(100, (p) => parents.get(p) ?? null)).toBe(50)
  })

  it('stops at the depth cap on a cyclic tree', () => {
    // A cycle must not loop for ever.
    expect(findTerminalPid(2, () => 2)).toBe(2)
  })

  it('has a depth cap above 1', () => {
    expect(MAX_WALK).toBeGreaterThan(1)
  })

  it('returns the pid unchanged when it is already 1', () => {
    expect(findTerminalPid(1, () => null)).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/focus-window.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 3: Write `src/focus-window.ts`**

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from './log.js'

const run = promisify(execFile)

/** Depth cap for the process walk. A broken tree must not loop. */
export const MAX_WALK = 12

const APPS: Record<string, string> = {
  ghostty: 'Ghostty',
  'iterm.app': 'iTerm2',
  iterm2: 'iTerm2',
  apple_terminal: 'Terminal',
  terminal: 'Terminal',
  wezterm: 'WezTerm',
  alacritty: 'Alacritty',
  kitty: 'kitty',
  vscode: 'Code',
  hyper: 'Hyper',
  warpterminal: 'Warp',
  tmux: 'Terminal',
}

/** Maps a `TERM_PROGRAM` value to a macOS application name. */
export function terminalAppName(termProgram: string): string | null {
  if (!termProgram) return null
  return APPS[termProgram.toLowerCase()] ?? null
}

/**
 * Builds the AppleScript that raises an application. It refuses a name with a
 * double quote, because that would let the name escape the string literal.
 */
export function buildFocusScript(app: string): string {
  if (app.includes('"') || app.includes('\\')) {
    throw new Error(`application name contains a quote: ${app}`)
  }
  return `tell application "${app}" to activate`
}

/**
 * Walks up the process tree from `pid`. It stops below `launchd`, which is pid
 * 1, and it stops at the depth cap.
 */
export function findTerminalPid(
  pid: number,
  readParent: (pid: number) => number | null,
): number {
  let current = pid
  for (let i = 0; i < MAX_WALK; i++) {
    const parent = readParent(current)
    if (parent === null || parent <= 1) return current
    if (parent === current) return current
    current = parent
  }
  return current
}

/** Reads a parent pid with `ps`. Returns null when the process is gone. */
export async function readParentPid(pid: number): Promise<number | null> {
  try {
    const { stdout } = await run('/bin/ps', ['-o', 'ppid=', '-p', String(pid)])
    const n = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * Raises the terminal window of a session. It returns false on any failure, and
 * the caller flashes the key red. A failure is never fatal.
 */
export async function focusWindow(pid: number, termProgram: string): Promise<boolean> {
  const app = terminalAppName(termProgram)
  if (!app) {
    log.once(`term-${termProgram}`, `no window focus rule for terminal "${termProgram}"`)
    return false
  }
  try {
    await run('/usr/bin/osascript', ['-e', buildFocusScript(app)])
    return true
  } catch (e) {
    log.warn(`window focus failed for ${app} pid ${pid}: ${String(e)}`)
    return false
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/focus-window.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Confirm focus works on the real desktop**

Switch to another application, then run:
```bash
npx tsx -e "
import { focusWindow } from './src/focus-window.js'
console.log('focused:', await focusWindow(process.pid, 'ghostty'))
"
```
Expected: Ghostty comes to the front, and the command prints `focused: true`.

macOS may show an automation permission prompt on the first run. Approve it. Without approval `osascript` fails, and the function returns false. Note this in the README in Task 15.

- [ ] **Step 6: Commit**

```bash
git add src/focus-window.ts tests/focus-window.test.ts
git commit -m "feat: focus a session terminal window"
```

---

### Task 10: The Claude page

**Files:**
- Create: `src/pages/types.ts`, `src/pages/claude-page.ts`
- Test: `tests/pages/claude-page.test.ts`

**Interfaces:**
- Consumes: `KeySpec`, `StripSpec`, `DeckFrame`, `blankKey` from Task 2. `theme`, `stateColor`, `stateLabel`, `barColor` from Task 2. `truncate`, `formatDuration` from Task 2. `Session`, `ClaudeSource` from Task 6. `UsageSource`, `computePace` from Task 7. `KeyAssigner` from Task 8. `focusWindow` from Task 9.
- Produces:
  - `interface Page` with `name: string`, `render(now: number): DeckFrame`, `onKeyPress(index: number): void | Promise<void>`, `onEnter?(): void`, `onLeave?(): void`.
  - `class ClaudePage implements Page`.
  - `PROJECT_CHARS = 10`.

The page is a pure function of source state plus the clock. It returns a description. It never touches canvas or HID, so every test here needs no hardware.

- [ ] **Step 1: Write `src/pages/types.ts`**

```ts
import type { DeckFrame } from '../render/specs.js'

export interface Page {
  /** Shown on the strip when no better text exists. */
  readonly name: string
  /** Describes the whole deck. `now` is unix seconds. */
  render(now: number): DeckFrame
  /** Handles a press on key 0 to 7. */
  onKeyPress(index: number): void | Promise<void>
  /** Called when the page becomes visible. */
  onEnter?(): void
  /** Called when the page stops being visible. */
  onLeave?(): void
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/pages/claude-page.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { ClaudePage } from '../../src/pages/claude-page.js'
import { theme } from '../../src/render/theme.js'
import type { Session } from '../../src/sources/claude.js'
import type { UsageSnapshot, SessionMeta } from '../../src/sources/usage.js'

const NOW = 1786549560
const FIVE_HOURS = 5 * 3600

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 'aaaa', state: 'tool', label: 'Running command', tool: 'Bash',
    project: 'streamdeckneoclaude', cwd: '/x', termProgram: 'ghostty',
    pid: 4242, startedAt: NOW - 840, ts: NOW, ...over,
  }
}

interface Fakes {
  sessions: Session[]
  usage: UsageSnapshot | null
  stale: boolean
  meta: Map<string, SessionMeta>
  focused: { pid: number; term: string }[]
}

function build(over: Partial<Fakes> = {}) {
  const f: Fakes = {
    sessions: [], usage: null, stale: false,
    meta: new Map(), focused: [], ...over,
  }
  const page = new ClaudePage(
    { getSessions: () => f.sessions, directoryExists: () => true },
    { getUsage: () => f.usage, isStale: () => f.stale, getMeta: (id) => f.meta.get(id) ?? null },
    async (pid, term) => { f.focused.push({ pid, term }); return true },
  )
  return { page, f }
}

function freshUsage(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    fiveHourPct: 62, fiveHourResetsAt: NOW + FIVE_HOURS / 2,
    sevenDayPct: 34, sevenDayResetsAt: NOW + 345600, ts: NOW, ...over,
  }
}

describe('ClaudePage layout', () => {
  it('returns exactly 8 keys and two button colours', () => {
    const { page } = build()
    const frame = page.render(NOW)
    expect(frame.keys).toHaveLength(8)
    expect(frame.buttons).toHaveLength(2)
  })

  it('renders a blank key for an unused session slot', () => {
    const { page } = build()
    expect(page.render(NOW).keys[0]!.kind).toBe('blank')
  })

  it('puts the state label and the project on a session key', () => {
    const { page } = build({ sessions: [session()] })
    const key = page.render(NOW).keys[0]!
    expect(key.kind).toBe('session')
    expect(key.lines![0]).toBe('TOOL')
    expect(key.lines![1]).toBe('streamdec…')
  })

  it('truncates a long project name to 10 characters', () => {
    const { page } = build({ sessions: [session({ project: 'regulatory-compliance-agent' })] })
    expect(page.render(NOW).keys[0]!.lines![1]).toHaveLength(10)
  })

  it('leaves a short project name alone', () => {
    const { page } = build({ sessions: [session({ project: 'SNOOP' })] })
    expect(page.render(NOW).keys[0]!.lines![1]).toBe('SNOOP')
  })

  it('shows the model name from the usage cache', () => {
    const meta = new Map([['aaaa', { model: 'Opus 5', ctxPct: 41, costUsd: 1, ts: NOW }]])
    const { page } = build({ sessions: [session()], meta })
    expect(page.render(NOW).keys[0]!.lines).toContain('Opus 5')
  })

  it('omits the model line when the cache has no entry', () => {
    const { page } = build({ sessions: [session()] })
    expect(page.render(NOW).keys[0]!.lines).not.toContain('Opus 5')
  })

  it('colours the border by state', () => {
    const { page } = build({ sessions: [session({ state: 'thinking' })] })
    expect(page.render(NOW).keys[0]!.border).toEqual(theme.blue)
  })

  it('marks a permission key so it pulses', () => {
    const { page } = build({ sessions: [session({ state: 'permission' })] })
    const a = page.render(NOW).keys[0]!
    const b = page.render(NOW + 1).keys[0]!
    expect(a.border).toEqual(theme.amber)
    expect(a.pulseOn).not.toBe(b.pulseOn)
  })

  it('does not pulse a non-permission key', () => {
    const { page } = build({ sessions: [session({ state: 'tool' })] })
    const a = page.render(NOW).keys[0]!
    const b = page.render(NOW + 1).keys[0]!
    expect(a.pulseOn).toBe(b.pulseOn)
  })
})

describe('ClaudePage gauges', () => {
  it('shows the 5 hour and 7 day percentages', () => {
    const { page } = build({ usage: freshUsage() })
    const keys = page.render(NOW).keys
    expect(keys[4]!.lines!.join(' ')).toContain('62%')
    expect(keys[5]!.lines!.join(' ')).toContain('34%')
  })

  it('fills the gauge bars to the percentage', () => {
    const { page } = build({ usage: freshUsage() })
    expect(page.render(NOW).keys[4]!.bar!.value).toBeCloseTo(0.62, 2)
  })

  it('colours the bar red above 85 percent', () => {
    const { page } = build({ usage: freshUsage({ fiveHourPct: 92 }) })
    expect(page.render(NOW).keys[4]!.bar!.color).toEqual(theme.red)
  })

  it('shows the pace on key 6', () => {
    const { page } = build({ usage: freshUsage({ fiveHourPct: 90 }) })
    expect(page.render(NOW).keys[6]!.lines!.join(' ')).toContain('fast')
  })

  it('shows the reset countdown on key 7', () => {
    const { page } = build({ usage: freshUsage({ fiveHourResetsAt: NOW + 7860 }) })
    expect(page.render(NOW).keys[7]!.lines!.join(' ')).toContain('2h11m')
  })

  it('shows two dashes when no usage file exists', () => {
    const { page } = build({ usage: null })
    expect(page.render(NOW).keys[4]!.lines!.join(' ')).toContain('--')
  })

  it('marks the gauges STALE past the limit', () => {
    const { page } = build({ usage: freshUsage(), stale: true })
    const key = page.render(NOW).keys[4]!
    expect(key.lines!.join(' ')).toContain('STALE')
    expect(key.dim).toBe(true)
  })

  it('does not dim a fresh gauge', () => {
    const { page } = build({ usage: freshUsage() })
    expect(page.render(NOW).keys[4]!.dim).not.toBe(true)
  })
})

describe('ClaudePage strip', () => {
  it('reports no active sessions when the list is empty', () => {
    const { page } = build()
    expect(page.render(NOW).strip.lines.join(' ')).toContain('no active sessions')
  })

  it('shows the project, the tool, and the elapsed time', () => {
    const { page } = build({ sessions: [session({ startedAt: NOW - 840 })] })
    const text = page.render(NOW).strip.lines.join(' ')
    expect(text).toContain('streamdeckneoclaude')
    expect(text).toContain('Bash')
    expect(text).toContain('14m')
  })

  it('shows an overflow count past four sessions', () => {
    const sessions = [1, 2, 3, 4, 5, 6].map((n) =>
      session({ sessionId: `s${n}`, ts: NOW - n }))
    const { page } = build({ sessions })
    expect(page.render(NOW).strip.lines.join(' ')).toContain('+2 more')
  })

  it('omits the overflow count at four sessions', () => {
    const sessions = [1, 2, 3, 4].map((n) => session({ sessionId: `s${n}`, ts: NOW - n }))
    const { page } = build({ sessions })
    expect(page.render(NOW).strip.lines.join(' ')).not.toContain('more')
  })

  it('reports missing session data when the directory is absent', () => {
    const page = new ClaudePage(
      { getSessions: () => [], directoryExists: () => false },
      { getUsage: () => null, isStale: () => true, getMeta: () => null },
      async () => true,
    )
    expect(page.render(NOW).strip.lines.join(' ')).toContain('no session data')
  })
})

describe('ClaudePage presses', () => {
  it('focuses the terminal of the pressed session', async () => {
    const { page, f } = build({ sessions: [session({ pid: 4242 })] })
    page.render(NOW)
    await page.onKeyPress(0)
    expect(f.focused).toEqual([{ pid: 4242, term: 'ghostty' }])
  })

  it('does nothing for an empty session key', async () => {
    const { page, f } = build()
    page.render(NOW)
    await page.onKeyPress(2)
    expect(f.focused).toEqual([])
  })

  it('does nothing for a gauge key', async () => {
    const { page, f } = build({ sessions: [session()], usage: freshUsage() })
    page.render(NOW)
    await page.onKeyPress(4)
    await page.onKeyPress(7)
    expect(f.focused).toEqual([])
  })

  it('focuses the right session when two are live', async () => {
    const { page, f } = build({
      sessions: [session({ sessionId: 'a', pid: 1, ts: NOW }),
                 session({ sessionId: 'b', pid: 2, ts: NOW - 5 })],
    })
    page.render(NOW)
    await page.onKeyPress(1)
    expect(f.focused[0]!.pid).toBe(2)
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run tests/pages/claude-page.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 4: Write `src/pages/claude-page.ts`**

The constructor takes narrow read interfaces, not the concrete sources. That keeps the tests small and the coupling loose.

```ts
import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
import { blankKey } from '../render/specs.js'
import { theme, stateColor, stateLabel, barColor } from '../render/theme.js'
import { truncate, formatDuration } from '../render/text.js'
import type { Page } from './types.js'
import type { Session } from '../sources/claude.js'
import type { UsageSnapshot, SessionMeta } from '../sources/usage.js'
import { computePace } from '../sources/usage.js'
import { KeyAssigner, SESSION_SLOTS } from './key-assigner.js'

export const PROJECT_CHARS = 10
const FIVE_HOURS = 5 * 3600
const SEVEN_DAYS = 7 * 86400

/** The part of `ClaudeSource` this page needs. */
export interface SessionReader {
  getSessions(): Session[]
  directoryExists(): boolean
}

/** The part of `UsageSource` this page needs. */
export interface UsageReader {
  getUsage(): UsageSnapshot | null
  isStale(): boolean
  getMeta(sessionId: string): SessionMeta | null
}

export type FocusFn = (pid: number, termProgram: string) => Promise<boolean>

export class ClaudePage implements Page {
  readonly name = 'claude'

  private assigner = new KeyAssigner()
  /** Session id per key 0 to 3, from the last render. A press reads it. */
  private slots: (string | null)[] = new Array(SESSION_SLOTS).fill(null)

  constructor(
    private readonly sessions: SessionReader,
    private readonly usage: UsageReader,
    private readonly focus: FocusFn,
  ) {}

  render(now: number): DeckFrame {
    const live = this.sessions.getSessions()
    const { slots, overflow } = this.assigner.assign(live)
    this.slots = slots

    const byId = new Map(live.map((s) => [s.sessionId, s]))
    const keys: KeySpec[] = []

    for (let i = 0; i < SESSION_SLOTS; i++) {
      const id = slots[i]
      const session = id ? byId.get(id) : undefined
      keys.push(session ? this.sessionKey(session, now) : blankKey())
    }

    keys.push(...this.gaugeKeys(now))

    return {
      keys,
      strip: this.strip(live, overflow, now),
      buttons: [theme.gray, theme.gray],
    }
  }

  private sessionKey(s: Session, now: number): KeySpec {
    const lines = [stateLabel(s.state), truncate(s.project, PROJECT_CHARS)]
    const meta = this.usage.getMeta(s.sessionId)
    if (meta?.model) lines.push(meta.model)

    const key: KeySpec = {
      kind: 'session',
      lines,
      border: stateColor(s.state),
      sprite: 'crab',
    }

    // A pending permission pulses once per second, so the eye finds it.
    if (s.state === 'permission') key.pulseOn = now % 2 === 0

    return key
  }

  private gaugeKeys(now: number): KeySpec[] {
    const u = this.usage.getUsage()
    const stale = this.usage.isStale()

    if (!u) {
      return [
        { kind: 'gauge', lines: ['5h', '--'], dim: true },
        { kind: 'gauge', lines: ['7d', '--'], dim: true },
        { kind: 'gauge', lines: ['PACE', '--'], dim: true },
        { kind: 'gauge', lines: ['RESET', '--'], dim: true },
      ]
    }

    const suffix = stale ? 'STALE' : ''
    const five = u.fiveHourPct
    const seven = u.sevenDayPct

    const gauge = (label: string, pct: number | null): KeySpec => {
      const spec: KeySpec = {
        kind: 'gauge',
        lines: [label, pct === null ? '--' : `${Math.floor(pct)}%`, suffix].filter(Boolean),
      }
      if (stale) spec.dim = true
      if (pct !== null) {
        spec.bar = { value: pct / 100, color: barColor(pct / 100) }
      }
      return spec
    }

    const pace =
      five === null
        ? 'even'
        : computePace(five, u.fiveHourResetsAt, FIVE_HOURS, now)
    const paceArrow = pace === 'fast' ? '⇡' : pace === 'slow' ? '⇣' : '·'

    const paceKey: KeySpec = {
      kind: 'gauge',
      lines: [`PACE ${paceArrow}`, pace, suffix].filter(Boolean),
    }
    const resetSeconds = u.fiveHourResetsAt ? u.fiveHourResetsAt - now : 0
    const resetKey: KeySpec = {
      kind: 'gauge',
      lines: ['RESET', u.fiveHourResetsAt ? formatDuration(resetSeconds) : '--', suffix].filter(Boolean),
    }
    if (stale) {
      paceKey.dim = true
      resetKey.dim = true
    }

    return [gauge('5h', five), gauge('7d', seven), paceKey, resetKey]
  }

  private strip(live: Session[], overflow: number, now: number): StripSpec {
    if (!this.sessions.directoryExists()) {
      return { lines: ['claude', 'no session data'], dim: true }
    }
    if (live.length === 0) {
      return { lines: ['claude', 'no active sessions'], dim: true }
    }

    const newest = live[0]!
    const elapsed = newest.startedAt ? formatDuration(now - newest.startedAt) : ''
    const parts = [newest.project, newest.tool || newest.label, elapsed].filter(Boolean)
    const second = overflow > 0 ? `+${overflow} more` : `${live.length} active`

    return { lines: [parts.join(' · '), second] }
  }

  async onKeyPress(index: number): Promise<void> {
    // Keys 4 to 7 are gauges. They do nothing in v1.
    if (index < 0 || index >= SESSION_SLOTS) return
    const id = this.slots[index]
    if (!id) return
    const session = this.sessions.getSessions().find((s) => s.sessionId === id)
    if (!session) return
    await this.focus(session.pid, session.termProgram)
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/pages/claude-page.test.ts`
Expected: PASS, 26 tests.

- [ ] **Step 6: Add the crab sprite asset**

The renderer accepts a `sprite` name but Task 3 did not draw it. Add the asset and the draw step now.

```bash
mkdir -p assets/crab
cp ~/Vibecoding/clawd-on-desk/assets/icon.png assets/crab/idle.png
ls -la ~/Vibecoding/clawd-on-desk/assets/gif ~/Vibecoding/clawd-on-desk/assets/svg 2>/dev/null | head -20
```

Pick one still frame that reads well at 40 × 40 px. Save it as `assets/crab/idle.png`.

Then add sprite support to `src/render/canvas.ts`. Load each sprite once and cache it, because the render loop must not read the disk.

```ts
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const spriteCache = new Map<string, Image | null>()

function loadSprite(name: string): Image | null {
  if (spriteCache.has(name)) return spriteCache.get(name)!
  const file = join(process.cwd(), 'assets', name, 'idle.png')
  let img: Image | null = null
  if (existsSync(file)) {
    img = new Image()
    img.src = readFileSync(file)
  }
  spriteCache.set(name, img)
  return img
}
```

In `renderKey`, draw the sprite after the text and before the bar:

```ts
  if (spec.sprite) {
    const img = loadSprite(spec.sprite)
    if (img) ctx.drawImage(img, KEY_SIZE / 2 - 20, 40, 40, 40)
  }
```

- [ ] **Step 7: Add a sprite test**

Append to `tests/render/canvas.test.ts`:

```ts
describe('renderKey sprite', () => {
  it('changes the image when a sprite is present', () => {
    const without = renderKey({ kind: 'session', lines: ['A'] })
    const withSprite = renderKey({ kind: 'session', lines: ['A'], sprite: 'crab' })
    expect(withSprite.equals(without)).toBe(false)
  })

  it('does not throw for an unknown sprite name', () => {
    expect(() => renderKey({ kind: 'session', sprite: 'no-such-sprite' })).not.toThrow()
  })
})
```

Run: `npx vitest run tests/render/canvas.test.ts`
Expected: PASS, 17 tests. If the first test fails, the sprite file is missing. Confirm `assets/crab/idle.png` exists.

- [ ] **Step 8: Record the sprite credit**

Create `ACKNOWLEDGEMENTS.md`:

```markdown
# Acknowledgements

The crab sprite in `assets/crab/` comes from
[clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) by
rullerzhou-afk, used under the MIT license.

The session state feed comes from the `daisy-statusbar` Claude Code plugin. This
project reads its state files and writes nothing to them.
```

- [ ] **Step 9: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 142 tests. The typecheck prints nothing.

- [ ] **Step 10: Commit**

```bash
git add src/pages tests/pages src/render/canvas.ts tests/render/canvas.test.ts assets ACKNOWLEDGEMENTS.md
git commit -m "feat: add the Claude page with sessions and usage gauges"
```

---

### Task 11: The page manager, the daemon, and the CLI — milestone 2

**Files:**
- Create: `src/page-manager.ts`, `src/daemon.ts`, `bin/deckd.ts`
- Test: `tests/page-manager.test.ts`, `tests/daemon.test.ts`

**Interfaces:**
- Consumes: `Page` from Task 10. `DeckDevice`, `BUTTON_LEFT`, `BUTTON_RIGHT`, `NEO_KEY_COUNT` from Task 4. `renderKey`, `renderStrip` from Task 3. `keyHash`, `stripHash` from Task 2. `ClaudeSource` from Task 6. `UsageSource` from Task 7. `ClaudePage` from Task 10. `focusWindow` from Task 9.
- Produces:
  - `class PageManager` with `add(page)`, `current(): Page`, `next()`, `prev()`, `setIndex(i)`, `index: number`, `onKeyPress(index)`.
  - `class Daemon` with `start()`, `stop()`, `renderOnce(now)`.
  - `bin/deckd.ts` with `start` and `smoke` subcommands.

After this task the deck shows live Claude data. This is the milestone that makes the project useful.

- [ ] **Step 1: Write the failing test for the page manager**

Create `tests/page-manager.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PageManager } from '../src/page-manager.js'
import type { Page } from '../src/pages/types.js'
import type { DeckFrame } from '../src/render/specs.js'

function fakePage(name: string, log: string[] = []): Page {
  return {
    name,
    render: (): DeckFrame => ({
      keys: Array.from({ length: 8 }, () => ({ kind: 'blank' as const })),
      strip: { lines: [name] },
      buttons: [[0, 0, 0], [0, 0, 0]],
    }),
    onKeyPress: (i) => { log.push(`${name}:${i}`) },
    onEnter: () => { log.push(`${name}:enter`) },
    onLeave: () => { log.push(`${name}:leave`) },
  }
}

describe('PageManager', () => {
  it('starts on the first page', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.add(fakePage('b'))
    expect(m.index).toBe(0)
    expect(m.current().name).toBe('a')
  })

  it('moves to the next page', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.add(fakePage('b'))
    m.next()
    expect(m.current().name).toBe('b')
  })

  it('wraps forward past the last page', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.add(fakePage('b'))
    m.next()
    m.next()
    expect(m.current().name).toBe('a')
  })

  it('wraps backward before the first page', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.add(fakePage('b'))
    m.prev()
    expect(m.current().name).toBe('b')
  })

  it('calls onLeave then onEnter on a page change', () => {
    const log: string[] = []
    const m = new PageManager()
    m.add(fakePage('a', log))
    m.add(fakePage('b', log))
    log.length = 0
    m.next()
    expect(log).toEqual(['a:leave', 'b:enter'])
  })

  it('does not fire lifecycle hooks when the index does not change', () => {
    const log: string[] = []
    const m = new PageManager()
    m.add(fakePage('a', log))
    log.length = 0
    m.next()
    expect(log).toEqual([])
  })

  it('routes a key press to the current page', () => {
    const log: string[] = []
    const m = new PageManager()
    m.add(fakePage('a', log))
    m.add(fakePage('b', log))
    m.next()
    void m.onKeyPress(3)
    expect(log).toContain('b:3')
  })

  it('throws when asked for a page before one is added', () => {
    expect(() => new PageManager().current()).toThrow(/no page/i)
  })

  it('ignores setIndex outside the range', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.setIndex(9)
    expect(m.index).toBe(0)
  })

  it('restores a saved index', () => {
    const m = new PageManager()
    m.add(fakePage('a'))
    m.add(fakePage('b'))
    m.setIndex(1)
    expect(m.current().name).toBe('b')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/page-manager.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 3: Write `src/page-manager.ts`**

```ts
import type { Page } from './pages/types.js'

export class PageManager {
  private pages: Page[] = []
  private idx = 0

  add(page: Page): void {
    this.pages.push(page)
    if (this.pages.length === 1) page.onEnter?.()
  }

  get index(): number {
    return this.idx
  }

  get count(): number {
    return this.pages.length
  }

  current(): Page {
    const p = this.pages[this.idx]
    if (!p) throw new Error('no page has been added')
    return p
  }

  next(): void {
    this.setIndex((this.idx + 1) % this.pages.length)
  }

  prev(): void {
    this.setIndex((this.idx - 1 + this.pages.length) % this.pages.length)
  }

  setIndex(i: number): void {
    if (i < 0 || i >= this.pages.length || i === this.idx) return
    this.pages[this.idx]?.onLeave?.()
    this.idx = i
    this.pages[this.idx]?.onEnter?.()
  }

  async onKeyPress(index: number): Promise<void> {
    await this.current().onKeyPress(index)
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/page-manager.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write the failing test for the daemon**

The one behavior worth protecting here is the dirty-key write. A one-key change must produce one key write, not eight.

Create `tests/daemon.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { FakeDevice } from '../src/fake-device.js'
import { PageManager } from '../src/page-manager.js'
import type { Page } from '../src/pages/types.js'
import type { DeckFrame, KeySpec } from '../src/render/specs.js'

/** A page whose content the test controls. */
class ControlPage implements Page {
  readonly name = 'test'
  lines = ['A']
  stripText = 'strip A'
  presses: number[] = []

  render(): DeckFrame {
    const keys: KeySpec[] = Array.from({ length: 8 }, (_, i) =>
      i === 0 ? { kind: 'gauge', lines: this.lines } : { kind: 'blank' })
    return {
      keys,
      strip: { lines: [this.stripText] },
      buttons: [[10, 10, 10], [20, 20, 20]],
    }
  }

  onKeyPress(i: number): void {
    this.presses.push(i)
  }
}

function build() {
  const device = new FakeDevice()
  const page = new ControlPage()
  const manager = new PageManager()
  manager.add(page)
  const daemon = new Daemon(device, manager)
  return { device, page, manager, daemon }
}

describe('Daemon', () => {
  it('writes all 8 keys and the strip on the first render', async () => {
    const { device, daemon } = build()
    await daemon.start()
    expect(device.keyWrites).toHaveLength(8)
    expect(device.stripWrites).toBe(1)
    await daemon.stop()
  })

  it('sets both touch button colours on the first render', async () => {
    const { device, daemon } = build()
    await daemon.start()
    expect(device.buttonColors.get(8)).toEqual([10, 10, 10])
    expect(device.buttonColors.get(9)).toEqual([20, 20, 20])
    await daemon.stop()
  })

  it('writes nothing on a second render with no change', async () => {
    const { device, daemon } = build()
    await daemon.start()
    device.reset()
    await daemon.renderOnce(1)
    expect(device.keyWrites).toHaveLength(0)
    expect(device.stripWrites).toBe(0)
    await daemon.stop()
  })

  it('writes only the changed key', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.reset()
    page.lines = ['B']
    await daemon.renderOnce(1)
    expect(device.keyWrites).toEqual([{ index: 0, bytes: expect.any(Number) }])
    await daemon.stop()
  })

  it('writes only the strip when only the strip changed', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.reset()
    page.stripText = 'strip B'
    await daemon.renderOnce(1)
    expect(device.keyWrites).toHaveLength(0)
    expect(device.stripWrites).toBe(1)
    await daemon.stop()
  })

  it('routes a key press to the page', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.simulatePress(3)
    await Promise.resolve()
    expect(page.presses).toContain(3)
    await daemon.stop()
  })

  it('does not route a touch button press to the page', async () => {
    const { device, page, daemon } = build()
    await daemon.start()
    device.simulatePress(8)
    device.simulatePress(9)
    await Promise.resolve()
    expect(page.presses).toEqual([])
    await daemon.stop()
  })

  it('redraws every key after a reconnect', async () => {
    const { device, daemon } = build()
    await daemon.start()
    device.reset()
    await daemon.handleReconnect()
    expect(device.keyWrites).toHaveLength(8)
    await daemon.stop()
  })

  it('survives a write failure and keeps running', async () => {
    const { device, daemon } = build()
    await daemon.start()
    const original = device.setKeyImage.bind(device)
    device.setKeyImage = async () => { throw new Error('usb gone') }
    await expect(daemon.renderOnce(2)).resolves.not.toThrow()
    device.setKeyImage = original
    await daemon.stop()
  })
})
```

- [ ] **Step 6: Run the test and confirm it fails**

Run: `npx vitest run tests/daemon.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 7: Write `src/daemon.ts`**

```ts
import type { DeckDevice } from './device.js'
import { BUTTON_LEFT, BUTTON_RIGHT, NEO_KEY_COUNT } from './device.js'
import type { PageManager } from './page-manager.js'
import { renderKey, renderStrip } from './render/canvas.js'
import { keyHash, stripHash, type Rgb } from './render/specs.js'
import { log } from './log.js'

const TICK_MS = 1000

/**
 * Owns the render loop. It compares each new key description against the last
 * one it drew, and it writes only what changed. A full 8 key write costs USB
 * bandwidth, so this comparison is the difference between a smooth deck and a
 * laggy one.
 */
export class Daemon {
  private lastKeys: (string | null)[] = new Array(NEO_KEY_COUNT).fill(null)
  private lastStrip: string | null = null
  private lastButtons: (string | null)[] = [null, null]
  private timer: NodeJS.Timeout | null = null
  private rendering = false

  constructor(
    private readonly device: DeckDevice,
    private readonly pages: PageManager,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async start(): Promise<void> {
    this.device.onPress((i) => void this.handlePress(i))
    this.device.onConnect(() => void this.handleReconnect())

    if (!this.device.isConnected()) await this.device.connect()
    await this.renderOnce(this.now())
    this.timer = setInterval(() => void this.renderOnce(this.now()), TICK_MS)
  }

  private async handlePress(index: number): Promise<void> {
    try {
      if (index === BUTTON_LEFT) {
        this.pages.prev()
        await this.renderOnce(this.now())
        return
      }
      if (index === BUTTON_RIGHT) {
        this.pages.next()
        await this.renderOnce(this.now())
        return
      }
      if (index < 0 || index >= NEO_KEY_COUNT) return
      await this.pages.onKeyPress(index)
      await this.renderOnce(this.now())
    } catch (e) {
      log.error(`press handler failed for index ${index}: ${String(e)}`)
    }
  }

  /** Forgets what is on the glass, so the next render writes everything. */
  async handleReconnect(): Promise<void> {
    this.lastKeys = new Array(NEO_KEY_COUNT).fill(null)
    this.lastStrip = null
    this.lastButtons = [null, null]
    await this.renderOnce(this.now())
  }

  /** Renders one frame. It writes only what changed. */
  async renderOnce(now: number): Promise<void> {
    if (this.rendering) return
    if (!this.device.isConnected()) return
    this.rendering = true
    try {
      const frame = this.pages.current().render(now)

      for (let i = 0; i < NEO_KEY_COUNT; i++) {
        const spec = frame.keys[i]
        if (!spec) continue
        const hash = keyHash(spec)
        if (hash === this.lastKeys[i]) continue
        await this.device.setKeyImage(i, renderKey(spec))
        this.lastKeys[i] = hash
      }

      const sHash = stripHash(frame.strip)
      if (sHash !== this.lastStrip) {
        await this.device.setStrip(renderStrip(frame.strip))
        this.lastStrip = sHash
      }

      await this.writeButton(0, BUTTON_LEFT, frame.buttons[0])
      await this.writeButton(1, BUTTON_RIGHT, frame.buttons[1])
    } catch (e) {
      // A write failure means the cable moved. The Device retries the open.
      log.warn(`render failed: ${String(e)}`)
      this.lastKeys = new Array(NEO_KEY_COUNT).fill(null)
      this.lastStrip = null
      this.lastButtons = [null, null]
    } finally {
      this.rendering = false
    }
  }

  private async writeButton(slot: number, index: number, rgb: Rgb): Promise<void> {
    const hash = rgb.join(',')
    if (hash === this.lastButtons[slot]) return
    await this.device.setButtonColor(index, rgb)
    this.lastButtons[slot] = hash
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `npx vitest run tests/daemon.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 9: Write `bin/deckd.ts`**

```ts
#!/usr/bin/env node
import { Device, DeviceBusyError } from '../src/device.js'
import { Daemon } from '../src/daemon.js'
import { PageManager } from '../src/page-manager.js'
import { ClaudePage } from '../src/pages/claude-page.js'
import { ClaudeSource } from '../src/sources/claude.js'
import { UsageSource } from '../src/sources/usage.js'
import { focusWindow } from '../src/focus-window.js'
import { ensureStateDir, paths } from '../src/paths.js'
import { log } from '../src/log.js'
import { readFileSync, writeFileSync } from 'node:fs'

async function start(): Promise<void> {
  ensureStateDir()
  log.info('deckd starting')

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
```

- [ ] **Step 10: Build and run the daemon against the real device — milestone 2**

Run: `npm run build && node dist/bin/deckd.js start`

Expected on the hardware:
- The top row shows a key for this Claude session. It reads `TOOL` or `IDLE`, then `streamdec…`, and it shows the crab.
- The bottom row shows the four gauges. They read `--` until a statusline renders, because the wrapper is not installed until Task 15.
- The strip shows the project, the tool, and the elapsed time.
- Both touch buttons glow dim gray.

Confirm the live behavior:
- Start a second Claude session in another terminal. A second key appears within 5 seconds.
- Press key 0. The terminal for that session comes to the front.
- Press key 4. Nothing happens, which is correct for v1.
- Unplug the deck. The log records it once, and the process stays alive. Plug it back in. Every key redraws.

- [ ] **Step 11: Fix any fault, then run the whole suite**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 161 tests. The typecheck prints nothing.

- [ ] **Step 12: Commit**

```bash
git add src/page-manager.ts src/daemon.ts bin/deckd.ts tests/page-manager.test.ts tests/daemon.test.ts
git commit -m "feat: run the deck with a live Claude page"
```

---

**Tasks 12 to 15 follow in this same file.**
