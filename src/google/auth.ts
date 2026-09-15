// The Google session (plan M3 steps 2–3): device-code connect, token store, refresh on expiry / 401,
// sign-out with revoke. Host-agnostic: every side effect comes through `GoogleAuthDeps`, and the UI
// follows `state` (a `Store<AuthState>`) instead of being called back. The controller mirrors that store
// into `SyncStatus` and shows the toasts; nothing in here knows about `logseq`.

import { fetchAccount, type GoogleAccount } from './account'
import type { CredentialsResolution } from './credentials'
import { AuthError, OAuthError, describeGoogleError } from './errors'
import type { FetchLike, HttpClient } from './http'
import { pollForDeviceToken, refreshAccessToken, requestDeviceCode, revokeToken, type DevicePollOutcome } from './oauth'
import type { StoredSession, TokenStore } from './tokenStore'
import { createStore, type Store } from '../sync/store'

export type AuthState =
  | { kind: 'signed-out'; reason: 'session-expired' | null }
  | { kind: 'connecting'; userCode: string; verificationUrl: string; expiresAt: number }
  | { kind: 'signed-in'; account: GoogleAccount }

export type ConnectResult =
  /** `warning`: signed in, but the e-mail lookup or the on-disk save failed; worth a toast. */
  | { kind: 'connected'; account: GoogleAccount; warning: string | null }
  | Exclude<DevicePollOutcome, { kind: 'authorized' }>
  | { kind: 'already-connected' }
  | { kind: 'already-connecting' }

export interface SignOutResult {
  /** `false` when Google could not be told; the local session is gone either way. */
  revoked: boolean
  revokeError: string | null
}

export interface GoogleAuthDeps {
  http: HttpClient
  store: TokenStore
  /** Read on every use so a settings change applies without a reload. */
  getCredentials: () => CredentialsResolution
  /** Must resolve early when `signal` aborts (cancel takes effect mid-poll). */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  log?: (line: string, detail?: unknown) => void
}

export interface GoogleAuth {
  readonly state: Store<AuthState>
  /** Startup: loads the stored session without a network call (DoD: connected state survives a restart). */
  restore(): Promise<AuthState>
  /** Runs the whole device flow. Throws `AuthError`, `OAuthError`, `HttpError` or a network `TypeError`. */
  connect(): Promise<ConnectResult>
  cancelConnect(): void
  /** A token valid for at least `EXPIRY_MARGIN_MS`; refreshes first when needed. */
  getAccessToken(): Promise<string>
  /** `fetch` with the Bearer header; one refresh + retry on 401. Same body-reuse contract as `HttpClient`. */
  fetch: FetchLike
  /** Revokes at Google (best effort) and always clears the local session. */
  signOut(): Promise<SignOutResult>
  isSignedIn(): boolean
}

/** Refresh when the access token has less than this left. */
export const EXPIRY_MARGIN_MS = 60_000
export const UNKNOWN_ACCOUNT: GoogleAccount = { email: 'unknown account' }

const SIGNED_OUT: AuthState = { kind: 'signed-out', reason: null }

interface ConnectRun {
  cancelled: boolean
  abort: AbortController
}

