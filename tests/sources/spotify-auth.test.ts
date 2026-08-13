import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { Server, ServerResponse } from 'node:http'
import {
  TokenStore, makeVerifier, challengeFor, buildAuthUrl, runAuthFlow,
  SCOPES, REDIRECT_URI, AUTH_PORT, parseTokenResponse, refreshTokens,
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

  it('requests only the three playback scopes the deck uses', () => {
    const u = new URL(buildAuthUrl('cid', REDIRECT_URI, 'chal', 'st'))
    const scopes = u.searchParams.get('scope')!.split(' ')
    expect(scopes).toContain('user-read-playback-state')
    expect(scopes).toContain('user-modify-playback-state')
    expect(scopes).toContain('user-read-currently-playing')
    expect(scopes).not.toContain('user-library-read')
    expect(scopes).not.toContain('user-library-modify')
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

  // C1 regression test. A body carrying a rotated `refresh_token` but no
  // usable `access_token` used to be serialised WHOLE into the thrown
  // message, which reaches `spotify.ts`'s `log.once` and then `deckd.log`.
  // Break the fix (put `JSON.stringify(body)` back into the message) and
  // this fails.
  it('never embeds the response body — including a refresh token — in the error message', () => {
    const secret = 'AQD-SUPER-SECRET-REFRESH-TOKEN'
    let caught: unknown
    try {
      parseTokenResponse({ refresh_token: secret, token_type: 'Bearer' }, 'rt', 0)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect(String(caught)).not.toContain(secret)
    expect(String(caught)).not.toContain('token_type')
  })

  it('throws when an initial exchange has no refresh token to store', () => {
    expect(() => parseTokenResponse({ access_token: 'at' }, '', 0))
      .toThrow(/refresh token/i)
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

describe('token endpoint validation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects an HTTP error before storing it as tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    })))
    await expect(refreshTokens('cid', 'bad-token')).rejects.toThrow(/HTTP 400.*invalid_grant/i)
  })

  it('rejects a non-JSON token response clearly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json') },
    })))
    await expect(refreshTokens('cid', 'rt')).rejects.toThrow(/invalid JSON/i)
  })

  // I6 regression test. `res.json()`'s own `SyntaxError` embeds a fragment
  // of the text it failed to parse. Break the fix (put `String(e)` back into
  // the thrown message) and this fails, because the truncated body below
  // starts with the secret.
  it('never lets a real SyntaxError fragment leak a token into the invalid-JSON error', async () => {
    const secret = 'AQD-SUPER-SECRET-REFRESH-TOKEN'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => JSON.parse(`{"refresh_token":"${secret}`), // truncated: a real SyntaxError
    })))
    let caught: unknown
    try {
      await refreshTokens('cid', 'rt')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect(String(caught)).toMatch(/invalid JSON/i)
    expect(String(caught)).not.toContain(secret)
  })
})

