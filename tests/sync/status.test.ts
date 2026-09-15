import { describe, expect, it } from 'vitest'
import type { ConflictItem } from '../../src/sync/conflict'
import { deriveSyncState, initialSyncStatus, type SyncStatus, type SyncSummary } from '../../src/sync/status'

const account = { email: 'x@example.com' }
const conflict: ConflictItem = { path: 'pages/A.md', kind: 'both-modified', local: null, remote: null }
const summary = (conflictsSkipped: number): SyncSummary => ({
  startedAt: 0,
  finishedAt: 1,
  uploaded: 0,
  downloaded: 0,
  deletedLocal: 0,
  deletedRemote: 0,
  conflictsResolved: 0,
  conflictsSkipped,
  snapshotTaken: false,
})
const status = (patch: Partial<SyncStatus>): SyncStatus => ({ ...initialSyncStatus(), account, ...patch })

describe('deriveSyncState', () => {
  it('starts signed out', () => {
    expect(deriveSyncState(initialSyncStatus())).toBe('signed-out')
  })

  it('is signed-out whatever else is going on', () => {
    expect(
      deriveSyncState(status({ account: null, running: { step: 'scan', label: '', done: 0, total: 0 }, pendingConflicts: [conflict] })),
    ).toBe('signed-out')
  })

  it('is idle when connected with nothing pending', () => {
    expect(deriveSyncState(status({}))).toBe('idle')
    expect(deriveSyncState(status({ lastSync: summary(0) }))).toBe('idle')
  })

  it('is syncing while a run is in progress', () => {
    expect(deriveSyncState(status({ running: { step: 'execute', label: '', done: 1, total: 2 } }))).toBe('syncing')
  })

  it('pending conflicts outrank the running state (the run is paused)', () => {
    expect(
      deriveSyncState(status({ running: { step: 'conflicts', label: '', done: 0, total: 1 }, pendingConflicts: [conflict] })),
    ).toBe('conflict')
  })

  it('shows the error after a failed run, and a new run clears it visually', () => {
    const failed = status({ lastError: { message: 'boom', at: 1 } })
    expect(deriveSyncState(failed)).toBe('error')
    expect(deriveSyncState({ ...failed, running: { step: 'lock', label: '', done: 0, total: 0 } })).toBe('syncing')
  })

  it('reports skipped conflicts from the last sync as conflict, below error', () => {
    expect(deriveSyncState(status({ lastSync: summary(2) }))).toBe('conflict')
    expect(deriveSyncState(status({ lastSync: summary(2), lastError: { message: 'x', at: 1 } }))).toBe('error')
  })
})
