import { describe, expect, it } from 'vitest'
import { createBakSession } from '../../src/fs/bak'
import { sha256Hex } from '../../src/fs/hash'
import { executePlan, type ExecutorDeps } from '../../src/sync/executor'
import type { LocalFile, SyncOp } from '../../src/sync/planner'
import type { RemoteFile } from '../../src/sync/remote'
import { jsonResponse, networkError } from '../google/helpers'
import { createWorld, T0, type Device, type World } from './world'

const enc = new TextEncoder()

async function localOf(d: Device, path: string): Promise<LocalFile> {
  const stat = (await d.graph.fs.stat(path))!
  return { path, sha256: await sha256Hex(await d.graph.fs.readBytes(path)), size: stat.size, mtimeMs: stat.mtimeMs }
}

function depsFor(w: World, d: Device, extra: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return { fs: d.graph.fs, remote: d.deps.remote, bak: createBakSession(d.graph.fs, new Date(T0)), deviceId: d.deviceId, now: w.clock.now, concurrency: 1, log: (l) => d.logs.push(l), ...extra }
}

/** Puts `content` on Drive at `path` through device `d`'s mirror and returns the RemoteFile. */
async function seedRemote(w: World, d: Device, path: string, content: string): Promise<RemoteFile> {
  return d.deps.remote.upload(path, enc.encode(content), { sha256: await sha256Hex(content), deviceId: 'seed', modifiedTime: w.clock.now() }, null)
}

