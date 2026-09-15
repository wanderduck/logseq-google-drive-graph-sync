import { describe, expect, it } from 'vitest'
import { HttpError, OAuthError } from '../../src/google/errors'
import { createHttpClient } from '../../src/google/http'
import {
  DRIVE_FILE_SCOPE,
  OAUTH_DEVICE_CODE_URL,
  OAUTH_REVOKE_URL,
  OAUTH_TOKEN_URL,
  pollForDeviceToken,
  refreshAccessToken,
  requestDeviceCode,
  revokeToken,
  type DeviceCode,
} from '../../src/google/oauth'
import { jsonResponse, oauthError, recordingSleep, scriptedFetch, textResponse, type ScriptStep } from './helpers'

const creds = { clientId: 'cid', clientSecret: 'csec' }
const T0 = 1_700_000_000_000

function http(script: ScriptStep[]) {
  const fetch = scriptedFetch(script)
  // No backoff sleeps here: the OAuth answers under test are never retried by the transport.
  return { fetch, client: createHttpClient({ fetch: fetch.fetch, sleep: async () => undefined }) }
}

const deviceCodeBody = {
  device_code: 'dev-123',
  user_code: 'GQVQ-JKEC',
  verification_url: 'https://www.google.com/device',
  expires_in: 1800,
  interval: 5,
}

const tokenBody = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599, scope: DRIVE_FILE_SCOPE, token_type: 'Bearer' }

function code(overrides: Partial<DeviceCode> = {}): DeviceCode {
  return { deviceCode: 'dev-123', userCode: 'GQVQ-JKEC', verificationUrl: 'https://www.google.com/device', expiresAt: T0 + 1_800_000, intervalMs: 5000, ...overrides }
}

describe('requestDeviceCode', () => {
  it('posts a form with the client id and the drive.file scope and parses the answer', async () => {
    const { fetch, client } = http([jsonResponse(200, deviceCodeBody)])
    const dc = await requestDeviceCode(client, creds, () => T0)
    expect(dc).toEqual(code())
    const call = fetch.calls[0]
    expect(call.url).toBe(OAUTH_DEVICE_CODE_URL)
    expect(call.method).toBe('POST')
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(call.form)).toEqual({ client_id: 'cid', scope: DRIVE_FILE_SCOPE })
  })

  it('defaults the interval to 5 s and the lifetime to 30 min when Google omits them', async () => {
    const { client } = http([jsonResponse(200, { device_code: 'd', user_code: 'u', verification_url: 'v' })])
    const dc = await requestDeviceCode(client, creds, () => T0)
    expect(dc.intervalMs).toBe(5000)
    expect(dc.expiresAt).toBe(T0 + 1_800_000)
  })

  it('surfaces invalid_client (wrong OAuth client type) as an OAuthError', async () => {
    const { client } = http([oauthError(401, 'invalid_client', "Only clients of type 'TVs and Limited Input devices' can use this flow")])
    const err = await requestDeviceCode(client, creds, () => T0).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('invalid_client')
    expect((err as OAuthError).description).toMatch(/TVs and Limited Input/)
  })

  it('turns a non-JSON, non-retryable failure into an HttpError', async () => {
    const { client } = http([textResponse(400, '<html>bad request</html>')])
    const err = await requestDeviceCode(client, creds, () => T0).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).info.message).toBe('<html>bad request</html>')
  })
})

