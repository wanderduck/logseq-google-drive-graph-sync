// Error types of the Google layer and the one place that turns them into a user-facing sentence.
// Pure TS. Google speaks two error dialects: OAuth (`{ error, error_description }`) and the Drive API
// (`{ error: { code, message, errors: [{ reason }], details: [{ reason }] } }`); `parseGoogleError` reads both.

export interface GoogleErrorInfo {
  /** OAuth `error` string, or the Drive `error.code` as a string. */
  code: string | null
  message: string | null
  /** Drive `error.errors[].reason` and `error.details[].reason`, e.g. `userRateLimitExceeded`, `SERVICE_DISABLED`. */
  reasons: string[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function reasonsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    if (isRecord(item) && typeof item.reason === 'string') out.push(item.reason)
  }
  return out
}

export function parseGoogleError(text: string): GoogleErrorInfo {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    const trimmed = text.trim()
    return { code: null, message: trimmed === '' ? null : trimmed.slice(0, 200), reasons: [] }
  }
  if (!isRecord(json)) return { code: null, message: null, reasons: [] }
  const e = json.error
  if (typeof e === 'string') return { code: e, message: asString(json.error_description), reasons: [] }
  if (isRecord(e)) {
    return {
      code: typeof e.code === 'number' ? String(e.code) : asString(e.code),
      message: asString(e.message),
      reasons: [...reasonsOf(e.errors), ...reasonsOf(e.details)],
    }
  }
  return { code: null, message: null, reasons: [] }
}

/** A non-2xx response that a caller decided is final. */
export class HttpError extends Error {
  override readonly name = 'HttpError'
  readonly status: number
  readonly url: string
  readonly info: GoogleErrorInfo

  constructor(status: number, url: string, info: GoogleErrorInfo) {
    super(`HTTP ${status} from ${url}${info.message ? `: ${info.message}` : ''}`)
    this.status = status
    this.url = url
    this.info = info
  }

  /** Reads the body; pass `url` because a `Response` built by hand (tests) has an empty `url`. */
  static async fromResponse(res: Response, url: string): Promise<HttpError> {
    let text = ''
    try {
      text = await res.text()
    } catch {
      // A body that cannot be read adds nothing to the message.
    }
    return new HttpError(res.status, url, parseGoogleError(text))
  }
}

/** An OAuth endpoint answered with `{ error: "<code>" }`. */
export class OAuthError extends Error {
  override readonly name = 'OAuthError'
  readonly code: string
  readonly description: string | null
  readonly status: number

  constructor(code: string, description: string | null, status: number) {
    super(`OAuth error ${code}${description ? `: ${description}` : ''} (HTTP ${status})`)
    this.code = code
    this.description = description
    this.status = status
  }
}

export type AuthErrorCode = 'not-signed-in' | 'session-expired' | 'no-credentials' | 'no-refresh-token'

/** A precondition of the auth service failed; `message` is already user-facing. */
export class AuthError extends Error {
  override readonly name = 'AuthError'
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export const DRIVE_API_DISABLED_REASONS = ['SERVICE_DISABLED', 'accessNotConfigured']

/** One user-facing sentence per failure; the raw error stays in the console. */
export function describeGoogleError(err: unknown): string {
  if (err instanceof AuthError) return err.message
  if (err instanceof OAuthError) {
    switch (err.code) {
      case 'invalid_client':
        return (
          'Google rejected the OAuth client (invalid_client). It must be a "TVs and Limited Input devices" client, ' +
          'and the client ID and secret must belong together.'
        )
      case 'invalid_grant':
      case 'unauthorized_client':
        return `Google no longer accepts the stored sign-in (${err.code}). Sign out and connect again.`
      case 'invalid_scope':
        return 'Google rejected the requested scope (invalid_scope). Add the Drive API scope to the OAuth consent screen.'
      default:
        return `Google OAuth error "${err.code}"${err.description ? `: ${err.description}` : ''}.`
    }
  }
  if (err instanceof HttpError) {
    if (err.info.reasons.some((r) => DRIVE_API_DISABLED_REASONS.includes(r))) {
      return 'The Google Drive API is not enabled in the Google Cloud project that owns this OAuth client. Enable it, wait a minute, and try again.'
    }
    if (err.status === 401) return 'Google rejected the access token (HTTP 401). Sign out and connect again.'
    const detail = err.info.message ? `: ${err.info.message}` : err.info.reasons.length > 0 ? ` (${err.info.reasons.join(', ')})` : ''
    if (err.status === 403) return `Google refused the request (HTTP 403)${detail}.`
    return `Google returned HTTP ${err.status}${detail}.`
  }
  // `fetch` reports a network failure as a TypeError ("Failed to fetch").
  if (err instanceof TypeError) return `Could not reach Google (${err.message}). Check the network connection.`
  if (err instanceof Error) return err.message
  return String(err)
}
