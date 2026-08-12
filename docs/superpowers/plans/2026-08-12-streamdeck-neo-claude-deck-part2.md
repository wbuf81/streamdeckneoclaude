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

    if (!this.device.isConnected()) await this.device.connect()
    await this.renderOnce(this.now())

    // Register the reconnect handler only after the first render. Registering
    // it earlier makes `connect()` fire `handleReconnect` while this method is
    // still rendering, and the two renders then race for the `rendering` flag.
    this.device.onConnect(() => void this.handleReconnect())

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

### Task 12: Spotify OAuth

**Files:**
- Create: `src/sources/spotify-auth.ts`
- Modify: `bin/deckd.ts` — add the `auth spotify` subcommand
- Test: `tests/sources/spotify-auth.test.ts`

**Interfaces:**
- Consumes: `paths`, `log` from Task 1.
- Produces:
  - `interface Tokens` with `accessToken`, `refreshToken`, `expiresAt`.
  - `class TokenStore` with `load(): Tokens | null`, `save(t: Tokens): void`, `clear(): void`.
  - `makeVerifier(random: () => string): string`, `challengeFor(verifier: string): string`.
  - `buildAuthUrl(clientId, redirectUri, challenge, state): string`.
  - `SCOPES: string[]`, `REDIRECT_URI`, `AUTH_PORT = 23400`.
  - `runAuthFlow(clientId: string): Promise<Tokens>`.
  - `refreshTokens(clientId, refreshToken, fetchFn?): Promise<Tokens>`.

Spotify allows a loopback redirect over plain HTTP, but only on `127.0.0.1`. It rejects `localhost`. The redirect URI must match the dashboard entry exactly.

- [ ] **Step 1: Write the failing test**

The test covers PKCE maths, the URL, and the token store. It never calls the network.

Create `tests/sources/spotify-auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  TokenStore, makeVerifier, challengeFor, buildAuthUrl,
  SCOPES, REDIRECT_URI, AUTH_PORT, parseTokenResponse,
} from '../../src/sources/spotify-auth.js'

describe('PKCE', () => {
  it('makes a verifier of at least 43 characters', () => {
    expect(makeVerifier().length).toBeGreaterThanOrEqual(43)
  })

  it('makes a verifier of at most 128 characters', () => {
    expect(makeVerifier().length).toBeLessThanOrEqual(128)
  })

  it('uses only unreserved characters', () => {
    expect(makeVerifier()).toMatch(/^[A-Za-z0-9\-._~]+$/)
  })

  it('makes a different verifier each call', () => {
    expect(makeVerifier()).not.toBe(makeVerifier())
  })

  it('derives the challenge as base64url of the sha256 digest', () => {
    const v = 'abcdefghijklmnopqrstuvwxyz0123456789abcdefgh'
    const expected = createHash('sha256').update(v).digest('base64url')
    expect(challengeFor(v)).toBe(expected)
  })

  it('makes a challenge with no base64 padding', () => {
    expect(challengeFor(makeVerifier())).not.toContain('=')
  })
})

describe('buildAuthUrl', () => {
  it('targets the Spotify authorize endpoint', () => {
    const u = new URL(buildAuthUrl('cid', REDIRECT_URI, 'chal', 'st'))
    expect(u.origin + u.pathname).toBe('https://accounts.spotify.com/authorize')
  })

  it('asks for a code with the S256 method', () => {
    const u = new URL(buildAuthUrl('cid', REDIRECT_URI, 'chal', 'st'))
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toBe('chal')
  })

  it('carries the client id, the redirect, and the state', () => {
    const u = new URL(buildAuthUrl('cid', REDIRECT_URI, 'chal', 'st'))
    expect(u.searchParams.get('client_id')).toBe('cid')
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(u.searchParams.get('state')).toBe('st')
  })

  it('requests the three scopes the deck needs', () => {
    const u = new URL(buildAuthUrl('cid', REDIRECT_URI, 'chal', 'st'))
    const scopes = u.searchParams.get('scope')!.split(' ')
    expect(scopes).toContain('user-read-playback-state')
    expect(scopes).toContain('user-modify-playback-state')
    expect(scopes).toContain('user-read-currently-playing')
    expect(SCOPES).toHaveLength(3)
  })

  it('uses a loopback IP redirect, because Spotify rejects localhost', () => {
    expect(REDIRECT_URI).toBe(`http://127.0.0.1:${AUTH_PORT}/callback`)
    expect(REDIRECT_URI).not.toContain('localhost')
  })
})

describe('parseTokenResponse', () => {
  it('reads the access token and computes an absolute expiry', () => {
    const t = parseTokenResponse(
      { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
      'old-rt', 1000,
    )
    expect(t.accessToken).toBe('at')
    expect(t.refreshToken).toBe('rt')
    expect(t.expiresAt).toBe(1000 + 3600)
  })

  it('keeps the old refresh token when the response omits one', () => {
    const t = parseTokenResponse({ access_token: 'at', expires_in: 60 }, 'old-rt', 0)
    expect(t.refreshToken).toBe('old-rt')
  })

  it('throws when the response has no access token', () => {
    expect(() => parseTokenResponse({ error: 'invalid_grant' }, 'rt', 0))
      .toThrow(/access token/i)
  })
})

describe('TokenStore', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deckd-tok-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns null before anything is saved', () => {
    expect(new TokenStore(join(dir, 'spotify.json')).load()).toBeNull()
  })

  it('round-trips the tokens', () => {
    const f = join(dir, 'spotify.json')
    const s = new TokenStore(f)
    s.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 99 })
    expect(new TokenStore(f).load()).toEqual({
      accessToken: 'a', refreshToken: 'r', expiresAt: 99,
    })
  })

  it('writes the file with mode 0600, because it holds a token', () => {
    const f = join(dir, 'spotify.json')
    new TokenStore(f).save({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 })
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('returns null for a corrupt file', () => {
    const f = join(dir, 'spotify.json')
    const s = new TokenStore(f)
    s.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 })
    require('node:fs').writeFileSync(f, '{ broken')
    expect(s.load()).toBeNull()
  })

  it('removes the file on clear', () => {
    const f = join(dir, 'spotify.json')
    const s = new TokenStore(f)
    s.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 })
    s.clear()
    expect(existsSync(f)).toBe(false)
  })

  it('does not throw when clear runs on a missing file', () => {
    expect(() => new TokenStore(join(dir, 'nope.json')).clear()).not.toThrow()
  })
})
```

- [ ] **Step 2: Replace the `require` in the corrupt-file test with an import**

Add `writeFileSync` to the `node:fs` import at the top of the test file, and use it directly. The project is ESM only.

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run tests/sources/spotify-auth.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 4: Write `src/sources/spotify-auth.ts`**

```ts
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { paths } from '../paths.js'
import { log } from '../log.js'

export const AUTH_PORT = 23400
/** Spotify allows plain HTTP only on a loopback IP. It rejects `localhost`. */
export const REDIRECT_URI = `http://127.0.0.1:${AUTH_PORT}/callback`
export const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
]

const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize'

export interface Tokens {
  accessToken: string
  refreshToken: string
  /** Unix seconds. */
  expiresAt: number
}

/** Makes a PKCE code verifier of 64 unreserved characters. */
export function makeVerifier(): string {
  return randomBytes(48).toString('base64url').slice(0, 64)
}

/** Derives the S256 code challenge from a verifier. */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const u = new URL(AUTHORIZE_URL)
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('state', state)
  u.searchParams.set('scope', SCOPES.join(' '))
  return u.toString()
}

/** Turns a token response into absolute-expiry `Tokens`. */
export function parseTokenResponse(
  body: Record<string, unknown>,
  previousRefresh: string,
  now: number,
): Tokens {
  const accessToken = body.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error(`token response has no access token: ${JSON.stringify(body)}`)
  }
  const refresh = typeof body.refresh_token === 'string' ? body.refresh_token : previousRefresh
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
  return { accessToken, refreshToken: refresh, expiresAt: now + expiresIn }
}

