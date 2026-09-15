// Plan §3.6 steps 1–2 and 10 around `runSync` (steps 3–8), M7: the editor force-save (spike §4.2), the
// Drive layout with its ids persisted in the state (M4: ≈1.5 s per folder lookup, so bootstrap once), the
// lock (acquire, renew while the run lasts, release), plus the panel's remote-status check (D9) and the
// mapping of a run onto the UI's `SyncSummary` / error text. Step 9 (snapshots) is M8's hook.
// Pure TS: Drive and the host reach it only through `SessionDeps`. src/logseq/syncController.ts wires the
// real ones; tests run it over FakeDrive + FakeHost through the real layout, mirror and lock code.

import type { GraphFs } from '../fs/graphFs'
import { sanitizeDeviceName, type ConflictItem, type ConflictResolution } from './conflict'
import { runSync, type SyncRunResult } from './engine'
import { MAX_CONSECUTIVE_FAILURES, opLabel } from './executor'
import type { RemoteDelta, RemoteFile, RemoteMirror } from './remote'
import { freshState, type SyncStateStore } from './state'
import type { RemoteStatus, SyncProgress, SyncSummary } from './status'

/** A run's lock lasts this long without a renewal; a crashed device blocks the others for at most this. */
export const LOCK_TTL_MS = 5 * 60_000
export const LOCK_RENEW_MS = 90_000

export interface LayoutIds {
  driveRootId: string
  graphFolderId: string
}

/** Structural twins of `LockInfo` / `DriveLock` in src/google/lock.ts, so this directory imports nothing from src/google/. */
export interface SessionLockInfo {
  deviceId: string
  deviceName: string
  acquiredAt: number
  expiresAt: number
}

export type SessionAcquireResult = { kind: 'acquired'; lock: SessionLockInfo } | { kind: 'held'; lock: SessionLockInfo; expired: boolean }

export interface SessionLock {
  read(): Promise<{ lock: SessionLockInfo } | null>
  acquire(opts: { ttlMs: number; breakExpired?: boolean }): Promise<SessionAcquireResult>
  renew(ttlMs: number): Promise<unknown>
  release(): Promise<void>
}

export type EditorFlushPhase = 'before-scan' | 'before-write'

export interface SessionDeps {
  fs: GraphFs
  store: SyncStateStore
  graphKey: string
  deviceId: string
  /** Already the effective name (`effectiveDeviceName`). */
  deviceName: string
  /** Verifies `known` (the persisted ids) or bootstraps plan §3.3; `reused` = nothing was looked up or created. */
  resolveLayout(known: LayoutIds | null): Promise<LayoutIds & { reused: boolean }>
  /** Find-only twin for the remote check: `null` when the graph has no mirror folder yet. */
  findLayout(known: LayoutIds | null): Promise<LayoutIds | null>
  /** The mirror and the lock of one graph folder. */
  openRemote(graphFolderId: string): { mirror: RemoteMirror; lock: SessionLock }
  /**
   * Spike §4.2: save the block being edited and wait for the file flush. `before-scan` runs once per sync
   * and should always wait for a pending flush; `before-write` runs ahead of every local write and may
   * return at once when nothing is being edited.
   */
  flushEditor(phase: EditorFlushPhase): Promise<void>
  now?: () => number
  log?: (line: string) => void
  describeError?: (err: unknown) => string
  /** Must resolve early when `signal` aborts (the renew loop stops with the run). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  lockTtlMs?: number
  lockRenewMs?: number
  concurrency?: number
  newRunId?: () => string
}

export interface SessionHooks {
  onProgress?: (progress: SyncProgress) => void
  resolveConflicts?: (items: ConflictItem[]) => Promise<ConflictResolution[]>
  signal?: AbortSignal
  /** Plan §3.6 step 2: take over an expired lock (the UI asked first). */
  breakExpiredLock?: boolean
}

export type SessionResult =
  | { kind: 'done'; result: SyncRunResult; layout: LayoutIds; lockLost: boolean }
  /** Another device holds the lock; `expired` means a retry with `breakExpiredLock` would take it. */
  | { kind: 'locked'; lock: SessionLockInfo; expired: boolean }

