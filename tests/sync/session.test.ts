import { describe, expect, it } from 'vitest'
import { FOLDER_MIME } from '../../src/google/driveQuery'
import { findLayout, resolveLayout, type LayoutSpec } from '../../src/google/layout'
import { LOCK_DIR, LOCK_FILE, createDriveLock } from '../../src/google/lock'
import { createDriveMirror } from '../../src/google/mirror'
import type { SyncRunResult } from '../../src/sync/engine'
import type { RemoteFile } from '../../src/sync/remote'
import {
  checkRemoteStatus,
  countRemoteChanges,
  describeRunProblems,
  describeSkippedOps,
  effectiveDeviceName,
  runSyncSession,
  summarizeRun,
  type EditorFlushPhase,
  type LayoutIds,
  type SessionDeps,
  type SessionLock,
} from '../../src/sync/session'
import { journalKey } from '../../src/sync/state'
import { GRAPH_NAME, createWorld, resolveAll, type Device, type World } from './world'

const INITIAL = {
  'pages/Alpha.md': 'alpha v1',
  'pages/Beta.md': 'beta v1',
  'journals/2026_09_15.md': 'journal v1',
  'logseq/config.edn': '{}',
}
const TTL = 60_000
const RENEW = 10_000

/** Resolves only when the signal aborts: the renew loop stays quiet unless a test says otherwise. */
const sleepUntilAbort = (_ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) resolve()
    else signal?.addEventListener('abort', () => resolve(), { once: true })
  })

interface Harness {
  deps: SessionDeps
  flushes: EditorFlushPhase[]
  layoutCalls: Array<{ known: LayoutIds | null; reused: boolean }>
  renews: number
  releases: number
}

interface HarnessOptions {
  spec?: Partial<LayoutSpec>
  sleep?: SessionDeps['sleep']
  /** Wraps the lock the session gets (to count calls or inject failures). */
  wrapLock?: (lock: SessionLock) => SessionLock
}

function harness(w: World, d: Device, opts: HarnessOptions = {}): Harness {
  const spec: LayoutSpec = { rootFolderName: 'Logseq Graph Sync', graphName: GRAPH_NAME, ...opts.spec }
  const client = d.client
  const h: Harness = { flushes: [], layoutCalls: [], renews: 0, releases: 0, deps: null as unknown as SessionDeps }
  h.deps = {
    fs: d.graph.fs,
    store: d.store,
    graphKey: w.graphKey,
    deviceId: d.deviceId,
    deviceName: d.name,
    resolveLayout: async (known) => {
      const r = await resolveLayout(client, spec, known)
      h.layoutCalls.push({ known, reused: r.reused })
      return r
    },
    findLayout: (known) => findLayout(client, spec, known),
    openRemote: (graphFolderId) => {
      const raw = createDriveLock({ client, graphFolderId, deviceId: d.deviceId, deviceName: d.name, now: w.clock.now, log: (l) => d.logs.push(`lock: ${l}`) })
      const counted: SessionLock = {
        read: () => raw.read(),
        acquire: (o) => raw.acquire(o),
        renew: (ttl) => {
          h.renews++
          return raw.renew(ttl)
        },
        release: () => {
          h.releases++
          return raw.release()
        },
      }
      return { mirror: createDriveMirror({ client, graphFolderId, log: (l) => d.logs.push(`mirror: ${l}`) }), lock: opts.wrapLock ? opts.wrapLock(counted) : counted }
    },
    flushEditor: async (phase) => {
      h.flushes.push(phase)
    },
    now: w.clock.now,
    log: (l) => d.logs.push(l),
    sleep: opts.sleep ?? sleepUntilAbort,
    lockTtlMs: TTL,
    lockRenewMs: RENEW,
    newRunId: () => `run-${d.name}-${w.clock.now()}`,
  }
  return h
}

function lockFiles(w: World, graphFolderId = w.graphFolderId) {
  const dir = w.drive.childrenOf(graphFolderId).find((f) => f.name === LOCK_DIR)
  return dir ? w.drive.childrenOf(dir.id).filter((f) => f.name === LOCK_FILE) : []
}

function folderCount(w: World): number {
  return [...w.drive.files.values()].filter((f) => f.mimeType === FOLDER_MIME && !f.trashed && f.id !== 'root').length
}

function done(r: Awaited<ReturnType<typeof runSyncSession>>): SyncRunResult {
  if (r.kind !== 'done') throw new Error(`expected a finished run, got ${JSON.stringify(r)}`)
  return r.result
}