/** Stores the tokens on disk with mode 0600. */
export class TokenStore {
  constructor(private readonly file: string = paths.spotifyFile) {}

  load(): Tokens | null {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Tokens>
      if (!raw.accessToken || !raw.refreshToken) return null
      return {
        accessToken: raw.accessToken,
        refreshToken: raw.refreshToken,
        expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
      }
    } catch {
      return null
    }
  }

  save(t: Tokens): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeFileSync(this.file, JSON.stringify(t), { mode: 0o600 })
  }

  clear(): void {
    try {
      unlinkSync(this.file)
    } catch {
      // Already absent. Nothing to do.
    }
  }
}

async function postForm(body: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  return (await res.json()) as Record<string, unknown>
}

/** Exchanges a refresh token for a new access token. */
export async function refreshTokens(
  clientId: string,
  refreshToken: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Tokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  })
  return parseTokenResponse(await postForm(body), refreshToken, now())
}

/**
 * Runs the full authorization flow once. It starts a loopback listener, opens
 * the browser, and waits for the redirect. It rejects on a state mismatch,
 * because that indicates a forged callback.
 */
export async function runAuthFlow(clientId: string): Promise<Tokens> {
  const verifier = makeVerifier()
  const state = randomBytes(16).toString('hex')
  const url = buildAuthUrl(clientId, REDIRECT_URI, challengeFor(verifier), state)

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const requested = new URL(req.url ?? '/', `http://127.0.0.1:${AUTH_PORT}`)
      if (requested.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const err = requested.searchParams.get('error')
      const gotCode = requested.searchParams.get('code')
      const gotState = requested.searchParams.get('state')

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (err || !gotCode) {
        res.end('<h1>Authorization failed</h1><p>Return to the terminal.</p>')
        server.close()
        reject(new Error(`authorization failed: ${err ?? 'no code'}`))
        return
      }
      if (gotState !== state) {
        res.end('<h1>State mismatch</h1><p>Return to the terminal.</p>')
        server.close()
        reject(new Error('state mismatch. The callback did not match the request.'))
        return
      }
      res.end('<h1>deckd is connected</h1><p>You can close this tab.</p>')
      server.close()
      resolve(gotCode)
    })
    server.on('error', reject)
    server.listen(AUTH_PORT, '127.0.0.1', () => {
      console.log('Opening the browser to authorize Spotify.')
      console.log(`If it does not open, visit:\n${url}`)
      execFile('/usr/bin/open', [url], () => {
        // A failure here is fine. The user has the URL printed above.
      })
    })
    setTimeout(() => {
      server.close()
      reject(new Error('authorization timed out after 5 minutes'))
    }, 5 * 60 * 1000)
  })

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  })
  const tokens = parseTokenResponse(await postForm(body), '', Math.floor(Date.now() / 1000))
  log.info('spotify authorized')
  return tokens
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/sources/spotify-auth.test.ts`
Expected: PASS, 21 tests.

- [ ] **Step 6: Add the `auth spotify` subcommand to `bin/deckd.ts`**

Add the imports and the function, then a `case 'auth':` to the switch.

```ts
import { runAuthFlow, TokenStore } from '../src/sources/spotify-auth.js'

