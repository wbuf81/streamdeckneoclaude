import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseConfig,
  loadConfig,
  DEFAULT_SYMBOLS,
  MAX_SYMBOLS,
  EMPTY_CONFIG,
} from '../src/config.js'

/** Collects the warnings a parse produced, so a test can assert that a
 * rejected value was REPORTED and not merely dropped. A configuration
 * mistake that disables a page in silence is the failure mode this whole
 * module exists to avoid. */
function collect(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = []
  return { warn: (m) => messages.push(m), messages }
}

const TEAM = {
  id: 'gators',
  label: 'GATORS',
  short: 'UF',
  league: 'college-football',
  espnId: '57',
  fullName: 'Florida Gators',
  logoUrl: 'https://example.test/uf.png',
}
const OTHER = { ...TEAM, id: 'jaguars', label: 'JAGUARS', short: 'JAX', league: 'nfl', espnId: '30' }

describe('parseConfig — an empty or malformed file', () => {
  it('treats an absent object as every default', () => {
    const { warn } = collect()
    expect(parseConfig({}, warn)).toEqual(EMPTY_CONFIG)
  })

  it('reports a non-object and falls back rather than throwing', () => {
    for (const bad of [null, 42, 'nope', []]) {
      const { warn, messages } = collect()
      expect(parseConfig(bad, warn)).toEqual(EMPTY_CONFIG)
      expect(messages.join(' ')).toContain('JSON object')
    }
  })
})

describe('parseConfig — the ZIP code', () => {
  it('accepts five digits', () => {
    const { warn, messages } = collect()
    expect(parseConfig({ weather: { zip: '90210' } }, warn).zip).toBe('90210')
    expect(messages).toEqual([])
  })

  it('trims surrounding whitespace', () => {
    const { warn } = collect()
    expect(parseConfig({ weather: { zip: '  90210  ' } }, warn).zip).toBe('90210')
  })

  it('rejects anything that is not five digits, and says so', () => {
    for (const bad of ['9021', '902100', 'ABCDE', '9021O', 90210]) {
      const { warn, messages } = collect()
      expect(parseConfig({ weather: { zip: bad } }, warn).zip).toBeNull()
      if (typeof bad === 'string') {
        expect(messages.join(' ')).toContain('five digits')
      }
    }
  })

  it('is null, never a fallback, when the section is absent', () => {
    const { warn, messages } = collect()
    expect(parseConfig({ weather: {} }, warn).zip).toBeNull()
    // Absent is not a mistake. Nothing to report.
    expect(messages).toEqual([])
  })
})

describe('parseConfig — the watchlist', () => {
  it('falls back to the generic default when absent', () => {
    const { warn } = collect()
    expect(parseConfig({}, warn).symbols).toEqual(DEFAULT_SYMBOLS)
    expect(parseConfig({ stocks: {} }, warn).symbols).toEqual(DEFAULT_SYMBOLS)
  })

  it('upper-cases what it is given', () => {
    const { warn } = collect()
    expect(parseConfig({ stocks: { symbols: ['spy', 'qqq'] } }, warn).symbols).toEqual(['SPY', 'QQQ'])
  })

  it('clamps to the eight keys the deck has, and says it did', () => {
    const nine = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']
    const { warn, messages } = collect()
    const got = parseConfig({ stocks: { symbols: nine } }, warn).symbols
    expect(got).toHaveLength(MAX_SYMBOLS)
    expect(got).toEqual(nine.slice(0, MAX_SYMBOLS))
    expect(messages.join(' ')).toContain('the deck shows 8')
  })

  it('rejects a non-array, an empty array, and a non-string member', () => {
    for (const bad of ['SPY', [], [1, 2], ['SPY', null]]) {
      const { warn, messages } = collect()
      expect(parseConfig({ stocks: { symbols: bad } }, warn).symbols).toEqual(DEFAULT_SYMBOLS)
      expect(messages.join(' ')).toContain('stocks.symbols')
    }
  })
})

