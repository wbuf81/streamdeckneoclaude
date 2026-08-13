import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSource, runSqlite } from '../../src/sources/codex.js'
import { CodexPage } from '../../src/pages/codex-page.js'

// Deliberately does NOT mock `node:child_process` — every other test file
// under tests/sources/ mocks `execFile` so its tests stay hermetic and fast.
// This file is the one exception: the live bug this fix addresses is a real
// sqlite3-vs-WAL interaction (docs/VERIFIED-FACTS.md), and re-deriving that
// interaction from an injected fake would just re-encode the same wrong
// assumption an earlier review already made once. So this file builds a
// REAL, on-disk WAL-mode database — outside `~`, never touching the user's
// actual `~/.codex` state — and calls the REAL `runSqlite`, through the
// REAL `/usr/bin/sqlite3` binary, exactly the technique that already caught
// the earlier wrong "`mode=ro` creates the `-shm` itself" claim.

/** Builds a real WAL-mode sqlite database with one `threads` row matching
 * the columns `THREAD_QUERY` selects, at `dir/state.sqlite`. Uses the same
 * `/usr/bin/sqlite3` CLI `runSqlite` itself shells out to, so the resulting
 * file is byte-for-byte what a real Codex install would produce, not a
 * hand-rolled approximation of one. */
function buildScratchDb(dir: string): string {
  const db = join(dir, 'state.sqlite')
  execFileSync('/usr/bin/sqlite3', [db, `
    PRAGMA journal_mode=WAL;
    CREATE TABLE threads(
      id TEXT, rollout_path TEXT, updated_at_ms INTEGER, title TEXT,
      cwd TEXT, model TEXT, tokens_used INTEGER, archived INTEGER,
      thread_source TEXT, preview TEXT
    );
    INSERT INTO threads VALUES
      ('t1', '', 0, '', '', '', NULL, 0, 'user', 'non-empty preview');
  `])
  return db
}

/** Removes the `-wal`/`-shm` sidecars by hand, reproducing the exact state
 * Codex's own database sits in whenever Codex itself is not currently
 * holding it open — measured (docs/VERIFIED-FACTS.md) to be its normal
 * resting state, not a rare edge case. */
function removeSidecars(db: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${db}${suffix}`
    if (existsSync(sidecar)) unlinkSync(sidecar)
  }
}

describe('runSqlite against a real WAL database, sidecars absent', () => {
  it('fails the primary mode=ro attempt and succeeds via the immutable=1 fallback, tagged degraded, creating no sidecar file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-wal-'))
    try {
      const db = buildScratchDb(dir)
      removeSidecars(db)
      expect(existsSync(`${db}-wal`)).toBe(false)
      expect(existsSync(`${db}-shm`)).toBe(false)

      const read = await runSqlite(db, 'SELECT id FROM threads;')
      expect(read.degraded).toBe(true)
      expect(read.text).toContain('t1')

      // The one thing that must never happen, whichever mode succeeds: a
      // read-write open, which would create the `-shm` sidecar and mutate
      // Codex's own on-disk state. Confirms this fallback read did not.
      expect(existsSync(`${db}-wal`)).toBe(false)
      expect(existsSync(`${db}-shm`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flows through CodexSource and CodexPage as a degraded, dimmed read that satisfies no freshness check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-wal-'))
    try {
      const db = buildScratchDb(dir)
      removeSidecars(db)
      const source = new CodexSource(
        db,
        runSqlite,
        () => ({ text: '', size: 0, consumedTo: 0 }), // this row's rollout_path is empty, so this is never called.
        () => 1000,
      )
      const page = new CodexPage(source)
      try {
        await source.refresh()
        expect(source.isAvailable()).toBe(true) // real data, shown rather than an empty page...
        expect(source.isDegraded()).toBe(true)
        expect(source.isStale()).toBe(true) // ...but it never satisfies a freshness check.

        const frame = page.render(1000)
        // The permanent OpenAI Codex identity tile (key 3) dims under the
        // same `readStale` signal every other accounting tile already
        // dims under — see codex-page.ts's `render()`.
        expect(frame.keys[3]!.dim).toBe(true)
      } finally {
        await source.stop()
      }

      // Never opened read-write: still no sidecar files after the whole
      // CodexSource/CodexPage round trip, not just the bare runSqlite call.
      expect(existsSync(`${db}-wal`)).toBe(false)
      expect(existsSync(`${db}-shm`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
