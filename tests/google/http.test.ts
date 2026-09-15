import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKOFF, backoffDelayMs, createHttpClient, isRetryable, retryAfterMs } from '../../src/google/http'
import { driveError, jsonResponse, networkError, oauthError, recordingSleep, scriptedFetch, textResponse } from './helpers'

const URL = 'https://www.googleapis.com/drive/v3/files'
/** Fixed jitter of half the bound: delays are base·2^n + 500. */
const halfJitter = () => 0.5

function client(script: Parameters<typeof scriptedFetch>[0], policy: Partial<typeof DEFAULT_BACKOFF> = {}) {
  const fetch = scriptedFetch(script)
  const sleeper = recordingSleep()
  const http = createHttpClient({ fetch: fetch.fetch, sleep: sleeper.sleep, random: halfJitter, now: () => 1_000_000, policy })
  return { http, fetch, sleeper }
}

describe('backoffDelayMs', () => {
  it('doubles from the base, caps the exponential part, and adds jitter on top', () => {
    const p = { ...DEFAULT_BACKOFF, baseDelayMs: 1000, maxDelayMs: 4000, jitterMs: 1000 }
    expect(backoffDelayMs(0, p, () => 0)).toBe(1000)
    expect(backoffDelayMs(1, p, () => 0)).toBe(2000)
    expect(backoffDelayMs(2, p, () => 0)).toBe(4000)
    expect(backoffDelayMs(3, p, () => 0)).toBe(4000)
    expect(backoffDelayMs(3, p, () => 0.999)).toBe(4999)
  })
})

describe('retryAfterMs', () => {
  it('reads delay-seconds and HTTP-dates, and ignores garbage', () => {
    const now = Date.parse('2026-09-15T10:00:00Z')
    expect(retryAfterMs(textResponse(429, '', { 'Retry-After': '7' }), now)).toBe(7000)
    expect(retryAfterMs(textResponse(429, '', { 'Retry-After': 'Tue, 15 Sep 2026 10:00:30 GMT' }), now)).toBe(30_000)
    expect(retryAfterMs(textResponse(429, '', { 'Retry-After': 'soon' }), now)).toBeNull()
    expect(retryAfterMs(textResponse(429, ''), now)).toBeNull()
  })
})

describe('isRetryable', () => {
  it('retries 429 and every 5xx', async () => {
    expect(await isRetryable(textResponse(429, ''))).toBe(true)
    expect(await isRetryable(textResponse(500, ''))).toBe(true)
    expect(await isRetryable(textResponse(503, ''))).toBe(true)
  })

  it('retries a 403 only for the Drive rate-limit reasons', async () => {
    expect(await isRetryable(driveError(403, 'userRateLimitExceeded'))).toBe(true)
    expect(await isRetryable(driveError(403, 'rateLimitExceeded'))).toBe(true)
    expect(await isRetryable(driveError(403, 'SERVICE_DISABLED'))).toBe(false)
    expect(await isRetryable(driveError(403, 'insufficientFilePermissions'))).toBe(false)
  })

  it('never retries OAuth-style 403s (slow_down, access_denied) or a 428', async () => {
    expect(await isRetryable(oauthError(403, 'slow_down'))).toBe(false)
    expect(await isRetryable(oauthError(403, 'access_denied'))).toBe(false)
    expect(await isRetryable(oauthError(428, 'authorization_pending'))).toBe(false)
    expect(await isRetryable(oauthError(400, 'invalid_grant'))).toBe(false)
  })

  it('leaves the body readable for the caller (inspects a clone)', async () => {
    const res = driveError(403, 'userRateLimitExceeded')
    await isRetryable(res)
    expect(res.bodyUsed).toBe(false)
    expect(await res.json()).toMatchObject({ error: { code: 403 } })
  })
})

describe('createHttpClient.request (plan M3 step 4)', () => {
  it('returns a success without sleeping and passes the init through', async () => {
    const { http, fetch, sleeper } = client([jsonResponse(200, { ok: 1 })])
    const res = await http.request(URL, { method: 'POST', body: 'a=1', headers: { 'X-Test': 'y' } })
    expect(res.status).toBe(200)
    expect(sleeper.delays).toEqual([])
    expect(fetch.calls[0]).toMatchObject({ url: URL, method: 'POST', body: 'a=1' })
    expect(fetch.calls[0].headers.get('x-test')).toBe('y')
  })

  it('backs off with exponential delays plus jitter on 5xx and 429, then returns the success', async () => {
    const { http, fetch, sleeper } = client([textResponse(503, ''), textResponse(429, ''), driveError(403, 'rateLimitExceeded'), jsonResponse(200, {})])
    const res = await http.request(URL)
    expect(res.status).toBe(200)
    expect(fetch.calls).toHaveLength(4)
    expect(sleeper.delays).toEqual([1500, 2500, 4500])
  })

  it('re-sends the same body on every retry', async () => {
    const { http, fetch } = client([textResponse(500, ''), jsonResponse(200, {})])
    await http.request(URL, { method: 'POST', body: 'grant_type=refresh_token' })
    expect(fetch.calls.map((c) => c.body)).toEqual(['grant_type=refresh_token', 'grant_type=refresh_token'])
  })

  it('returns a final 4xx (SERVICE_DISABLED, 428, 401) immediately', async () => {
    for (const final of [driveError(403, 'SERVICE_DISABLED'), oauthError(428, 'authorization_pending'), textResponse(401, '')]) {
      const { http, fetch, sleeper } = client([final])
      const res = await http.request(URL)
      expect(res.status).toBe(final.status)
      expect(fetch.calls).toHaveLength(1)
      expect(sleeper.delays).toEqual([])
    }
  })

  it('honours Retry-After when it is longer than the computed delay, up to the cap', async () => {
    const { http, sleeper } = client(
      [textResponse(429, '', { 'Retry-After': '7' }), textResponse(429, '', { 'Retry-After': '600' }), jsonResponse(200, {})],
      { maxRetryAfterMs: 10_000 },
    )
    await http.request(URL)
    expect(sleeper.delays).toEqual([7000, 10_000])
  })

  it('gives up after maxRetries and returns the last response', async () => {
    const { http, fetch, sleeper } = client([textResponse(503, 'a'), textResponse(503, 'b'), textResponse(502, 'c'), jsonResponse(200, {})], {
      maxRetries: 2,
    })
    const res = await http.request(URL)
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('c')
    expect(fetch.calls).toHaveLength(3)
    expect(sleeper.delays).toHaveLength(2)
    expect(fetch.remaining()).toBe(1)
  })

  it('retries a network failure a small number of times, then rethrows it', async () => {
    const recovered = client([networkError(), jsonResponse(200, {})])
    expect((await recovered.http.request(URL)).status).toBe(200)
    expect(recovered.sleeper.delays).toEqual([1500])

    const offline = client([networkError(), networkError(), networkError(), jsonResponse(200, {})], { networkRetries: 2 })
    await expect(offline.http.request(URL)).rejects.toThrow('Failed to fetch')
    expect(offline.fetch.calls).toHaveLength(3)
    expect(offline.sleeper.delays).toEqual([1500, 2500])
  })

  it('logs each retry', async () => {
    const lines: string[] = []
    const fetch = scriptedFetch([textResponse(500, ''), jsonResponse(200, {})])
    const http = createHttpClient({ fetch: fetch.fetch, sleep: async () => undefined, random: () => 0, log: (l) => lines.push(l) })
    await http.request(URL)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/HTTP 500 .* retry 1\/5 in 1000 ms/)
  })
})
