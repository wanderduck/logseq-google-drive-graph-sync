// Google OAuth 2.0 for TV and limited-input devices (RFC 8628), plan M3 steps 2–3, over the backoff
// client with `application/x-www-form-urlencoded` bodies (spike §2 item 4a, §3). Stateless functions:
// src/google/auth.ts owns the session, this file only talks to the three OAuth endpoints.

import { HttpError, OAuthError } from './errors'
import type { ClientCredentials } from './credentials'
import type { HttpClient } from './http'

export const OAUTH_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code'
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
/** Non-sensitive scope: only files this app created (plan §2 items 4–5). */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const DEFAULT_POLL_INTERVAL_MS = 5000
/** RFC 8628 §3.5: on `slow_down` the polling interval is increased by 5 seconds. */
const SLOW_DOWN_STEP_MS = 5000

export interface DeviceCode {
  deviceCode: string
  /** What the user types at `verificationUrl`, e.g. `GQVQ-JKEC`. */
  userCode: string
  verificationUrl: string
  /** Epoch ms after which the code is dead. */
  expiresAt: number
  intervalMs: number
}

export interface TokenResponse {
  accessToken: string
  /** Only present on the first grant; a refresh answer normally omits it. */
  refreshToken: string | null
  /** Epoch ms. */
  expiresAt: number
  scope: string
  tokenType: string
}

export type DevicePollOutcome =
  | { kind: 'authorized'; tokens: TokenResponse }
  /** The user clicked "Cancel"/"Deny" on Google's page (`access_denied`). */
  | { kind: 'denied' }
  /** `expired_token`, or the local deadline passed. */
  | { kind: 'expired' }
  /** `isCancelled()` turned true. */
  | { kind: 'cancelled' }

export interface PollDeps {
  sleep: (ms: number) => Promise<void>
  now: () => number
  isCancelled: () => boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

async function postForm(http: HttpClient, url: string, fields: Record<string, string>): Promise<Response> {
  return http.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  })
}

/** Body as JSON, or `null` when it is not JSON (an HTML error page after a failed retry run). */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Turns a non-2xx OAuth answer into an `OAuthError` (JSON) or `HttpError` (anything else). */
async function oauthFailure(res: Response, url: string): Promise<Error> {
  const clone = res.clone()
  const json = await readJson(res)
  if (json && typeof json.error === 'string') {
    return new OAuthError(json.error, typeof json.error_description === 'string' ? json.error_description : null, res.status)
  }
  return HttpError.fromResponse(clone, url)
}

function toTokenResponse(json: Record<string, unknown>, now: number): TokenResponse {
  const accessToken = json.access_token
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || accessToken === '') throw new Error('Google token response has no access_token.')
  const seconds = typeof expiresIn === 'number' ? expiresIn : typeof expiresIn === 'string' ? Number(expiresIn) : NaN
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token !== '' ? json.refresh_token : null,
    expiresAt: now + (Number.isFinite(seconds) ? seconds : 0) * 1000,
    scope: typeof json.scope === 'string' ? json.scope : '',
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
  }
}

/** Step 1 of the device flow: `POST /device/code`. */
export async function requestDeviceCode(http: HttpClient, creds: ClientCredentials, now: () => number): Promise<DeviceCode> {
  const res = await postForm(http, OAUTH_DEVICE_CODE_URL, { client_id: creds.clientId, scope: DRIVE_FILE_SCOPE })
  if (!res.ok) throw await oauthFailure(res, OAUTH_DEVICE_CODE_URL)
  const json = await readJson(res)
  if (!json) throw new Error('Google device-code response is not JSON.')
  const { device_code, user_code, verification_url, expires_in, interval } = json
  if (typeof device_code !== 'string' || typeof user_code !== 'string' || typeof verification_url !== 'string') {
    throw new Error('Google device-code response is missing device_code, user_code or verification_url.')
  }
  const expiresIn = typeof expires_in === 'number' ? expires_in : 1800
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUrl: verification_url,
    expiresAt: now() + expiresIn * 1000,
    intervalMs: typeof interval === 'number' && interval > 0 ? interval * 1000 : DEFAULT_POLL_INTERVAL_MS,
  }
}

/**
 * Step 2: poll `POST /token` every `intervalMs` until the user approves (plan M3 step 2). Google answers
 * HTTP 428 `authorization_pending` while waiting and 403 `slow_down` / `access_denied`; the backoff client
 * leaves all of those alone (only 429/5xx/quota-403 are retried) so this loop sees every one of them.
 */
export async function pollForDeviceToken(
  http: HttpClient,
  creds: ClientCredentials,
  code: DeviceCode,
  deps: PollDeps,
): Promise<DevicePollOutcome> {
  let intervalMs = code.intervalMs
  for (;;) {
    if (deps.isCancelled()) return { kind: 'cancelled' }
    if (deps.now() >= code.expiresAt) return { kind: 'expired' }
    await deps.sleep(intervalMs)
    if (deps.isCancelled()) return { kind: 'cancelled' }

    const res = await postForm(http, OAUTH_TOKEN_URL, {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      device_code: code.deviceCode,
      grant_type: DEVICE_CODE_GRANT,
    })
    if (res.ok) {
      const json = await readJson(res)
      if (!json) throw new Error('Google token response is not JSON.')
      return { kind: 'authorized', tokens: toTokenResponse(json, deps.now()) }
    }
    const failure = await oauthFailure(res, OAUTH_TOKEN_URL)
    if (!(failure instanceof OAuthError)) throw failure
    switch (failure.code) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        intervalMs += SLOW_DOWN_STEP_MS
        continue
      case 'access_denied':
        return { kind: 'denied' }
      case 'expired_token':
        return { kind: 'expired' }
      default:
        throw failure
    }
  }
}

/** `grant_type=refresh_token`. Throws `OAuthError('invalid_grant')` once the grant was revoked or expired. */
export async function refreshAccessToken(
  http: HttpClient,
  creds: ClientCredentials,
  refreshToken: string,
  now: () => number,
): Promise<TokenResponse> {
  const res = await postForm(http, OAUTH_TOKEN_URL, {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  if (!res.ok) throw await oauthFailure(res, OAUTH_TOKEN_URL)
  const json = await readJson(res)
  if (!json) throw new Error('Google token response is not JSON.')
  return toTokenResponse(json, now())
}

/** Revoking the refresh token revokes the whole grant (spike H14). Non-2xx → `OAuthError`/`HttpError`. */
export async function revokeToken(http: HttpClient, token: string): Promise<void> {
  const res = await postForm(http, OAUTH_REVOKE_URL, { token })
  if (!res.ok) throw await oauthFailure(res, OAUTH_REVOKE_URL)
}
