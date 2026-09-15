// Plan §3.6 step 5, the three-way plan per path with L = local scan, R = remote view, B = base entry:
//   L = B, R = B → no-op            L ≠ B, R = B → upload          L = B, R ≠ B → download
//   L ≠ B, R ≠ B, L = R → update base only          L ≠ B, R ≠ B, L ≠ R → CONFLICT
//   absent vs base = delete; delete on one side + modify on the other → CONFLICT; deleted on both → drop entry
//   renames = delete + add (v1).   No base (first sync, new device): add/add identical → base, different → CONFLICT.
// Pure: no I/O, deterministic (ops and conflicts sorted by path). Step 6 (D7) turns the user's answers into
// ops with `conflictOps`. "Keep both" keeps the LOCAL version under `conflictCopyName(...)` (this device's
// name in it) and lets the remote version keep the original name, so both devices converge on the same two files.

import { conflictCopyName, normalizeChoice, type ConflictChoice, type ConflictItem, type ConflictResolution } from './conflict'
import type { RemoteFile, RemoteView } from './remote'
import type { SyncEntry } from './state'

/** What the scanner reports per file (`ScannedFile` in src/fs/scanner.ts). */
export interface LocalFile {
  path: string
  sha256: string
  size: number
  mtimeMs: number
}

/** The stat taken at scan time; the executor re-checks it before overwriting or moving a local file. */
export interface LocalStat {
  size: number
  mtimeMs: number
}

export type SyncOp =
  /** `stashRemote`: the remote version this upload overwrites is saved to the bak folder first (a "keep local" answer). */
  | { kind: 'upload'; path: string; local: LocalFile; existingId: string | null; stashRemote?: RemoteFile }
  | { kind: 'download'; path: string; remote: RemoteFile; expectLocal: LocalStat | null }
  | { kind: 'delete-local'; path: string; expectLocal: LocalStat }
  | { kind: 'delete-remote'; path: string; remote: RemoteFile }
  /** Content identical on both sides (or only stats/ids drifted): record the base without transferring anything. */
  | { kind: 'update-base'; path: string; local: LocalFile; remote: RemoteFile }
  /** Gone on both sides: forget the base. */
  | { kind: 'drop-base'; path: string }
  /** D7 "keep both": copy the local file to `copyPath`, upload the copy, then download the remote version over `path`. */
  | { kind: 'keep-both'; path: string; copyPath: string; local: LocalFile; remote: RemoteFile }
  /** A younger twin of the file at `path` (see `DeltaResult.duplicates`): trashed, no state change. */
  | { kind: 'trash-duplicate'; path: string; remote: RemoteFile }

export type SyncOpKind = SyncOp['kind']

/** Stable identity of an op inside one run (journal key). */
export function opKey(op: SyncOp): string {
  return op.kind === 'trash-duplicate' ? `${op.kind}:${op.path}#${op.remote.id}` : `${op.kind}:${op.path}`
}

export interface PlannedConflict {
  item: ConflictItem
  local: LocalFile | null
  remote: RemoteFile | null
}

export interface PlanInput {
  local: readonly LocalFile[]
  remote: RemoteView
  base: Readonly<Record<string, SyncEntry>>
}

export interface SyncPlan {
  ops: SyncOp[]
  conflicts: PlannedConflict[]
  /** Paths equal on all three sides. */
  unchanged: number
}

/** R ≠ B by content: the sha when the remote carries one, otherwise the Drive identity (id, modifiedTime, size). */
export function remoteChanged(remote: RemoteFile, base: SyncEntry): boolean {
  if (remote.sha256 !== null) return remote.sha256 !== base.sha256
  return remote.id !== base.driveId || remote.modifiedTime !== base.driveModifiedTime || remote.size !== base.size
}

/** Same content, but the recorded stat or Drive identity moved on: worth a base refresh so the next scan can skip the hash. */
function identityDrift(local: LocalFile, remote: RemoteFile, base: SyncEntry): boolean {
  return local.mtimeMs !== base.mtimeMs || local.size !== base.size || remote.id !== base.driveId || remote.modifiedTime !== base.driveModifiedTime
}

function sameContent(local: LocalFile, remote: RemoteFile): boolean {
  return remote.sha256 !== null && remote.sha256 === local.sha256
}

function localSide(local: LocalFile) {
  return { size: local.size, modifiedAt: local.mtimeMs, sha256: local.sha256 }
}

function remoteSide(remote: RemoteFile) {
  return { size: remote.size, modifiedAt: remote.modifiedTime, sha256: remote.sha256 }
}

