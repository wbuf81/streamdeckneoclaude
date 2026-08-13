import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs'
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

  const runAsync = (payload: string, seen: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', [WRAPPER], {
        env: {
          ...process.env,
          DECKD_STATE_DIR: dir,
          DECKD_INNER: `${inner} ${seen}`,
        },
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`wrapper exited ${String(code)}: ${stderr}`))
      })
      child.stdin.end(payload)
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

  it('passes trailing blank lines through to the inner command, exact byte count', () => {
    // $(cat) in a shell variable strips trailing newlines. A payload ending
    // in two newlines proves the wrapper preserves them: 9 bytes in must be
    // 9 bytes out, not 7.
    const payload = '{"a":1}\n\n'
    execFileSync('/bin/sh', [WRAPPER], {
      input: payload,
      env: {
        ...process.env,
        DECKD_STATE_DIR: dir,
        DECKD_INNER: `${inner} ${join(dir, 'seen.json')}`,
      },
      encoding: 'utf8',
    })
    const seen = readFileSync(join(dir, 'seen.json'), 'utf8')
    expect(Buffer.byteLength(seen, 'utf8')).toBe(Buffer.byteLength(payload, 'utf8'))
    expect(seen).toBe(payload)
  })

  it('rejects a session_id with path traversal characters', () => {
    // "/" is outside the allowed charset, so "../evil" is rejected outright.
    // Without the guard, "$STATE_DIR/sessions/../evil.json" resolves to
    // "$STATE_DIR/evil.json" — one directory above where per-session files
    // belong, inside the user's state directory.
    const payload = JSON.stringify({
      session_id: '../evil',
      model: { display_name: 'Opus 5' },
      rate_limits: { five_hour: { used_percentage: 1, resets_at: 1 } },
    })
    execFileSync('/bin/sh', [WRAPPER], {
      input: payload,
      env: {
        ...process.env,
        DECKD_STATE_DIR: dir,
        DECKD_INNER: `${inner} ${join(dir, 'seen.json')}`,
      },
      encoding: 'utf8',
    })
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
    expect(existsSync(join(dir, 'evil.json'))).toBe(false)
    expect(existsSync(join(dir, 'evil.json.tmp'))).toBe(false)
    expect(existsSync(join(dir, 'sessions', 'evil.json'))).toBe(false)
  })

  it('keeps concurrent cache writes atomic and leaves no temporary files', async () => {
    const runs = Array.from({ length: 16 }, (_, i) => {
      const payload = JSON.stringify({
        session_id: `session-${i}`,
        model: { display_name: `Model ${i}` },
        rate_limits: { five_hour: { used_percentage: i, resets_at: i } },
      })
      return runAsync(payload, join(dir, `seen-${i}.json`))
    })

    await Promise.all(runs)
    const usage = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'))
    expect(typeof usage.rate_limits.five_hour.used_percentage).toBe('number')
    for (let i = 0; i < 16; i++) {
      const session = JSON.parse(readFileSync(join(dir, 'sessions', `session-${i}.json`), 'utf8'))
      expect(session.model).toBe(`Model ${i}`)
    }
    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([])
    expect(readdirSync(join(dir, 'sessions')).filter((name) => name.startsWith('.'))).toEqual([])
  })
})
