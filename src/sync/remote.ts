// Plan §3.6 step 4: the engine's view of the Drive mirror. `RemoteMirror` is everything src/sync/ knows
// about Google Drive (this directory imports nothing from src/google/); src/google/mirror.ts implements
// it over `DriveClient`, and the tests run that real adapter over FakeDrive (M4 decision: the engine is
// never tested against a hand-rolled interface fake).
//
// A `RemoteFile` is a file under the graph folder addressed by its graph-relative path. The engine keeps a
// persisted REMOTE VIEW (`state.remote`, see state.ts): Drive's state under the graph folder as of the stored
// changes token, including changes not yet applied locally (a skipped conflict, a failed download).
// `applyDelta` advances that view from a full listing or a changes feed, so the token can always move on.

export interface RemoteFile {
  /** Graph-relative, forward slashes. */
  path: string
  /** Drive file id. */
  id: string
  /** `appProperties.sha256` written by this plugin's uploads; `null` when the file lacks it. */
  sha256: string | null
  size: number
  /** Epoch ms. */
  modifiedTime: number
  /** Epoch ms; decides duplicate-name races the same way on every device. */
  createdTime: number
  /** Drive's own checksum, informational. */
  md5: string | null
}

export type RemoteDelta =
  /** First sync, a rejected token, or a folder change the feed cannot express: the whole tree. */
  | { kind: 'full'; files: RemoteFile[]; token: string }
  /** `changes.list` since the stored token: ids that changed with their CURRENT state, and ids that are gone (removed, trashed, moved out). */
  | { kind: 'changes'; changed: RemoteFile[]; removedIds: string[]; token: string }

export interface TransferOpts {
  signal?: AbortSignal
  /** Bytes done and total, for the progress toast. */
  onProgress?: (done: number, total: number) => void
}

/** Written to `appProperties` (plan §3.3) and `modifiedTime` on every upload. */
export interface UploadMeta {
  sha256: string
  deviceId: string
  /** The local file's mtime, stored as Drive's `modifiedTime`. */
  modifiedTime: number
}

export interface RemoteMirror {
  /** `token === null` means "no state yet": a full listing plus a fresh start token. */
  fetchDelta(token: string | null): Promise<RemoteDelta>
  download(id: string, opts?: TransferOpts): Promise<Uint8Array>
  /**
   * Update the file `existingId` in place, or create it under `path` when `existingId` is `null` (or the
   * existing file is gone). Parent folders are created as needed.
   */
  upload(path: string, data: Uint8Array, meta: UploadMeta, existingId: string | null, opts?: TransferOpts): Promise<RemoteFile>
  /** Drive trash (plan §3.6 step 7); a file that is already gone is not an error. */
  trash(id: string): Promise<void>
}

export type RemoteView = Map<string, RemoteFile>

/** Two files with the same path (a create race): every device keeps the oldest, `createdTime` then id, like `oldestFirst` in the Drive client. */
export function olderRemote(a: RemoteFile, b: RemoteFile): RemoteFile {
  if (a.createdTime !== b.createdTime) return a.createdTime < b.createdTime ? a : b
  return a.id <= b.id ? a : b
}

export interface DeltaResult {
  view: RemoteView
  /**
   * Live files that share a path with an older one and therefore are not in the view. Drive has no atomic
   * create, so a create whose response was lost and retried leaves such a twin (identical at birth, never
   * updated afterwards because every device addresses the oldest); the engine trashes them.
   */
  duplicates: RemoteFile[]
}

function collect(view: RemoteView, duplicates: RemoteFile[], f: RemoteFile): void {
  const cur = view.get(f.path)
  if (!cur) {
    view.set(f.path, f)
    return
  }
  const winner = olderRemote(cur, f)
  duplicates.push(winner === cur ? f : cur)
  view.set(f.path, winner)
}

export function remoteViewOf(files: Iterable<RemoteFile>): RemoteView {
  const view: RemoteView = new Map()
  for (const f of files) collect(view, [], f)
  return view
}

/** One entry per id, and never a file that is in the view (a twin can be met twice: as displaced incumbent and as feed entry). */
function distinctLosers(view: RemoteView, duplicates: RemoteFile[]): RemoteFile[] {
  const byId = new Map<string, RemoteFile>()
  for (const d of duplicates) if (view.get(d.path)?.id !== d.id) byId.set(d.id, d)
  return [...byId.values()]
}

/** Pure: the view after `delta` plus the younger duplicates it revealed; `view` is not modified. */
export function applyDeltaWithDuplicates(view: RemoteView, delta: RemoteDelta): DeltaResult {
  const duplicates: RemoteFile[] = []
  if (delta.kind === 'full') {
    const next: RemoteView = new Map()
    for (const f of delta.files) collect(next, duplicates, f)
    return { view: next, duplicates: distinctLosers(next, duplicates) }
  }

  const next: RemoteView = new Map(view)
  const pathOfId = new Map<string, string>()
  for (const [path, f] of next) pathOfId.set(f.id, path)
  const removeId = (id: string): void => {
    const path = pathOfId.get(id)
    if (path === undefined) return
    if (next.get(path)?.id === id) next.delete(path)
    pathOfId.delete(id)
  }

  const removed = new Set(delta.removedIds)
  for (const id of removed) removeId(id)

  // The feed can repeat an id; every entry carries the file's current state, so the last one is as good as any.
  const byId = new Map<string, RemoteFile>()
  for (const f of delta.changed) if (!removed.has(f.id)) byId.set(f.id, f)
  for (const f of byId.values()) {
    removeId(f.id) // it may have moved to another path
    const incumbent = next.get(f.path)
    if (incumbent && incumbent.id !== f.id) {
      if (olderRemote(incumbent, f) === incumbent) {
        duplicates.push(f)
        continue
      }
      duplicates.push(incumbent)
      removeId(incumbent.id)
    }
    next.set(f.path, f)
    pathOfId.set(f.id, f.path)
  }
  return { view: next, duplicates: distinctLosers(next, duplicates) }
}

export function applyDelta(view: RemoteView, delta: RemoteDelta): RemoteView {
  return applyDeltaWithDuplicates(view, delta).view
}