/** Settings `deviceName` made file-name safe, or `device-<8 hex>` from the device id when empty. */
export function effectiveDeviceName(setting: string, deviceId: string): string {
  return sanitizeDeviceName(setting, `device-${deviceId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8) || 'unnamed'}`)
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

function defaultDescribe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function runSyncSession(deps: SessionDeps, hooks: SessionHooks = {}): Promise<SessionResult> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const describe = deps.describeError ?? defaultDescribe
  const sleep = deps.sleep ?? defaultSleep
  const ttlMs = deps.lockTtlMs ?? LOCK_TTL_MS
  const renewMs = deps.lockRenewMs ?? LOCK_RENEW_MS
  const progress = (step: SyncProgress['step'], label: string): void => hooks.onProgress?.({ step, label, done: 0, total: 0 })

  // Step 1, the Drive part: the folders, from the persisted ids while they still verify.
  progress('preflight', 'Locating the Drive folder')
  let state = await deps.store.loadState(deps.graphKey)
  const known: LayoutIds | null = state.driveRootId && state.graphFolderId ? { driveRootId: state.driveRootId, graphFolderId: state.graphFolderId } : null
  const layout = await deps.resolveLayout(known)
  if (layout.driveRootId !== state.driveRootId || layout.graphFolderId !== state.graphFolderId) {
    if (state.graphFolderId !== null) {
      // A different mirror (root folder renamed in settings, or the old folder gone from Drive). The base and
      // the remote view describe files of the old folder; kept, the planner would read an empty new mirror as
      // "everything deleted remotely" and delete the graph. A fresh state makes it the first-run merge instead.
      log(`the Drive folder changed (${state.graphFolderId} → ${layout.graphFolderId}); starting from a fresh state`)
      state = freshState(deps.graphKey)
      await deps.store.clearJournal(deps.graphKey)
    }
    state.driveRootId = layout.driveRootId
    state.graphFolderId = layout.graphFolderId
    await deps.store.saveState(state)
  } else if (!layout.reused) {
    log('the Drive layout was re-created with the same ids')
  }

  // Step 2: the lock.
  progress('lock', 'Acquiring the Drive lock')
  const { mirror, lock } = deps.openRemote(layout.graphFolderId)
  const acquired = await lock.acquire({ ttlMs, breakExpired: hooks.breakExpiredLock })
  if (acquired.kind === 'held') {
    log(`the Drive lock is held by "${acquired.lock.deviceName}" until ${new Date(acquired.lock.expiresAt).toISOString()}${acquired.expired ? ' (expired)' : ''}`)
    return { kind: 'locked', lock: acquired.lock, expired: acquired.expired }
  }

  // Steps 3–8 with the lock renewed in the background. Losing it aborts the run (the journal resumes it next time).
  const abort = new AbortController()
  const onOuterAbort = (): void => abort.abort()
  if (hooks.signal?.aborted) abort.abort()
  else hooks.signal?.addEventListener('abort', onOuterAbort, { once: true })
  let lockLost = false
  const renewLoop = (async () => {
    while (!abort.signal.aborted) {
      await sleep(renewMs, abort.signal)
      if (abort.signal.aborted) return
      try {
        await lock.renew(ttlMs)
      } catch (err) {
        lockLost = true
        log(`renewing the Drive lock failed: ${describe(err)}; stopping the run`)
        abort.abort()
        return
      }
    }
  })()

  try {
    // Step 1, the host part, as late as possible: the open block reaches the disk right before the scan
    // reads the file, and a run refused by the lock never interrupts the editor.
    progress('scan', 'Saving open edits')
    await deps.flushEditor('before-scan')
    const result = await runSync(
      {
        fs: deps.fs,
        remote: mirror,
        store: deps.store,
        graphKey: deps.graphKey,
        deviceId: deps.deviceId,
        deviceName: deps.deviceName,
        now,
        log,
        concurrency: deps.concurrency,
        describeError: describe,
        newRunId: deps.newRunId,
      },
      {
        onProgress: hooks.onProgress,
        resolveConflicts: hooks.resolveConflicts,
        beforeLocalWrite: () => deps.flushEditor('before-write'),
        signal: abort.signal,
      },
    )
    return { kind: 'done', result, layout, lockLost }
  } finally {
    abort.abort() // ends the renew loop (its sleep resolves early on abort)
    hooks.signal?.removeEventListener('abort', onOuterAbort)
    await renewLoop
    // Step 10: release. When it fails the lock simply expires within `ttlMs`; nothing else depends on it.
    if (!lockLost) {
      progress('finish', 'Releasing the Drive lock')
      try {
        await lock.release()
      } catch (err) {
        log(`releasing the Drive lock failed: ${describe(err)}`)
      }
    }
  }
}

