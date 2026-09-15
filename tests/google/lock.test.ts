import { describe, expect, it } from 'vitest'
import { createDriveClient } from '../../src/google/drive'
import { LOCK_DIR, LOCK_FILE, createDriveLock, parseLockInfo, serializeLockInfo, type DriveLockDeps } from '../../src/google/lock'
import { createFakeDrive } from './fakeDrive'
import { jsonResponse } from './helpers'

const T0 = 1_700_000_000_000
const TTL = 10 * 60_000

function world() {
  let now = T0
  const fake = createFakeDrive({ now: () => now })
  const graph = fake.addFolder('root', 'g')
  const logs: string[] = []
  const device = (deviceId: string, deviceName: string, overrides: Partial<DriveLockDeps> = {}) =>
    createDriveLock({ client: createDriveClient({ fetch: fake.fetch }), graphFolderId: graph.id, deviceId, deviceName, now: () => now, log: (l) => logs.push(l), ...overrides })
  const lockFiles = () => {
    const dir = fake.childrenOf(graph.id).find((f) => f.name === LOCK_DIR)
    return dir ? fake.childrenOf(dir.id).filter((f) => f.name === LOCK_FILE) : []
  }
  return { fake, graph, logs, device, lockFiles, advance: (ms: number) => (now += ms), now: () => now }
}

describe('parseLockInfo', () => {
  it('round-trips and treats garbage as an expired lock of an unknown device', () => {
    const lock = { deviceId: 'd1', deviceName: 'Laptop', acquiredAt: T0, expiresAt: T0 + TTL }
    expect(parseLockInfo(serializeLockInfo(lock))).toEqual(lock)
    expect(JSON.parse(serializeLockInfo(lock)).version).toBe(1)
    expect(parseLockInfo('not json')).toEqual({ deviceId: '', deviceName: 'unknown device', acquiredAt: 0, expiresAt: 0 })
    expect(parseLockInfo('[1]')).toMatchObject({ expiresAt: 0 })
    expect(parseLockInfo('{"deviceId":"x","expiresAt":"soon"}')).toEqual({ deviceId: 'x', deviceName: 'unknown device', acquiredAt: 0, expiresAt: 0 })
  })
})

