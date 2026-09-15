// The `RemoteMirror` (src/sync/remote.ts) over the Drive client: the graph folder `<root>/graphs/<graph>`
// seen as graph-relative paths. Drive facts it absorbs so the engine never sees them (spike §4 item 8,
// M4 findings): a file's path is its `parents` chain (rebuilt with `pathUnder` and the folder cache, never
// trusted from `appProperties.relPath`); every `changes.list` entry reports the file's CURRENT state and an
// id can repeat; a trashed or moved-out file is simply gone; `.gdsync/` is bookkeeping (the lock), not
// content; duplicate names collapse onto the oldest file (`oldestFirst`); a rejected token means "list
// everything". A folder that the feed shows renamed, moved or trashed changes the paths of everything
// below it without those files appearing in the feed, so any folder change the cache cannot vouch for
// falls back to a full listing (cheap: one request per folder, rare after the first sync).

import { InvalidPageTokenError, isNotFound, type ChangesResult, type DriveClient, type DriveFile } from './drive'
import { LOCK_DIR } from './lock'
import type { RemoteDelta, RemoteFile, RemoteMirror, TransferOpts, UploadMeta } from '../sync/remote'

/** `appProperties` keys of every mirrored file (plan §3.3). */
export const PROP_SHA256 = 'sha256'
export const PROP_REL_PATH = 'relPath'
export const PROP_DEVICE_ID = 'deviceId'

export interface DriveMirrorDeps {
  client: DriveClient
  /** `DriveLayout.graphFolderId` from `bootstrapLayout`. */
  graphFolderId: string
  log?: (line: string) => void
}

const SHA256_RE = /^[0-9a-f]{64}$/

export function toRemoteFile(file: DriveFile, path: string): RemoteFile {
  const sha = file.appProperties[PROP_SHA256]
  return {
    path,
    id: file.id,
    sha256: typeof sha === 'string' && SHA256_RE.test(sha) ? sha : null,
    size: file.size ?? 0,
    modifiedTime: file.modifiedTime,
    createdTime: file.createdTime,
    md5: file.md5Checksum,
  }
}

function isBookkeeping(segments: readonly string[]): boolean {
  return segments[0] === LOCK_DIR
}

export function createDriveMirror(deps: DriveMirrorDeps): RemoteMirror {
  const { client, graphFolderId } = deps
  const log = deps.log ?? (() => undefined)
  /** Concurrent uploads into one new directory share a single `ensureFolderPath` round trip. */
  const pendingFolders = new Map<string, Promise<string>>()

  async function full(): Promise<RemoteDelta> {
    // The token first, so a change that lands during the listing is seen by the next delta.
    const token = await client.getStartPageToken()
    const files: RemoteFile[] = []
    for (const { file, segments } of await client.listTree(graphFolderId)) {
      if (file.isFolder || file.trashed || isBookkeeping(segments)) continue
      files.push(toRemoteFile(file, segments.join('/')))
    }
    return { kind: 'full', files, token }
  }

  async function fetchDelta(token: string | null): Promise<RemoteDelta> {
    if (token === null) return full()
    let result: ChangesResult
    try {
      result = await client.listChanges(token)
    } catch (err) {
      if (!(err instanceof InvalidPageTokenError)) throw err
      log('the changes token was rejected; listing the whole graph folder')
      return full()
    }
    const changed = new Map<string, RemoteFile>()
    const removedIds = new Set<string>()
    for (const change of result.changes) {
      const { file } = change
      if (change.removed || !file || file.trashed) {
        if (file?.isFolder) {
          log(`folder ${change.fileId} was trashed or removed; listing the whole graph folder`)
          return full()
        }
        removedIds.add(change.fileId)
        changed.delete(change.fileId)
        continue
      }
      if (file.isFolder) {
        if (file.name === LOCK_DIR && file.parents[0] === graphFolderId) continue // the lock folder, never content
        const known = client.folders.entry(file.id)
        if (!known || known.parentId !== file.parents[0] || known.name !== file.name) {
          log(`folder "${file.name}" (${file.id}) is new or moved; listing the whole graph folder`)
          return full()
        }
        continue
      }
      const segments = await client.pathUnder(file, graphFolderId)
      if (segments === null) {
        removedIds.add(file.id) // outside the graph folder now (or its folder is gone)
        changed.delete(file.id)
        continue
      }
      if (isBookkeeping(segments)) continue
      removedIds.delete(file.id)
      changed.set(file.id, toRemoteFile(file, segments.join('/')))
    }
    return { kind: 'changes', changed: [...changed.values()], removedIds: [...removedIds], token: result.newStartPageToken }
  }

  async function download(id: string, opts: TransferOpts = {}): Promise<Uint8Array> {
    return new Uint8Array(await client.download(id, opts))
  }

  /** Memoised per path prefix, so `n/a.md`, `n/b.md` and `n/sub/c.md` uploaded at once create `n` exactly once. */
  function folderFor(dir: string): Promise<string> {
    if (dir === '') return Promise.resolve(graphFolderId)
    const pending = pendingFolders.get(dir)
    if (pending) return pending
    const slash = dir.lastIndexOf('/')
    const parent = slash === -1 ? '' : dir.slice(0, slash)
    const name = slash === -1 ? dir : dir.slice(slash + 1)
    const p = folderFor(parent).then((parentId) => client.ensureFolder(parentId, name))
    pendingFolders.set(dir, p)
    void p.catch(() => undefined).finally(() => pendingFolders.delete(dir))
    return p
  }

  async function upload(path: string, data: Uint8Array, meta: UploadMeta, existingId: string | null, opts: TransferOpts = {}): Promise<RemoteFile> {
    const appProperties = { [PROP_SHA256]: meta.sha256, [PROP_REL_PATH]: path, [PROP_DEVICE_ID]: meta.deviceId }
    if (existingId !== null) {
      try {
        return toRemoteFile(await client.updateFile(existingId, data, { appProperties, modifiedTime: meta.modifiedTime }, opts), path)
      } catch (err) {
        if (!isNotFound(err)) throw err
        log(`${path}: Drive file ${existingId} is gone; creating it anew`)
      }
    }
    const slash = path.lastIndexOf('/')
    const parentId = await folderFor(slash === -1 ? '' : path.slice(0, slash))
    const name = slash === -1 ? path : path.slice(slash + 1)
    return toRemoteFile(await client.createFile(data, { name, parentId, appProperties, modifiedTime: meta.modifiedTime }, opts), path)
  }

  async function trash(id: string): Promise<void> {
    try {
      await client.trash(id)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  return { fetchDelta, download, upload, trash }
}
