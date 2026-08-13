import { describe, it, expect, vi } from 'vitest'

// Isolated in its own file, per the pattern in tests/install/install.test.ts,
// so mocking `node:child_process` here cannot affect the CodexSource tests
// in codex.test.ts, which inject their own `SqliteRunner` fake and never
// touch the real `execFile` path at all.
// `vi.mock`'s factory is hoisted above every top-level statement in this
// file, including a plain `const`, so the mock function itself must be
// created inside `vi.hoisted` — mirrors tests/install/install.test.ts.
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (error: Error | null, stdout: string, stderr: string) => void,
    ) => cb(null, '[]', ''),
  ),
}))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { runSqlite } from '../../src/sources/codex.js'

describe('runSqlite', () => {
  // The `-readonly` CLI flag against a plain path was measured to fail
  // intermittently (SQLITE_CANTOPEN) against the live WAL-mode database, so
  // the primary attempt now opens through the URI form with `mode=ro`
  // instead — see `runSqlite`'s own doc comment in src/sources/codex.ts for
  // the full reasoning and its fallback to `immutable=1`. This test only
  // covers the primary attempt's shape and the shared timeout bound; the
  // fallback and failure paths are covered in tests/sources/codex.test.ts.
  it('bounds stdout and bounds a hung child with a timeout (I6, I9)', async () => {
    await runSqlite('/tmp/does-not-matter.sqlite', 'SELECT 1;')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = execFileMock.mock.calls[0]!
    expect(cmd).toBe('/usr/bin/sqlite3')
    expect(args).toContain('-json')
    expect(args.some((arg) => arg.startsWith('file:') && arg.includes('mode=ro'))).toBe(true)
    expect(opts).toMatchObject({ maxBuffer: 1024 * 1024 })
    // A stop() that awaits an in-flight refresh must not be able to hang
    // forever behind an unresponsive sqlite3 child — see the review's I9.
    expect(typeof (opts as { timeout?: unknown }).timeout).toBe('number')
    expect((opts as { timeout: number }).timeout).toBeGreaterThan(0)
  })
})