export function createGoogleAuth(deps: GoogleAuthDeps): GoogleAuth {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const state = createStore<AuthState>(SIGNED_OUT)

  let session: StoredSession | null = null
  let refreshing: Promise<string> | null = null
  let run: ConnectRun | null = null

  function credentials() {
    const r = deps.getCredentials()
    if (!r.ok) throw new AuthError('no-credentials', r.reason)
    return r.credentials
  }

  function accountOf(s: StoredSession): GoogleAccount {
    return s.account ?? UNKNOWN_ACCOUNT
  }

  async function dropSession(reason: 'session-expired' | null): Promise<void> {
    session = null
    state.set({ kind: 'signed-out', reason })
    try {
      await deps.store.clear()
    } catch (err) {
      log('clearing the token store failed', err)
    }
  }

  function refresh(): Promise<string> {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const current = session
      if (!current) throw new AuthError('not-signed-in', 'Not connected to Google.')
      const creds = credentials()
      try {
        const t = await refreshAccessToken(deps.http, creds, current.refreshToken, now)
        // The session may have been dropped meanwhile (sign-out during the request): do not resurrect it.
        if (session !== current) throw new AuthError('not-signed-in', 'Not connected to Google.')
        session = {
          ...current,
          accessToken: t.accessToken,
          expiresAt: t.expiresAt,
          refreshToken: t.refreshToken ?? current.refreshToken,
          scope: t.scope || current.scope,
        }
        await deps.store.save(session)
        return session.accessToken
      } catch (err) {
        if (err instanceof OAuthError && (err.code === 'invalid_grant' || err.code === 'unauthorized_client')) {
          log('refresh rejected; dropping the session', err)
          await dropSession('session-expired')
          throw new AuthError('session-expired', 'The Google sign-in expired or was revoked. Connect again.')
        }
        throw err
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  async function getAccessToken(): Promise<string> {
    if (!session) throw new AuthError('not-signed-in', 'Not connected to Google.')
    if (session.expiresAt - now() > EXPIRY_MARGIN_MS) return session.accessToken
    return refresh()
  }

  function withBearer(init: RequestInit | undefined, token: string): RequestInit {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return { ...init, headers }
  }

  const authorizedFetch: FetchLike = async (url, init) => {
    const token = await getAccessToken()
    const res = await deps.http.request(url, withBearer(init, token))
    if (res.status !== 401) return res
    log(`HTTP 401 on ${url}; refreshing the access token once`)
    const fresh = await refresh()
    return deps.http.request(url, withBearer(init, fresh))
  }

  async function restore(): Promise<AuthState> {
    try {
      session = await deps.store.load()
    } catch (err) {
      log('loading the token store failed', err)
      session = null
    }
    if (!session) {
      state.set(SIGNED_OUT)
      return state.get()
    }
    state.set({ kind: 'signed-in', account: accountOf(session) })
    if (session.account === null) void completeAccount()
    return state.get()
  }

  /** Second chance for the e-mail when `about` failed at connect time (e.g. the Drive API was not enabled yet). */
  async function completeAccount(): Promise<void> {
    const current = session
    if (!current) return
    try {
      const account = await fetchAccount(authorizedFetch)
      if (session !== current) return
      session = { ...current, account }
      await deps.store.save(session)
      state.set({ kind: 'signed-in', account })
    } catch (err) {
      log('account lookup failed', err)
    }
  }

  async function connect(): Promise<ConnectResult> {
    if (session) return { kind: 'already-connected' }
    if (run) return { kind: 'already-connecting' }
    const creds = credentials()
    const thisRun: ConnectRun = { cancelled: false, abort: new AbortController() }
    run = thisRun
    try {
      const code = await requestDeviceCode(deps.http, creds, now)
      if (thisRun.cancelled) return { kind: 'cancelled' }
      state.set({ kind: 'connecting', userCode: code.userCode, verificationUrl: code.verificationUrl, expiresAt: code.expiresAt })

      const outcome = await pollForDeviceToken(deps.http, creds, code, {
        sleep: (ms) => deps.sleep(ms, thisRun.abort.signal),
        now,
        isCancelled: () => thisRun.cancelled,
      })
      if (outcome.kind !== 'authorized') {
        state.set(SIGNED_OUT)
        return outcome
      }
      if (!outcome.tokens.refreshToken) {
        throw new AuthError(
          'no-refresh-token',
          'Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and connect again.',
        )
      }

      session = {
        version: 1,
        accessToken: outcome.tokens.accessToken,
        refreshToken: outcome.tokens.refreshToken,
        expiresAt: outcome.tokens.expiresAt,
        scope: outcome.tokens.scope,
        account: null,
        connectedAt: now(),
      }
      const warnings: string[] = []
      try {
        session = { ...session, account: await fetchAccount(authorizedFetch) }
      } catch (err) {
        log('account lookup failed after sign-in', err)
        warnings.push(`The Drive API check failed: ${describeGoogleError(err)}`)
      }
      try {
        await deps.store.save(session)
      } catch (err) {
        log('saving the session failed', err)
        warnings.push('The sign-in could not be saved to disk, so it will not survive a Logseq restart.')
      }
      const account = accountOf(session)
      state.set({ kind: 'signed-in', account })
      return { kind: 'connected', account, warning: warnings.length > 0 ? warnings.join(' ') : null }
    } catch (err) {
      if (!session) state.set(SIGNED_OUT)
      throw err
    } finally {
      if (run === thisRun) run = null
    }
  }

  function cancelConnect(): void {
    if (!run) return
    run.cancelled = true
    run.abort.abort()
  }

  async function signOut(): Promise<SignOutResult> {
    cancelConnect()
    const current = session
    let revoked = false
    let revokeError: string | null = null
    if (current) {
      try {
        await revokeToken(deps.http, current.refreshToken)
        revoked = true
      } catch (err) {
        log('revoke failed', err)
        revokeError = describeGoogleError(err)
      }
    }
    await dropSession(null)
    return { revoked, revokeError }
  }

  return {
    state,
    restore,
    connect,
    cancelConnect,
    getAccessToken,
    fetch: authorizedFetch,
    signOut,
    isSignedIn: () => session !== null,
  }
}
