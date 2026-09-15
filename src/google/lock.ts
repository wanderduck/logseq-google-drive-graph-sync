// Plan M4 step 4: the per-graph Drive lock, `<graph folder>/.gdsync/lock.json` holding
// `{ deviceId, deviceName, acquiredAt, expiresAt }` (plan §3.3). Drive has no atomic create-if-absent, so
// acquire is "look, create, re-list": when two devices raced, the oldest lock file wins and the loser
// removes its own (plan §7 risk table; manual single-user sync makes this rare). An expired lock can be
// broken on request (§3.6 step 2). Lock files are deleted for good, never trashed.

import { isNotFound, oldestFirst, type DriveClient, type DriveFile } from './drive'

export const LOCK_DIR = '.gdsync'
export const LOCK_FILE = 'lock.json'
export const LOCK_MIME = 'application/json'

export interface LockInfo {
  deviceId: string
  deviceName: string
  /** Epoch ms. */
  acquiredAt: number
  /** Epoch ms; a lock past this is stale and may be broken. */
  expiresAt: number
}

export interface LockHandle {
  fileId: string
  lock: LockInfo
}

export type AcquireResult =
  | { kind: 'acquired'; lock: LockInfo }
  /** Another device holds it; `expired` tells the caller whether `breakExpired: true` would take it. */
  | { kind: 'held'; lock: LockInfo; expired: boolean }

export interface AcquireOptions {
  ttlMs: number
  /** Take over a lock whose `expiresAt` has passed. Off by default: the UI asks first. */
  breakExpired?: boolean
}

export interface DriveLockDeps {
  client: DriveClient
  graphFolderId: string
  deviceId: string
  deviceName: string
  now?: () => number
  log?: (line: string) => void
}

export interface DriveLock {
  /** The current lock on Drive, whoever holds it; `null` when none. */
  read(): Promise<LockHandle | null>
  acquire(opts: AcquireOptions): Promise<AcquireResult>
  /** Pushes `expiresAt` out by `ttlMs` on the lock this device holds (long syncs). */
  renew(ttlMs: number): Promise<LockInfo>
  /** Deletes this device's lock file; a no-op when none is held or it is already gone. */
  release(): Promise<void>
  /** Non-null between a successful `acquire` and `release`. */
  held(): LockInfo | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Unreadable content parses to an already-expired lock from an unknown device, so it can be broken. */
export function parseLockInfo(text: string): LockInfo {
  const broken: LockInfo = { deviceId: '', deviceName: 'unknown device', acquiredAt: 0, expiresAt: 0 }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return broken
  }
  if (!isRecord(json)) return broken
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    deviceId: typeof json.deviceId === 'string' ? json.deviceId : '',
    deviceName: typeof json.deviceName === 'string' && json.deviceName !== '' ? json.deviceName : 'unknown device',
    acquiredAt: num(json.acquiredAt),
    expiresAt: num(json.expiresAt),
  }
}

export function serializeLockInfo(lock: LockInfo): string {
  return JSON.stringify({ version: 1, ...lock })
}

export function createDriveLock(deps: DriveLockDeps): DriveLock {
  const { client, graphFolderId, deviceId, deviceName } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  let current: LockHandle | null = null

  async function lockFilesIn(dirId: string): Promise<DriveFile[]> {
    return (await client.listChildren(dirId, 'files')).filter((f) => f.name === LOCK_FILE).sort(oldestFirst)
  }

  async function handleOf(file: DriveFile): Promise<LockHandle> {
    return { fileId: file.id, lock: parseLockInfo(await client.downloadText(file.id)) }
  }

  async function read(): Promise<LockHandle | null> {
    const dir = await client.findChild(graphFolderId, LOCK_DIR, true)
    if (!dir) return null
    const files = await lockFilesIn(dir.id)
    if (files.length === 0) return null
    if (files.length > 1) log(`${files.length} lock files found; the oldest (${files[0].id}) counts`)
    return handleOf(files[0])
  }

  async function deleteQuietly(fileId: string): Promise<void> {
    try {
      await client.deleteForever(fileId)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  async function writeLock(fileId: string, lock: LockInfo): Promise<void> {
    await client.updateFile(fileId, serializeLockInfo(lock), { appProperties: { deviceId } })
  }

  async function acquire(opts: AcquireOptions): Promise<AcquireResult> {
    const t = now()
    const existing = await read()
    if (existing) {
      const expired = existing.lock.expiresAt <= t
      if (existing.lock.deviceId === deviceId) {
        // Left behind by a crashed run on this very device: take it back in place.
        log(`re-using this device's own lock (${existing.fileId}${expired ? ', expired' : ''})`)
        const lock: LockInfo = { deviceId, deviceName, acquiredAt: t, expiresAt: t + opts.ttlMs }
        await writeLock(existing.fileId, lock)
        current = { fileId: existing.fileId, lock }
        return { kind: 'acquired', lock }
      }
      if (!expired) return { kind: 'held', lock: existing.lock, expired: false }
      if (!opts.breakExpired) return { kind: 'held', lock: existing.lock, expired: true }
      log(`breaking the expired lock of "${existing.lock.deviceName}" (${existing.fileId})`)
      await deleteQuietly(existing.fileId)
    }

    const dirId = await client.ensureFolder(graphFolderId, LOCK_DIR)
    const lock: LockInfo = { deviceId, deviceName, acquiredAt: t, expiresAt: t + opts.ttlMs }
    const created = await client.createFile(serializeLockInfo(lock), { name: LOCK_FILE, parentId: dirId, mimeType: LOCK_MIME, appProperties: { deviceId } })

    const all = await lockFilesIn(dirId)
    const winner = all[0]
    if (winner && winner.id !== created.id) {
      log(`lost the lock race to ${winner.id}; removing our lock file (${created.id})`)
      await deleteQuietly(created.id)
      const theirs = await handleOf(winner)
      return { kind: 'held', lock: theirs.lock, expired: theirs.lock.expiresAt <= now() }
    }
    current = { fileId: created.id, lock }
    return { kind: 'acquired', lock }
  }

  async function renew(ttlMs: number): Promise<LockInfo> {
    if (!current) throw new Error('This device does not hold the Drive lock.')
    const lock: LockInfo = { ...current.lock, expiresAt: now() + ttlMs }
    try {
      await writeLock(current.fileId, lock)
    } catch (err) {
      if (isNotFound(err)) {
        current = null
        throw new Error('The Drive lock file disappeared while this device held it.')
      }
      throw err
    }
    current = { fileId: current.fileId, lock }
    return lock
  }

  async function release(): Promise<void> {
    if (!current) return
    const { fileId } = current
    current = null
    await deleteQuietly(fileId)
  }

  return { read, acquire, renew, release, held: () => current?.lock ?? null }
}