describe('runSyncSession: plan §3.6 steps 1–2 and 10 around the engine', () => {
  it('first run: flushes the editor, bootstraps and persists the layout, holds the lock only for the run, uploads', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    const h = harness(w, A)

    const r = await runSyncSession(h.deps, { onProgress: () => undefined })
    expect(r.kind).toBe('done')
    if (r.kind !== 'done') return
    expect(r.result).toMatchObject({ uploaded: 4, downloaded: 0, failures: [], stoppedEarly: null })
    expect(r.lockLost).toBe(false)
    expect(r.layout.graphFolderId).toBe(w.graphFolderId)
    expect(h.flushes[0]).toBe('before-scan')
    expect(h.flushes).not.toContain('before-write') // uploads never touch the graph
    // The world already created the plan §3.3 folders; the session found them and created only the
    // graph's own sub-folders (pages, journals, logseq) plus the lock dir.
    expect(h.layoutCalls).toEqual([{ known: null, reused: false }])
    expect(w.drive.childrenOf('root').map((f) => f.name)).toEqual(['Logseq Graph Sync'])
    expect(w.drive.childrenOf(w.graphFolderId).map((f) => f.name).sort()).toEqual([LOCK_DIR, 'journals', 'logseq', 'pages'])
    expect(folderCount(w)).toBe(10)

    const s = await A.state()
    expect(s.graphFolderId).toBe(w.graphFolderId)
    expect(s.driveRootId).toBe(w.drive.childrenOf('root').find((f) => f.name === 'Logseq Graph Sync')!.id)
    expect(Object.keys(s.entries)).toHaveLength(4)
    expect(lockFiles(w)).toHaveLength(0)
    expect(h.releases).toBe(1)
    expect(A.logs.some((l) => l.includes('starting from a fresh state'))).toBe(false)
  })

  it('second run on a restarted device verifies the persisted ids (no folder lookups by name, nothing created)', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    done(await runSyncSession(harness(w, A).deps))
    const A2 = w.restart(A)
    const h = harness(w, A2)
    const before = w.drive.calls.length
    done(await runSyncSession(h.deps))
    expect(h.layoutCalls).toEqual([{ known: { driveRootId: expect.any(String), graphFolderId: w.graphFolderId }, reused: true }])
    const during = w.drive.calls.slice(before)
    // Layout verification is `files.get` only; the name queries left are the lock's and the delta's.
    const nameQueries = during.filter((c) => c.method === 'GET' && c.url.pathname.endsWith('/files') && (c.url.searchParams.get('q') ?? '').includes("name = 'Logseq Graph Sync'"))
    expect(nameQueries).toHaveLength(0)
    expect(during.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/files'))).toHaveLength(1) // the lock file
    expect(lockFiles(w)).toHaveLength(0)
  })

  it('flushes the editor before every local write (downloads) but not before uploads', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    done(await runSyncSession(harness(w, A).deps))
    const B = w.addDevice('B')
    const hB = harness(w, B)
    const r = done(await runSyncSession(hB.deps))
    expect(r.downloaded).toBe(4)
    expect(hB.flushes[0]).toBe('before-scan')
    expect(hB.flushes.filter((p) => p === 'before-write')).toHaveLength(4)
    expect(B.files()).toEqual(A.files())
  })

  it('refuses while another device holds a live lock, and offers to break an expired one', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    const B = w.addDevice('B')
    const other = createDriveLock({ client: B.client, graphFolderId: w.graphFolderId, deviceId: B.deviceId, deviceName: 'B', now: w.clock.now })
    expect((await other.acquire({ ttlMs: TTL })).kind).toBe('acquired')

    const h = harness(w, A)
    const held = await runSyncSession(h.deps)
    expect(held).toEqual({ kind: 'locked', lock: expect.objectContaining({ deviceId: B.deviceId, deviceName: 'B' }), expired: false })
    expect(Object.keys((await A.state()).entries)).toHaveLength(0)
    expect(A.storage.files.has(journalKey(w.graphKey))).toBe(false)
    expect(h.releases).toBe(0)
    expect(lockFiles(w)).toHaveLength(1) // theirs, untouched

    w.clock.advance(TTL + 1)
    const expired = await runSyncSession(h.deps)
    expect(expired).toMatchObject({ kind: 'locked', expired: true })
    expect(lockFiles(w)).toHaveLength(1)

    // The user said yes: the stale lock goes, the run happens, and the lock is released afterwards.
    const r = done(await runSyncSession(h.deps, { breakExpiredLock: true }))
    expect(r.uploaded).toBe(4)
    expect(lockFiles(w)).toHaveLength(0)
    expect(A.logs.some((l) => l.includes('breaking the expired lock of "B"'))).toBe(true)
  })

  it('releases the lock when the engine throws', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    const h = harness(w, A)
    A.graph.host.failNext({ match: (c) => c.action === 'listdir', answer: new Error('EIO: disk on fire'), mode: 'reject' })
    await expect(runSyncSession(h.deps)).rejects.toThrow(/EIO/)
    expect(h.releases).toBe(1)
    expect(lockFiles(w)).toHaveLength(0)
  })

  it('renews the lock while the run lasts and stops the run when a renewal fails', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    let ticks = 0
    const tickOnce: SessionDeps['sleep'] = (ms, signal) => (ticks++ === 0 ? Promise.resolve() : sleepUntilAbort(ms, signal))
    const h = harness(w, A, { sleep: tickOnce })
    const r = await runSyncSession(h.deps)
    expect(r.kind).toBe('done')
    if (r.kind !== 'done') return
    expect(h.renews).toBe(1)
    expect(r.lockLost).toBe(false)
    expect(r.result.uploaded).toBe(4)
    expect(lockFiles(w)).toHaveLength(0)

    // Another device broke the lock (say, after a laptop sleep): renewal fails, the run stops, the journal keeps the rest.
    const B = w.addDevice('B')
    ticks = 0
    A.write('pages/Gamma.md', 'gamma v1')
    A.write('pages/Delta.md', 'delta v1')
    const A2 = w.restart(A)
    const hB = harness(w, A2, {
      sleep: tickOnce,
      wrapLock: (lock) => ({
        ...lock,
        renew: async () => {
          throw new Error('The Drive lock file disappeared while this device held it.')
        },
      }),
    })
    const lost = await runSyncSession(hB.deps)
    expect(lost.kind).toBe('done')
    if (lost.kind !== 'done') return
    expect(lost.lockLost).toBe(true)
    expect(lost.result.stoppedEarly).toBe('aborted')
    expect(lost.result.planned).toBe(2)
    expect(hB.releases).toBe(0) // not ours any more
    expect(A2.logs.some((l) => l.includes('renewing the Drive lock failed'))).toBe(true)
    expect(lockFiles(w)).toHaveLength(1) // left to expire; B can break it later
    expect(B.name).toBe('B')
  })

  it('an aborted outer signal ends the run early with the lock released', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    const h = harness(w, A)
    const abort = new AbortController()
    abort.abort()
    const r = done(await runSyncSession(h.deps, { signal: abort.signal }))
    expect(r.stoppedEarly).toBe('aborted')
    expect(r.uploaded).toBe(0)
    expect(h.releases).toBe(1)
    expect(lockFiles(w)).toHaveLength(0)
  })

  it('a changed Drive folder starts from a fresh state instead of deleting the graph', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    done(await runSyncSession(harness(w, A).deps))
    const first = await A.state()

    // The user renamed the root folder in settings: a different mirror, empty.
    const A2 = w.restart(A)
    const moved = harness(w, A2, { spec: { rootFolderName: 'Other Root' } })
    const r = done(await runSyncSession(moved.deps))
    expect(r).toMatchObject({ uploaded: 4, downloaded: 0, deletedLocal: 0, deletedRemote: 0, delta: 'full' })
    expect(A.files()).toEqual(new Map(Object.entries(INITIAL)))
    expect(moved.layoutCalls[0].reused).toBe(false)
    const s = await A.state()
    expect(s.driveRootId).not.toBe(first.driveRootId)
    expect(s.graphFolderId).not.toBe(first.graphFolderId)
    expect(w.drive.childrenOf('root').map((f) => f.name).sort()).toEqual(['Logseq Graph Sync', 'Other Root'])
    expect(w.driveFiles().size).toBe(4) // the old mirror is untouched
    expect(A2.logs.some((l) => l.includes('starting from a fresh state'))).toBe(true)

    // The old mirror trashed in Drive: same guard.
    w.drive.files.get(s.graphFolderId!)!.trashed = true
    const again = harness(w, w.restart(A), { spec: { rootFolderName: 'Other Root' } })
    const r2 = done(await runSyncSession(again.deps))
    expect(r2).toMatchObject({ uploaded: 4, deletedLocal: 0 })
    expect(A.files()).toEqual(new Map(Object.entries(INITIAL)))
    expect((await A.state()).graphFolderId).not.toBe(s.graphFolderId)
  })

  it('a stale journal from the old folder is dropped with the state', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    done(await runSyncSession(harness(w, A).deps))
    await A.store.saveJournal(w.graphKey, { version: 1, runId: 'old', startedAt: 1, bakDir: 'logseq/bak/gdsync/x', ops: [], done: {}, resolutions: [] })
    const moved = harness(w, w.restart(A), { spec: { rootFolderName: 'Other Root' } })
    const r = done(await runSyncSession(moved.deps))
    expect(r.recovered).toBe(false)
    expect(r.uploaded).toBe(4)
  })

  it('threads conflict answers and progress through to the engine', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    const B = w.addDevice('B')
    done(await runSyncSession(harness(w, A).deps))
    done(await runSyncSession(harness(w, B).deps))
    A.write('pages/Alpha.md', 'alpha A')
    B.write('pages/Alpha.md', 'alpha B')
    done(await runSyncSession(harness(w, A).deps))
    const steps: string[] = []
    const r = done(await runSyncSession(harness(w, B).deps, { onProgress: (p) => steps.push(p.step), resolveConflicts: resolveAll('keep-remote') }))
    expect(r).toMatchObject({ conflicts: 1, conflictsResolved: 1, downloaded: 1 })
    expect(B.read('pages/Alpha.md')).toBe('alpha A')
    expect([...new Set(steps)]).toEqual(['preflight', 'lock', 'scan', 'remote', 'plan', 'conflicts', 'execute', 'finish'])
  })
})