async function authSpotify(): Promise<void> {
  ensureStateDir()
  const clientId = process.env.SPOTIFY_CLIENT_ID ?? readClientId()
  if (!clientId) {
    console.error(
      'No Spotify client id.\n\n' +
        '1. Open https://developer.spotify.com/dashboard and create an app.\n' +
        '2. Add this redirect URI exactly:\n' +
        '     http://127.0.0.1:23400/callback\n' +
        '3. Copy the client id, then run:\n' +
        '     deckd auth spotify --client-id <ID>\n',
    )
    process.exit(2)
  }
  const tokens = await runAuthFlow(clientId)
  new TokenStore().save(tokens)
  writeFileSync(paths.configFile, JSON.stringify({ spotify: { clientId } }, null, 2), {
    mode: 0o600,
  })
  console.log('Spotify is connected. Restart deckd to pick it up.')
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
```

Add to the switch:

```ts
  case 'auth':
    if (process.argv[3] === 'spotify') {
      void authSpotify()
    } else {
      console.error('usage: deckd auth spotify --client-id <ID>')
      process.exit(2)
    }
    break
```

- [ ] **Step 7: Run the real flow**

Create the Spotify app first. Add the redirect URI `http://127.0.0.1:23400/callback` exactly, with no trailing slash.

Run: `npm run build && node dist/bin/deckd.js auth spotify --client-id <YOUR_ID>`
Expected: the browser opens, you approve, the page reads `deckd is connected`, and the terminal reports success.

Confirm the file mode:
```bash
ls -l ~/.local/state/deckd/spotify.json
```
Expected: `-rw-------`, which is mode 0600.

- [ ] **Step 8: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 182 tests. The typecheck prints nothing.

- [ ] **Step 9: Commit**

```bash
git add src/sources/spotify-auth.ts bin/deckd.ts tests/sources/spotify-auth.test.ts
git commit -m "feat: authorize Spotify with OAuth PKCE"
```

---

### Task 13: The Spotify source

**Files:**
- Create: `src/sources/spotify.ts`
- Test: `tests/sources/spotify.test.ts`

**Interfaces:**
- Consumes: `Tokens`, `TokenStore`, `refreshTokens` from Task 12. `log`, `paths` from Task 1.
- Produces:
  - `interface PlayerState` with `isPlaying`, `title`, `artist`, `album`, `positionMs`, `durationMs`, `trackId`, `artUrl`, `shuffle`, `repeat`, `volumePercent`, `hasDevice`.
  - `type SpotifyStatus = 'ok' | 'unauthorized' | 'offline' | 'no-device'`.
  - `parsePlayer(json: unknown): PlayerState | null`.
  - `pickArtUrl(images, minWidth): string | null`.
  - `class SpotifySource` with `start()`, `stop()`, `getState()`, `getStatus()`, `interpolate(now)`, `play()`, `pause()`, `next()`, `previous()`, `setVolume(p)`, `toggleShuffle()`, `cycleRepeat()`, `getArt(trackId)`, `on('change', cb)`.

The source takes an injected `fetch`, so every test runs offline.

- [ ] **Step 1: Write the failing test**

Create `tests/sources/spotify.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { parsePlayer, pickArtUrl, SpotifySource } from '../../src/sources/spotify.js'
import type { Tokens } from '../../src/sources/spotify-auth.js'

const PLAYER = {
  is_playing: true,
  progress_ms: 134000,
  shuffle_state: true,
  repeat_state: 'context',
  device: { volume_percent: 55 },
  item: {
    id: 'track-1',
    name: 'Planet Caravan',
    duration_ms: 272000,
    artists: [{ name: 'Black Sabbath' }, { name: 'Guest' }],
    album: {
      name: 'Paranoid',
      images: [
        { url: 'https://i/large.jpg', width: 640, height: 640 },
        { url: 'https://i/mid.jpg', width: 300, height: 300 },
        { url: 'https://i/small.jpg', width: 64, height: 64 },
      ],
    },
  },
}

describe('parsePlayer', () => {
  it('reads the track, the artist, and the album', () => {
    const s = parsePlayer(PLAYER)!
    expect(s.title).toBe('Planet Caravan')
    expect(s.artist).toBe('Black Sabbath')
    expect(s.album).toBe('Paranoid')
    expect(s.trackId).toBe('track-1')
  })

  it('reads the position and the duration in milliseconds', () => {
    const s = parsePlayer(PLAYER)!
    expect(s.positionMs).toBe(134000)
    expect(s.durationMs).toBe(272000)
  })

  it('reads the transport flags', () => {
    const s = parsePlayer(PLAYER)!
    expect(s.isPlaying).toBe(true)
    expect(s.shuffle).toBe(true)
    expect(s.repeat).toBe('context')
    expect(s.volumePercent).toBe(55)
  })

  it('joins more than one artist with a comma', () => {
    const s = parsePlayer({ ...PLAYER, item: { ...PLAYER.item, artists: [{ name: 'A' }, { name: 'B' }] } })!
    expect(s.artist).toBe('A, B')
  })

  it('returns null for an empty 204 body', () => {
    expect(parsePlayer(null)).toBeNull()
    expect(parsePlayer(undefined)).toBeNull()
    expect(parsePlayer('')).toBeNull()
  })

  it('returns null when there is no item', () => {
    expect(parsePlayer({ is_playing: false, item: null })).toBeNull()
  })

  it('handles a missing device block', () => {
    const s = parsePlayer({ ...PLAYER, device: null })!
    expect(s.hasDevice).toBe(false)
    expect(s.volumePercent).toBeNull()
  })

  it('handles a track with no album art', () => {
    const s = parsePlayer({ ...PLAYER, item: { ...PLAYER.item, album: { name: 'X', images: [] } } })!
    expect(s.artUrl).toBeNull()
  })
})

describe('pickArtUrl', () => {
  const images = [
    { url: 'large', width: 640 },
    { url: 'mid', width: 300 },
    { url: 'small', width: 64 },
  ]

  it('picks the smallest image at or above the minimum width', () => {
    expect(pickArtUrl(images, 96)).toBe('mid')
  })

  it('picks the largest available when none reach the minimum', () => {
    expect(pickArtUrl([{ url: 'tiny', width: 32 }], 96)).toBe('tiny')
  })

  it('returns null for an empty list', () => {
    expect(pickArtUrl([], 96)).toBeNull()
  })

  it('accepts an exact match on the minimum width', () => {
    expect(pickArtUrl([{ url: 'exact', width: 96 }], 96)).toBe('exact')
  })
})

function tokens(over: Partial<Tokens> = {}): Tokens {
  return { accessToken: 'at', refreshToken: 'rt', expiresAt: 9_999_999_999, ...over }
}

function build(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string }> = []
  let i = 0
  const fetchFn = vi.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const r = responses[Math.min(i++, responses.length - 1)]!
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body ?? {},
      arrayBuffer: async () => new ArrayBuffer(8),
    }
  })
  const store = {
    load: () => tokens(),
    save: vi.fn(),
    clear: vi.fn(),
  }
  const src = new SpotifySource('cid', store as never, fetchFn as never, () => 1000)
  return { src, calls, fetchFn, store }
}

describe('SpotifySource', () => {
  it('reports ok and the state after a good poll', async () => {
    const { src } = build([{ status: 200, body: PLAYER }])
    await src.poll()
    expect(src.getStatus()).toBe('ok')
    expect(src.getState()!.title).toBe('Planet Caravan')
  })

  it('reports no-device on an empty 204', async () => {
    const { src } = build([{ status: 204 }])
    await src.poll()
    expect(src.getStatus()).toBe('no-device')
    expect(src.getState()).toBeNull()
  })

  it('refreshes once on a 401 and retries', async () => {
    const { src, calls } = build([
      { status: 401 },
      { status: 200, body: { access_token: 'new', expires_in: 3600 } },
      { status: 200, body: PLAYER },
    ])
    await src.poll()
    expect(src.getStatus()).toBe('ok')
    expect(calls.some((c) => c.url.includes('/api/token'))).toBe(true)
  })

  it('reports unauthorized after a second 401', async () => {
    const { src } = build([
      { status: 401 },
      { status: 200, body: { access_token: 'new', expires_in: 3600 } },
      { status: 401 },
    ])
    await src.poll()
    expect(src.getStatus()).toBe('unauthorized')
  })

  it('reports unauthorized when no token is stored', async () => {
    const src = new SpotifySource('cid', { load: () => null, save: () => {}, clear: () => {} } as never)
    await src.poll()
    expect(src.getStatus()).toBe('unauthorized')
  })

  it('reports offline when fetch throws', async () => {
    const src = new SpotifySource(
      'cid',
      { load: () => tokens(), save: () => {}, clear: () => {} } as never,
      (async () => { throw new Error('ENOTFOUND') }) as never,
    )
    await src.poll()
    expect(src.getStatus()).toBe('offline')
  })

  it('keeps the last known state when it goes offline', async () => {
    const { src } = build([{ status: 200, body: PLAYER }])
    await src.poll()
    src.setFetchForTest((async () => { throw new Error('down') }) as never)
    await src.poll()
    expect(src.getStatus()).toBe('offline')
    expect(src.getState()!.title).toBe('Planet Caravan')
  })

  it('honours Retry-After on a 429', async () => {
    const { src } = build([{ status: 429, headers: { 'retry-after': '7' } }])
    await src.poll()
    expect(src.retryAfterSeconds()).toBe(7)
  })

  it('advances the position locally between polls', async () => {
    const { src } = build([{ status: 200, body: PLAYER }])
    await src.poll()
    // The poll happened at now = 1000. Read the state 3 seconds later.
    expect(src.interpolate(1003)!.positionMs).toBe(134000 + 3000)
  })

  it('does not advance the position while paused', async () => {
    const { src } = build([{ status: 200, body: { ...PLAYER, is_playing: false } }])
    await src.poll()
    expect(src.interpolate(1010)!.positionMs).toBe(134000)
  })

  it('never advances past the track duration', async () => {
    const { src } = build([{ status: 200, body: PLAYER }])
    await src.poll()
    expect(src.interpolate(99999)!.positionMs).toBe(272000)
  })

  it('sends a PUT to pause', async () => {
    const { src, calls } = build([{ status: 200, body: PLAYER }, { status: 204 }])
    await src.poll()
    await src.pause()
    const last = calls[calls.length - 1]!
    expect(last.method).toBe('PUT')
    expect(last.url).toContain('/me/player/pause')
  })

  it('sends a POST to skip forward', async () => {
    const { src, calls } = build([{ status: 200, body: PLAYER }, { status: 204 }])
    await src.poll()
    await src.next()
    const last = calls[calls.length - 1]!
    expect(last.method).toBe('POST')
    expect(last.url).toContain('/me/player/next')
  })

  it('clamps the volume to 0 and 100', async () => {
    const { src, calls } = build([{ status: 200, body: PLAYER }, { status: 204 }, { status: 204 }])
    await src.poll()
    await src.setVolume(150)
    expect(calls[calls.length - 1]!.url).toContain('volume_percent=100')
    await src.setVolume(-20)
    expect(calls[calls.length - 1]!.url).toContain('volume_percent=0')
  })

  it('cycles repeat off to context to track and back', () => {
    expect(SpotifySource.nextRepeat('off')).toBe('context')
    expect(SpotifySource.nextRepeat('context')).toBe('track')
    expect(SpotifySource.nextRepeat('track')).toBe('off')
  })

  it('reports no-device when a control returns 403', async () => {
    const { src } = build([{ status: 200, body: PLAYER }, { status: 403 }])
    await src.poll()
    expect(await src.pause()).toBe(false)
    expect(src.getStatus()).toBe('no-device')
  })

  it('returns true when a control succeeds', async () => {
    const { src } = build([{ status: 200, body: PLAYER }, { status: 204 }])
    await src.poll()
    expect(await src.pause()).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/sources/spotify.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 3: Write `src/sources/spotify.ts`**

```ts
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../paths.js'
import { log } from '../log.js'
import { TokenStore, refreshTokens, type Tokens } from './spotify-auth.js'

const API = 'https://api.spotify.com/v1'
const POLL_PLAYING_MS = 3000
const POLL_IDLE_MS = 30000
const ART_MIN_WIDTH = 96
const ART_CACHE_MAX = 200

export type RepeatMode = 'off' | 'context' | 'track'
export type SpotifyStatus = 'ok' | 'unauthorized' | 'offline' | 'no-device'

export interface PlayerState {
  isPlaying: boolean
  title: string
  artist: string
  album: string
  positionMs: number
  durationMs: number
  trackId: string
  artUrl: string | null
  shuffle: boolean
  repeat: RepeatMode
  volumePercent: number | null
  hasDevice: boolean
}

interface ImageLike {
  url?: unknown
  width?: unknown
}

/** Picks the smallest image at or above `minWidth`, else the largest one. */
export function pickArtUrl(images: ImageLike[], minWidth: number): string | null {
  const sized = images
    .filter((i): i is { url: string; width: number } =>
      typeof i.url === 'string' && typeof i.width === 'number')
    .sort((a, b) => a.width - b.width)
  if (sized.length === 0) return null
  return (sized.find((i) => i.width >= minWidth) ?? sized[sized.length - 1]!).url
}

/** Parses the `/me/player` body. Returns null for an empty body or no track. */
export function parsePlayer(body: unknown): PlayerState | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, any>
  const item = b.item
  if (!item || typeof item !== 'object') return null

  const artists = Array.isArray(item.artists) ? item.artists : []
  const images = Array.isArray(item.album?.images) ? item.album.images : []
  const repeat: RepeatMode =
    b.repeat_state === 'context' || b.repeat_state === 'track' ? b.repeat_state : 'off'

  return {
    isPlaying: b.is_playing === true,
    title: typeof item.name === 'string' ? item.name : '',
    artist: artists.map((a: any) => a?.name).filter(Boolean).join(', '),
    album: typeof item.album?.name === 'string' ? item.album.name : '',
    positionMs: typeof b.progress_ms === 'number' ? b.progress_ms : 0,
    durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : 0,
    trackId: typeof item.id === 'string' ? item.id : '',
    artUrl: pickArtUrl(images, ART_MIN_WIDTH),
    shuffle: b.shuffle_state === true,
    repeat,
    volumePercent:
      typeof b.device?.volume_percent === 'number' ? b.device.volume_percent : null,
    hasDevice: Boolean(b.device),
  }
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}>