describe('executePlan: one op of each kind', () => {
  it('upload → download → overwrite with bak → delete-local → delete-remote → update-base / drop-base', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', { 'pages/a.md': 'A1' })
    const B = w.addDevice('B')
    const shaA1 = await sha256Hex('A1')

    const up = await executePlan(depsFor(w, A), [{ kind: 'upload', path: 'pages/a.md', local: await localOf(A, 'pages/a.md'), existingId: null }])
    expect(up.counts).toMatchObject({ uploaded: 1 })
    expect(up.completions).toHaveLength(1)
    const c1 = up.completions[0]
    expect(c1.entry).toMatchObject({ sha256: shaA1, size: 2, driveId: c1.remote!.id })
    expect(c1.remote).toMatchObject({ path: 'pages/a.md', sha256: shaA1, size: 2 })
    expect(w.driveFiles().get('pages/a.md')).toBe('A1')

    const down = await executePlan(depsFor(w, B), [{ kind: 'download', path: 'pages/a.md', remote: c1.remote!, expectLocal: null }])
    expect(down.counts.downloaded).toBe(1)
    expect(B.read('pages/a.md')).toBe('A1')
    expect(down.completions[0].entry).toMatchObject({ sha256: shaA1, driveId: c1.remote!.id, driveModifiedTime: c1.remote!.modifiedTime })
    expect(B.bakFiles().size).toBe(0)

    // Overwrite: the previous content is copied to bak first; the stat guard must match.
    A.write('pages/a.md', 'A2')
    const localA2 = await localOf(A, 'pages/a.md')
    const rf2 = await seedRemote(w, A, 'pages/a.md', 'A2')
    const stale = await executePlan(depsFor(w, B), [{ kind: 'download', path: 'pages/a.md', remote: rf2, expectLocal: { size: 2, mtimeMs: 1 } }])
    expect(stale.skipped).toEqual([{ op: expect.objectContaining({ kind: 'download' }), reason: 'changed locally during the sync' }])
    expect(B.read('pages/a.md')).toBe('A1')
    const bLocal = await localOf(B, 'pages/a.md')
    const over = await executePlan(depsFor(w, B), [{ kind: 'download', path: 'pages/a.md', remote: rf2, expectLocal: { size: bLocal.size, mtimeMs: bLocal.mtimeMs } }])
    expect(over.counts.downloaded).toBe(1)
    expect(B.read('pages/a.md')).toBe('A2')
    expect([...B.bakFiles().entries()]).toEqual([['pages/a.md', 'A1']])
    expect(localA2.sha256).toBe(over.completions[0].entry!.sha256)

    // A download onto a path that appeared locally in the meantime is skipped too.
    B.write('pages/new.md', 'typed')
    const appeared = await executePlan(depsFor(w, B), [{ kind: 'download', path: 'pages/new.md', remote: { ...rf2, path: 'pages/new.md' }, expectLocal: null }])
    expect(appeared.skipped[0]?.reason).toBe('appeared locally during the sync')

    // delete-local: guard, move to bak, already-gone is fine.
    const bNow = await localOf(B, 'pages/a.md')
    const guarded = await executePlan(depsFor(w, B), [{ kind: 'delete-local', path: 'pages/a.md', expectLocal: { size: 99, mtimeMs: 99 } }])
    expect(guarded.skipped).toHaveLength(1)
    const moved = await executePlan(depsFor(w, B), [{ kind: 'delete-local', path: 'pages/a.md', expectLocal: { size: bNow.size, mtimeMs: bNow.mtimeMs } }])
    expect(moved.counts.deletedLocal).toBe(1)
    expect(moved.completions).toEqual([{ path: 'pages/a.md', entry: null, remote: null }])
    expect(B.has('pages/a.md')).toBe(false)
    expect(B.bakFiles().get('pages/a.md~1')).toBe('A2') // second copy of the same path in one session
    const gone = await executePlan(depsFor(w, B), [{ kind: 'delete-local', path: 'pages/a.md', expectLocal: { size: 0, mtimeMs: 0 } }])
    expect(gone.counts.deletedLocal).toBe(1)
    expect(gone.skipped).toEqual([])

    // delete-remote trashes; update-base and drop-base only record.
    const trashed = await executePlan(depsFor(w, A), [{ kind: 'delete-remote', path: 'pages/a.md', remote: rf2 }])
    expect(trashed.counts.deletedRemote).toBe(1)
    expect(w.drive.files.get(rf2.id)?.trashed).toBe(true)
    const records = await executePlan(depsFor(w, A), [
      { kind: 'update-base', path: 'pages/a.md', local: localA2, remote: { ...rf2, sha256: null } },
      { kind: 'drop-base', path: 'pages/zzz.md' },
    ])
    expect(records.counts.baseUpdated).toBe(2)
    expect(records.completions[0]).toEqual({ path: 'pages/a.md', entry: expect.objectContaining({ sha256: localA2.sha256, driveId: rf2.id }), remote: { ...rf2, sha256: localA2.sha256 } })
    expect(records.completions[1]).toEqual({ path: 'pages/zzz.md', entry: null, remote: null })
    expect(records.completions[0].entry!.syncedAt).toBeGreaterThan(T0)
  })

  it('keep-both copies the local version aside, uploads the copy and downloads the remote over the original', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', { 'pages/p.md': 'local' })
    const rf = await seedRemote(w, w.addDevice('B'), 'pages/p.md', 'remote')
    const local = await localOf(A, 'pages/p.md')
    const r = await executePlan(depsFor(w, A), [{ kind: 'keep-both', path: 'pages/p.md', copyPath: 'pages/p.conflict-A-20260915-1200.md', local, remote: rf }])
    expect(r.counts).toMatchObject({ uploaded: 1, downloaded: 1 })
    expect(r.completions.map((c) => c.path)).toEqual(['pages/p.conflict-A-20260915-1200.md', 'pages/p.md'])
    expect(A.files()).toEqual(new Map([['pages/p.conflict-A-20260915-1200.md', 'local'], ['pages/p.md', 'remote']]))
    expect(A.bakFiles().get('pages/p.md')).toBe('local')
    expect(w.driveFiles()).toEqual(new Map([['pages/p.conflict-A-20260915-1200.md', 'local'], ['pages/p.md', 'remote']]))

    // Guard: the original changed since the plan → nothing happens.
    A.write('pages/p.md', 'edited')
    const r2 = await executePlan(depsFor(w, A), [{ kind: 'keep-both', path: 'pages/p.md', copyPath: 'pages/p.conflict-A-20260915-1201.md', local, remote: rf }])
    expect(r2.skipped).toHaveLength(1)
    expect(A.has('pages/p.conflict-A-20260915-1201.md')).toBe(false)
  })

  it('fails a download whose bytes do not match the remote sha, leaving the local file alone', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', { 'pages/p.md': 'mine' })
    const rf = await seedRemote(w, w.addDevice('B'), 'pages/p.md', 'theirs')
    w.drive.files.get(rf.id)!.content = enc.encode('changed after planning')
    const local = await localOf(A, 'pages/p.md')
    const r = await executePlan(depsFor(w, A), [{ kind: 'download', path: 'pages/p.md', remote: rf, expectLocal: { size: local.size, mtimeMs: local.mtimeMs } }])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].message).toMatch(/hash mismatch/)
    expect(A.read('pages/p.md')).toBe('mine')
    expect(A.bakFiles().size).toBe(0)
  })
})