describe('checkRemoteStatus (D9): reads only', () => {
  it('reports "no remote copy" without creating folders, then the mirror size before the first sync, then changes since the last one', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    const B = w.addDevice('B')
    const folders = folderCount(w)

    // A graph nobody synced yet, under an existing root: nothing is created.
    const none = await checkRemoteStatus(harness(w, A, { spec: { graphName: 'other graph' } }).deps)
    expect(none).toEqual({ kind: 'ok', checkedAt: expect.any(Number), pendingChanges: 0, lock: null, firstSync: true })
    expect(folderCount(w)).toBe(folders)

    done(await runSyncSession(harness(w, A).deps))
    // A's own uploads are re-reported by the feed (the token predates them) and must not count.
    expect(await checkRemoteStatus(harness(w, A).deps)).toMatchObject({ pendingChanges: 0, firstSync: false, lock: null })
    // B never synced: the mirror's file count, and its state stays untouched.
    const beforeB = JSON.stringify([...B.storage.files])
    expect(await checkRemoteStatus(harness(w, B).deps)).toMatchObject({ pendingChanges: 4, firstSync: true })
    expect(JSON.stringify([...B.storage.files])).toBe(beforeB)

    done(await runSyncSession(harness(w, B).deps))
    expect(await checkRemoteStatus(harness(w, B).deps)).toMatchObject({ pendingChanges: 0, firstSync: false })
    A.write('pages/Alpha.md', 'alpha v2')
    A.remove('pages/Beta.md')
    done(await runSyncSession(harness(w, A).deps))
    expect(await checkRemoteStatus(harness(w, B).deps)).toMatchObject({ pendingChanges: 2, firstSync: false })
    // Checking twice changes nothing (no state write, no token advance).
    expect(await checkRemoteStatus(harness(w, B).deps)).toMatchObject({ pendingChanges: 2 })
    done(await runSyncSession(harness(w, B).deps))
    expect(await checkRemoteStatus(harness(w, B).deps)).toMatchObject({ pendingChanges: 0 })
    expect(lockFiles(w)).toHaveLength(0)
  })

  it('shows a live foreign lock, hides an expired or own one', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    const B = w.addDevice('B')
    done(await runSyncSession(harness(w, A).deps))
    const other = createDriveLock({ client: B.client, graphFolderId: w.graphFolderId, deviceId: B.deviceId, deviceName: 'Office-PC', now: w.clock.now })
    await other.acquire({ ttlMs: TTL })
    expect(await checkRemoteStatus(harness(w, A).deps)).toMatchObject({ lock: { deviceName: 'Office-PC', expiresAt: expect.any(Number) } })
    expect(await checkRemoteStatus(harness(w, B).deps)).toMatchObject({ lock: null })
    w.clock.advance(TTL + 1)
    expect(await checkRemoteStatus(harness(w, A).deps)).toMatchObject({ lock: null })
  })
})

