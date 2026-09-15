import { describe, expect, it } from 'vitest'
import { DRIVE_ABOUT_URL } from '../../src/google/account'
import { EXPIRY_MARGIN_MS, UNKNOWN_ACCOUNT, createGoogleAuth, type AuthState } from '../../src/google/auth'
import type { CredentialsResolution } from '../../src/google/credentials'
import { createHttpClient } from '../../src/google/http'
import { DRIVE_FILE_SCOPE, OAUTH_DEVICE_CODE_URL, OAUTH_REVOKE_URL, OAUTH_TOKEN_URL } from '../../src/google/oauth'
import { SESSION_KEY, createTokenStore, type StoredSession } from '../../src/google/tokenStore'
import { driveError, fakeStorage, jsonResponse, networkError, oauthError, scriptedFetch, type ScriptStep } from './helpers'

const T0 = 1_700_000_000_000
const OK_CREDS: CredentialsResolution = { ok: true, credentials: { clientId: 'cid', clientSecret: 'csec' }, source: 'built-in' }
const NO_CREDS: CredentialsResolution = { ok: false, reason: 'no client' }

const deviceCodeBody = { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 }
const grantBody = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599, scope: DRIVE_FILE_SCOPE, token_type: 'Bearer' }
const aboutBody = { user: { emailAddress: 'me@example.com', displayName: 'Me' } }

function storedSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    version: 1,
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: T0 + 3_000_000,
    scope: DRIVE_FILE_SCOPE,
    account: { email: 'me@example.com' },
    connectedAt: T0 - 86_400_000,
    ...overrides,
  }
}

interface Harness {
  script: ScriptStep[]
  stored?: StoredSession | null
  creds?: CredentialsResolution
  now?: () => number
}

function harness({ script, stored = null, creds = OK_CREDS, now = () => T0 }: Harness) {
  const fetch = scriptedFetch(script)
  const storage = fakeStorage(stored ? { [SESSION_KEY]: JSON.stringify(stored) } : {})
  const sleeps: number[] = []
  const logs: string[] = []
  let cancelAt: ((ms: number) => void) | null = null
  const auth = createGoogleAuth({
    http: createHttpClient({ fetch: fetch.fetch, sleep: async () => undefined, random: () => 0 }),
    store: createTokenStore(storage),
    getCredentials: () => creds,
    sleep: async (ms, signal) => {
      sleeps.push(ms)
      cancelAt?.(ms)
      // Like the host sleep: an aborted signal ends the wait at once.
      if (signal?.aborted) return
    },
    now,
    log: (line) => logs.push(line),
  })
  const states: AuthState[] = []
  auth.state.subscribe((s) => states.push(s))
  const savedSession = (): StoredSession | null => {
    const raw = storage.files.get(SESSION_KEY)
    return raw === undefined ? null : (JSON.parse(raw) as StoredSession | null)
  }
  return { auth, fetch, storage, sleeps, logs, states, savedSession, setCancelHook: (fn: (ms: number) => void) => (cancelAt = fn) }
}

describe('restore (DoD: connected state survives a restart)', () => {
  it('reports signed-out when nothing is stored, without any network call', async () => {
    const h = harness({ script: [] })
    expect(await h.auth.restore()).toEqual({ kind: 'signed-out', reason: null })
    expect(h.auth.isSignedIn()).toBe(false)
    expect(h.fetch.calls).toHaveLength(0)
  })

  it('reports signed-in with the stored e-mail, without any network call', async () => {
    const h = harness({ script: [], stored: storedSession() })
    expect(await h.auth.restore()).toEqual({ kind: 'signed-in', account: { email: 'me@example.com' } })
    expect(h.auth.isSignedIn()).toBe(true)
    expect(h.fetch.calls).toHaveLength(0)
  })

  it('completes a missing e-mail in the background and saves it', async () => {
    const h = harness({ script: [jsonResponse(200, aboutBody)], stored: storedSession({ account: null }) })
    expect(await h.auth.restore()).toEqual({ kind: 'signed-in', account: UNKNOWN_ACCOUNT })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.auth.state.get()).toEqual({ kind: 'signed-in', account: { email: 'me@example.com' } })
    expect(h.savedSession()?.account).toEqual({ email: 'me@example.com' })
    expect(h.fetch.calls[0].url).toBe(DRIVE_ABOUT_URL)
  })

  it('treats an unreadable store as signed-out and logs it', async () => {
    const h = harness({ script: [], stored: storedSession() })
    h.storage.hasItem = async () => {
      throw new Error('disk on fire')
    }
    expect(await h.auth.restore()).toEqual({ kind: 'signed-out', reason: null })
    expect(h.logs.some((l) => /token store/.test(l))).toBe(true)
  })
})

