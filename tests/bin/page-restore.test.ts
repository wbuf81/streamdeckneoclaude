import { describe, it, expect } from 'vitest'
import { restorePage, savePage } from '../../bin/deckd.js'
import { PageManager } from '../../src/page-manager.js'
import type { Page } from '../../src/pages/types.js'
import type { DeckFrame } from '../../src/render/specs.js'

/**
 * I8 — `restorePage` and `savePage` had zero tests before this file, and the
 * legacy `+1` migration ran whenever a saved `pageName` failed to resolve,
 * not only when `pageName` was absent altogether. Every test here reads and
 * writes an IN-MEMORY string, never the real `ui.json` under `~` — `readFile`
 * and `writeFile` are injected, exactly so this file can stay off the real
 * home directory.
 */

function fakePage(name: string): Page {
  return {
    name,
    render: (): DeckFrame => ({
      keys: Array.from({ length: 8 }, () => ({ kind: 'blank' as const })),
      strip: { lines: [name] },
      buttons: [[0, 0, 0], [0, 0, 0]],
    }),
    onKeyPress: () => {},
  }
}

/** Builds the five-page manager in today's real order: Claude, Codex,
 * Spotify, Stocks, Weather — Codex inserted at index 1, matching the
 * migration comment in `bin/deckd.ts`. */
function fivePageManager(): PageManager {
  const m = new PageManager()
  for (const name of ['claude', 'codex', 'spotify', 'stocks', 'weather']) m.add(fakePage(name))
  return m
}

function readerFor(json: string | null): (path: string, encoding: 'utf8') => string {
  return () => {
    if (json === null) throw new Error('ENOENT: no such file')
    return json
  }
}

describe('restorePage', () => {
  it('restores a page by its saved name when it still exists', () => {
    const pages = fivePageManager()
    restorePage(pages, readerFor(JSON.stringify({ page: 1, pageName: 'codex' })))
    expect(pages.current().name).toBe('codex')
  })

  it('falls back to the first page when a saved name no longer resolves, without applying the legacy +1 shift', () => {
    // The exact review scenario: Codex is later renamed to something else,
    // and ui.json still holds the OLD name at index 1 — written by today's
    // own savePage, not legacy data. `1 + 1` would silently land on
    // 'stocks' (index 2 in a Claude/spotify/stocks/weather-without-codex
    // world) or whatever sits there; it must not.
    const pages = fivePageManager() // has no page literally named 'openai-codex'
    restorePage(pages, readerFor(JSON.stringify({ page: 1, pageName: 'openai-codex' })))
    expect(pages.current().name).toBe('claude') // the default first page, untouched
  })

  it('resolves a duplicate name deterministically to its first match, without throwing', () => {
    const pages = new PageManager()
    pages.add(fakePage('claude'))
    pages.add(fakePage('codex'))
    pages.add(fakePage('codex')) // a duplicate, as a defensive edge case
    expect(() => restorePage(pages, readerFor(JSON.stringify({ pageName: 'codex' })))).not.toThrow()
    expect(pages.index).toBe(1)
  })

  it('does nothing on a first run with no saved file', () => {
    const pages = fivePageManager()
    restorePage(pages, readerFor(null))
    expect(pages.current().name).toBe('claude')
  })

  it('applies the legacy +1 shift only when pageName is entirely absent', () => {
    // Old-format ui.json, from before stable page names existed at all.
    const pages = fivePageManager()
    restorePage(pages, readerFor(JSON.stringify({ page: 1 })))
    expect(pages.current().name).toBe('spotify') // old index 1 (Spotify) -> new index 2
  })

  it('leaves the legacy page 0 unshifted', () => {
    const pages = fivePageManager()
    restorePage(pages, readerFor(JSON.stringify({ page: 0 })))
    expect(pages.current().name).toBe('claude')
  })

  it('ignores a non-integer legacy page index rather than corrupting the manager', () => {
    const pages = fivePageManager()
    expect(() => restorePage(pages, readerFor(JSON.stringify({ page: 1.5 })))).not.toThrow()
    expect(pages.current().name).toBe('claude')
  })

  it('does not apply the legacy shift for an absent pageName combined with a present but unresolved one on a later read', () => {
    // Guards the exact regression: pageName present-but-stale must never
    // fall through into the numeric branch, even when `page` is also set.
    const pages = fivePageManager()
    restorePage(pages, readerFor(JSON.stringify({ page: 0, pageName: 'renamed-claude' })))
    expect(pages.current().name).toBe('claude') // NOT shifted to index 1 ('codex')
  })
})

describe('savePage', () => {
  it("writes the current page's stable name and numeric index", () => {
    const pages = fivePageManager()
    pages.setByName('spotify')
    let written: { path: string; data: string } | null = null
    savePage(pages, (path, data) => { written = { path, data } })
    expect(written).not.toBeNull()
    expect(JSON.parse(written!.data)).toEqual({ page: 2, pageName: 'spotify' })
  })

  it('does not throw when the write fails', () => {
    const pages = fivePageManager()
    expect(() => savePage(pages, () => { throw new Error('disk full') })).not.toThrow()
  })
})
