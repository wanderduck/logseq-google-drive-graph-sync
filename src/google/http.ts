// Plan M3 step 4: the one HTTP transport, iframe `fetch` (spike §3), with backoff and jitter on 429,
// 5xx and the 403 rate-limit reasons Drive uses for quota trouble. Host-agnostic: `fetch`, `sleep`,
// `random` and `now` are injected, so tests script every response and never wait.
//
// Contract for callers: `init.body` may be re-sent on a retry, so pass a string, URLSearchParams, Blob,
// ArrayBuffer or typed array, never a one-shot ReadableStream.

import { parseGoogleError } from './errors'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface BackoffPolicy {
  /** Retries after the first attempt for 429 / 5xx / 403 rate-limit responses. */
  maxRetries: number
  baseDelayMs: number
  /** Cap of the exponential part; jitter is added on top. */
  maxDelayMs: number
  /** Retries when `fetch` itself rejects (offline, DNS). Small on purpose so an offline machine fails fast. */
  networkRetries: number
  /** Upper bound of the random jitter added to every delay. */
  jitterMs: number
  /** A `Retry-After` header is honoured up to this bound. */
  maxRetryAfterMs: number
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 32_000,
  networkRetries: 2,
  jitterMs: 1000,
  maxRetryAfterMs: 60_000,
}

export interface HttpDeps {
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  /** Uniform in [0, 1). Defaults to `Math.random`. */
  random?: () => number
  /** Epoch ms; only used to interpret an HTTP-date `Retry-After`. Defaults to `Date.now`. */
  now?: () => number
  policy?: Partial<BackoffPolicy>
  log?: (line: string) => void
}

export interface HttpClient {
  /**
   * `fetch` with backoff. Resolves with the final response, 4xx/5xx included, so callers decide what a
   * non-2xx means (an OAuth poll treats 428 as "keep waiting"). Rejects only when `fetch` keeps failing.
   */
  request(url: string, init?: RequestInit): Promise<Response>
}

/** Drive `error.errors[].reason` values that mean "back off and retry" (Google's usage-limits guidance). */
export const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'sharingRateLimitExceeded'])

/** 429 and 5xx always; 403 only for the quota reasons. Other 403s (permissions, SERVICE_DISABLED, OAuth `slow_down`/`access_denied`) are final. */
export async function isRetryable(res: Response): Promise<boolean> {
  if (res.status === 429 || (res.status >= 500 && res.status <= 599)) return true
  if (res.status !== 403) return false
  let text = ''
  try {
    text = await res.clone().text()
  } catch {
    return false
  }
  return parseGoogleError(text).reasons.some((r) => RATE_LIMIT_REASONS.has(r))
}

/** `Retry-After` as delay-seconds or an HTTP-date; `null` when absent or unparsable. */
export function retryAfterMs(res: Response, now: number): number | null {
  const raw = res.headers.get('retry-after')
  if (raw === null) return null
  const value = raw.trim()
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

/** `min(maxDelay, base · 2^attempt) + jitter`, attempt counted from 0. */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy, random: () => number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt)
  return exponential + Math.floor(random() * policy.jitterMs)
}

export function createHttpClient(deps: HttpDeps): HttpClient {
  const policy: BackoffPolicy = { ...DEFAULT_BACKOFF, ...deps.policy }
  const random = deps.random ?? Math.random
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)

  async function request(url: string, init?: RequestInit): Promise<Response> {
    let attempt = 0
    let networkFailures = 0
    for (;;) {
      let res: Response
      try {
        res = await deps.fetch(url, init)
      } catch (err) {
        if (networkFailures >= policy.networkRetries) throw err
        const delay = backoffDelayMs(networkFailures, policy, random)
        networkFailures++
        log(`network error on ${url} (${err instanceof Error ? err.message : String(err)}); retry ${networkFailures}/${policy.networkRetries} in ${delay} ms`)
        await deps.sleep(delay)
        continue
      }
      if (attempt >= policy.maxRetries || !(await isRetryable(res))) return res
      const hinted = retryAfterMs(res, now())
      const delay = Math.max(backoffDelayMs(attempt, policy, random), Math.min(hinted ?? 0, policy.maxRetryAfterMs))
      attempt++
      log(`HTTP ${res.status} on ${url}; retry ${attempt}/${policy.maxRetries} in ${delay} ms`)
      await deps.sleep(delay)
    }
  }

  return { request }
}
