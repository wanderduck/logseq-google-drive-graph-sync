// M2-ONLY MOCK of the sync flow (plan §3.6) so every UI state is demoable without Google or file access.
// It drives the same stores and toasts the real engine will drive, behind the same `SyncController`
// interface. M7 replaces it and deletes `src/mock/`. Nothing in here touches the graph or the network.

import { openPanel } from '../logseq/commands'
import type { GdsyncSettings } from '../logseq/settings'
import { openProgressToast, showToast } from '../logseq/toasts'
import { conflictCopyName, type ConflictItem, type ConflictResolution } from '../sync/conflict'
import type { SyncController } from '../sync/controller'
import type { SyncProgress, SyncState, SyncStatus, SyncStep, SyncSummary } from '../sync/status'
import type { Store } from '../sync/store'
import { formatSummary } from '../ui/format'

export type DemoScenario = 'clean' | 'conflicts' | 'error'

export interface MockSyncController extends SyncController {
  /** Runs the fake sync flow end to end; `syncNow()` is `runDemo('clean')`. */
  runDemo(scenario: DemoScenario): Promise<void>
  /** Forces the toolbar/panel into one of the five states. `syncing` reverts to idle after a few seconds. */
  showState(state: SyncState): void
}

export interface MockDeps {
  status: Store<SyncStatus>
  settings: Store<GdsyncSettings>
}

const HOUR = 3_600_000
const MOCK_ACCOUNT = { email: 'demo.user@gmail.com' }
const MOCK_FILES = [
  'pages/Alpha.md',
  'pages/Beta.md',
  'pages/Gamma.md',
  'pages/contents.md',
  'journals/2026_09_13.md',
  'journals/2026_09_14.md',
  'journals/2026_09_15.md',
  'assets/diagram_1726300000000_0.png',
  'assets/paper_1726300000001_0.pdf',
  'logseq/config.edn',
  'logseq/custom.css',
  'draws/sketch.excalidraw',
]

type OpKind = 'upload' | 'download' | 'delete-local' | 'delete-remote'
interface MockOp {
  kind: OpKind
  path: string
}
const OP_VERB: Record<OpKind, string> = {
  upload: 'Uploading',
  download: 'Downloading',
  'delete-local': 'Deleting locally',
  'delete-remote': 'Trashing on Drive',
}