describe('countRemoteChanges', () => {
  const file = (path: string, id: string, extra: Partial<RemoteFile> = {}): RemoteFile => ({ path, id, sha256: 'a'.repeat(64), size: 3, modifiedTime: 10, createdTime: 1, md5: null, ...extra })
  const view = { 'a.md': file('a.md', 'A'), 'b.md': file('b.md', 'B') }

  it('ignores re-reported unchanged files and unknown removed ids', () => {
    expect(countRemoteChanges({ kind: 'changes', changed: [file('a.md', 'A')], removedIds: ['lock-file'], token: 't' }, view)).toBe(0)
    expect(countRemoteChanges({ kind: 'changes', changed: [file('a.md', 'A', { modifiedTime: 11 })], removedIds: ['B'], token: 't' }, view)).toBe(2)
    expect(countRemoteChanges({ kind: 'changes', changed: [file('c.md', 'C')], removedIds: [], token: 't' }, view)).toBe(1)
  })

  it('diffs a full listing against the view, missing paths included', () => {
    expect(countRemoteChanges({ kind: 'full', files: [file('a.md', 'A'), file('b.md', 'B')], token: 't' }, view)).toBe(0)
    expect(countRemoteChanges({ kind: 'full', files: [file('a.md', 'A2')], token: 't' }, view)).toBe(2)
    expect(countRemoteChanges({ kind: 'full', files: [], token: 't' }, {})).toBe(0)
  })
})