function sameRemote(a: RemoteFile | undefined, b: RemoteFile): boolean {
  return a !== undefined && a.id === b.id && a.modifiedTime === b.modifiedTime && a.size === b.size && a.sha256 === b.sha256
}

/**
 * Remote changes since the last sync, judged against the persisted remote view: the changes token is taken
 * before a run's own uploads, so the feed re-reports them and they must not count.
 */
export function countRemoteChanges(delta: RemoteDelta, view: Readonly<Record<string, RemoteFile>>): number {
  if (delta.kind === 'full') {
    const seen = new Set<string>()
    let n = 0
    for (const f of delta.files) {
      seen.add(f.path)
      if (!sameRemote(view[f.path], f)) n++
    }
    for (const path of Object.keys(view)) if (!seen.has(path)) n++
    return n
  }
  const knownIds = new Set(Object.values(view).map((f) => f.id))
  let n = 0
  for (const f of delta.changed) if (!sameRemote(view[f.path], f)) n++
  for (const id of delta.removedIds) if (knownIds.has(id)) n++
  return n
}

/** D9: the panel's status check. Reads Drive, writes nothing (not even the state), and never takes the lock. */
export async function checkRemoteStatus(deps: SessionDeps): Promise<RemoteStatus> {
  const now = deps.now ?? Date.now
  const state = await deps.store.loadState(deps.graphKey)
  const known: LayoutIds | null = state.driveRootId && state.graphFolderId ? { driveRootId: state.driveRootId, graphFolderId: state.graphFolderId } : null
  const layout = await deps.findLayout(known)
  if (!layout) return { kind: 'ok', checkedAt: now(), pendingChanges: 0, lock: null, firstSync: true }

  const { mirror, lock } = deps.openRemote(layout.graphFolderId)
  const firstSync = state.changesPageToken === null || layout.graphFolderId !== state.graphFolderId
  const delta = await mirror.fetchDelta(firstSync ? null : state.changesPageToken)
  const pendingChanges = firstSync ? (delta.kind === 'full' ? delta.files.length : 0) : countRemoteChanges(delta, state.remote)

  const held = await lock.read()
  const t = now()
  const foreign = held !== null && held.lock.deviceId !== deps.deviceId && held.lock.expiresAt > t
  return {
    kind: 'ok',
    checkedAt: t,
    pendingChanges,
    lock: foreign ? { deviceName: held.lock.deviceName, expiresAt: held.lock.expiresAt } : null,
    firstSync,
  }
}

/** The run's counts in the shape the panel and the summary toast show. */
export function summarizeRun(r: SyncRunResult, snapshotTaken = false): SyncSummary {
  return {
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    uploaded: r.uploaded,
    downloaded: r.downloaded,
    deletedLocal: r.deletedLocal,
    deletedRemote: r.deletedRemote,
    conflictsResolved: r.conflictsResolved,
    conflictsSkipped: r.conflictsSkipped,
    snapshotTaken,
  }
}

/** The error banner's text for a run that did not do everything it planned, or `null` when it did. */
export function describeRunProblems(r: SyncRunResult, abortReason: string | null): string | null {
  const parts: string[] = []
  if (r.stoppedEarly === 'aborted') parts.push(abortReason ?? 'The sync was stopped before it finished.')
  if (r.stoppedEarly === 'too-many-failures') parts.push(`The sync stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`)
  if (r.failures.length > 0) {
    const first = r.failures[0]
    const count = r.failures.length === 1 ? '1 operation' : `${r.failures.length} operations`
    parts.push(`${count} failed; first: ${opLabel(first.op)}: ${first.message}`)
  }
  if (parts.length === 0) return null
  return `${parts.join(' ')} Sync again to retry; finished work is kept.`
}

/** Files the stat guard left alone because they changed during the run (executor.ts); `null` when none. */
export function describeSkippedOps(r: SyncRunResult): string | null {
  if (r.skippedOps.length === 0) return null
  const paths = r.skippedOps.map((s) => s.op.path)
  const shown = paths.slice(0, 3).join(', ') + (paths.length > 3 ? `, … (${paths.length - 3} more)` : '')
  const n = paths.length
  return `${n} ${n === 1 ? 'file' : 'files'} changed during the sync and ${n === 1 ? 'was' : 'were'} left alone: ${shown}. The next sync handles ${n === 1 ? 'it' : 'them'}.`
}
