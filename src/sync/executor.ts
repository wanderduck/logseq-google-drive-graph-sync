// Plan §3.6 step 7 / M6 step 4: runs a plan with a concurrency limit. Every operation reports a
// `Completion` (state.ts) the moment it is done, so the engine can journal it; a failing operation is
// recorded and the run goes on, except that three failures in a row trip a breaker (an offline machine or
// an expired sign-in would otherwise fail every remaining op after the transport's full backoff).
// Local safety: a download re-checks the stat taken at scan time and skips a file the user changed in the
// meantime; the previous content is copied to the run's bak folder before an overwrite, and local deletes
// are moves into it (plan §3.6 step 7 + the 2026-09-15 amendment). A downloaded file's bytes are verified
// against the remote sha256 before they replace anything.

import { writeFileAtomic } from '../fs/atomicWrite'
import type { BakSession } from '../fs/bak'
import { isFsNotFound, type FileStat, type GraphFs } from '../fs/graphFs'
import { sha256Hex } from '../fs/hash'
import type { LocalStat, SyncOp } from './planner'
import type { RemoteFile, RemoteMirror } from './remote'
import type { Completion } from './state'

export const DEFAULT_EXECUTE_CONCURRENCY = 4
export const MAX_CONSECUTIVE_FAILURES = 3

export type OpOutcome =
  | { kind: 'done'; completions: Completion[] }
  /** A guard said no (the file changed locally during the run); nothing was touched. Planned again next run. */
  | { kind: 'skipped'; reason: string; completions: Completion[] }
  /** `completions` holds the parts of a compound op that did finish before the failure. */
  | { kind: 'failed'; message: string; completions: Completion[] }

export interface OpFailure {
  op: SyncOp
  message: string
}

export interface OpSkip {
  op: SyncOp
  reason: string
}

export type StopReason = 'aborted' | 'too-many-failures'

export interface ExecuteCounts {
  uploaded: number
  downloaded: number
  deletedLocal: number
  deletedRemote: number
  baseUpdated: number
  duplicatesTrashed: number
}

export interface ExecuteResult {
  completions: Completion[]
  failures: OpFailure[]
  skipped: OpSkip[]
  counts: ExecuteCounts
  /** Set when not every op was attempted. */
  stoppedEarly: StopReason | null
}

export interface ExecutorDeps {
  fs: GraphFs
  remote: RemoteMirror
  bak: BakSession
  deviceId: string
  now: () => number
  concurrency?: number
  log?: (line: string) => void
  /** Turns a thrown error into the message kept in `failures`; the M7 wiring passes `describeGoogleError`. */
  describeError?: (err: unknown) => string
  /**
   * Awaited right before an op modifies the graph (download, delete-local, keep-both), ahead of the stat
   * guard. The M7 wiring force-saves the block being edited and waits for the flush (spike §4.2), so an edit
   * in progress lands on disk first and the guard then skips the file instead of overwriting it.
   */
  beforeLocalWrite?: (path: string) => Promise<void>
}

export interface ExecuteHooks {
  /** Called just before an op runs. Like `onOpDone`, an exception here stops the run. */
  onOpStart?: (op: SyncOp, total: number) => void
  /**
   * Called after every op, in completion order, with the running count. The engine journals here. An
   * exception thrown by either hook is treated like a crash: no further op starts, the in-flight ones finish,
   * and the exception is rethrown.
   */
  onOpDone?: (op: SyncOp, outcome: OpOutcome, done: number, total: number) => void | Promise<void>
  signal?: AbortSignal
}

export function opLabel(op: SyncOp): string {
  switch (op.kind) {
    case 'upload':
      return `Uploading ${op.path}`
    case 'download':
      return `Downloading ${op.path}`
    case 'delete-local':
      return `Moving ${op.path} to logseq/bak/gdsync`
    case 'delete-remote':
      return `Trashing ${op.path} on Drive`
    case 'update-base':
      return `Recording ${op.path}`
    case 'drop-base':
      return `Forgetting ${op.path}`
    case 'keep-both':
      return `Keeping both versions of ${op.path}`
    case 'trash-duplicate':
      return `Trashing a duplicate of ${op.path} on Drive`
  }
}

function defaultDescribe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type Guarded<T> = { ok: true; value: T } | { ok: false; reason: string }