describe('run → UI mapping', () => {
  const base: SyncRunResult = {
    startedAt: 1,
    finishedAt: 2,
    recovered: false,
    tempFilesMoved: 0,
    scan: { files: 1, hashed: 1, reused: 0, ignored: 0, vanished: 0 },
    delta: 'changes',
    remoteFiles: 1,
    planned: 0,
    unchanged: 1,
    uploaded: 2,
    downloaded: 3,
    deletedLocal: 1,
    deletedRemote: 1,
    baseUpdated: 0,
    duplicatesTrashed: 0,
    conflicts: 2,
    conflictsResolved: 1,
    conflictsReplayed: 0,
    conflictsSkipped: 1,
    failures: [],
    skippedOps: [],
    stoppedEarly: null,
    bakDir: 'logseq/bak/gdsync/x',
  }
  const local = { path: 'pages/A.md', sha256: 'x', size: 1, mtimeMs: 1 }

  it('summarizeRun keeps the counts the panel shows', () => {
    expect(summarizeRun(base)).toEqual({ startedAt: 1, finishedAt: 2, uploaded: 2, downloaded: 3, deletedLocal: 1, deletedRemote: 1, conflictsResolved: 1, conflictsSkipped: 1, snapshotTaken: false })
    expect(summarizeRun(base, true).snapshotTaken).toBe(true)
  })

  it('describeRunProblems is null for a clean run and names the stop reason and the first failure otherwise', () => {
    expect(describeRunProblems(base, null)).toBeNull()
    expect(describeRunProblems({ ...base, stoppedEarly: 'aborted' }, 'The graph changed.')).toBe('The graph changed. Sync again to retry; finished work is kept.')
    expect(describeRunProblems({ ...base, stoppedEarly: 'aborted' }, null)).toMatch(/^The sync was stopped before it finished\./)
    const failures = [
      { op: { kind: 'upload' as const, path: 'pages/A.md', local, existingId: null }, message: 'HTTP 500' },
      { op: { kind: 'upload' as const, path: 'pages/B.md', local, existingId: null }, message: 'HTTP 500' },
    ]
    expect(describeRunProblems({ ...base, failures }, null)).toBe('2 operations failed; first: Uploading pages/A.md: HTTP 500 Sync again to retry; finished work is kept.')
    expect(describeRunProblems({ ...base, failures: failures.slice(0, 1), stoppedEarly: 'too-many-failures' }, null)).toMatch(
      /^The sync stopped after 3 consecutive failures\. 1 operation failed; first: Uploading pages\/A\.md: HTTP 500/,
    )
  })

  it('describeSkippedOps lists up to three paths', () => {
    expect(describeSkippedOps(base)).toBeNull()
    const skip = (path: string) => ({ op: { kind: 'delete-local' as const, path, expectLocal: { size: 1, mtimeMs: 1 } }, reason: 'changed locally during the sync' })
    expect(describeSkippedOps({ ...base, skippedOps: [skip('a')] })).toBe('1 file changed during the sync and was left alone: a. The next sync handles it.')
    expect(describeSkippedOps({ ...base, skippedOps: ['a', 'b', 'c', 'd', 'e'].map(skip) })).toBe('5 files changed during the sync and were left alone: a, b, c, … (2 more). The next sync handles them.')
  })

  it('effectiveDeviceName sanitises the setting or derives one from the device id', () => {
    expect(effectiveDeviceName('My Laptop!', 'abc')).toBe('My-Laptop')
    expect(effectiveDeviceName('', '3f9a1c2e-1234-4bcd-8ef0-000000000000')).toBe('device-3f9a1c2e')
    expect(effectiveDeviceName('   ', '')).toBe('device-unnamed')
  })
})
