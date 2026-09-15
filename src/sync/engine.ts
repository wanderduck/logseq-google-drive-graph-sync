// Plan §3.6 steps 3–8 as one pure function, `runSync`: local scan → remote delta → three-way plan →
// conflict answers → journaled execution → persisted state. Steps 1–2 and 9–10 (preflight, the Drive lock,
// snapshots, UI) are the M7 wiring around it; nothing here imports `logseq` or src/google/.
//
// Crash safety (M6 step 4). The plan is written to the journal before execution and completed ops are
// appended in batches. The next run first RECOVERS: it folds the journal's completions into the state,
// then plans afresh. Re-planning, not replaying, is what makes the resume idempotent and safe against
// edits made in between: an op that finished without being journaled leaves L = R ≠ B (→ base update),
// a half-written download leaves a dot-prefixed temp file (moved to bak here), an op that never ran is
// planned again. Conflict answers are journaled with both hashes and replayed only for the identical conflict.

import { listTempFiles } from '../fs/atomicWrite'
import { createBakSession } from '../fs/bak'
import type { GraphFs } from '../fs/graphFs'
import { isIgnoredGraphPath } from '../fs/ignore'
import { scanFiles, type ScanResult } from '../fs/scanner'
import type { ConflictItem, ConflictResolution } from './conflict'
import { DEFAULT_EXECUTE_CONCURRENCY, executePlan, opLabel, type OpFailure, type OpSkip, type StopReason } from './executor'
import { conflictOps, opKey, planSync, type AppliedResolution, type PlannedConflict, type SyncOp } from './planner'
import { applyDeltaWithDuplicates, remoteViewOf, type RemoteMirror, type RemoteView } from './remote'
import { applyCompletions, type Completion, type SyncJournal, type SyncState, type SyncStateStore } from './state'
import type { SyncProgress } from './status'

/** The journal is rewritten after this many completed ops or this much time, whichever comes first. */
export const JOURNAL_FLUSH_OPS = 25
export const JOURNAL_FLUSH_MS = 3000

export interface SyncEngineDeps {
  fs: GraphFs
  remote: RemoteMirror
  store: SyncStateStore
  graphKey: string
  deviceId: string
  /** Raw settings value; `conflictCopyName` sanitises it. */
  deviceName: string
  now?: () => number
  log?: (line: string) => void
  concurrency?: number
  describeError?: (err: unknown) => string
  newRunId?: () => string
  /** Journal rewrite thresholds; defaults `JOURNAL_FLUSH_OPS` / `JOURNAL_FLUSH_MS`. */
  journalFlush?: { ops: number; ms: number }
}

export interface SyncRunHooks {
  onProgress?: (progress: SyncProgress) => void
  /** The conflict dialog (D7). Paths missing from the answer are skipped. Without a hook every conflict is skipped. */
  resolveConflicts?: (items: ConflictItem[]) => Promise<ConflictResolution[]>
  /** See `ExecutorDeps.beforeLocalWrite` (the editor force-save of spike §4.2). */
  beforeLocalWrite?: (path: string) => Promise<void>
  signal?: AbortSignal
}

export interface SyncRunResult {
  startedAt: number
  finishedAt: number
  /** A journal of an interrupted run was folded into the state first. */
  recovered: boolean
  /** Leftover `*.gdsync-tmp` files moved to the bak folder. */
  tempFilesMoved: number
  scan: Omit<ScanResult, 'files'> & { files: number }
  delta: 'full' | 'changes'
  /** Paths on Drive as of this run. */
  remoteFiles: number
  planned: number
  unchanged: number
  uploaded: number
  downloaded: number
  deletedLocal: number
  deletedRemote: number
  baseUpdated: number
  /** Younger twins of a path on Drive that were trashed (see `DeltaResult.duplicates`). */
  duplicatesTrashed: number
  conflicts: number
  conflictsResolved: number
  /** Answers taken from the journal of the interrupted run instead of asking again. */
  conflictsReplayed: number
  conflictsSkipped: number
  failures: OpFailure[]
  skippedOps: OpSkip[]
  stoppedEarly: StopReason | null
  /** Where this run's backups went (only exists when something was backed up or moved). */
  bakDir: string
}

function defaultRunId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function pruneIgnored(view: RemoteView): RemoteView {
  const out: RemoteView = new Map()
  for (const [path, f] of view) if (!isIgnoredGraphPath(path)) out.set(path, f)
  return out
}