interface Store {
  load(): Tokens | null
  save(t: Tokens): void
  clear(): void
}

/**
 * Reads and controls Spotify playback. It polls only while the page is visible,
 * and it advances the playback position locally between polls, so a smooth
 * progress bar costs no extra requests.
 */
export class SpotifySource extends EventEmitter {
  private state: PlayerState | null = null
  private status: SpotifyStatus = 'unauthorized'
  private polledAt = 0
  private retryAfter = 0
  private timer: NodeJS.Timeout | null = null
  private visible = false
  private artCache = new Map<string, Buffer>()

  constructor(
    private readonly clientId: string,
    private readonly store: Store = new TokenStore(),
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    super()
  }

  /** Test helper. Swaps the fetch implementation mid-test. */
  setFetchForTest(f: FetchLike): void {
    this.fetchFn = f
  }

  static nextRepeat(mode: RepeatMode): RepeatMode {
    return mode === 'off' ? 'context' : mode === 'context' ? 'track' : 'off'
  }

  getState(): PlayerState | null {
    return this.state
  }

  getStatus(): SpotifyStatus {
    return this.status
  }

  retryAfterSeconds(): number {
    return this.retryAfter
  }

  /** Called when the Spotify page becomes visible. It starts the poll loop. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) {
      void this.poll()
      this.schedule()
    } else if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.visible) return
    const base = this.state?.isPlaying ? POLL_PLAYING_MS : POLL_IDLE_MS
    const delay = Math.max(base, this.retryAfter * 1000)
    this.timer = setTimeout(() => {
      void this.poll().then(() => this.schedule())
    }, delay)
  }

  private async accessToken(): Promise<string | null> {
    const t = this.store.load()
    if (!t) {
      this.status = 'unauthorized'
      return null
    }
    if (t.expiresAt > this.now() + 30) return t.accessToken
    return this.doRefresh(t)
  }

  private async doRefresh(t: Tokens): Promise<string | null> {
    try {
      const fresh = await refreshTokens(this.clientId, t.refreshToken, this.now)
      this.store.save(fresh)
      return fresh.accessToken
    } catch (e) {
      log.warn(`spotify token refresh failed: ${String(e)}`)
      this.status = 'unauthorized'
      return null
    }
  }

  /** Polls the player. It refreshes the token once on a 401 and retries. */
  async poll(): Promise<void> {
    const before = JSON.stringify(this.state) + this.status
    await this.pollInner()
    if (JSON.stringify(this.state) + this.status !== before) this.emit('change')
  }