describe('executePlan: failures, breaker, abort, hooks, concurrency', () => {
  const uploads = (paths: string[], d: Device) => Promise.all(paths.map(async (p): Promise<SyncOp> => ({ kind: 'upload', path: p, local: await localOf(d, p), existingId: null })))

  it('records a failed op, resets the streak on success, and stops after three failures in a row', async () => {
    const w = await createWorld()
    const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`pages/${n}.md`, n]))
    const A = w.addDevice('A', files)
    const ops = await uploads(Object.keys(files), A)
    const isUpload = (c: { method: string; url: URL }) => c.method === 'POST' && c.url.pathname.startsWith('/upload/')

    // One op exhausts the transport's retries (6 attempts), the rest succeed.
    w.drive.failNext({ match: isUpload, answer: jsonResponse(500, { error: { code: 500, message: 'boom' } }), times: 6 })
    const one = await executePlan(depsFor(w, A), ops)
    expect(one.failures.map((f) => f.op.path)).toEqual(['pages/a.md'])
    expect(one.failures[0].message).toMatch(/HTTP 500/)
    expect(one.counts.uploaded).toBe(4)
    expect(one.stoppedEarly).toBeNull()

    // Three in a row trip the breaker; the remaining ops never start.
    const B = w.addDevice('B', files)
    const opsB = await uploads(Object.keys(files), B)
    w.drive.failNext({ match: isUpload, answer: networkError(), times: 9 }) // 3 attempts per request × 3 ops
    const started: string[] = []
    const broke = await executePlan(depsFor(w, B), opsB, { onOpStart: (op) => started.push(op.path) })
    expect(broke.failures).toHaveLength(3)
    expect(broke.stoppedEarly).toBe('too-many-failures')
    expect(started).toEqual(['pages/a.md', 'pages/b.md', 'pages/c.md'])
    expect(broke.counts.uploaded).toBe(0)
  })

  it('honours the abort signal between ops and persists what finished', async () => {
    const w = await createWorld()
    const files = Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [`pages/${n}.md`, n]))
    const A = w.addDevice('A', files)
    const ac = new AbortController()
    const r = await executePlan(depsFor(w, A), await uploads(Object.keys(files), A), {
      signal: ac.signal,
      onOpDone: (_op, _outcome, done) => {
        if (done === 2) ac.abort()
      },
    })
    expect(r.counts.uploaded).toBe(2)
    expect(r.stoppedEarly).toBe('aborted')
    expect(w.driveFiles().size).toBe(2)
  })

  it('a throwing hook stops scheduling, lets in-flight ops finish, and rethrows', async () => {
    const w = await createWorld()
    const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => [`pages/${n}.md`, n]))
    const A = w.addDevice('A', files)
    const started: string[] = []
    const boom = new Error('crash')
    await expect(
      executePlan(depsFor(w, A, { concurrency: 2 }), await uploads(Object.keys(files), A), {
        onOpStart: (op) => started.push(op.path),
        onOpDone: () => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)
    expect(started.length).toBeLessThanOrEqual(2)
    expect(w.driveFiles().size).toBe(started.length) // whatever started also finished on Drive

    // Nothing else runs afterwards.
    const before = w.drive.calls.length
    await new Promise((r) => setTimeout(r, 5))
    expect(w.drive.calls.length).toBe(before)
  })

  it('runs at most `concurrency` ops at once', async () => {
    const w = await createWorld()
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`pages/${i}.md`, `${i}`]))
    const A = w.addDevice('A', files)
    let inFlight = 0
    let peak = 0
    const r = await executePlan(depsFor(w, A, { concurrency: 3 }), await uploads(Object.keys(files), A), {
      onOpStart: () => {
        inFlight++
        peak = Math.max(peak, inFlight)
      },
      onOpDone: () => {
        inFlight--
      },
    })
    expect(r.counts.uploaded).toBe(10)
    expect(peak).toBe(3)
    expect(w.driveFiles().size).toBe(10)
  })
})