describe('runAuthFlow', () => {
  // Regression test for: the 5-minute timeout timer was never captured, so
  // it was never cleared on any settle path. A pending Node timer keeps the
  // event loop alive, so a CLI process would print success and then hang for
  // up to 5 minutes needing Ctrl-C. This drives the real success path (a real
  // loopback server, a real HTTP round trip to it) while injecting fakes for
  // the two things that must never happen in a test: a real browser opening,
  // and a real network call to Spotify's token endpoint. It binds an
  // OS-assigned port (0), never the real 8888.
  it('clears the timeout timer once the flow succeeds, so a pending timer does not keep the process alive', async () => {
    const uniqueMs = 654321 // distinct from any delay Node might use internally, so the spy match below is unambiguous
    const setSpy = vi.spyOn(global, 'setTimeout')
    const clearSpy = vi.spyOn(global, 'clearTimeout')

    const fetchFn = vi.fn(async () => ({
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    })) as unknown as typeof fetch

    let port = 0
    try {
      const tokens = await runAuthFlow('cid', {
        port: 0,
        timeoutMs: uniqueMs,
        fetchFn,
        onListening: (p) => { port = p },
        openUrl: (url) => {
          // Stands in for the user's browser completing the real Spotify
          // consent screen: fire the same redirect Spotify would send, at
          // the loopback server this process itself just started.
          const state = new URL(url).searchParams.get('state')
          void fetch(`http://127.0.0.1:${port}/callback?code=testcode&state=${state}`)
        },
      })

      expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: expect.any(Number) })

      const callIndex = setSpy.mock.calls.findIndex((c) => c[1] === uniqueMs)
      expect(callIndex).toBeGreaterThanOrEqual(0)
      const timerId = setSpy.mock.results[callIndex]?.value
      expect(clearSpy.mock.calls.some((c) => c[0] === timerId)).toBe(true)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })

  // Regression test for: after the timer fix above, the process STILL did
  // not exit after a successful authorization. `lsof` on the live process
  // showed the browser's connection to the loopback server as ESTABLISHED
  // long after the flow resolved — `server.close()` stops the server
  // accepting NEW connections but does not touch an EXISTING one, so the
  // browser's keep-alive socket kept the event loop alive on its own,
  // independent of the timer.
  //
  // This drives a raw `net` socket standing in for the browser, rather than
  // `fetch`, because a real `fetch()` client may reuse a keep-alive agent
  // under the hood and mask exactly this leak. The socket never calls
  // `.end()` on itself — only the SERVER may close it, which is the thing
  // that was missing. Uses the same fakes as the test above: an
  // OS-assigned port (0) and injected `openUrl`/`fetchFn`, so this never
  // binds 8888 and never makes a real request to Spotify.
  it('destroys the browser-side socket and stops listening once authorization succeeds, so nothing keeps the process alive', async () => {
    const fetchFn = vi.fn(async () => ({
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    })) as unknown as typeof fetch

    let port = 0
    let clientSocket: Socket | undefined
    let socketClosed = false

    const tokens = await runAuthFlow('cid', {
      port: 0,
      fetchFn,
      onListening: (p) => { port = p },
      openUrl: (url) => {
        const state = new URL(url).searchParams.get('state')
        clientSocket = netConnect(port, '127.0.0.1', () => {
          clientSocket!.write(
            `GET /callback?code=testcode&state=${state} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            `Connection: keep-alive\r\n\r\n`,
          )
        })
        // A Node Socket starts in paused mode: with no `data` listener (and
        // no `.resume()`), it never drains, so `end` — and therefore
        // `close` — would never fire even once the server sends its FIN.
        // `resume()` puts it in flowing mode so this test observes the
        // close the server actually performs, rather than an artifact of
        // an unread stream.
        clientSocket.resume()
        clientSocket.on('close', () => { socketClosed = true })
      },
    })

    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: expect.any(Number) })

    // Socket teardown is a network event, one tick removed from the promise
    // resolving above. Before the fix, this would still be false a full
    // second later — the socket was never destroyed, just abandoned.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(socketClosed).toBe(true)
    expect(clientSocket?.destroyed).toBe(true)

    // The listener itself must also be gone: a fresh connection to the same
    // port must be refused, not accepted, proving `server.close()` (the
    // "stop taking new connections" half) also ran on this path.
    await new Promise<void>((resolve, reject) => {
      const probe = netConnect(port, '127.0.0.1')
      probe.on('connect', () => {
        probe.destroy()
        reject(new Error('the port is still accepting connections after authorization succeeded'))
      })
      probe.on('error', () => resolve()) // ECONNREFUSED is the expected, healthy outcome.
    })
  })

  // Regression coverage for: `closeAllConnections()` ran on the very next
  // synchronous line after `res.end(html)`, with no callback given to
  // `end` at all. `res.end()` handing data to the socket is not the same
  // moment as Node actually finishing the flush -- that only happens when
  // the callback `end` accepts fires. Closing before that point risked
  // truncating the browser's confirmation page. This does not try to
  // reproduce the truncation itself, which depends on OS-level socket
  // timing and would be flaky; instead it proves the STRUCTURAL fix: `end`
  // is called with a flush callback, and the connections are only closed
  // from inside it, never before.
  it('closes connections only after the response has flushed, never before', async () => {
    const originalEnd = ServerResponse.prototype.end
    const originalCloseAll = Server.prototype.closeAllConnections
    const order: string[] = []

    const endSpy = vi
      .spyOn(ServerResponse.prototype, 'end')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(function (this: ServerResponse, ...args: any[]) {
        const last = args[args.length - 1]
        if (typeof last === 'function') {
          args[args.length - 1] = (...cbArgs: unknown[]) => {
            order.push('flushed')
            last(...cbArgs)
          }
        } else {
          // The unfixed code calls `res.end(html)` with no callback at
          // all, so there is nothing to defer the close on.
          order.push('ended-without-callback')
        }
        return (originalEnd as unknown as (...a: unknown[]) => ServerResponse).apply(this, args)
      })
    const closeSpy = vi
      .spyOn(Server.prototype, 'closeAllConnections')
      .mockImplementation(function (this: Server) {
        order.push('closed')
        return originalCloseAll.apply(this)
      })

    try {
      const fetchFn = vi.fn(async () => ({
        json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
      })) as unknown as typeof fetch

      let port = 0
      await runAuthFlow('cid', {
        port: 0,
        fetchFn,
        onListening: (p) => { port = p },
        openUrl: (url) => {
          const state = new URL(url).searchParams.get('state')
          void fetch(`http://127.0.0.1:${port}/callback?code=testcode&state=${state}`)
        },
      })

      expect(order).not.toContain('ended-without-callback')
      const flushedAt = order.indexOf('flushed')
      const closedAt = order.indexOf('closed')
      expect(flushedAt).toBeGreaterThanOrEqual(0)
      expect(closedAt).toBeGreaterThan(flushedAt)
    } finally {
      endSpy.mockRestore()
      closeSpy.mockRestore()
    }
  })

  // Regression coverage for I2/B2: `closeServer` ran only from `res.end`'s
  // flush callback. Node does not guarantee that callback fires -- if the
  // response socket is already destroyed by the time `res.end` runs,
  // `'finish'` never comes, so nothing would ever close the listener, and
  // (since the timeout is cleared on the same line) nothing would ever bound
  // the hang either. This does not need to reproduce a destroyed socket to
  // prove the fix: it drops the flush callback entirely, exactly the
  // condition under which the old code could never close, and shows the
  // `'close'`-event path closes the server anyway.
  it('closes the listener via the "close" event even when the flush callback never fires', async () => {
    const originalEnd = ServerResponse.prototype.end
    const endSpy = vi
      .spyOn(ServerResponse.prototype, 'end')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(function (this: ServerResponse, ...args: any[]) {
        // Simulates Node never invoking the flush callback at all -- the
        // exact condition the review measured with a destroyed-socket probe.
        const withoutCallback = args.filter((a) => typeof a !== 'function')
        return (originalEnd as unknown as (...a: unknown[]) => ServerResponse).apply(this, withoutCallback)
      })

    try {
      const fetchFn = vi.fn(async () => ({
        json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
      })) as unknown as typeof fetch

      let port = 0
      const tokens = await runAuthFlow('cid', {
        port: 0,
        fetchFn,
        onListening: (p) => { port = p },
        openUrl: (url) => {
          const state = new URL(url).searchParams.get('state')
          void fetch(`http://127.0.0.1:${port}/callback?code=testcode&state=${state}`)
        },
      })

      expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: expect.any(Number) })

      // The listener must still be gone -- proving the `'close'` event, not
      // the flush callback, drove the teardown this time. Before the fix,
      // this connection would have been accepted, because nothing ever
      // called `closeServer`.
      await new Promise<void>((resolve, reject) => {
        const probe = netConnect(port, '127.0.0.1')
        probe.on('connect', () => {
          probe.destroy()
          reject(new Error('the port still accepts connections; a flush-callback-only close would hang here'))
        })
        probe.on('error', () => resolve())
      })
    } finally {
      endSpy.mockRestore()
    }
  })

  // Regression coverage for the honest gap the review flagged: the earlier
  // structural test proved the success path only. A CLI process hangs just
  // as badly if the error, state-mismatch, or timeout path leaks the
  // listener.
  it('closes the listener after an authorization error from the provider', async () => {
    let port = 0
    await expect(
      runAuthFlow('cid', {
        port: 0,
        onListening: (p) => { port = p },
        openUrl: (url) => {
          const state = new URL(url).searchParams.get('state')
          void fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=${state}`)
        },
      }),
    ).rejects.toThrow(/authorization failed/)

    await new Promise<void>((resolve, reject) => {
      const probe = netConnect(port, '127.0.0.1')
      probe.on('connect', () => {
        probe.destroy()
        reject(new Error('the port still accepts connections after an authorization error'))
      })
      probe.on('error', () => resolve())
    })
  })

  it('closes the listener after a state mismatch', async () => {
    let port = 0
    await expect(
      runAuthFlow('cid', {
        port: 0,
        onListening: (p) => { port = p },
        openUrl: (url) => {
          void new URL(url) // the real state is deliberately ignored below
          void fetch(`http://127.0.0.1:${port}/callback?code=testcode&state=wrong`)
        },
      }),
    ).rejects.toThrow(/state mismatch/)

    await new Promise<void>((resolve, reject) => {
      const probe = netConnect(port, '127.0.0.1')
      probe.on('connect', () => {
        probe.destroy()
        reject(new Error('the port still accepts connections after a state mismatch'))
      })
      probe.on('error', () => resolve())
    })
  })

  it('closes the listener when the flow times out with no callback ever arriving', async () => {
    let port = 0
    await expect(
      runAuthFlow('cid', {
        port: 0,
        timeoutMs: 50,
        onListening: (p) => { port = p },
        openUrl: () => {
          // Deliberately does nothing -- the browser never comes back.
        },
      }),
    ).rejects.toThrow(/timed out/)

    await new Promise<void>((resolve, reject) => {
      const probe = netConnect(port, '127.0.0.1')
      probe.on('connect', () => {
        probe.destroy()
        reject(new Error('the port still accepts connections after the flow timed out'))
      })
      probe.on('error', () => resolve())
    })
  })

  // The exact wording of the review's honest limit: "a client that never
  // reads the response." A raw socket that writes the request and then never
  // reads a byte back still must not hang the flow -- `Connection: close`
  // plus `closeAllConnections()` are the backstop for a client like this,
  // independent of whether it ever drains the response.
  it('resolves even when the client socket never reads the response', async () => {
    const fetchFn = vi.fn(async () => ({
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    })) as unknown as typeof fetch

    let port = 0
    let clientSocket: Socket | undefined
    const tokens = await runAuthFlow('cid', {
      port: 0,
      fetchFn,
      onListening: (p) => { port = p },
      openUrl: (url) => {
        const state = new URL(url).searchParams.get('state')
        clientSocket = netConnect(port, '127.0.0.1', () => {
          clientSocket!.write(
            `GET /callback?code=testcode&state=${state} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            `Connection: keep-alive\r\n\r\n`,
          )
        })
        // No `.resume()`, no `data` listener: this client never reads
        // anything back.
      },
    })

    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: expect.any(Number) })
    clientSocket?.destroy()
  })

  // Regression coverage for the idempotency this fix adds: the success path
  // now has two independent triggers for the same teardown -- `res.end`'s
  // flush callback and the response's `'close'` event -- and both routinely
  // fire for one request, since every response here sends
  // `Connection: close`. The teardown itself must still happen exactly once.
  it('closes the server exactly once even though both the flush callback and the close event fire', async () => {
    const originalClose = Server.prototype.close
    const originalCloseAll = Server.prototype.closeAllConnections
    const closeSpy = vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, ...a: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalClose as any).apply(this, a)
    })
    const closeAllSpy = vi.spyOn(Server.prototype, 'closeAllConnections').mockImplementation(function (this: Server) {
      return originalCloseAll.apply(this)
    })

    try {
      const fetchFn = vi.fn(async () => ({
        json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
      })) as unknown as typeof fetch

      let port = 0
      await runAuthFlow('cid', {
        port: 0,
        fetchFn,
        onListening: (p) => { port = p },
        openUrl: (url) => {
          const state = new URL(url).searchParams.get('state')
          void fetch(`http://127.0.0.1:${port}/callback?code=testcode&state=${state}`)
        },
      })

      // Give the socket's own `'close'` event, the second of the two
      // triggers, a chance to fire after the flush callback already ran.
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(closeSpy).toHaveBeenCalledTimes(1)
      expect(closeAllSpy).toHaveBeenCalledTimes(1)
    } finally {
      closeSpy.mockRestore()
      closeAllSpy.mockRestore()
    }
  })
})
