import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
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

/**
 * Starts a REAL `/usr/bin/sqlite3` CLI process against `db`, keeps its
 * stdin pipe open (never sends `.exit`), and has it hold
 * `PRAGMA locking_mode=EXCLUSIVE` after inserting one row — reproducing,
 * with the real binary rather than a mock, the exact state
 * docs/VERIFIED-FACTS.md calls "the exclusive-lock trap": a live writer
 * that makes a real primary `mode=ro` read fail with
 * `database is locked (5)`, and makes the SAME `immutable=1` fallback
 * SUCCEED while silently missing the row this writer just committed,
 * because `immutable=1` never reads the `-wal` at all. `ready` resolves
 * once the CLI has echoed back a `.print READY` sentinel written AFTER the
 * insert, so the caller knows the insert (and the `-wal` write it produces)
 * has actually happened before proceeding — a plain `setTimeout` guess
 * would be exactly the kind of unmeasured assumption lesson 17 warns
 * against. `release()` sends `.exit` and waits for the process to exit,
 * so a test's `finally` can always clean this up even if an assertion
 * above it throws.
 */
function spawnExclusiveWriter(db: string, insertSql: string): { ready: Promise<void>; release: () => Promise<void> } {
  const child = spawn('/usr/bin/sqlite3', [db], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes('READY')) resolve()
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (!stdout.includes('READY')) reject(new Error(`sqlite3 exited (code ${code}) before READY: ${stdout}`))
    })
  })
  child.stdin.write('PRAGMA journal_mode=WAL;\n')
  child.stdin.write('PRAGMA locking_mode=EXCLUSIVE;\n')
  child.stdin.write(`${insertSql}\n`)
  child.stdin.write('.print READY\n')
  const release = () => new Promise<void>((resolve) => {
    child.on('exit', () => resolve())
    child.stdin.write('.exit\n')
    child.stdin.end()
  })
  return { ready, release }
}

describe('runSqlite against a real WAL database, sidecars absent', () => {
  // I3 — with the `-wal` sidecar absent, `immutable=1` cannot be missing
  // anything: there was nothing in the WAL to miss. Before this round's
  // fix, EVERY fallback read was tagged degraded unconditionally, which
  // made this — Codex's own NORMAL resting state whenever it is not this
  // instant writing — read as permanently degraded on the real page. This
  // is now reported as an EXACT read, the same as a primary one.
  it('fails the primary mode=ro attempt, succeeds via the immutable=1 fallback, and reports it EXACT (not degraded), creating no sidecar file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-wal-'))
    try {
      const db = buildScratchDb(dir)
      removeSidecars(db)
      expect(existsSync(`${db}-wal`)).toBe(false)
      expect(existsSync(`${db}-shm`)).toBe(false)

      const read = await runSqlite(db, 'SELECT id FROM threads;')
      expect(read.degraded).toBe(false)
      expect(read.walBytes).toBe(0)
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

  it('flows through CodexSource and CodexPage as an EXACT, undimmed read that satisfies a freshness check', async () => {
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
        expect(source.isAvailable()).toBe(true)
        expect(source.isDegraded()).toBe(false)
        expect(source.isStale()).toBe(false) // an EXACT read satisfies a freshness check.
        expect(source.staleForSeconds()).toBe(0)

        const frame = page.render(1000)
        // The permanent OpenAI Codex identity tile (key 3) does NOT dim —
        // this is the everyday, sidecar-absent path, not a degraded one.
        expect(frame.keys[3]!.dim).toBe(false)
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

describe('runSqlite against a real WAL database, wal sidecar holds real content', () => {
  // I3 — the mirror case, and the one that actually deserves the word
  // "degraded": a real, uncheckpointed write sitting in a non-empty `-wal`
  // that `immutable=1` genuinely cannot see. Reproduces the exact
  // exclusive-lock trap docs/VERIFIED-FACTS.md describes, with the real
  // `/usr/bin/sqlite3` binary on both sides — a live writer under
  // `PRAGMA locking_mode=exclusive`, matching a real primary `mode=ro`
  // failing with `database is locked (5)`.
  it('makes the primary mode=ro attempt fail, and reports the immutable=1 fallback genuinely DEGRADED, missing the uncheckpointed row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-wal-'))
    const writer = spawnExclusiveWriter(
      buildScratchDb(dir),
      `INSERT INTO threads VALUES ('t2', '', 0, '', '', '', NULL, 0, 'user', 'wal-only preview');`,
    )
    try {
      const db = join(dir, 'state.sqlite')
      await writer.ready
      expect(existsSync(`${db}-wal`)).toBe(true)
      expect(statSync(`${db}-wal`).size).toBeGreaterThan(0)

      const read = await runSqlite(db, 'SELECT id FROM threads;')
      expect(read.degraded).toBe(true)
      expect(read.walBytes).toBeGreaterThan(0)
      expect(read.text).toContain('t1') // the checkpointed row: still visible.
      expect(read.text).not.toContain('t2') // the wal-only row: genuinely missed.

      // Never opened read-write, and the writer's own sidecars are
      // untouched by this read either way.
      expect(existsSync(`${db}-wal`)).toBe(true)
    } finally {
      await writer.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flows through CodexSource and CodexPage as a genuinely degraded, dimmed read labelled STALE, that satisfies no freshness check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-codex-wal-'))
    const writer = spawnExclusiveWriter(
      buildScratchDb(dir),
      `INSERT INTO threads VALUES ('t2', '', 0, '', '', '', NULL, 0, 'user', 'wal-only preview');`,
    )
    try {
      const db = join(dir, 'state.sqlite')
      await writer.ready
      const source = new CodexSource(
        db,
        runSqlite,
        () => ({ text: '', size: 0, consumedTo: 0 }),
        () => 1000,
      )
      const page = new CodexPage(source)
      try {
        await source.refresh()
        expect(source.isAvailable()).toBe(true) // real data, shown rather than an empty page...
        expect(source.isDegraded()).toBe(true)
        expect(source.isStale()).toBe(true) // ...but it never satisfies a freshness check.
        expect(source.staleForSeconds()).toBeNull() // no EXACT read has ever happened.

        const frame = page.render(1000)
        expect(frame.keys[3]!.dim).toBe(true)
        // I3 — a word beats a shade when the shade is permanent: task tiles
        // (this database has no active task, so key 0 is blank; the
        // accounting tiles are what carry the label here since there is no
        // usage sample). The identity tile dims; the source-level assertions
        // above are what actually confirm the genuinely-degraded path this
        // test targets.
      } finally {
        await source.stop()
      }
    } finally {
      await writer.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
