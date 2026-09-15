// Host wiring for src/google/: iframe `fetch` (spike §3), `logseq.FileStorage` for the session file,
// and the build-time client from `.env.local` (D5) with the settings override (plan M3 step 1).

import { createGoogleAuth, type GoogleAuth } from '../google/auth'
import { resolveClientCredentials, type BuiltInCredentials } from '../google/credentials'
import { createDriveClient, type DriveClient, type DriveClientDeps } from '../google/drive'
import { createHttpClient } from '../google/http'
import { createTokenStore } from '../google/tokenStore'
import type { Store } from '../sync/store'
import type { GdsyncSettings } from './settings'

/** `setTimeout` that resolves early (not rejects) when `signal` aborts, so a cancelled poll stops waiting. */
export function hostSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createHostGoogleAuth(settings: Store<GdsyncSettings>): GoogleAuth {
  // Vite inlines both at build time; a build without `.env.local` leaves them undefined.
  const builtIn: BuiltInCredentials = {
    clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
    clientSecret: import.meta.env.VITE_GOOGLE_CLIENT_SECRET,
  }
  const log = (line: string, detail?: unknown): void => {
    if (detail === undefined) console.info(`[gdsync] ${line}`)
    else console.warn(`[gdsync] ${line}`, detail)
  }
  const http = createHttpClient({
    fetch: (url, init) => window.fetch(url, init),
    sleep: hostSleep,
    log: (line) => log(`http: ${line}`),
  })
  return createGoogleAuth({
    http,
    store: createTokenStore(logseq.FileStorage),
    getCredentials: () => resolveClientCredentials(builtIn, settings.get()),
    sleep: hostSleep,
    log: (line, detail) => log(`auth: ${line}`, detail),
  })
}

/** The Drive client over the authorized fetch (M4). `overrides` exist for the smoke test's small upload thresholds. */
export function createHostDriveClient(auth: GoogleAuth, overrides: Partial<Omit<DriveClientDeps, 'fetch'>> = {}): DriveClient {
  return createDriveClient({
    fetch: auth.fetch,
    log: (line) => console.info(`[gdsync] drive: ${line}`),
    ...overrides,
  })
}