describe('pollForDeviceToken (plan M3 step 2)', () => {
  it('waits the interval, keeps polling on authorization_pending, slows down by 5 s on slow_down, and returns the tokens', async () => {
    const { fetch, client } = http([oauthError(428, 'authorization_pending'), oauthError(403, 'slow_down'), oauthError(428, 'authorization_pending'), jsonResponse(200, tokenBody)])
    const sleeper = recordingSleep()
    const outcome = await pollForDeviceToken(client, creds, code(), { sleep: sleeper.sleep, now: () => T0, isCancelled: () => false })
    expect(outcome).toEqual({
      kind: 'authorized',
      tokens: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: T0 + 3_599_000, scope: DRIVE_FILE_SCOPE, tokenType: 'Bearer' },
    })
    expect(sleeper.delays).toEqual([5000, 5000, 10_000, 10_000])
    expect(fetch.calls).toHaveLength(4)
    for (const call of fetch.calls) {
      expect(call.url).toBe(OAUTH_TOKEN_URL)
      expect(Object.fromEntries(call.form)).toEqual({
        client_id: 'cid',
        client_secret: 'csec',
        device_code: 'dev-123',
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
    }
  })

  it('reports access_denied and expired_token as outcomes, not errors', async () => {
    const denied = http([oauthError(403, 'access_denied')])
    expect(await pollForDeviceToken(denied.client, creds, code(), { sleep: async () => undefined, now: () => T0, isCancelled: () => false })).toEqual({ kind: 'denied' })
    const expired = http([oauthError(400, 'expired_token')])
    expect(await pollForDeviceToken(expired.client, creds, code(), { sleep: async () => undefined, now: () => T0, isCancelled: () => false })).toEqual({ kind: 'expired' })
  })

  it('stops without a request once the local deadline has passed', async () => {
    const { fetch, client } = http([])
    const outcome = await pollForDeviceToken(client, creds, code({ expiresAt: T0 }), { sleep: async () => undefined, now: () => T0, isCancelled: () => false })
    expect(outcome).toEqual({ kind: 'expired' })
    expect(fetch.calls).toHaveLength(0)
  })

  it('returns cancelled as soon as the flag flips, before the next request', async () => {
    let cancelled = false
    const { fetch, client } = http([
      () => {
        cancelled = true
        return oauthError(428, 'authorization_pending')
      },
    ])
    const outcome = await pollForDeviceToken(client, creds, code(), { sleep: async () => undefined, now: () => T0, isCancelled: () => cancelled })
    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(fetch.calls).toHaveLength(1)
  })

  it('throws on any other OAuth error', async () => {
    const { client } = http([oauthError(400, 'invalid_grant', 'Bad Request')])
    await expect(pollForDeviceToken(client, creds, code(), { sleep: async () => undefined, now: () => T0, isCancelled: () => false })).rejects.toMatchObject({
      name: 'OAuthError',
      code: 'invalid_grant',
    })
  })
})

describe('refreshAccessToken (plan M3 step 3)', () => {
  it('posts the refresh grant and parses the new access token (no refresh token in the answer)', async () => {
    const { fetch, client } = http([jsonResponse(200, { access_token: 'at-2', expires_in: 3599, scope: DRIVE_FILE_SCOPE, token_type: 'Bearer' })])
    const t = await refreshAccessToken(client, creds, 'rt-1', () => T0)
    expect(t).toEqual({ accessToken: 'at-2', refreshToken: null, expiresAt: T0 + 3_599_000, scope: DRIVE_FILE_SCOPE, tokenType: 'Bearer' })
    expect(Object.fromEntries(fetch.calls[0].form)).toEqual({ client_id: 'cid', client_secret: 'csec', refresh_token: 'rt-1', grant_type: 'refresh_token' })
  })

  it('throws OAuthError(invalid_grant) when the grant was revoked', async () => {
    const { client } = http([oauthError(400, 'invalid_grant', 'Token has been expired or revoked.')])
    await expect(refreshAccessToken(client, creds, 'rt-1', () => T0)).rejects.toMatchObject({ name: 'OAuthError', code: 'invalid_grant' })
  })
})

describe('revokeToken', () => {
  it('posts the token as a form and resolves on 200', async () => {
    const { fetch, client } = http([jsonResponse(200, {})])
    await revokeToken(client, 'rt-1')
    expect(fetch.calls[0].url).toBe(OAUTH_REVOKE_URL)
    expect(Object.fromEntries(fetch.calls[0].form)).toEqual({ token: 'rt-1' })
  })

  it('throws on a non-2xx answer', async () => {
    const { client } = http([oauthError(400, 'invalid_token')])
    await expect(revokeToken(client, 'rt-1')).rejects.toMatchObject({ name: 'OAuthError', code: 'invalid_token' })
  })
})