describe('parseConfig — the teams', () => {
  it('accepts a complete pair, in row order', () => {
    const { warn, messages } = collect()
    const teams = parseConfig({ football: { top: TEAM, bottom: OTHER } }, warn).teams
    expect(teams?.[0]?.id).toBe('gators')
    expect(teams?.[1]?.id).toBe('jaguars')
    expect(messages).toEqual([])
  })

  it('is null and silent when the whole section is absent', () => {
    const { warn, messages } = collect()
    expect(parseConfig({}, warn).teams).toBeNull()
    expect(messages).toEqual([])
  })

  it('names every missing field rather than failing on the first', () => {
    const { warn, messages } = collect()
    const partial = { id: 'x', label: 'X' }
    expect(parseConfig({ football: { top: partial, bottom: OTHER } }, warn).teams).toBeNull()
    const text = messages.join(' ')
    for (const field of ['short', 'league', 'espnId', 'fullName', 'logoUrl']) {
      expect(text).toContain(field)
    }
  })

  it('rejects an unknown league', () => {
    const { warn, messages } = collect()
    const bad = { ...TEAM, league: 'basketball' }
    expect(parseConfig({ football: { top: bad, bottom: OTHER } }, warn).teams).toBeNull()
    expect(messages.join(' ')).toContain('nfl or college-football')
  })

  it('refuses a half-configured section rather than rendering one row', () => {
    const { warn, messages } = collect()
    expect(parseConfig({ football: { top: TEAM } }, warn).teams).toBeNull()
    expect(messages.join(' ')).toContain('The football page is off.')
  })

  it('refuses two teams that share an id', () => {
    // Every cache in the source is keyed by id, so a duplicate would make one
    // team silently overwrite the other's schedule, record, and crest.
    const { warn, messages } = collect()
    expect(parseConfig({ football: { top: TEAM, bottom: { ...OTHER, id: TEAM.id } } }, warn).teams).toBeNull()
    expect(messages.join(' ')).toContain('share the id')
  })
})

describe('parseConfig — section independence', () => {
  it('keeps every good section when one is malformed', () => {
    // AGENTS.md: a schema problem must not stop the daemon or unrelated
    // pages. Break the football section and the other three must survive
    // intact — this is the property the whole per-section design exists for.
    const { warn } = collect()
    const got = parseConfig(
      {
        spotify: { clientId: 'abc' },
        weather: { zip: '90210' },
        stocks: { symbols: ['spy'] },
        football: { top: 'not an object', bottom: OTHER },
        // An unknown section, of the kind an older or newer deckd may leave
        // behind. It must be ignored, never fatal, and never dropped from the
        // file — nothing here rewrites it.
        knob: { hosts: ['a.local'] },
      },
      warn,
    )
    expect(got.spotifyClientId).toBe('abc')
    expect(got.zip).toBe('90210')
    expect(got.symbols).toEqual(['SPY'])
    expect(got.teams).toBeNull()
  })
})

describe('loadConfig', () => {
  it('is silent about a file that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-config-'))
    try {
      const { warn, messages } = collect()
      expect(loadConfig(join(dir, 'nope.json'), warn)).toEqual(EMPTY_CONFIG)
      expect(messages).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a file that exists but is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-config-'))
    const file = join(dir, 'config.json')
    try {
      writeFileSync(file, '{ this is not json')
      const { warn, messages } = collect()
      expect(loadConfig(file, warn)).toEqual(EMPTY_CONFIG)
      expect(messages.join(' ')).toContain('not valid JSON')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a file it cannot read for a reason other than absence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-config-'))
    const file = join(dir, 'config.json')
    try {
      writeFileSync(file, '{}')
      chmodSync(file, 0o000)
      const { warn, messages } = collect()
      const got = loadConfig(file, warn)
      // Running as root defeats the mode, and then the read simply succeeds.
      // Assert the branch only when the permission actually bit.
      if (messages.length > 0) {
        expect(messages.join(' ')).toContain('cannot read')
        expect(got).toEqual(EMPTY_CONFIG)
      }
    } finally {
      chmodSync(file, 0o600)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a real file end to end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckd-config-'))
    const file = join(dir, 'config.json')
    try {
      writeFileSync(
        file,
        JSON.stringify({
          spotify: { clientId: 'cid' },
          weather: { zip: '10001' },
          stocks: { symbols: ['aapl'] },
          football: { top: TEAM, bottom: OTHER },
        }),
      )
      const { warn, messages } = collect()
      const got = loadConfig(file, warn)
      expect(messages).toEqual([])
      expect(got.spotifyClientId).toBe('cid')
      expect(got.zip).toBe('10001')
      expect(got.symbols).toEqual(['AAPL'])
      expect(got.teams?.[1]?.short).toBe('JAX')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
