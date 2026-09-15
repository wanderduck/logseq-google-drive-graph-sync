// The real `SyncController` (src/sync/controller.ts) since M7: host wiring around `runSyncSession`
// (src/sync/session.ts). It owns the status-store patches, the toasts, the conflict-dialog promise, the D9
// remote check, the graph-switch policy (plan M7 step 3) and the Google account mirroring that M3 had put
// into the mock. Everything Drive- or file-related is built per run from the real layers (a fresh Drive
// client per run, like a restart, so no folder cache outlives a run): `createHostDriveClient`,
// `resolveLayout`/`findLayout`, `createDriveMirror`, `createDriveLock`, `createHostGraphFs`.

import type { AuthState, GoogleAuth } from '../google/auth'
import { describeGoogleError } from '../google/errors'
import { findLayout, resolveLayout, type LayoutSpec } from '../google/layout'
import { createDriveLock } from '../google/lock'
import { createDriveMirror } from '../google/mirror'
import type { ConflictItem, ConflictResolution } from '../sync/conflict'
import type { SyncController, SyncNowOptions } from '../sync/controller'
import {
  checkRemoteStatus,
  describeRunProblems,
  describeSkippedOps,
  effectiveDeviceName,
  runSyncSession,
  summarizeRun,
  type EditorFlushPhase,
  type SessionDeps,
} from '../sync/session'
import { createSyncStateStore, ensureDevice, graphKey, type DeviceInfo } from '../sync/state'
import type { SyncProgress, SyncStatus } from '../sync/status'
import type { Store } from '../sync/store'
import { throttleLatest } from '../sync/throttle'
import { formatDateTime, formatSummary } from '../ui/format'
import { openPanel } from './commands'
import { createHostGraphFs, hostBridge } from './fsHost'
import { createHostDriveClient, hostSleep } from './googleHost'
import { isSupportedHostVersion } from './hostVersion'
import type { GdsyncSettings } from './settings'
import { closeToast, openProgressToast, showStickyToast, showToast } from './toasts'

const CONNECT_TOAST_KEY = 'gdsync-connect'
/** Spike §4.2: a block saved by `exitEditingMode` reaches the disk within about a second. */
export const EDITOR_FLUSH_MS = 1200
/** The engine reports per file and per op; the panel and the toast see at most one update per interval. */
const PROGRESS_INTERVAL_MS = 250
/** D11: until M9 the plugin refuses to sync any graph outside the disposable test graphs. Removed in M9. */
export const DEV_GRAPH_MARKER = '/logseq-test-graphs/'

export interface SyncControllerDeps {
  status: Store<SyncStatus>
  settings: Store<GdsyncSettings>
  auth: GoogleAuth
  hostVersion: string
}

interface GraphRef {
  name: string
  path: string
}

interface ActiveRun {
  abort: AbortController
  graphPath: string
  /** Why `abort` was fired, for the error banner. */
  abortReason: string | null
  promise: Promise<void>
}

function warn(line: string, detail: unknown): void {
  console.warn(`[gdsync] ${line}`, detail)
}

/** `crypto.randomUUID` needs a secure context (file:// counts in Chromium); the fallback keeps the id 128 random bits either way. */
function newDeviceId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Spike §4.2: an external write to the file of the block being edited closes the editor and drops the
 * unsaved input without a prompt, so the block is saved first and the flush is awaited. Before the scan the
 * wait is unconditional (a block left a moment ago may still be queued for its file write); before a local
 * write it is needed only while a block is being edited.
 */
async function flushEditor(phase: EditorFlushPhase): Promise<void> {
  let editing = true
  try {
    editing = Boolean(await logseq.Editor.checkEditing())
  } catch (err) {
    warn('Editor.checkEditing failed; assuming a block is being edited', err)
  }
  if (editing) {
    try {
      await logseq.Editor.exitEditingMode()
    } catch (err) {
      warn('Editor.exitEditingMode failed', err)
    }
  }
  if (editing || phase === 'before-scan') await hostSleep(EDITOR_FLUSH_MS)
}

