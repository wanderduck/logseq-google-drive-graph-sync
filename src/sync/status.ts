// UI-facing sync status model. Pure TS. The engine (M6/M7) writes it; the toolbar, panel and toasts read it.

import type { ConflictItem } from './conflict'

/** The five toolbar states of plan M2 step 2. Derived from `SyncStatus` by `deriveSyncState`. */
export type SyncState = 'signed-out' | 'idle' | 'syncing' | 'conflict' | 'error'

/** Steps of the sync flow, plan §3.6. */
export type SyncStep = 'preflight' | 'lock' | 'scan' | 'remote' | 'plan' | 'conflicts' | 'execute' | 'snapshot' | 'finish'

export interface SyncProgress {
  step: SyncStep
  /** One human-readable line for the toast and the panel, e.g. "Uploading pages/Alpha.md". */
  label: string
  done: number
  /** 0 = indeterminate. */
  total: number
}

export interface SyncSummary {
  startedAt: number
  finishedAt: number
  uploaded: number
  downloaded: number
  deletedLocal: number
  deletedRemote: number
  conflictsResolved: number
  /** Conflicts the user did not decide; they are prompted again on the next sync. */
  conflictsSkipped: number
  snapshotTaken: boolean
}

export interface RemoteLock {
  deviceName: string
  expiresAt: number
}

export type RemoteStatus =
  | { kind: 'unchecked' }
  | { kind: 'checking' }
  | { kind: 'ok'; checkedAt: number; pendingChanges: number; lock: RemoteLock | null }
  | { kind: 'unavailable'; checkedAt: number; reason: string }

export interface SyncError {
  message: string
  at: number
}

export interface SyncStatus {
  /** `null` = not connected to Google. */
  account: { email: string } | null
  graph: { name: string; path: string } | null
  /** Non-null while a sync or backup runs. */
  running: SyncProgress | null
  /** Conflicts waiting for a decision in the dialog. The running sync is paused while this is non-empty. */
  pendingConflicts: ConflictItem[]
  /** Set when the last run failed; cleared when the user dismisses it or a new run starts. */
  lastError: SyncError | null
  lastSync: SyncSummary | null
  lastSnapshotAt: number | null
  lastProfileBackupAt: number | null
  remote: RemoteStatus
}

export function initialSyncStatus(): SyncStatus {
  return {
    account: null,
    graph: null,
    running: null,
    pendingConflicts: [],
    lastError: null,
    lastSync: null,
    lastSnapshotAt: null,
    lastProfileBackupAt: null,
    remote: { kind: 'unchecked' },
  }
}

/**
 * Precedence: signed-out > conflict (decision pending) > syncing > error > conflict (skipped last time) > idle.
 * A pending decision outranks "syncing" because the run is paused until the user answers.
 */
export function deriveSyncState(s: SyncStatus): SyncState {
  if (!s.account) return 'signed-out'
  if (s.pendingConflicts.length > 0) return 'conflict'
  if (s.running) return 'syncing'
  if (s.lastError) return 'error'
  if (s.lastSync && s.lastSync.conflictsSkipped > 0) return 'conflict'
  return 'idle'
}