function mockConflicts(now: number): ConflictItem[] {
  return [
    {
      path: 'pages/Alpha.md',
      kind: 'both-modified',
      local: { size: 2431, modifiedAt: now - 5 * 60_000, sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
      remote: { size: 2518, modifiedAt: now - 42 * 60_000, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    },
    {
      path: 'journals/2026_09_14.md',
      kind: 'remote-deleted',
      local: { size: 812, modifiedAt: now - 3 * HOUR, sha256: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae' },
      remote: null,
    },
    {
      path: 'logseq/custom.css',
      kind: 'local-deleted',
      local: null,
      remote: { size: 1207, modifiedAt: now - 26 * HOUR, sha256: 'fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9' },
    },
  ]
}

function planMockOps(
  scenario: DemoScenario,
  conflicts: ConflictItem[],
  resolutions: ConflictResolution[],
  deviceName: string,
  startedAt: number,
): MockOp[] {
  const conflicted = new Set(conflicts.map((c) => c.path))
  const seed: MockOp[] = [
    { kind: 'upload', path: 'pages/Beta.md' },
    { kind: 'upload', path: 'journals/2026_09_15.md' },
    { kind: 'upload', path: 'assets/diagram_1726300000000_0.png' },
    { kind: 'download', path: 'pages/Gamma.md' },
    { kind: 'delete-remote', path: 'pages/Old notes.md' },
  ]
  const ops = seed.filter((op) => !conflicted.has(op.path))
  if (scenario !== 'conflicts') ops.push({ kind: 'download', path: 'logseq/custom.css' })

  for (const r of resolutions) {
    const item = conflicts.find((c) => c.path === r.path)
    if (!item) continue
    switch (r.choice) {
      case 'keep-local':
        ops.push(item.local ? { kind: 'upload', path: item.path } : { kind: 'delete-remote', path: item.path })
        break
      case 'keep-remote':
        ops.push(item.remote ? { kind: 'download', path: item.path } : { kind: 'delete-local', path: item.path })
        break
      case 'keep-both':
        ops.push(
          { kind: 'upload', path: conflictCopyName(item.path, deviceName, new Date(startedAt)) },
          { kind: 'download', path: item.path },
        )
        break
    }
  }
  return ops
}

function countOps(ops: MockOp[], kind: OpKind): number {
  return ops.filter((o) => o.kind === kind).length
}

export function createMockSyncController({ status, settings }: MockDeps): MockSyncController {
  let disposed = false
  let pendingResolve: ((r: ConflictResolution[]) => void) | null = null

  const patch = (p: Partial<SyncStatus>): void => status.update((s) => ({ ...s, ...p }))
  const progress = (p: SyncProgress): void => patch({ running: p })

  /** Resolves after `ms`, or rejects once the plugin is unloading so a run cannot outlive it. */
  const tick = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      setTimeout(() => (disposed ? reject(new Error('disposed')) : resolve()), ms)
    })

  function canStart(action: string): boolean {
    const s = status.get()
    if (!s.account) {
      showToast(`Connect Google Drive before you ${action}.`, 'warning')
      openPanel()
      return false
    }
    if (s.running) {
      showToast('A sync or backup is already running.', 'info', 3000)
      return false
    }
    return true
  }

  function fail(what: string, err: unknown): void {
    if (disposed) return
    const message = err instanceof Error ? err.message : String(err)
    patch({ running: null, pendingConflicts: [], lastError: { message, at: Date.now() } })
    showToast(`${what} failed: ${message}`, 'error', 8000)
  }

  async function runSync(scenario: DemoScenario): Promise<void> {
    if (!canStart('sync')) return
    const startedAt = Date.now()
    patch({ lastError: null, running: { step: 'preflight', label: 'Checking prerequisites…', done: 0, total: 0 } })
    const toast = await openProgressToast('Google Drive Sync: checking prerequisites…')
    const stage = async (step: SyncStep, label: string, ms: number): Promise<void> => {
      progress({ step, label, done: 0, total: 0 })
      await toast.update(`Google Drive Sync: ${label}`)
      await tick(ms)
    }

    try {
      await stage('lock', 'Acquiring the Drive lock…', 300)

      for (let i = 0; i < MOCK_FILES.length; i++) {
        progress({ step: 'scan', label: `Scanning ${MOCK_FILES[i]}`, done: i + 1, total: MOCK_FILES.length })
        await tick(70)
      }
      await toast.update(`Google Drive Sync: scanned ${MOCK_FILES.length} files`)
      await stage('remote', 'Fetching remote changes…', 450)
      if (scenario === 'error') {
        throw new Error('Drive returned HTTP 403 (SERVICE_DISABLED): enable the Drive API in the Google Cloud project.')
      }
      await stage('plan', 'Planning…', 250)

      let conflicts: ConflictItem[] = []
      let resolutions: ConflictResolution[] = []
      if (scenario === 'conflicts') {
        conflicts = mockConflicts(startedAt)
        progress({ step: 'conflicts', label: `${conflicts.length} conflicts need your decision`, done: 0, total: conflicts.length })
        await toast.update('Google Drive Sync: waiting for your conflict decisions…')
        patch({ pendingConflicts: conflicts })
        openPanel()
        resolutions = await new Promise<ConflictResolution[]>((resolve) => {
          pendingResolve = resolve
        })
        pendingResolve = null
        patch({ pendingConflicts: [] })
        if (disposed) throw new Error('disposed')
      }

      const ops = planMockOps(scenario, conflicts, resolutions, settings.get().deviceName, startedAt)
      for (let i = 0; i < ops.length; i++) {
        const label = `${OP_VERB[ops[i].kind]} ${ops[i].path}`
        progress({ step: 'execute', label, done: i, total: ops.length })
        await toast.update(`Google Drive Sync: ${label} (${i + 1}/${ops.length})`)
        await tick(240)
      }

      const lastSnapshotAt = status.get().lastSnapshotAt
      const snapshotDue = lastSnapshotAt === null || startedAt - lastSnapshotAt > settings.get().snapshotIntervalHours * HOUR
      if (snapshotDue) await stage('snapshot', 'Uploading the graph snapshot…', 700)
      await stage('finish', 'Saving sync state…', 150)

      const finishedAt = Date.now()
      const summary: SyncSummary = {
        startedAt,
        finishedAt,
        uploaded: countOps(ops, 'upload'),
        downloaded: countOps(ops, 'download'),
        deletedLocal: countOps(ops, 'delete-local'),
        deletedRemote: countOps(ops, 'delete-remote'),
        conflictsResolved: resolutions.length,
        conflictsSkipped: conflicts.length - resolutions.length,
        snapshotTaken: snapshotDue,
      }
      patch({
        running: null,
        lastSync: summary,
        lastSnapshotAt: snapshotDue ? finishedAt : lastSnapshotAt,
        remote: { kind: 'ok', checkedAt: finishedAt, pendingChanges: 0, lock: null },
      })
      toast.close()
      showToast(formatSummary(summary), summary.conflictsSkipped > 0 ? 'warning' : 'success', 6000)
    } catch (err) {
      toast.close()
      fail('Sync', err)
    }
  }

  async function backupNow(): Promise<void> {
    if (!canStart('back up')) return
    patch({ lastError: null, running: { step: 'snapshot', label: 'Building the graph snapshot…', done: 0, total: 3 } })
    const toast = await openProgressToast('Google Drive Sync: building the graph snapshot…')
    try {
      await tick(600)
      progress({ step: 'snapshot', label: 'Uploading the graph snapshot (3.2 MB)…', done: 1, total: 3 })
      await toast.update('Google Drive Sync: uploading the graph snapshot (3.2 MB)…')
      await tick(900)
      const withProfile = settings.get().profileBackupEnabled
      if (withProfile) {
        progress({ step: 'snapshot', label: 'Uploading the profile bundle…', done: 2, total: 3 })
        await toast.update('Google Drive Sync: uploading the profile bundle…')
        await tick(700)
      }
      const now = Date.now()
      patch({
        running: null,
        lastSnapshotAt: now,
        lastProfileBackupAt: withProfile ? now : status.get().lastProfileBackupAt,
      })
      toast.close()
      showToast(
        withProfile
          ? 'Backup complete: graph snapshot and profile bundle uploaded.'
          : 'Backup complete: graph snapshot uploaded (profile backup is disabled in settings).',
        'success',
        6000,
      )
    } catch (err) {
      toast.close()
      fail('Backup', err)
    }
  }

  async function checkRemote(): Promise<void> {
    const s = status.get()
    if (!s.account || s.running || s.remote.kind === 'checking') return
    patch({ remote: { kind: 'checking' } })
    try {
      await tick(700)
    } catch {
      return
    }
    if (!status.get().account) return
    patch({ remote: { kind: 'ok', checkedAt: Date.now(), pendingChanges: status.get().lastSync ? 0 : 2, lock: null } })
  }

  async function connect(): Promise<void> {
    patch({ account: MOCK_ACCOUNT })
    showToast('Connected to Google Drive (mock account; the real sign-in arrives in M3).', 'success')
    await checkRemote()
  }

  async function signOut(): Promise<void> {
    if (status.get().running) {
      showToast('Wait for the current sync or backup to finish before signing out.', 'warning')
      return
    }
    patch({ account: null, remote: { kind: 'unchecked' }, pendingConflicts: [] })
  }

  function resolveConflicts(resolutions: ConflictResolution[]): void {
    if (pendingResolve) {
      pendingResolve(resolutions)
      return
    }
    // A conflict state forced by `showState`: nothing is waiting, just leave it.
    patch({ pendingConflicts: [], running: null })
  }

  function showState(state: SyncState): void {
    const s = status.get()
    const base: Partial<SyncStatus> = { running: null, pendingConflicts: [], lastError: null }
    switch (state) {
      case 'signed-out':
        patch({ ...base, account: null, remote: { kind: 'unchecked' } })
        break
      case 'idle':
        patch({ ...base, account: MOCK_ACCOUNT, lastSync: s.lastSync ? { ...s.lastSync, conflictsSkipped: 0 } : null })
        break
      case 'syncing': {
        const running: SyncProgress = { step: 'execute', label: 'Uploading pages/Alpha.md', done: 3, total: 7 }
        patch({ ...base, account: MOCK_ACCOUNT, running })
        void tick(4000)
          .then(() => {
            if (status.get().running === running) patch({ running: null })
          })
          .catch(() => undefined)
        break
      }
      case 'conflict':
        patch({
          ...base,
          account: MOCK_ACCOUNT,
          running: { step: 'conflicts', label: '3 conflicts need your decision', done: 0, total: 3 },
          pendingConflicts: mockConflicts(Date.now()),
        })
        break
      case 'error':
        patch({
          ...base,
          account: MOCK_ACCOUNT,
          lastError: {
            message: 'Another device ("Office-PC") holds the Drive lock for 12 more minutes. Retry later or break the lock from that device.',
            at: Date.now(),
          },
        })
        break
    }
  }

  return {
    syncNow: () => runSync('clean'),
    runDemo: runSync,
    backupNow,
    checkRemote,
    connect,
    signOut,
    resolveConflicts,
    dismissError: () => patch({ lastError: null }),
    showState,
    dispose: () => {
      disposed = true
      pendingResolve?.([])
    },
  }
}