export function createSyncController({ status, settings, auth, hostVersion }: SyncControllerDeps): SyncController {
  let disposed = false
  let run: ActiveRun | null = null
  let pendingResolve: ((r: ConflictResolution[]) => void) | null = null
  const store = createSyncStateStore(logseq.FileStorage)
  let devicePromise: Promise<DeviceInfo> | null = null

  const log = (line: string): void => console.info(`[gdsync] sync: ${line}`)
  const patch = (p: Partial<SyncStatus>): void => status.update((s) => ({ ...s, ...p }))

  /** `device.json`, created once (plan §3.5); a failed read is retried on the next use. */
  function device(): Promise<DeviceInfo> {
    if (!devicePromise) {
      devicePromise = ensureDevice(store, { newId: newDeviceId, now: Date.now }).catch((err: unknown) => {
        devicePromise = null
        throw err
      })
    }
    return devicePromise
  }

  /** One-way mirror auth → status. Losing the account also drops remote state and pending conflicts. */
  function mirrorAuth(a: AuthState): void {
    const account = a.kind === 'signed-in' ? a.account : null
    const deviceFlow = a.kind === 'connecting' ? { userCode: a.userCode, verificationUrl: a.verificationUrl, expiresAt: a.expiresAt } : null
    status.update((s) => {
      const lostAccount = s.account !== null && account === null
      return {
        ...s,
        account,
        deviceFlow,
        ...(lostAccount ? { remote: { kind: 'unchecked' as const }, pendingConflicts: [] } : {}),
      }
    })
    if (deviceFlow) {
      showStickyToast(
        CONNECT_TOAST_KEY,
        `Google sign-in: enter code ${deviceFlow.userCode} at ${deviceFlow.verificationUrl}. The sync panel has the details.`,
      )
    } else {
      closeToast(CONNECT_TOAST_KEY)
    }
    if (a.kind === 'signed-out' && a.reason === 'session-expired') {
      showToast('The Google sign-in expired or was revoked. Connect again from the sync panel.', 'warning', 10_000)
    }
    // A session lost mid-run: the transport fails every request from here on; stop instead of burning retries.
    if (account === null && run) {
      run.abortReason = 'The Google sign-in was lost during the sync, so the run was stopped. Connect and sync again to resume it.'
      run.abort.abort()
      finishConflicts([])
    }
  }
  const unsubscribeAuth = auth.state.subscribe(mirrorAuth)

  // Graph switches (plan M7 step 3): the panel's facts follow the open graph; a run belongs to the graph it started on.
  let graphPath: string | null = status.get().graph?.path ?? null
  const unsubscribeGraph = status.subscribe((s) => {
    const next = s.graph?.path ?? null
    if (next === graphPath) return
    graphPath = next
    onGraphChanged(s.graph)
  })

  function onGraphChanged(graph: GraphRef | null): void {
    if (run && run.graphPath !== graph?.path) {
      run.abortReason = 'The graph changed during the sync, so the run was stopped. Sync again to resume it.'
      run.abort.abort()
      finishConflicts([])
    }
    patch({ lastSync: null, lastSyncAt: null, lastSnapshotAt: null, lastError: null, remote: { kind: 'unchecked' } })
    if (graph) void loadGraphFacts(graph)
  }

  async function loadGraphFacts(graph: GraphRef): Promise<void> {
    try {
      const st = await store.loadState(graphKey(graph.name, graph.path))
      if (disposed || status.get().graph?.path !== graph.path) return
      patch({ lastSyncAt: st.lastSyncAt, lastSnapshotAt: st.lastSnapshotAt })
    } catch (err) {
      warn('loading the sync state failed', err)
    }
  }

  async function sessionDeps(graph: GraphRef): Promise<SessionDeps> {
    const bridge = hostBridge()
    const dev = await device()
    const cfg = settings.get()
    const deviceName = effectiveDeviceName(cfg.deviceName, dev.deviceId)
    const client = createHostDriveClient(auth)
    const spec: LayoutSpec = { rootFolderName: cfg.rootFolderName, graphName: graph.name }
    return {
      fs: createHostGraphFs(graph.path, bridge),
      store,
      graphKey: graphKey(graph.name, graph.path),
      deviceId: dev.deviceId,
      deviceName,
      resolveLayout: (known) => resolveLayout(client, spec, known),
      findLayout: (known) => findLayout(client, spec, known),
      openRemote: (graphFolderId) => ({
        mirror: createDriveMirror({ client, graphFolderId, log: (l) => log(`mirror: ${l}`) }),
        lock: createDriveLock({ client, graphFolderId, deviceId: dev.deviceId, deviceName, log: (l) => log(`lock: ${l}`) }),
      }),
      flushEditor,
      log,
      describeError: describeGoogleError,
      sleep: hostSleep,
    }
  }

  /** The graph to act on, or `null` after the toast that says why not. */
  function canStart(action: string): GraphRef | null {
    const s = status.get()
    if (!s.account) {
      showToast(`Connect Google Drive before you ${action}.`, 'warning')
      openPanel()
      return null
    }
    if (s.running) {
      showToast('A sync is already running.', 'info', 3000)
      return null
    }
    if (!s.graph) {
      showToast(`Open a graph before you ${action}.`, 'warning')
      return null
    }
    return s.graph
  }

  function fail(what: string, err: unknown): void {
    if (disposed) return
    console.error(`[gdsync] ${what} failed`, err)
    const message = `${what} failed: ${describeGoogleError(err)}`
    patch({ running: null, pendingConflicts: [], lastError: { message, at: Date.now() } })
    showToast(message, 'error', 10_000)
  }

  function finishConflicts(resolutions: ConflictResolution[]): void {
    const resolve = pendingResolve
    pendingResolve = null
    if (status.get().pendingConflicts.length > 0) patch({ pendingConflicts: [] })
    resolve?.(resolutions)
  }

  async function syncNow(opts: SyncNowOptions = {}): Promise<void> {
    const graph = canStart('sync')
    if (!graph) return
    if (!graph.path.includes(DEV_GRAPH_MARKER)) {
      const message = `This development build only syncs graphs under ~${DEV_GRAPH_MARKER} (plan D11); "${graph.path}" is not one of them.`
      patch({ lastError: { message, at: Date.now() } })
      showToast(message, 'error', 10_000)
      return
    }
    if (!isSupportedHostVersion(hostVersion)) {
      showToast(`Logseq "${hostVersion}" is untested with this plugin (it targets 0.10.x); syncing anyway.`, 'warning', 6000)
    }

    const abort = new AbortController()
    const current: ActiveRun = { abort, graphPath: graph.path, abortReason: null, promise: Promise.resolve() }
    run = current
    patch({ lastError: null, pendingConflicts: [], running: { step: 'preflight', label: 'Checking prerequisites', done: 0, total: 0 } })
    const toast = await openProgressToast('Google Drive Sync: checking prerequisites…')
    const progress = throttleLatest<SyncProgress>(PROGRESS_INTERVAL_MS, (p) => {
      if (run !== current || disposed) return
      patch({ running: p })
      void toast.update(`Google Drive Sync: ${p.label}${p.total > 0 ? ` (${p.done}/${p.total})` : ''}…`)
    })
    const resolveConflicts = (items: ConflictItem[]): Promise<ConflictResolution[]> =>
      new Promise((resolve) => {
        progress.cancel()
        pendingResolve = resolve
        const n = items.length
        patch({
          pendingConflicts: items,
          running: { step: 'conflicts', label: `${n} ${n === 1 ? 'conflict needs' : 'conflicts need'} your decision`, done: 0, total: n },
        })
        void toast.update('Google Drive Sync: waiting for your conflict decisions…')
        openPanel()
      })

    current.promise = (async () => {
      try {
        const deps = await sessionDeps(graph)
        log(`starting on "${graph.name}" (${graph.path}) as device "${deps.deviceName}"${opts.breakExpiredLock ? ', breaking an expired lock' : ''}`)
        const outcome = await runSyncSession(deps, {
          onProgress: progress.push,
          resolveConflicts,
          signal: abort.signal,
          breakExpiredLock: opts.breakExpiredLock,
        })
        progress.cancel()
        if (disposed) return
        toast.close()

        if (outcome.kind === 'locked') {
          const until = formatDateTime(outcome.lock.expiresAt)
          const message = outcome.expired
            ? `Another device ("${outcome.lock.deviceName}") left a Drive lock that expired at ${until}; it probably crashed mid-sync. You can break the lock and sync.`
            : `Another device ("${outcome.lock.deviceName}") is syncing this graph; its lock lasts until ${until}. Try again later.`
          patch({
            running: null,
            lastError: {
              message,
              at: Date.now(),
              ...(outcome.expired ? { expiredLock: { deviceName: outcome.lock.deviceName, expiresAt: outcome.lock.expiresAt } } : {}),
            },
          })
          showToast(message, 'warning', 10_000)
          if (outcome.expired) openPanel()
          return
        }

        const { result } = outcome
        const summary = summarizeRun(result)
        const abortReason = current.abortReason ?? (outcome.lockLost ? 'The Drive lock could not be renewed, so the run was stopped. Sync again to resume it.' : null)
        const problem = describeRunProblems(result, abortReason)
        const skipped = describeSkippedOps(result)
        const finishedAt = Date.now()
        log(
          `done in ${result.finishedAt - result.startedAt} ms: ${result.delta} delta, ${result.scan.files} local files (${result.scan.hashed} hashed), ` +
            `${result.remoteFiles} remote, ${result.planned} planned, ${result.unchanged} unchanged, ${result.uploaded} up, ${result.downloaded} down, ` +
            `${result.deletedLocal}/${result.deletedRemote} deleted, ${result.baseUpdated} base updates, ${result.conflicts} conflicts ` +
            `(${result.conflictsResolved} resolved, ${result.conflictsReplayed} replayed, ${result.conflictsSkipped} skipped), ` +
            `${result.failures.length} failed, ${result.skippedOps.length} skipped ops${result.recovered ? ', recovered a journal' : ''}` +
            `${result.stoppedEarly ? `, stopped early (${result.stoppedEarly})` : ''}; bak ${result.bakDir}`,
        )
        patch({
          running: null,
          pendingConflicts: [],
          lastSync: summary,
          lastSyncAt: summary.finishedAt,
          lastError: problem ? { message: problem, at: finishedAt } : null,
          ...(problem ? {} : { remote: { kind: 'ok', checkedAt: finishedAt, pendingChanges: 0, lock: null, firstSync: false } }),
        })
        if (problem) showToast(`Sync finished with problems. ${problem}`, 'error', 12_000)
        else showToast(formatSummary(summary), summary.conflictsSkipped > 0 ? 'warning' : 'success', 6000)
        if (skipped) showToast(skipped, 'info', 8000)
      } catch (err) {
        progress.cancel()
        toast.close()
        fail('Sync', err)
      } finally {
        if (run === current) run = null
        pendingResolve = null
      }
    })()
    await current.promise
  }

  async function backupNow(): Promise<void> {
    if (!canStart('back up')) return
    showToast('Backups (graph snapshots and the profile bundle) arrive with the next milestone (M8).', 'info', 5000)
  }

  async function checkRemote(): Promise<void> {
    const s = status.get()
    const graph = s.graph
    if (!s.account || s.running || s.remote.kind === 'checking' || !graph) return
    patch({ remote: { kind: 'checking' } })
    try {
      const deps = await sessionDeps(graph)
      const remote = await checkRemoteStatus(deps)
      if (disposed || status.get().graph?.path !== graph.path || !status.get().account) return
      patch({ remote })
    } catch (err) {
      if (disposed) return
      warn('remote check failed', err)
      if (status.get().graph?.path === graph.path) patch({ remote: { kind: 'unavailable', checkedAt: Date.now(), reason: describeGoogleError(err) } })
    }
  }

  async function connect(): Promise<void> {
    patch({ lastError: null })
    try {
      const r = await auth.connect()
      switch (r.kind) {
        case 'connected':
          showToast(`Connected to Google Drive as ${r.account.email}.`, 'success')
          if (r.warning) showToast(r.warning, 'warning', 12_000)
          await checkRemote()
          break
        case 'denied':
          showToast('Google sign-in was declined. Nothing was connected.', 'warning')
          break
        case 'expired':
          showToast('The sign-in code expired before it was approved. Connect again to get a new code.', 'warning')
          break
        case 'cancelled':
          showToast('Sign-in cancelled.', 'info', 3000)
          break
        case 'already-connected':
          mirrorAuth(auth.state.get())
          break
        case 'already-connecting':
          openPanel()
          break
      }
    } catch (err) {
      if (disposed) return
      console.error('[gdsync] connect failed', err)
      const message = describeGoogleError(err)
      patch({ lastError: { message: `Google sign-in failed. ${message}`, at: Date.now() } })
      showToast(`Google sign-in failed: ${message}`, 'error', 10_000)
    }
  }

  async function signOut(): Promise<void> {
    if (status.get().running) {
      showToast('Wait for the current sync to finish before signing out.', 'warning')
      return
    }
    const r = await auth.signOut()
    if (r.revoked) {
      showToast('Signed out of Google Drive; the plugin’s access was revoked.', 'success')
    } else if (r.revokeError) {
      showToast(
        `Signed out locally, but Google could not be told to revoke access (${r.revokeError}). ` +
          'You can remove "Google Drive Graph Sync" at https://myaccount.google.com/permissions.',
        'warning',
        12_000,
      )
    }
  }

  return {
    syncNow,
    backupNow,
    checkRemote,
    connect,
    cancelConnect: () => auth.cancelConnect(),
    signOut,
    resolveConflicts: finishConflicts,
    dismissError: () => patch({ lastError: null }),
    dispose: async () => {
      disposed = true
      const active = run
      if (active) {
        active.abortReason = 'Logseq is closing.'
        active.abort.abort()
      }
      finishConflicts([])
      auth.cancelConnect()
      unsubscribeAuth()
      unsubscribeGraph()
      // The in-flight ops finish, the state is saved, the lock is released; `beforeunload` awaits this.
      if (active) await active.promise.catch(() => undefined)
    },
  }
}