describe('createDriveLock (plan M4 step 4)', () => {
  it('acquires by creating .gdsync/lock.json, reads it back, and releases by deleting it', async () => {
    const w = world()
    const a = w.device('d1', 'Laptop')
    expect(await a.read()).toBeNull()
    expect(a.held()).toBeNull()
    const r = await a.acquire({ ttlMs: TTL })
    expect(r).toEqual({ kind: 'acquired', lock: { deviceId: 'd1', deviceName: 'Laptop', acquiredAt: T0, expiresAt: T0 + TTL } })
    expect(a.held()).toEqual(r.lock)
    const files = w.lockFiles()
    expect(files).toHaveLength(1)
    expect(JSON.parse(w.fake.textOf(files[0].id))).toMatchObject({ version: 1, deviceId: 'd1', expiresAt: T0 + TTL })
    expect(files[0].appProperties).toEqual({ deviceId: 'd1' })
    expect(files[0].mimeType).toBe('application/json')
    expect((await a.read())?.lock).toEqual(r.lock)
    await a.release()
    expect(a.held()).toBeNull()
    expect(w.lockFiles()).toHaveLength(0)
    expect(w.fake.files.size).toBe(3) // root, g, .gdsync stay
    await a.release() // idempotent
  })

  it('reports a live lock of another device as held, and an expired one as breakable', async () => {
    const w = world()
    await w.device('d1', 'Laptop').acquire({ ttlMs: TTL })
    const b = w.device('d2', 'Office-PC')
    expect(await b.acquire({ ttlMs: TTL })).toEqual({ kind: 'held', lock: { deviceId: 'd1', deviceName: 'Laptop', acquiredAt: T0, expiresAt: T0 + TTL }, expired: false })
    expect(b.held()).toBeNull()
    w.advance(TTL + 1)
    expect(await b.acquire({ ttlMs: TTL })).toMatchObject({ kind: 'held', expired: true })
    expect(w.lockFiles()).toHaveLength(1)
    const broken = await b.acquire({ ttlMs: TTL, breakExpired: true })
    expect(broken).toMatchObject({ kind: 'acquired', lock: { deviceId: 'd2', acquiredAt: w.now(), expiresAt: w.now() + TTL } })
    expect(w.lockFiles()).toHaveLength(1)
    expect(JSON.parse(w.fake.textOf(w.lockFiles()[0].id)).deviceId).toBe('d2')
    expect(w.logs.some((l) => l.includes('breaking the expired lock of "Laptop"'))).toBe(true)
  })

  it('takes back its own stale lock in place after a crash (same device id, new instance)', async () => {
    const w = world()
    await w.device('d1', 'Laptop').acquire({ ttlMs: TTL })
    const fileId = w.lockFiles()[0].id
    w.advance(5000)
    const again = w.device('d1', 'Laptop-renamed')
    const r = await again.acquire({ ttlMs: TTL })
    expect(r).toMatchObject({ kind: 'acquired', lock: { deviceName: 'Laptop-renamed', acquiredAt: T0 + 5000 } })
    expect(w.lockFiles().map((f) => f.id)).toEqual([fileId])
    expect(w.logs.some((l) => l.includes("re-using this device's own lock"))).toBe(true)
    await again.release()
    expect(w.lockFiles()).toHaveLength(0)
  })

  it('renew pushes expiresAt out; it fails when nothing is held or the file vanished', async () => {
    const w = world()
    const a = w.device('d1', 'Laptop')
    await expect(a.renew(TTL)).rejects.toThrow(/does not hold/)
    await a.acquire({ ttlMs: TTL })
    w.advance(60_000)
    const renewed = await a.renew(TTL)
    expect(renewed.expiresAt).toBe(T0 + 60_000 + TTL)
    expect(a.held()?.expiresAt).toBe(renewed.expiresAt)
    expect(JSON.parse(w.fake.textOf(w.lockFiles()[0].id)).expiresAt).toBe(renewed.expiresAt)
    w.fake.files.delete(w.lockFiles()[0].id)
    await expect(a.renew(TTL)).rejects.toThrow(/disappeared/)
    expect(a.held()).toBeNull()
    await a.release()
  })

  it('loses a create race to an older lock file and removes its own', async () => {
    const w = world()
    const a = w.device('d1', 'Laptop')
    // The other device's lock lands just after this device looked and saw nothing.
    const dirId = await createDriveClient({ fetch: w.fake.fetch }).ensureFolder(w.graph.id, LOCK_DIR)
    w.fake.addFile(dirId, LOCK_FILE, serializeLockInfo({ deviceId: 'd2', deviceName: 'Office-PC', acquiredAt: T0 - 1000, expiresAt: T0 + TTL }), { createdTime: T0 - 1000 })
    w.fake.failNext({ match: (c) => c.method === 'GET' && (c.url.searchParams.get('q') ?? '').includes(`'${dirId}' in parents`), answer: jsonResponse(200, { files: [] }) })
    const r = await a.acquire({ ttlMs: TTL })
    expect(r).toEqual({ kind: 'held', lock: { deviceId: 'd2', deviceName: 'Office-PC', acquiredAt: T0 - 1000, expiresAt: T0 + TTL }, expired: false })
    expect(a.held()).toBeNull()
    expect(w.lockFiles()).toHaveLength(1)
    expect(w.logs.some((l) => l.includes('lost the lock race'))).toBe(true)
  })

  it('treats an unreadable lock file as expired and breaks it on request', async () => {
    const w = world()
    const dirId = await createDriveClient({ fetch: w.fake.fetch }).ensureFolder(w.graph.id, LOCK_DIR)
    w.fake.addFile(dirId, LOCK_FILE, 'garbage')
    const a = w.device('d1', 'Laptop')
    expect(await a.acquire({ ttlMs: TTL })).toEqual({ kind: 'held', lock: { deviceId: '', deviceName: 'unknown device', acquiredAt: 0, expiresAt: 0 }, expired: true })
    expect(await a.acquire({ ttlMs: TTL, breakExpired: true })).toMatchObject({ kind: 'acquired' })
    expect(w.lockFiles()).toHaveLength(1)
  })
})