export function planSync(input: PlanInput): SyncPlan {
  const localByPath = new Map<string, LocalFile>()
  for (const f of input.local) localByPath.set(f.path, f)
  const paths = new Set<string>([...localByPath.keys(), ...input.remote.keys(), ...Object.keys(input.base)])

  const ops: SyncOp[] = []
  const conflicts: PlannedConflict[] = []
  let unchanged = 0

  const conflict = (path: string, kind: ConflictItem['kind'], local: LocalFile | null, remote: RemoteFile | null): void => {
    conflicts.push({
      item: { path, kind, local: local ? localSide(local) : null, remote: remote ? remoteSide(remote) : null },
      local,
      remote,
    })
  }

  for (const path of [...paths].sort()) {
    const local = localByPath.get(path) ?? null
    const remote = input.remote.get(path) ?? null
    const base = input.base[path]

    if (!base) {
      if (local && remote) {
        if (sameContent(local, remote)) ops.push({ kind: 'update-base', path, local, remote })
        else conflict(path, 'both-modified', local, remote)
      } else if (local) {
        ops.push({ kind: 'upload', path, local, existingId: null })
      } else if (remote) {
        ops.push({ kind: 'download', path, remote, expectLocal: null })
      }
      continue
    }

    if (local && remote) {
      const lChanged = local.sha256 !== base.sha256
      const rChanged = remoteChanged(remote, base)
      if (!lChanged && !rChanged) {
        if (identityDrift(local, remote, base)) ops.push({ kind: 'update-base', path, local, remote })
        else unchanged++
      } else if (lChanged && !rChanged) {
        ops.push({ kind: 'upload', path, local, existingId: remote.id })
      } else if (!lChanged && rChanged) {
        ops.push({ kind: 'download', path, remote, expectLocal: { size: local.size, mtimeMs: local.mtimeMs } })
      } else if (sameContent(local, remote)) {
        ops.push({ kind: 'update-base', path, local, remote })
      } else {
        conflict(path, 'both-modified', local, remote)
      }
    } else if (!local && remote) {
      if (remoteChanged(remote, base)) conflict(path, 'local-deleted', null, remote)
      else ops.push({ kind: 'delete-remote', path, remote })
    } else if (local && !remote) {
      if (local.sha256 !== base.sha256) conflict(path, 'remote-deleted', local, null)
      else ops.push({ kind: 'delete-local', path, expectLocal: { size: local.size, mtimeMs: local.mtimeMs } })
    } else {
      ops.push({ kind: 'drop-base', path })
    }
  }

  return { ops, conflicts, unchanged }
}

/** A conflict answer with the two hashes it was given for, so a crashed run can replay it only for the very same conflict. */
export interface AppliedResolution {
  path: string
  choice: ConflictChoice
  localSha: string | null
  remoteSha: string | null
}

export interface ConflictOpsResult {
  ops: SyncOp[]
  applied: AppliedResolution[]
  /** Conflicts without an answer: reported, and planned again next run (plan §3.6 step 6). */
  skipped: ConflictItem[]
}

/**
 * Plan §3.6 step 6. `keep-both` on a delete conflict is normalised to the side that still has content
 * (`normalizeChoice`); a resolution for a path that is not in conflict is ignored.
 */
export function conflictOps(conflicts: readonly PlannedConflict[], resolutions: readonly ConflictResolution[], deviceName: string, at: Date): ConflictOpsResult {
  const byPath = new Map<string, ConflictResolution>()
  for (const r of resolutions) byPath.set(r.path, r)
  const ops: SyncOp[] = []
  const applied: AppliedResolution[] = []
  const skipped: ConflictItem[] = []

  for (const c of conflicts) {
    const answer = byPath.get(c.item.path)
    if (!answer) {
      skipped.push(c.item)
      continue
    }
    const choice = normalizeChoice(c.item, answer.choice)
    const { path } = c.item
    switch (choice) {
      case 'keep-local':
        // The remote version is nobody's local file any more once overwritten: stash it in bak first.
        if (c.local) ops.push({ kind: 'upload', path, local: c.local, existingId: c.remote?.id ?? null, ...(c.remote ? { stashRemote: c.remote } : {}) })
        else if (c.remote) ops.push({ kind: 'delete-remote', path, remote: c.remote })
        break
      case 'keep-remote':
        if (c.remote) ops.push({ kind: 'download', path, remote: c.remote, expectLocal: c.local ? { size: c.local.size, mtimeMs: c.local.mtimeMs } : null })
        else if (c.local) ops.push({ kind: 'delete-local', path, expectLocal: { size: c.local.size, mtimeMs: c.local.mtimeMs } })
        break
      case 'keep-both':
        // normalizeChoice guarantees both sides exist here.
        if (c.local && c.remote) ops.push({ kind: 'keep-both', path, copyPath: conflictCopyName(path, deviceName, at), local: c.local, remote: c.remote })
        break
    }
    applied.push({ path, choice, localSha: c.local?.sha256 ?? null, remoteSha: c.remote?.sha256 ?? null })
  }
  return { ops, applied, skipped }
}