/** Answers from the crashed run that match a conflict of this run exactly (path and both hashes). */
function replayable(conflicts: PlannedConflict[], remembered: readonly AppliedResolution[]): { replayed: ConflictResolution[]; toAsk: PlannedConflict[] } {
  const replayed: ConflictResolution[] = []
  const toAsk: PlannedConflict[] = []
  for (const c of conflicts) {
    const localSha = c.local?.sha256 ?? null
    const remoteSha = c.remote?.sha256 ?? null
    const hit = remembered.find((r) => r.path === c.item.path && r.localSha === localSha && r.remoteSha === remoteSha)
    if (hit) replayed.push({ path: hit.path, choice: hit.choice })
    else toAsk.push(c)
  }
  return { replayed, toAsk }
}

export async function runSync(deps: SyncEngineDeps, hooks: SyncRunHooks = {}): Promise<SyncRunResult> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const progress = (p: SyncProgress): void => hooks.onProgress?.(p)
  const startedAt = now()
  const { store, graphKey } = deps

  // Recovery of an interrupted run (see the header).
  const state: SyncState = await store.loadState(graphKey)
  const previous = await store.loadJournal(graphKey)
  let remembered: AppliedResolution[] = []
  if (previous) {
    const completions = Object.values(previous.done).flat()
    applyCompletions(state, completions)
    await store.saveState(state)
    await store.clearJournal(graphKey)
    remembered = previous.resolutions
    log(`recovered the interrupted run ${previous.runId}: ${completions.length} completed operations folded in, ${remembered.length} conflict answers kept`)
  }

  // Step 3: local scan, after moving the temp files a crashed download left behind (invisible to Logseq, but clutter).
  const bak = createBakSession(deps.fs, new Date(startedAt))
  progress({ step: 'scan', label: 'Scanning local files', done: 0, total: 0 })
  let tempFilesMoved = 0
  for (const tmp of await listTempFiles(deps.fs)) {
    await bak.moveIn(tmp)
    tempFilesMoved++
  }
  const scan = await scanFiles(deps.fs, {
    cache: (path) => state.entries[path],
    onProgress: (done, total) => progress({ step: 'scan', label: 'Scanning local files', done, total }),
  })

  // Step 4: remote delta onto the persisted remote view.
  progress({ step: 'remote', label: 'Fetching remote changes', done: 0, total: 0 })
  const delta = await deps.remote.fetchDelta(state.changesPageToken)
  const applied = applyDeltaWithDuplicates(remoteViewOf(Object.values(state.remote)), delta)
  const view = pruneIgnored(applied.view)
  const duplicates = applied.duplicates.filter((d) => !isIgnoredGraphPath(d.path))
  log(
    `remote delta: ${delta.kind === 'full' ? `full listing, ${delta.files.length} files` : `${delta.changed.length} changed, ${delta.removedIds.length} removed`}; ` +
      `view holds ${view.size} files${duplicates.length > 0 ? `, ${duplicates.length} younger duplicates to trash` : ''}`,
  )

  let journaled = false
  const finish = async (partial: Omit<SyncRunResult, 'finishedAt' | 'startedAt' | 'recovered' | 'tempFilesMoved' | 'scan' | 'delta' | 'remoteFiles' | 'bakDir'>): Promise<SyncRunResult> => {
    progress({ step: 'finish', label: 'Saving sync state', done: 0, total: 0 })
    state.remote = Object.fromEntries(view)
    state.changesPageToken = delta.token
    state.lastSyncAt = now()
    await store.saveState(state)
    if (journaled) await store.clearJournal(graphKey)
    return {
      startedAt,
      finishedAt: now(),
      recovered: previous !== null,
      tempFilesMoved,
      scan: { files: scan.files.length, hashed: scan.hashed, reused: scan.reused, ignored: scan.ignored, vanished: scan.vanished },
      delta: delta.kind,
      remoteFiles: view.size,
      bakDir: bak.dir,
      ...partial,
    }
  }

  // Step 5: the plan.
  progress({ step: 'plan', label: 'Planning', done: 0, total: 0 })
  const plan = planSync({ local: scan.files, remote: view, base: state.entries })
  log(`plan: ${plan.ops.length} operations, ${plan.conflicts.length} conflicts, ${plan.unchanged} unchanged`)

  // Step 6: conflict answers, replayed from the journal where the same conflict came back.
  const { replayed, toAsk } = replayable(plan.conflicts, remembered)
  let asked: ConflictResolution[] = []
  if (toAsk.length > 0 && hooks.resolveConflicts) {
    progress({ step: 'conflicts', label: `${toAsk.length} ${toAsk.length === 1 ? 'conflict needs' : 'conflicts need'} your decision`, done: 0, total: toAsk.length })
    asked = await hooks.resolveConflicts(toAsk.map((c) => c.item))
  }
  const resolved = conflictOps(plan.conflicts, [...replayed, ...asked], deps.deviceName, new Date(startedAt))
  // A "keep both" whose copy already exists (an interrupted run made it, or its own op in this plan handles
  // it) degrades to the download half, so the copy is never uploaded twice.
  const localPaths = new Set(scan.files.map((f) => f.path))
  const conflictOpsFinal: SyncOp[] = resolved.ops.map((op) =>
    op.kind === 'keep-both' && (localPaths.has(op.copyPath) || view.has(op.copyPath))
      ? { kind: 'download', path: op.path, remote: op.remote, expectLocal: { size: op.local.size, mtimeMs: op.local.mtimeMs } }
      : op,
  )
  const ops: SyncOp[] = [...plan.ops, ...conflictOpsFinal, ...duplicates.map((remote): SyncOp => ({ kind: 'trash-duplicate', path: remote.path, remote }))]
  const conflictCounts = {
    conflicts: plan.conflicts.length,
    conflictsResolved: resolved.applied.length,
    conflictsReplayed: replayed.length,
    conflictsSkipped: resolved.skipped.length,
  }
  for (const item of resolved.skipped) log(`conflict on ${item.path} left undecided; it will be asked again`)

  const empty = { planned: ops.length, unchanged: plan.unchanged, uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, baseUpdated: 0, duplicatesTrashed: 0, ...conflictCounts, failures: [], skippedOps: [] }
  if (hooks.signal?.aborted) return finish({ ...empty, stoppedEarly: 'aborted' })
  if (ops.length === 0) return finish({ ...empty, stoppedEarly: null })

  // Step 7: journaled execution.
  const journal: SyncJournal = {
    version: 1,
    runId: deps.newRunId?.() ?? defaultRunId(startedAt),
    startedAt,
    bakDir: bak.dir,
    ops,
    done: {},
    resolutions: resolved.applied,
  }
  await store.saveJournal(graphKey, journal)
  journaled = true

  const flushOps = deps.journalFlush?.ops ?? JOURNAL_FLUSH_OPS
  const flushMs = deps.journalFlush?.ms ?? JOURNAL_FLUSH_MS
  let sinceFlush = 0
  let lastFlushAt = now()
  let flushChain: Promise<void> = Promise.resolve()
  const flushJournal = (): Promise<void> => {
    sinceFlush = 0
    lastFlushAt = now()
    const snapshot = JSON.parse(JSON.stringify(journal)) as SyncJournal
    flushChain = flushChain.then(() => store.saveJournal(graphKey, snapshot))
    return flushChain
  }

  const exec = await executePlan(
    {
      fs: deps.fs,
      remote: deps.remote,
      bak,
      deviceId: deps.deviceId,
      now,
      concurrency: deps.concurrency ?? DEFAULT_EXECUTE_CONCURRENCY,
      log,
      describeError: deps.describeError,
      beforeLocalWrite: hooks.beforeLocalWrite,
    },
    ops,
    {
      signal: hooks.signal,
      onOpStart: (op, total) => progress({ step: 'execute', label: opLabel(op), done: Object.keys(journal.done).length, total }),
      onOpDone: async (op, outcome, done, total) => {
        const completions: Completion[] = outcome.completions
        applyCompletions(state, completions)
        for (const c of completions) {
          if (c.remote) view.set(c.path, c.remote)
          else view.delete(c.path)
        }
        journal.done[opKey(op)] = completions
        sinceFlush++
        if (sinceFlush >= flushOps || now() - lastFlushAt >= flushMs) await flushJournal()
        progress({ step: 'execute', label: opLabel(op), done, total })
      },
    },
  )
  await flushChain

  // Step 8: persist, clear the journal.
  if (exec.stoppedEarly) log(`execution stopped early: ${exec.stoppedEarly}`)
  return finish({
    planned: ops.length,
    unchanged: plan.unchanged,
    ...exec.counts,
    ...conflictCounts,
    failures: exec.failures,
    skippedOps: exec.skipped,
    stoppedEarly: exec.stoppedEarly,
  })
}