  private async pollInner(retried = false): Promise<void> {
    const token = await this.accessToken()
    if (!token) return

    let res
    try {
      res = await this.fetchFn(`${API}/me/player`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {
      // Keep the last known state. A dropped network is not a data change.
      this.status = 'offline'
      return
    }

    if (res.status === 401) {
      if (retried) {
        this.status = 'unauthorized'
        return
      }
      const t = this.store.load()
      if (!t) {
        this.status = 'unauthorized'
        return
      }
      const fresh = await this.doRefresh(t)
      if (!fresh) return
      return this.pollInner(true)
    }

    if (res.status === 429) {
      this.retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '5', 10) || 5
      log.warn(`spotify rate limited. Waiting ${this.retryAfter} seconds.`)
      return
    }
    this.retryAfter = 0

    if (res.status === 204) {
      this.state = null
      this.status = 'no-device'
      return
    }

    if (!res.ok) {
      this.status = 'offline'
      return
    }

    const parsed = parsePlayer(await res.json())
    this.state = parsed
    this.status = parsed ? 'ok' : 'no-device'
    this.polledAt = this.now()
  }

  /**
   * Returns the state with the position advanced to `now`. The progress bar
   * moves once per second without a request.
   */
  interpolate(now: number): PlayerState | null {
    if (!this.state) return null
    if (!this.state.isPlaying) return this.state
    const elapsed = Math.max(0, now - this.polledAt) * 1000
    const positionMs = Math.min(this.state.durationMs, this.state.positionMs + elapsed)
    return { ...this.state, positionMs }
  }

  private async command(
    path: string,
    method: 'PUT' | 'POST',
    query: Record<string, string> = {},
  ): Promise<boolean> {
    const token = await this.accessToken()
    if (!token) return false
    const url = new URL(`${API}${path}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    try {
      const res = await this.fetchFn(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' },
      })
      if (res.status === 403 || res.status === 404) {
        // Spotify returns these when no device is active.
        this.status = 'no-device'
        this.emit('change')
        return false
      }
      if (!res.ok) return false
      // The API needs a moment to settle, so poll after a short delay.
      setTimeout(() => void this.poll(), 300)
      return true
    } catch {
      this.status = 'offline'
      return false
    }
  }

  play(): Promise<boolean> {
    return this.command('/me/player/play', 'PUT')
  }
  pause(): Promise<boolean> {
    return this.command('/me/player/pause', 'PUT')
  }
  next(): Promise<boolean> {
    return this.command('/me/player/next', 'POST')
  }
  previous(): Promise<boolean> {
    return this.command('/me/player/previous', 'POST')
  }
  setVolume(percent: number): Promise<boolean> {
    const clamped = Math.min(100, Math.max(0, Math.round(percent)))
    return this.command('/me/player/volume', 'PUT', { volume_percent: String(clamped) })
  }
  toggleShuffle(): Promise<boolean> {
    const next = !(this.state?.shuffle ?? false)
    return this.command('/me/player/shuffle', 'PUT', { state: String(next) })
  }
  cycleRepeat(): Promise<boolean> {
    const next = SpotifySource.nextRepeat(this.state?.repeat ?? 'off')
    return this.command('/me/player/repeat', 'PUT', { state: next })
  }

  /**
   * Returns the cached album art for a track, or null. It downloads in the
   * background and emits `change` when the image arrives, so the render loop
   * never waits on the network.
   */
  getArt(trackId: string, url: string | null): Buffer | null {
    if (!trackId) return null
    const cached = this.artCache.get(trackId)
    if (cached) return cached
    const onDisk = join(paths.artDir, `${trackId}.img`)
    if (existsSync(onDisk)) {
      try {
        const buf = readFileSync(onDisk)
        this.remember(trackId, buf)
        return buf
      } catch {
        // Fall through to a download.
      }
    }
    if (url) void this.download(trackId, url)
    return null
  }

  private async download(trackId: string, url: string): Promise<void> {
    try {
      const res = await this.fetchFn(url, {})
      if (!res.ok) return
      const buf = Buffer.from(await res.arrayBuffer())
      this.remember(trackId, buf)
      mkdirSync(paths.artDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(paths.artDir, `${trackId}.img`), buf)
      this.emit('change')
    } catch {
      // No art this time. The page shows the fallback.
    }
  }

  private remember(trackId: string, buf: Buffer): void {
    this.artCache.set(trackId, buf)
    // A Map keeps insertion order, so the first key is the oldest.
    while (this.artCache.size > ART_CACHE_MAX) {
      const oldest = this.artCache.keys().next().value
      if (oldest === undefined) break
      this.artCache.delete(oldest)
    }
  }

  async start(): Promise<void> {
    // Nothing to do until the page becomes visible.
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/sources/spotify.test.ts`
Expected: PASS, 30 tests.

- [ ] **Step 5: Confirm it reads your real playback**

Start playing something in Spotify, then run:
```bash
npx tsx -e "
import { SpotifySource } from './src/sources/spotify.js'
import { readFileSync } from 'node:fs'
import { paths } from './src/paths.js'
const cid = JSON.parse(readFileSync(paths.configFile,'utf8')).spotify.clientId
const s = new SpotifySource(cid)
await s.poll()
console.log('status:', s.getStatus())
console.log(JSON.stringify(s.getState(), null, 2))
"
```
Expected: `status: ok`, and the real track, artist, album, and an `artUrl`.

If it reports `no-device`, nothing is playing. Start a track and retry.

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 212 tests. The typecheck prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/sources/spotify.ts tests/sources/spotify.test.ts
git commit -m "feat: read and control Spotify playback"
```

---

### Task 14: The Spotify page — milestone 3

**Files:**
- Create: `src/pages/spotify-page.ts`
- Modify: `bin/deckd.ts` — add the page. `src/render/canvas.ts` — scale album art.
- Test: `tests/pages/spotify-page.test.ts`

**Interfaces:**
- Consumes: `Page` from Task 10. `SpotifySource`, `PlayerState`, `SpotifyStatus`, `RepeatMode` from Task 13. `formatClock`, `truncate` from Task 2. `theme` from Task 2.
- Produces: `class SpotifyPage implements Page`.

- [ ] **Step 1: Write the failing test**

Create `tests/pages/spotify-page.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { SpotifyPage } from '../../src/pages/spotify-page.js'
import type { PlayerState, SpotifyStatus } from '../../src/sources/spotify.js'

const NOW = 1786549560

function player(over: Partial<PlayerState> = {}): PlayerState {
  return {
    isPlaying: true, title: 'Planet Caravan', artist: 'Black Sabbath',
    album: 'Paranoid', positionMs: 134000, durationMs: 272000,
    trackId: 'track-1', artUrl: 'https://i/mid.jpg', shuffle: true,
    repeat: 'context', volumePercent: 55, hasDevice: true, ...over,
  }
}

function build(state: PlayerState | null, status: SpotifyStatus = 'ok', art: Buffer | null = null) {
  const calls: string[] = []
  const source = {
    interpolate: () => state,
    getStatus: () => status,
    getArt: () => art,
    play: async () => { calls.push('play'); return true },
    pause: async () => { calls.push('pause'); return true },
    next: async () => { calls.push('next'); return true },
    previous: async () => { calls.push('previous'); return true },
    setVolume: async (p: number) => { calls.push(`volume:${p}`); return true },
    toggleShuffle: async () => { calls.push('shuffle'); return true },
    cycleRepeat: async () => { calls.push('repeat'); return true },
    setVisible: (v: boolean) => { calls.push(`visible:${v}`) },
  }
  return { page: new SpotifyPage(source as never), calls }
}

describe('SpotifyPage layout', () => {
  it('returns 8 keys', () => {
    const { page } = build(player())
    expect(page.render(NOW).keys).toHaveLength(8)
  })

  it('puts album art on key 0 when it is cached', () => {
    const art = Buffer.from('png-bytes')
    const { page } = build(player(), 'ok', art)
    const key = page.render(NOW).keys[0]!
    expect(key.kind).toBe('image')
    expect(key.image).toBe(art)
    expect(key.imageKey).toBe('track-1')
  })

  it('falls back to text on key 0 when art is absent', () => {
    const { page } = build(player(), 'ok', null)
    expect(page.render(NOW).keys[0]!.kind).not.toBe('image')
  })

  it('shows SIGN IN on key 0 when unauthorized', () => {
    const { page } = build(null, 'unauthorized')
    expect(page.render(NOW).keys[0]!.lines!.join(' ')).toContain('SIGN IN')
  })

  it('shows a pause glyph while playing', () => {
    const { page } = build(player({ isPlaying: true }))
    expect(page.render(NOW).keys[2]!.glyph).toBe('❙❙')
  })

  it('shows a play glyph while paused', () => {
    const { page } = build(player({ isPlaying: false }))
    expect(page.render(NOW).keys[2]!.glyph).toBe('▶')
  })

  it('shows the skip glyphs on keys 1 and 3', () => {
    const { page } = build(player())
    const keys = page.render(NOW).keys
    expect(keys[1]!.glyph).toBe('◀◀')
    expect(keys[3]!.glyph).toBe('▶▶')
  })

  it('shows the shuffle and repeat state', () => {
    const { page } = build(player({ shuffle: true, repeat: 'track' }))
    const keys = page.render(NOW).keys
    expect(keys[6]!.lines!.join(' ')).toContain('on')
    expect(keys[7]!.lines!.join(' ')).toContain('track')
  })

  it('dims the transport keys when there is no device', () => {
    const { page } = build(null, 'no-device')
    expect(page.render(NOW).keys[2]!.dim).toBe(true)
  })
})

describe('SpotifyPage strip', () => {
  it('shows the artist and the title', () => {
    const { page } = build(player())
    expect(page.render(NOW).strip.lines[0]).toContain('Black Sabbath')
    expect(page.render(NOW).strip.lines[0]).toContain('Planet Caravan')
  })

  it('shows the position and the duration as a clock', () => {
    const { page } = build(player())
    expect(page.render(NOW).strip.right).toBe('2:14 / 4:32')
  })

  it('fills the progress bar to the position fraction', () => {
    const { page } = build(player())
    expect(page.render(NOW).strip.bar!.value).toBeCloseTo(134000 / 272000, 3)
  })

  it('shows nothing playing when there is no state', () => {
    const { page } = build(null, 'no-device')
    expect(page.render(NOW).strip.lines.join(' ')).toContain('nothing playing')
  })

  it('tells the user how to authorize when unauthorized', () => {
    const { page } = build(null, 'unauthorized')
    expect(page.render(NOW).strip.lines.join(' ')).toContain('deckd auth spotify')
  })

  it('handles a zero duration without dividing by zero', () => {
    const { page } = build(player({ durationMs: 0, positionMs: 0 }))
    expect(page.render(NOW).strip.bar!.value).toBe(0)
  })
})

describe('SpotifyPage presses', () => {
  it('pauses when playing', async () => {
    const { page, calls } = build(player({ isPlaying: true }))
    await page.onKeyPress(2)
    expect(calls).toContain('pause')
  })

  it('plays when paused', async () => {
    const { page, calls } = build(player({ isPlaying: false }))
    await page.onKeyPress(2)
    expect(calls).toContain('play')
  })

  it('maps the skip keys', async () => {
    const { page, calls } = build(player())
    await page.onKeyPress(1)
    await page.onKeyPress(3)
    expect(calls).toContain('previous')
    expect(calls).toContain('next')
  })

  it('steps the volume by 10 points', async () => {
    const { page, calls } = build(player({ volumePercent: 55 }))
    await page.onKeyPress(4)
    await page.onKeyPress(5)
    expect(calls).toContain('volume:45')
    expect(calls).toContain('volume:65')
  })

  it('assumes 50 percent when the volume is unknown', async () => {
    const { page, calls } = build(player({ volumePercent: null }))
    await page.onKeyPress(5)
    expect(calls).toContain('volume:60')
  })

  it('maps the shuffle and repeat keys', async () => {
    const { page, calls } = build(player())
    await page.onKeyPress(6)
    await page.onKeyPress(7)
    expect(calls).toContain('shuffle')
    expect(calls).toContain('repeat')
  })

  it('does nothing on the album art key', async () => {
    const { page, calls } = build(player())
    await page.onKeyPress(0)
    expect(calls).toEqual([])
  })

  it('tells the source when it becomes visible', () => {
    const { page, calls } = build(player())
    page.onEnter!()
    page.onLeave!()
    expect(calls).toEqual(['visible:true', 'visible:false'])
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/pages/spotify-page.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 3: Write `src/pages/spotify-page.ts`**

```ts
import type { DeckFrame, KeySpec, StripSpec } from '../render/specs.js'
import { theme, barColor } from '../render/theme.js'
import { truncate, formatClock } from '../render/text.js'
import type { Page } from './types.js'
import type { PlayerState, SpotifyStatus, RepeatMode } from '../sources/spotify.js'

const VOLUME_STEP = 10
const TITLE_CHARS = 34

/** The part of `SpotifySource` this page needs. */
export interface PlayerReader {
  interpolate(now: number): PlayerState | null
  getStatus(): SpotifyStatus
  getArt(trackId: string, url: string | null): Buffer | null
  play(): Promise<boolean>
  pause(): Promise<boolean>
  next(): Promise<boolean>
  previous(): Promise<boolean>
  setVolume(percent: number): Promise<boolean>
  toggleShuffle(): Promise<boolean>
  cycleRepeat(): Promise<boolean>
  setVisible(visible: boolean): void
}

export class SpotifyPage implements Page {
  readonly name = 'spotify'

  constructor(private readonly source: PlayerReader) {}

  onEnter(): void {
    this.source.setVisible(true)
  }

  onLeave(): void {
    this.source.setVisible(false)
  }

  render(now: number): DeckFrame {
    const state = this.source.interpolate(now)
    const status = this.source.getStatus()
    const dead = status === 'no-device' || status === 'unauthorized' || !state

    return {
      keys: [
        this.artKey(state, status),
        { kind: 'control', glyph: '◀◀', dim: dead },
        { kind: 'control', glyph: state?.isPlaying ? '❙❙' : '▶', dim: dead },
        { kind: 'control', glyph: '▶▶', dim: dead },
        { kind: 'control', lines: ['VOL −'], align: 'center', dim: dead },
        { kind: 'control', lines: ['VOL +'], align: 'center', dim: dead },
        { kind: 'control', lines: ['SHUFFLE', state?.shuffle ? 'on' : 'off'], dim: dead },
        { kind: 'control', lines: ['REPEAT', repeatLabel(state?.repeat ?? 'off')], dim: dead },
      ],
      strip: this.strip(state, status),
      buttons: [theme.gray, theme.gray],
    }
  }

  private artKey(state: PlayerState | null, status: SpotifyStatus): KeySpec {
    if (status === 'unauthorized') {
      return { kind: 'control', lines: ['SPOTIFY', 'SIGN IN'], align: 'center', dim: true }
    }
    if (!state) {
      return { kind: 'control', lines: ['SPOTIFY', '—'], align: 'center', dim: true }
    }
    const art = this.source.getArt(state.trackId, state.artUrl)
    if (art) {
      return { kind: 'image', image: art, imageKey: state.trackId }
    }
    // The art downloads in the background. Show the album name meanwhile.
    return { kind: 'control', lines: ['NOW', truncate(state.album, 10)], align: 'center' }
  }

  private strip(state: PlayerState | null, status: SpotifyStatus): StripSpec {
    if (status === 'unauthorized') {
      return { lines: ['spotify not connected', 'run: deckd auth spotify'], dim: true }
    }
    if (!state) {
      return { lines: ['spotify', 'nothing playing'], dim: true }
    }

    const headline = truncate(
      state.artist ? `${state.artist} — ${state.title}` : state.title,
      TITLE_CHARS,
    )
    const fraction = state.durationMs > 0 ? state.positionMs / state.durationMs : 0

    return {
      lines: [headline, ''],
      right: `${formatClock(state.positionMs / 1000)} / ${formatClock(state.durationMs / 1000)}`,
      bar: { value: fraction, color: theme.green },
      dim: status === 'offline',
    }
  }

  async onKeyPress(index: number): Promise<void> {
    const state = this.source.interpolate(Math.floor(Date.now() / 1000))
    const volume = state?.volumePercent ?? 50

    switch (index) {
      case 0:
        return // The art key does nothing.
      case 1:
        await this.source.previous()
        return
      case 2:
        await (state?.isPlaying ? this.source.pause() : this.source.play())
        return
      case 3:
        await this.source.next()
        return
      case 4:
        await this.source.setVolume(volume - VOLUME_STEP)
        return
      case 5:
        await this.source.setVolume(volume + VOLUME_STEP)
        return
      case 6:
        await this.source.toggleShuffle()
        return
      case 7:
        await this.source.cycleRepeat()
        return
      default:
        return
    }
  }
}

function repeatLabel(mode: RepeatMode): string {
  return mode === 'context' ? 'all' : mode
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/pages/spotify-page.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Add the Spotify page to `bin/deckd.ts`**

Album art arrives as a JPEG at 300 × 300, and the key is 96 × 96. Task 3 already scales any `image` to the key size with `drawImage`, so no extra scaling code is needed.

In `start()`, after the Claude page:

```ts
import { SpotifySource } from '../src/sources/spotify.js'
import { SpotifyPage } from '../src/pages/spotify-page.js'

  const clientId = readClientId()
  const spotify = new SpotifySource(clientId)
  await spotify.start()
  pages.add(new SpotifyPage(spotify))
  spotify.on('change', () => void daemon.renderOnce(Math.floor(Date.now() / 1000)))
```

Add `await spotify.stop()` to `shutdown()`.

Move `restorePage(pages)` to run after both pages are added, because a saved index of 1 is invalid while only one page exists.

- [ ] **Step 6: Run the deck with both pages — milestone 3**

Run: `npm run build && node dist/bin/deckd.js start`

Expected:
- The Claude page appears first.
- Press the right touch button. The Spotify page appears.
- Album art appears on key 0 within a second or two. The first render may show the album name while the image downloads.
- The strip shows the artist, the title, the elapsed clock, and a bar that advances once per second.
- Press key 2. Playback pauses, and the glyph becomes `▶` within about 300 ms.
- Press keys 4 and 5. The volume steps by 10.
- Press the left touch button. The Claude page returns.
- Stop playback on every device. Key 0 shows `—`, and the transport keys dim.

- [ ] **Step 7: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 236 tests. The typecheck prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src/pages/spotify-page.ts bin/deckd.ts tests/pages/spotify-page.test.ts
git commit -m "feat: add the Spotify page with album art and transport"
```

---

### Task 15: Install, uninstall, and launchd

**Files:**
- Create: `src/install/install.ts`
- Modify: `bin/deckd.ts`, `README.md`
- Test: `tests/install/install.test.ts`

**Interfaces:**
- Consumes: `paths`, `ensureStateDir` from Task 1.
- Produces:
  - `buildPlist(label, nodePath, scriptPath, logPath): string`.
  - `wrapStatusLine(current: unknown, wrapperPath: string): { statusLine: unknown; inner: string }`.
  - `unwrapStatusLine(current: unknown): unknown`.
  - `isInstalled(settings: unknown): boolean`.
  - `install(): Promise<void>`, `uninstall(): Promise<void>`.

This task changes `~/.claude/settings.json`. That file matters to the user, so the code backs it up, writes to a temporary file, and renames it. A crash cannot leave a broken settings file.

- [ ] **Step 1: Write the failing test**

Create `tests/install/install.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  buildPlist, wrapStatusLine, unwrapStatusLine, isInstalled, WRAPPER_MARKER,
} from '../../src/install/install.js'

const WRAPPER = '/Users/w/.local/state/deckd/statusline-wrapper.sh'

describe('buildPlist', () => {
  it('names the label', () => {
    expect(buildPlist('com.wbard.deckd', '/usr/bin/node', '/x/deckd.js', '/x/out.log'))
      .toContain('<string>com.wbard.deckd</string>')
  })

  it('runs at load and stays alive', () => {
    const p = buildPlist('com.wbard.deckd', '/usr/bin/node', '/x/deckd.js', '/x/out.log')
    expect(p).toContain('RunAtLoad')
    expect(p).toContain('KeepAlive')
  })

  it('passes the start argument', () => {
    const p = buildPlist('com.wbard.deckd', '/usr/bin/node', '/x/deckd.js', '/x/out.log')
    expect(p).toContain('<string>/usr/bin/node</string>')
    expect(p).toContain('<string>/x/deckd.js</string>')
    expect(p).toContain('<string>start</string>')
  })

  it('is a valid plist document', () => {
    const p = buildPlist('com.wbard.deckd', '/usr/bin/node', '/x/deckd.js', '/x/out.log')
    expect(p.startsWith('<?xml')).toBe(true)
    expect(p).toContain('</plist>')
  })
})

describe('wrapStatusLine', () => {
  it('wraps a string command and keeps it as the inner command', () => {
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER)
    expect(r.inner).toBe('~/.claude/statusline.sh')
    expect(JSON.stringify(r.statusLine)).toContain(WRAPPER)
  })

  it('wraps an object command', () => {
    const r = wrapStatusLine({ type: 'command', command: 'foo.sh' }, WRAPPER)
    expect(r.inner).toBe('foo.sh')
    expect((r.statusLine as { command: string }).command).toContain(WRAPPER)
  })

  it('preserves other fields on an object command', () => {
    const r = wrapStatusLine({ type: 'command', command: 'foo.sh', padding: 1 }, WRAPPER)
    expect((r.statusLine as { padding: number }).padding).toBe(1)
    expect((r.statusLine as { type: string }).type).toBe('command')
  })

  it('handles an absent statusline', () => {
    const r = wrapStatusLine(undefined, WRAPPER)
    expect(r.inner).toBe('')
    expect(JSON.stringify(r.statusLine)).toContain(WRAPPER)
  })

  it('embeds the inner command so uninstall can recover it', () => {
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER)
    expect(JSON.stringify(r.statusLine)).toContain('~/.claude/statusline.sh')
  })

  it('includes the marker, so isInstalled can find it', () => {
    const r = wrapStatusLine('x.sh', WRAPPER)
    expect(JSON.stringify(r.statusLine)).toContain(WRAPPER_MARKER)
  })
})

describe('isInstalled', () => {
  it('is false for a clean settings file', () => {
    expect(isInstalled({ statusLine: '~/.claude/statusline.sh' })).toBe(false)
  })

  it('is false when there is no statusline', () => {
    expect(isInstalled({})).toBe(false)
  })

  it('is true after a wrap', () => {
    const r = wrapStatusLine('x.sh', WRAPPER)
    expect(isInstalled({ statusLine: r.statusLine })).toBe(true)
  })
})

describe('unwrapStatusLine', () => {
  it('restores a wrapped string command', () => {
    const r = wrapStatusLine('~/.claude/statusline.sh', WRAPPER)
    expect(unwrapStatusLine(r.statusLine)).toBe('~/.claude/statusline.sh')
  })

  it('restores a wrapped object command', () => {
    const original = { type: 'command', command: 'foo.sh', padding: 1 }
    const r = wrapStatusLine(original, WRAPPER)
    expect(unwrapStatusLine(r.statusLine)).toEqual(original)
  })

  it('round-trips wrap then unwrap for an absent statusline', () => {
    const r = wrapStatusLine(undefined, WRAPPER)
    expect(unwrapStatusLine(r.statusLine)).toBeUndefined()
  })

  it('leaves an unwrapped command alone', () => {
    expect(unwrapStatusLine('plain.sh')).toBe('plain.sh')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/install/install.test.ts`
Expected: FAIL. The error names a missing module.

- [ ] **Step 3: Write `src/install/install.ts`**

The wrapped command records the original inside itself, in a JSON blob after the marker. So uninstall recovers the original with no separate state file to lose.

```ts
import {
  readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync,
  existsSync, chmodSync, mkdirSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { paths, ensureStateDir } from '../paths.js'

const run = promisify(execFile)

/** Marks a wrapped statusline, so install and uninstall recognise their work. */
export const WRAPPER_MARKER = '# deckd-wrapped'

export function buildPlist(
  label: string,
  nodePath: string,
  scriptPath: string,
  logPath: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`
}

interface WrapResult {
  statusLine: unknown
  inner: string
}

/**
 * Builds a statusline command that runs the wrapper first. The original command
 * travels inside the new one, after the marker, so uninstall needs no other
 * record.
 */
export function wrapStatusLine(current: unknown, wrapperPath: string): WrapResult {
  const inner = extractCommand(current)
  const encoded = JSON.stringify({ original: current ?? null })
  const command = `DECKD_INNER=${shellQuote(inner)} ${shellQuote(wrapperPath)} ${WRAPPER_MARKER} ${encoded}`

  if (current && typeof current === 'object') {
    return { statusLine: { ...(current as object), command }, inner }
  }
  return { statusLine: command, inner }
}

/** Recovers the original statusline from a wrapped one. */
export function unwrapStatusLine(current: unknown): unknown {
  const command = extractCommand(current)
  const at = command.indexOf(WRAPPER_MARKER)
  if (at === -1) return current
  try {
    const blob = command.slice(at + WRAPPER_MARKER.length).trim()
    const parsed = JSON.parse(blob) as { original: unknown }
    return parsed.original ?? undefined
  } catch {
    return undefined
  }
}

export function isInstalled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false
  const sl = (settings as Record<string, unknown>).statusLine
  if (sl === undefined) return false
  return extractCommand(sl).includes(WRAPPER_MARKER)
}

function extractCommand(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const c = (v as Record<string, unknown>).command
    if (typeof c === 'string') return c
  }
  return ''
}

/** Quotes a value for `sh`. A path with a space must survive. */
function shellQuote(s: string): string {
  if (s === '') return "''"
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Writes a file through a temporary name, so a crash cannot truncate it. */
function writeAtomic(file: string, content: string, mode = 0o644): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content, { mode })
  renameSync(tmp, file)
}

export async function install(): Promise<void> {
  ensureStateDir()
  const changed: string[] = []

  // 1. Copy the wrapper into the state directory, so an uninstalled repo
  //    cannot break the statusline.
  const wrapperSrc = join(dirname(new URL(import.meta.url).pathname), 'statusline-wrapper.sh')
  const wrapperDst = join(paths.stateDir, 'statusline-wrapper.sh')
  copyFileSync(wrapperSrc, wrapperDst)
  chmodSync(wrapperDst, 0o755)
  changed.push(`wrote ${wrapperDst}`)

  // 2. Wrap the statusline, after a backup.
  const settings = readSettings()
  if (isInstalled(settings)) {
    console.log('deckd is already installed. Run `deckd uninstall` first to redo it.')
    return
  }
  const backup = `${paths.claudeSettings}.deckd-backup`
  if (existsSync(paths.claudeSettings)) {
    copyFileSync(paths.claudeSettings, backup)
    changed.push(`backed up ${paths.claudeSettings} to ${backup}`)
  }
  const { statusLine } = wrapStatusLine(settings.statusLine, wrapperDst)
  settings.statusLine = statusLine
  writeAtomic(paths.claudeSettings, JSON.stringify(settings, null, 2))
  changed.push(`wrapped statusLine in ${paths.claudeSettings}`)

  // 3. Write and load the launchd agent.
  const script = join(process.cwd(), 'dist', 'bin', 'deckd.js')
  if (!existsSync(script)) {
    throw new Error(`build first: ${script} does not exist. Run npm run build.`)
  }
  mkdirSync(dirname(paths.launchAgent), { recursive: true })
  writeAtomic(
    paths.launchAgent,
    buildPlist(paths.launchAgentLabel, process.execPath, script, join(paths.stateDir, 'launchd.log')),
  )
  changed.push(`wrote ${paths.launchAgent}`)
  await bootout()
  await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, paths.launchAgent])
    .catch(() => run('/bin/launchctl', ['load', '-w', paths.launchAgent]))
  changed.push('loaded the launchd agent')

  console.log('deckd installed.\n')
  for (const line of changed) console.log(`  · ${line}`)
  console.log('\nThe deck starts now, and at every login.')
  console.log('macOS may ask to allow automation. Approve it, so window focus works.')
}

export async function uninstall(): Promise<void> {
  const removed: string[] = []

  await bootout()
  if (existsSync(paths.launchAgent)) {
    unlinkSync(paths.launchAgent)
    removed.push(`removed ${paths.launchAgent}`)
  }

  const settings = readSettings()
  if (isInstalled(settings)) {
    const original = unwrapStatusLine(settings.statusLine)
    if (original === undefined) delete settings.statusLine
    else settings.statusLine = original
    writeAtomic(paths.claudeSettings, JSON.stringify(settings, null, 2))
    removed.push(`restored statusLine in ${paths.claudeSettings}`)
  }

  const wrapper = join(paths.stateDir, 'statusline-wrapper.sh')
  if (existsSync(wrapper)) {
    unlinkSync(wrapper)
    removed.push(`removed ${wrapper}`)
  }

  console.log('deckd uninstalled.\n')
  for (const line of removed) console.log(`  · ${line}`)
  console.log(`\nThe state directory remains: ${paths.stateDir}`)
  console.log('It holds your Spotify token. Delete it by hand if you want it gone.')
}

async function bootout(): Promise<void> {
  const uid = process.getuid?.() ?? 501
  await run('/bin/launchctl', ['bootout', `gui/${uid}/${paths.launchAgentLabel}`]).catch(() => {
    // Not loaded. Nothing to stop.
  })
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(paths.claudeSettings, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/install/install.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Add the subcommands to `bin/deckd.ts`**

```ts
import { install, uninstall } from '../src/install/install.js'
```

```ts
  case 'install':
    void install().catch((e) => { console.error(String(e)); process.exit(1) })
    break
  case 'uninstall':
    void uninstall().catch((e) => { console.error(String(e)); process.exit(1) })
    break
```

- [ ] **Step 6: Confirm the round trip on a copy before touching the real file**

```bash
cp ~/.claude/settings.json /tmp/settings-before.json
npm run build
node dist/bin/deckd.js install
node -e "
const a=require('/tmp/settings-before.json');
const b=require(process.env.HOME+'/.claude/settings.json');
console.log('statusLine changed:', JSON.stringify(a.statusLine)!==JSON.stringify(b.statusLine));
console.log('now:', JSON.stringify(b.statusLine).slice(0,120));
"
```
Expected: `statusLine changed: true`, and the new value names the wrapper.

Open a new Claude Code session and confirm the terminal statusline still renders exactly as before. This is the one check that matters most.

Then confirm the cache appears:
```bash
cat ~/.local/state/deckd/usage.json
ls ~/.local/state/deckd/sessions/
```
Expected: `usage.json` holds real `rate_limits` and a recent `ts`. The gauge keys on the deck now show real percentages instead of `--`.

- [ ] **Step 7: Confirm the uninstall restores the file exactly**

```bash
node dist/bin/deckd.js uninstall
diff <(node -e "console.log(JSON.stringify(require('/tmp/settings-before.json'),null,2))") \
     <(node -e "console.log(JSON.stringify(require(process.env.HOME+'/.claude/settings.json'),null,2))") \
  && echo "IDENTICAL"
```
Expected: it prints `IDENTICAL`.

If it differs, fix `unwrapStatusLine` before continuing. A failure here means the uninstall damages the user's settings, and that is the worst outcome this project can produce.

Then reinstall: `node dist/bin/deckd.js install`

- [ ] **Step 8: Confirm launchd runs it**

```bash
launchctl list | grep deckd
```
Expected: one line with the label `com.wbard.deckd` and exit status 0.

Kill the process and confirm `KeepAlive` restarts it:
```bash
pkill -f 'deckd.js start'; sleep 3; launchctl list | grep deckd
```
Expected: it is running again, with a new pid.

- [ ] **Step 9: Finish the README**

Add these sections:

```markdown
## Install

```bash
npm install
npm run build
node dist/bin/deckd.js install
```

The install does three things, and it prints each one:

1. Copies the statusline wrapper into `~/.local/state/deckd/`.
2. Wraps `statusLine` in `~/.claude/settings.json`, after a backup to
   `settings.json.deckd-backup`. Your terminal statusline output does not
   change. The wrapper only saves the rate limit numbers, which no file on disk
   holds.
3. Writes and loads a launchd agent, so the deck starts at login.

`node dist/bin/deckd.js uninstall` reverses all three. It leaves the state
directory, because that directory holds your Spotify token.

## Spotify

```bash
node dist/bin/deckd.js auth spotify --client-id <ID>
```

Create a free app at https://developer.spotify.com/dashboard first. Add this
redirect URI exactly:

```
http://127.0.0.1:23400/callback
```

Spotify rejects `localhost` for a plain HTTP redirect, so the URI must use the
loopback IP.

## Permissions

macOS asks to allow automation the first time the deck focuses a terminal
window. Approve it. Without approval the session keys still show status, but a
press cannot raise the window.

## Layout

**Claude page.** Keys 0 to 3 hold live sessions, newest first. A session keeps
its key while it lives, so the display does not move while you read it. Keys 4
to 7 show the 5-hour usage, the 7-day usage, the pace, and the reset countdown.
Press a session key to focus its terminal.

**Spotify page.** Key 0 shows album art. Keys 1 to 3 are previous, play or
pause, and next. Keys 4 and 5 step the volume. Keys 6 and 7 toggle shuffle and
cycle repeat.

**Paging.** The left touch button goes back a page. The right goes forward.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `cannot open the Stream Deck Neo` | Another process owns it. Quit the Elgato app or a second deckd. |
| Gauges show `--` | The statusline wrapper is not installed, or no Claude session has rendered yet. |
| Gauges show `STALE` | No Claude session has rendered a statusline in 15 minutes. |
| Keys show `no session data` | `~/.claude/daisy-statusbar/state.d/` is absent. |
| Key 0 shows `SIGN IN` | Run `deckd auth spotify`. |
| A transport key flashes red | No active Spotify device. Start playback somewhere. |
| A press does not focus a window | Approve the macOS automation prompt. |

Logs are at `~/.local/state/deckd/deckd.log`.
```

- [ ] **Step 10: Run the whole suite and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, 253 tests. The typecheck prints nothing.

- [ ] **Step 11: Commit**

```bash
git add src/install/install.ts bin/deckd.ts tests/install/install.test.ts README.md
git commit -m "feat: install and uninstall with a launchd agent"
```

- [ ] **Step 12: Push**

```bash
git push
```

---

## Spec coverage check

Every numbered spec section maps to a task.

| Spec section | Task |
| --- | --- |
| 4, verified hardware facts | 4, 5 |
| 5.1, module boundaries | 1 to 4, 10, 11 |
| 5.2, render loop and dirty keys | 11 |
| 6.1, Claude session state | 6 |
| 6.2, rate limit usage and the wrapper | 7 |
| 6.3, Spotify | 12, 13 |
| 7.1, session keys and key holding | 8, 10 |
| 7.2, gauge keys | 10 |
| 7.3, presses and window focus | 9, 10 |
| 7.4, strip | 10 |
| 8, Spotify page | 14 |
| 9, paging and saved page index | 11 |
| 10, install and uninstall | 15 |
| 11, rendering | 2, 3, 10 |
| 12, failure modes | 4, 6, 7, 11, 13 |
| 13, testing | every task |
| 14, future scope, lights | none, by design |

Two spec items are deliberately absent from the plan. The `state.d` fallback hooks in section 6.1 stay out, because v1 reads `state.d` and reports a clear message when it is absent. The transcript token count in section 14.2 is future scope.