function statMatches(stat: FileStat | null, expect: LocalStat): boolean {
  return stat !== null && stat.size === expect.size && stat.mtimeMs === expect.mtimeMs
}

export async function executePlan(deps: ExecutorDeps, ops: readonly SyncOp[], hooks: ExecuteHooks = {}): Promise<ExecuteResult> {
  const { fs, remote, bak, deviceId, now } = deps
  const log = deps.log ?? (() => undefined)
  const describe = deps.describeError ?? defaultDescribe
  const concurrency = deps.concurrency ?? DEFAULT_EXECUTE_CONCURRENCY
  const signal = hooks.signal
  const transfer = { signal }
  const beforeLocalWrite = deps.beforeLocalWrite ?? (async () => undefined)

  async function upload(path: string, existingId: string | null, stashRemote: RemoteFile | null = null): Promise<Guarded<Completion>> {
    const stat = await fs.stat(path)
    if (stat === null) return { ok: false, reason: 'vanished locally during the sync' }
    let bytes: Uint8Array
    try {
      bytes = await fs.readBytes(path)
    } catch (err) {
      if (isFsNotFound(err)) return { ok: false, reason: 'vanished locally during the sync' }
      throw err
    }
    // A "keep local" answer overwrites a version that exists only on Drive (the other device may have moved
    // on): it is kept in this run's bak folder, like the local content a download replaces.
    if (stashRemote) await bak.stash(path, await remote.download(stashRemote.id, transfer))
    // Whatever is on disk now is uploaded (local wins); the pre-read stat is recorded so a file that
    // changed between stat and read is re-hashed by the next scan instead of trusted.
    const sha256 = await sha256Hex(bytes)
    const file = await remote.upload(path, bytes, { sha256, deviceId, modifiedTime: stat.mtimeMs }, existingId, transfer)
    return {
      ok: true,
      value: {
        path,
        entry: { sha256, size: stat.size, mtimeMs: stat.mtimeMs, driveId: file.id, driveModifiedTime: file.modifiedTime, syncedAt: now() },
        remote: file,
      },
    }
  }

  async function download(path: string, file: RemoteFile, expectLocal: LocalStat | null): Promise<Guarded<Completion>> {
    const bytes = await remote.download(file.id, transfer)
    const sha256 = await sha256Hex(bytes)
    if (file.sha256 !== null && sha256 !== file.sha256) {
      throw new Error(`${path} changed on Google Drive during the sync (content hash mismatch); it is planned again next run`)
    }
    await beforeLocalWrite(path)
    const current = await fs.stat(path)
    if (expectLocal) {
      if (!statMatches(current, expectLocal)) return { ok: false, reason: 'changed locally during the sync' }
      await bak.backupCopy(path)
    } else if (current !== null) {
      return { ok: false, reason: 'appeared locally during the sync' }
    }
    const stat = await writeFileAtomic(fs, path, bytes)
    return {
      ok: true,
      value: {
        path,
        entry: { sha256, size: stat.size, mtimeMs: stat.mtimeMs, driveId: file.id, driveModifiedTime: file.modifiedTime, syncedAt: now() },
        remote: { ...file, sha256, size: bytes.byteLength },
      },
    }
  }

  async function runOp(op: SyncOp): Promise<OpOutcome> {
    switch (op.kind) {
      case 'upload': {
        const r = await upload(op.path, op.existingId, op.stashRemote ?? null)
        return r.ok ? { kind: 'done', completions: [r.value] } : { kind: 'skipped', reason: r.reason, completions: [] }
      }
      case 'download': {
        const r = await download(op.path, op.remote, op.expectLocal)
        return r.ok ? { kind: 'done', completions: [r.value] } : { kind: 'skipped', reason: r.reason, completions: [] }
      }
      case 'delete-local': {
        await beforeLocalWrite(op.path)
        const current = await fs.stat(op.path)
        if (current === null) return { kind: 'done', completions: [{ path: op.path, entry: null, remote: null }] } // already gone
        if (!statMatches(current, op.expectLocal)) return { kind: 'skipped', reason: 'changed locally during the sync', completions: [] }
        await bak.moveIn(op.path)
        return { kind: 'done', completions: [{ path: op.path, entry: null, remote: null }] }
      }
      case 'delete-remote':
        await remote.trash(op.remote.id)
        return { kind: 'done', completions: [{ path: op.path, entry: null, remote: null }] }
      case 'trash-duplicate':
        await remote.trash(op.remote.id)
        return { kind: 'done', completions: [] } // the view never held it; nothing to record
      case 'update-base': {
        const { local, remote: file } = op
        const sha256 = local.sha256
        return {
          kind: 'done',
          completions: [
            {
              path: op.path,
              entry: { sha256, size: local.size, mtimeMs: local.mtimeMs, driveId: file.id, driveModifiedTime: file.modifiedTime, syncedAt: now() },
              remote: file.sha256 === null ? { ...file, sha256 } : file,
            },
          ],
        }
      }
      case 'drop-base':
        return { kind: 'done', completions: [{ path: op.path, entry: null, remote: null }] }
      case 'keep-both': {
        const expect: LocalStat = { size: op.local.size, mtimeMs: op.local.mtimeMs }
        await beforeLocalWrite(op.path)
        if (!statMatches(await fs.stat(op.path), expect)) return { kind: 'skipped', reason: 'changed locally during the sync', completions: [] }
        await fs.copyFile(op.path, op.copyPath)
        const completions: Completion[] = []
        try {
          const copy = await upload(op.copyPath, null)
          if (!copy.ok) return { kind: 'failed', message: `${op.copyPath}: ${copy.reason}`, completions }
          completions.push(copy.value)
          const original = await download(op.path, op.remote, expect)
          if (!original.ok) return { kind: 'skipped', reason: original.reason, completions }
          completions.push(original.value)
          return { kind: 'done', completions }
        } catch (err) {
          return { kind: 'failed', message: describe(err), completions }
        }
      }
    }
  }

  const queue = [...ops]
  const total = ops.length
  const result: ExecuteResult = {
    completions: [],
    failures: [],
    skipped: [],
    counts: { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, baseUpdated: 0, duplicatesTrashed: 0 },
    stoppedEarly: null,
  }
  let done = 0
  let consecutiveFailures = 0
  let stopped = false
  // An array, not a nullable variable: TS would narrow the latter to `null` across the closure assignments (see limit.ts).
  const hookErrors: unknown[] = []

  function count(op: SyncOp, outcome: OpOutcome): void {
    if (outcome.kind !== 'done') return
    const c = result.counts
    switch (op.kind) {
      case 'upload':
        c.uploaded++
        break
      case 'download':
        c.downloaded++
        break
      case 'delete-local':
        c.deletedLocal++
        break
      case 'delete-remote':
        c.deletedRemote++
        break
      case 'trash-duplicate':
        c.duplicatesTrashed++
        break
      case 'update-base':
      case 'drop-base':
        c.baseUpdated++
        break
      case 'keep-both':
        c.uploaded++
        c.downloaded++
        break
    }
  }

  async function worker(): Promise<void> {
    while (!stopped && queue.length > 0) {
      if (signal?.aborted) {
        stopped = true
        result.stoppedEarly = 'aborted'
        return
      }
      const op = queue.shift()!
      try {
        hooks.onOpStart?.(op, total)
      } catch (err) {
        stopped = true
        hookErrors.push(err)
        return
      }
      let outcome: OpOutcome
      try {
        outcome = await runOp(op)
      } catch (err) {
        outcome = { kind: 'failed', message: describe(err), completions: [] }
      }
      done++
      result.completions.push(...outcome.completions)
      count(op, outcome)
      if (outcome.kind === 'failed') {
        result.failures.push({ op, message: outcome.message })
        log(`${opLabel(op)} failed: ${outcome.message}`)
        consecutiveFailures++
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !stopped) {
          stopped = true
          result.stoppedEarly = 'too-many-failures'
        }
      } else {
        consecutiveFailures = 0
        if (outcome.kind === 'skipped') {
          result.skipped.push({ op, reason: outcome.reason })
          log(`${opLabel(op)} skipped: ${outcome.reason}`)
        }
      }
      try {
        await hooks.onOpDone?.(op, outcome, done, total)
      } catch (err) {
        stopped = true
        hookErrors.push(err)
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker))
  if (hookErrors.length > 0) throw hookErrors[0]
  return result
}
