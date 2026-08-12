import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { paths } from '../paths.js'
import { log } from '../log.js'

export const AUTH_PORT = 8888
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
    // The `mode` option applies only when the call creates the target. An
    // existing directory or file keeps its old permissions, and no error
    // reports it. So chmod both without a condition. This file holds a
    // refresh token.
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    chmodSync(dirname(this.file), 0o700)
    writeFileSync(this.file, JSON.stringify(t), { mode: 0o600 })
    chmodSync(this.file, 0o600)
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