describe('connect (plan M3 step 2)', () => {
  it('runs the device flow end to end: code → connecting state → poll → tokens → about → saved session', async () => {
    const h = harness({
      script: [jsonResponse(200, deviceCodeBody), oauthError(428, 'authorization_pending'), jsonResponse(200, grantBody), jsonResponse(200, aboutBody)],
    })
    const result = await h.auth.connect()
    expect(result).toEqual({ kind: 'connected', account: { email: 'me@example.com' }, warning: null })
    expect(h.states).toEqual([
      { kind: 'connecting', userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device', expiresAt: T0 + 1_800_000 },
      { kind: 'signed-in', account: { email: 'me@example.com' } },
    ])
    expect(h.fetch.calls.map((c) => c.url)).toEqual([OAUTH_DEVICE_CODE_URL, OAUTH_TOKEN_URL, OAUTH_TOKEN_URL, DRIVE_ABOUT_URL])
    expect(h.fetch.calls[3].headers.get('authorization')).toBe('Bearer at-1')
    expect(h.sleeps).toEqual([5000, 5000])
    expect(h.savedSession()).toEqual({
      version: 1,
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: T0 + 3_599_000,
      scope: DRIVE_FILE_SCOPE,
      account: { email: 'me@example.com' },
      connectedAt: T0,
    })
    expect(h.auth.isSignedIn()).toBe(true)
  })

  it('refuses to start without credentials and stays signed-out', async () => {
    const h = harness({ script: [], creds: NO_CREDS })
    await expect(h.auth.connect()).rejects.toMatchObject({ name: 'AuthError', code: 'no-credentials', message: 'no client' })
    expect(h.states).toEqual([])
    expect(h.auth.state.get().kind).toBe('signed-out')
  })

  it('returns the poll outcome (denied / expired) and goes back to signed-out', async () => {
    const h = harness({ script: [jsonResponse(200, deviceCodeBody), oauthError(403, 'access_denied')] })
    expect(await h.auth.connect()).toEqual({ kind: 'denied' })
    expect(h.states.map((s) => s.kind)).toEqual(['connecting', 'signed-out'])
    expect(h.savedSession()).toBeNull()
  })

  it('can be cancelled while waiting for approval', async () => {
    const h = harness({ script: [jsonResponse(200, deviceCodeBody), oauthError(428, 'authorization_pending')] })
    h.setCancelHook(() => {
      if (h.fetch.calls.length === 2) h.auth.cancelConnect()
    })
    expect(await h.auth.connect()).toEqual({ kind: 'cancelled' })
    expect(h.auth.state.get()).toEqual({ kind: 'signed-out', reason: null })
    expect(h.fetch.remaining()).toBe(0)
  })

  it('still connects when the Drive about call fails, with a warning and an unknown account', async () => {
    const h = harness({ script: [jsonResponse(200, deviceCodeBody), jsonResponse(200, grantBody), driveError(403, 'SERVICE_DISABLED', 'Drive API has not been used')] })
    const result = await h.auth.connect()
    expect(result.kind).toBe('connected')
    if (result.kind !== 'connected') return
    expect(result.account).toEqual(UNKNOWN_ACCOUNT)
    expect(result.warning).toMatch(/Drive API is not enabled/)
    expect(h.savedSession()?.account).toBeNull()
    expect(h.auth.state.get()).toEqual({ kind: 'signed-in', account: UNKNOWN_ACCOUNT })
  })

  it('rejects a grant without a refresh token and returns to signed-out', async () => {
    const h = harness({ script: [jsonResponse(200, deviceCodeBody), jsonResponse(200, { ...grantBody, refresh_token: undefined })] })
    await expect(h.auth.connect()).rejects.toMatchObject({ name: 'AuthError', code: 'no-refresh-token' })
    expect(h.auth.state.get().kind).toBe('signed-out')
    expect(h.savedSession()).toBeNull()
  })

  it('propagates an OAuth failure of the device-code request and returns to signed-out', async () => {
    const h = harness({ script: [oauthError(401, 'invalid_client')] })
    await expect(h.auth.connect()).rejects.toMatchObject({ name: 'OAuthError', code: 'invalid_client' })
    expect(h.auth.state.get().kind).toBe('signed-out')
  })

  it('reports already-connected and already-connecting instead of starting a second flow', async () => {
    const connected = harness({ script: [], stored: storedSession() })
    await connected.auth.restore()
    expect(await connected.auth.connect()).toEqual({ kind: 'already-connected' })

    const pending = harness({ script: [jsonResponse(200, deviceCodeBody), oauthError(428, 'authorization_pending')] })
    let second: Promise<unknown> | null = null
    pending.setCancelHook(() => {
      if (pending.fetch.calls.length === 2) {
        second = pending.auth.connect()
        pending.auth.cancelConnect()
      }
    })
    expect(await pending.auth.connect()).toEqual({ kind: 'cancelled' })
    expect(await second).toEqual({ kind: 'already-connecting' })
  })
})

describe('getAccessToken and refresh (plan M3 step 3)', () => {
  it('returns the stored token while it has more than the margin left', async () => {
    const h = harness({ script: [], stored: storedSession({ expiresAt: T0 + EXPIRY_MARGIN_MS + 1 }) })
    await h.auth.restore()
    expect(await h.auth.getAccessToken()).toBe('at-old')
    expect(h.fetch.calls).toHaveLength(0)
  })

  it('refreshes once when the token is about to expire, saves the new one, and shares one in-flight refresh', async () => {
    const h = harness({
      script: [jsonResponse(200, { access_token: 'at-new', expires_in: 3599, scope: DRIVE_FILE_SCOPE, token_type: 'Bearer' })],
      stored: storedSession({ expiresAt: T0 + EXPIRY_MARGIN_MS }),
    })
    await h.auth.restore()
    const [a, b] = await Promise.all([h.auth.getAccessToken(), h.auth.getAccessToken()])
    expect(a).toBe('at-new')
    expect(b).toBe('at-new')
    expect(h.fetch.calls).toHaveLength(1)
    expect(Object.fromEntries(h.fetch.calls[0].form)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-old' })
    expect(h.savedSession()).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-old', expiresAt: T0 + 3_599_000 })
    expect(h.auth.state.get()).toEqual({ kind: 'signed-in', account: { email: 'me@example.com' } })
  })

  it('drops the session on invalid_grant: signed-out with reason, store cleared, AuthError(session-expired)', async () => {
    const h = harness({ script: [oauthError(400, 'invalid_grant', 'Token has been expired or revoked.')], stored: storedSession({ expiresAt: T0 }) })
    await h.auth.restore()
    await expect(h.auth.getAccessToken()).rejects.toMatchObject({ name: 'AuthError', code: 'session-expired' })
    expect(h.auth.state.get()).toEqual({ kind: 'signed-out', reason: 'session-expired' })
    expect(h.auth.isSignedIn()).toBe(false)
    expect(h.savedSession()).toBeNull()
  })

  it('keeps the session on a transient refresh failure', async () => {
    const h = harness({ script: [networkError(), networkError(), networkError()], stored: storedSession({ expiresAt: T0 }) })
    await h.auth.restore()
    await expect(h.auth.getAccessToken()).rejects.toThrow('Failed to fetch')
    expect(h.auth.isSignedIn()).toBe(true)
    expect(h.auth.state.get().kind).toBe('signed-in')
  })

  it('throws not-signed-in when there is no session', async () => {
    const h = harness({ script: [] })
    await expect(h.auth.getAccessToken()).rejects.toMatchObject({ name: 'AuthError', code: 'not-signed-in' })
  })
})

describe('authorized fetch', () => {
  it('adds the Bearer header and keeps the caller headers', async () => {
    const h = harness({ script: [jsonResponse(200, { files: [] })], stored: storedSession() })
    await h.auth.restore()
    const res = await h.auth.fetch('https://www.googleapis.com/drive/v3/files', { headers: { Accept: 'application/json' } })
    expect(res.status).toBe(200)
    expect(h.fetch.calls[0].headers.get('authorization')).toBe('Bearer at-old')
    expect(h.fetch.calls[0].headers.get('accept')).toBe('application/json')
  })

  it('refreshes once on 401 and retries with the new token', async () => {
    const h = harness({
      script: [
        jsonResponse(401, { error: { code: 401, message: 'Invalid Credentials' } }),
        jsonResponse(200, { access_token: 'at-new', expires_in: 3599 }),
        jsonResponse(200, { files: [] }),
      ],
      stored: storedSession(),
    })
    await h.auth.restore()
    const res = await h.auth.fetch('https://www.googleapis.com/drive/v3/files')
    expect(res.status).toBe(200)
    expect(h.fetch.calls.map((c) => c.url)).toEqual(['https://www.googleapis.com/drive/v3/files', OAUTH_TOKEN_URL, 'https://www.googleapis.com/drive/v3/files'])
    expect(h.fetch.calls[2].headers.get('authorization')).toBe('Bearer at-new')
  })

  it('returns the second 401 to the caller instead of looping', async () => {
    const h = harness({
      script: [jsonResponse(401, {}), jsonResponse(200, { access_token: 'at-new', expires_in: 3599 }), jsonResponse(401, {})],
      stored: storedSession(),
    })
    await h.auth.restore()
    expect((await h.auth.fetch('https://www.googleapis.com/drive/v3/files')).status).toBe(401)
    expect(h.fetch.calls).toHaveLength(3)
  })
})

describe('signOut', () => {
  it('revokes the refresh token, clears the store, and reports revoked', async () => {
    const h = harness({ script: [jsonResponse(200, {})], stored: storedSession() })
    await h.auth.restore()
    expect(await h.auth.signOut()).toEqual({ revoked: true, revokeError: null })
    expect(h.fetch.calls[0].url).toBe(OAUTH_REVOKE_URL)
    expect(Object.fromEntries(h.fetch.calls[0].form)).toEqual({ token: 'rt-old' })
    expect(h.auth.state.get()).toEqual({ kind: 'signed-out', reason: null })
    expect(h.auth.isSignedIn()).toBe(false)
    expect(h.storage.files.get(SESSION_KEY)).toBe('null')
  })

  it('still signs out locally when the revoke call fails, and says so', async () => {
    const h = harness({ script: [networkError(), networkError(), networkError()], stored: storedSession() })
    await h.auth.restore()
    const r = await h.auth.signOut()
    expect(r.revoked).toBe(false)
    expect(r.revokeError).toMatch(/Could not reach Google/)
    expect(h.auth.isSignedIn()).toBe(false)
    expect(h.storage.files.get(SESSION_KEY)).toBe('null')
  })

  it('aborts a pending sign-in and needs no revoke when nothing was granted', async () => {
    const h = harness({ script: [jsonResponse(200, deviceCodeBody), oauthError(428, 'authorization_pending')] })
    h.setCancelHook(() => {
      if (h.fetch.calls.length === 2) void h.auth.signOut()
    })
    expect(await h.auth.connect()).toEqual({ kind: 'cancelled' })
    expect(h.fetch.calls).toHaveLength(2)
    expect(h.auth.state.get().kind).toBe('signed-out')
  })
})
