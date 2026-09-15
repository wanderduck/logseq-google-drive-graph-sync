// Plan M3 step 3: the Google session persisted in `logseq.FileStorage` as one JSON string
// (`~/.logseq/storages/<plugin-id>/auth/google-session.json`, plaintext; plan §2 item 6).
// Verified host facts (spike §4.4 + host source `logseq.api.read_plugin_storage_file`):
//   - `setItem` / `getItem` / `hasItem` are awaited round trips;
//   - `getItem` of a missing key REJECTS ("file not existed"), so `hasItem` is checked first;
//   - `removeItem` / `clear` are fire-and-forget in SDK 0.0.17, so `clear()` overwrites the file with
//     the JSON literal `null` instead, which `load()` reads as "signed out".

/** The subset of `logseq.FileStorage` (`IAsyncStorage`) this store needs; tests pass an in-memory map. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null | undefined>
  setItem(key: string, value: string): Promise<void>
  hasItem(key: string): Promise<boolean>
}

export interface StoredSession {
  version: 1
  accessToken: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
  scope: string
  /** `null` when the Drive `about` call failed right after sign-in; retried on the next restore. */
  account: { email: string } | null
  /** Epoch ms of the device-flow approval. */
  connectedAt: number
}

export const SESSION_KEY = 'auth/google-session.json'

export interface TokenStore {
  /** `null` when nothing is stored, the file was cleared, or its content is unusable. */
  load(): Promise<StoredSession | null>
  save(session: StoredSession): Promise<void>
  clear(): Promise<void>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Pure validation of the stored text. Anything not written by `save` reads as "no session". */
export function parseStoredSession(text: unknown): StoredSession | null {
  if (typeof text !== 'string' || text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null
  const { accessToken, refreshToken, expiresAt, scope, account, connectedAt } = parsed
  if (typeof accessToken !== 'string' || accessToken === '') return null
  if (typeof refreshToken !== 'string' || refreshToken === '') return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
  const email = isRecord(account) && typeof account.email === 'string' && account.email !== '' ? account.email : null
  return {
    version: 1,
    accessToken,
    refreshToken,
    expiresAt,
    scope: typeof scope === 'string' ? scope : '',
    account: email === null ? null : { email },
    connectedAt: typeof connectedAt === 'number' && Number.isFinite(connectedAt) ? connectedAt : 0,
  }
}

export function createTokenStore(storage: KeyValueStorage, key: string = SESSION_KEY): TokenStore {
  return {
    async load() {
      if (!(await storage.hasItem(key))) return null
      try {
        return parseStoredSession(await storage.getItem(key))
      } catch {
        return null
      }
    },
    async save(session) {
      await storage.setItem(key, JSON.stringify(session))
    },
    async clear() {
      await storage.setItem(key, 'null')
    },
  }
}
