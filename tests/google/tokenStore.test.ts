import { describe, expect, it } from 'vitest'
import { SESSION_KEY, createTokenStore, parseStoredSession, type StoredSession } from '../../src/google/tokenStore'
import { fakeStorage } from './helpers'

const session: StoredSession = {
  version: 1,
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: 1_700_000_000_000,
  scope: 'https://www.googleapis.com/auth/drive.file',
  account: { email: 'me@example.com' },
  connectedAt: 1_699_999_000_000,
}

describe('parseStoredSession', () => {
  it('round-trips what save writes', () => {
    expect(parseStoredSession(JSON.stringify(session))).toEqual(session)
  })

  it('accepts a session without an account and fills the optional fields', () => {
    const minimal = { version: 1, accessToken: 'a', refreshToken: 'r', expiresAt: 5 }
    expect(parseStoredSession(JSON.stringify(minimal))).toEqual({ ...minimal, scope: '', account: null, connectedAt: 0 })
  })

  it('reads anything not written by save as "no session"', () => {
    expect(parseStoredSession(undefined)).toBeNull()
    expect(parseStoredSession('')).toBeNull()
    expect(parseStoredSession('null')).toBeNull()
    expect(parseStoredSession('{not json')).toBeNull()
    expect(parseStoredSession(JSON.stringify({ ...session, version: 2 }))).toBeNull()
    expect(parseStoredSession(JSON.stringify({ ...session, refreshToken: '' }))).toBeNull()
    expect(parseStoredSession(JSON.stringify({ ...session, expiresAt: 'soon' }))).toBeNull()
  })
})

describe('createTokenStore over FileStorage (plan M3 step 3)', () => {
  it('saves under the session key and loads it back', async () => {
    const storage = fakeStorage()
    const store = createTokenStore(storage)
    await store.save(session)
    expect(storage.files.has(SESSION_KEY)).toBe(true)
    expect(await store.load()).toEqual(session)
  })

  it('returns null without calling getItem when nothing is stored (host getItem would reject)', async () => {
    const storage = fakeStorage()
    storage.failReads = true
    expect(await createTokenStore(storage).load()).toBeNull()
  })

  it('returns null when getItem rejects anyway', async () => {
    const storage = fakeStorage({ [SESSION_KEY]: JSON.stringify(session) })
    storage.failReads = true
    expect(await createTokenStore(storage).load()).toBeNull()
  })

  it('clear overwrites the file with "null" because removeItem is fire-and-forget on SDK 0.0.17', async () => {
    const storage = fakeStorage({ [SESSION_KEY]: JSON.stringify(session) })
    const store = createTokenStore(storage)
    await store.clear()
    expect(storage.files.get(SESSION_KEY)).toBe('null')
    expect(await store.load()).toBeNull()
  })
})
