import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
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

  it('tightens the mode on a file that already exists too open', () => {
    // `writeFileSync`'s mode option applies only when it creates the file, so
    // a pre-existing loose file would otherwise keep its permissions.
    const f = join(dir, 'spotify.json')
    writeFileSync(f, '{}', { mode: 0o644 })
    expect(statSync(f).mode & 0o777).toBe(0o644)
    new TokenStore(f).save({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 })
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('tightens the mode on a directory that already exists too open', () => {
    const sub = join(dir, 'nested')
    mkdirSync(sub, { mode: 0o755 })
    new TokenStore(join(sub, 'spotify.json'))
      .save({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 })
    expect(statSync(sub).mode & 0o777).toBe(0o700)
  })

  it('returns null for a corrupt file', () => {
    const f = join(dir, 'spotify.json')
    const s = new TokenStore(f)
    s.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 })
    writeFileSync(f, '{ broken')
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
