import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../../src/fs/hash'
import { PROP_DEVICE_ID, PROP_REL_PATH, PROP_SHA256 } from '../../src/google/mirror'
import { journalKey, parseJournal } from '../../src/sync/state'
import { jsonResponse, networkError } from '../google/helpers'
import { SimulatedCrash, createWorld, crashAtExecuteEvent, resolveAll, resolveNever, resolveWith, shaOf, type Device, type World } from './world'

const INITIAL = {
  'pages/Alpha.md': 'alpha v1',
  'pages/Beta.md': 'beta v1',
  'journals/2026_09_15.md': 'journal v1',
  'logseq/config.edn': '{}',
  'logseq/bak/pages/x.md': 'never synced',
  'logseq/graphs-txid.edn': 'never synced either',
  '.DS_Store': 'junk',
}
const SYNCED = ['journals/2026_09_15.md', 'logseq/config.edn', 'pages/Alpha.md', 'pages/Beta.md']

/** A's synced files: what B and Drive must mirror (A also holds the ignored files). */
function synced(d: Device): Map<string, string> {
  return new Map([...d.files()].filter(([p]) => !p.startsWith('logseq/bak/') && p !== 'logseq/graphs-txid.edn' && p !== '.DS_Store'))
}

/** Two devices that both hold the initial graph, synced and quiet. */
async function pair(): Promise<{ w: World; A: Device; B: Device }> {
  const w = await createWorld()
  const A = w.addDevice('A', INITIAL)
  const B = w.addDevice('B')
  await A.sync()
  await B.sync()
  return { w, A, B }
}

const noOps = { planned: 0, conflicts: 0, failures: [], skippedOps: [], stoppedEarly: null }

describe('runSync: first runs (plan M7 step 2 modes, engine side)', () => {
  it('local → Drive: uploads the synced scope, records entries, remote view and token; a second run is a no-op', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    const r1 = await A.sync()
    expect(r1).toMatchObject({ delta: 'full', uploaded: 4, downloaded: 0, planned: 4, unchanged: 0, conflicts: 0, failures: [], stoppedEarly: null, recovered: false, tempFilesMoved: 0, remoteFiles: 4 })
    expect(r1.scan).toEqual({ files: 4, hashed: 4, reused: 0, ignored: 3, vanished: 0 })
    expect(w.driveFiles()).toEqual(synced(A))
    expect([...w.driveFiles().keys()].sort()).toEqual(SYNCED)

    const s = await A.state()
    expect(Object.keys(s.entries).sort()).toEqual(SYNCED)
    expect(Object.keys(s.remote).sort()).toEqual(SYNCED)
    // The token was taken before the uploads, so the next delta re-reports them (harmlessly, same state).
    expect(s.changesPageToken).toMatch(/^\d+$/)
    expect(Number(s.changesPageToken)).toBeLessThan(Number(w.drive.nextStartToken()))
    expect(s.lastSyncAt).toBeGreaterThan(r1.startedAt)
    for (const p of SYNCED) {
      const f = w.driveFile(p)!
      expect(s.entries[p]).toMatchObject({ sha256: await shaOf(A.read(p)), driveId: f.id, driveModifiedTime: f.modifiedTime, size: A.read(p).length })
      expect(s.remote[p]).toMatchObject({ id: f.id, sha256: s.entries[p].sha256 })
    }
    expect(w.driveFile('pages/Alpha.md')!.appProperties).toEqual({ [PROP_SHA256]: await shaOf('alpha v1'), [PROP_REL_PATH]: 'pages/Alpha.md', [PROP_DEVICE_ID]: 'dev-A' })
    expect(w.driveFile('pages/Alpha.md')!.modifiedTime).toBe((await A.graph.fs.stat('pages/Alpha.md'))!.mtimeMs)

    const uploadsBefore = w.drive.callsMatching(/^(POST|PATCH) \/upload\//).length
    const r2 = await A.sync()
    expect(r2).toMatchObject({ ...noOps, delta: 'changes', unchanged: 4 })
    expect(r2.scan).toMatchObject({ hashed: 0, reused: 4 })
    expect(w.drive.callsMatching(/^(POST|PATCH) \/upload\//).length).toBe(uploadsBefore)
    expect(A.storage.files.get(journalKey(w.graphKey))).toBe('null') // cleared by the first run; the no-op run wrote none
  })

  it('Drive → local: a new device downloads everything, without bak copies', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    await A.sync()
    const B = w.addDevice('B')
    const r = await B.sync()
    expect(r).toMatchObject({ delta: 'full', downloaded: 4, uploaded: 0, planned: 4 })
    expect(B.files()).toEqual(synced(A))
    expect(B.bakFiles().size).toBe(0)
    const s = await B.state()
    expect(Object.keys(s.entries).sort()).toEqual(SYNCED)
    expect(s.entries['pages/Alpha.md'].mtimeMs).toBe((await B.graph.fs.stat('pages/Alpha.md'))!.mtimeMs)
    expect(await B.sync()).toMatchObject({ ...noOps, unchanged: 4 })
  })

  it('both non-empty: identical files record the base, different ones conflict, the rest merges', async () => {
    const w = await createWorld()
    const A = w.addDevice('A', INITIAL)
    await A.sync()
    const B = w.addDevice('B', { 'pages/Alpha.md': 'alpha v1', 'pages/Beta.md': 'beta from B', 'pages/OnlyB.md': 'only b' })
    const r = await B.sync()
    expect(r).toMatchObject({ baseUpdated: 1, downloaded: 2, uploaded: 1, conflicts: 1, conflictsSkipped: 1, conflictsResolved: 0 })
    expect(B.read('pages/Beta.md')).toBe('beta from B')
    expect(w.driveFiles().get('pages/Beta.md')).toBe('beta v1')
    expect(w.driveFiles().get('pages/OnlyB.md')).toBe('only b')
    const r2 = await B.sync({ resolveConflicts: resolveAll('keep-remote') })
    expect(r2).toMatchObject({ conflicts: 1, conflictsResolved: 1, downloaded: 1 })
    expect(B.files()).toEqual(w.driveFiles())
    expect(B.bakFiles().get('pages/Beta.md')).toBe('beta from B')
  })
})

describe('runSync: propagation and deletes', () => {
  it('edits, adds and deletes flow A → Drive → B; deletes become bak moves and Drive trash', async () => {
    const { w, A, B } = await pair()
    A.write('pages/Alpha.md', 'alpha v2')
    A.write('pages/Gamma.md', 'gamma')
    A.remove('pages/Beta.md')
    const beta = w.driveFile('pages/Beta.md')!
    const rA = await A.sync()
    expect(rA).toMatchObject({ uploaded: 2, deletedRemote: 1, planned: 3, unchanged: 2 })
    expect(w.drive.files.get(beta.id)?.trashed).toBe(true)
    expect(w.driveFiles().has('pages/Beta.md')).toBe(false)

    const rB = await B.sync()
    expect(rB).toMatchObject({ downloaded: 2, deletedLocal: 1, planned: 3, delta: 'changes' })
    expect(B.files()).toEqual(synced(A))
    expect(B.bakFiles()).toEqual(new Map([['pages/Alpha.md', 'alpha v1'], ['pages/Beta.md', 'beta v1']]))
    expect(Object.keys((await B.state()).entries).sort()).toEqual(['journals/2026_09_15.md', 'logseq/config.edn', 'pages/Alpha.md', 'pages/Gamma.md'])
    expect(await A.sync()).toMatchObject(noOps)
    expect(await B.sync()).toMatchObject(noOps)
  })

  it('deleted on both sides drops the entry; the same file added on both sides is recorded, not transferred', async () => {
    const { w, A, B } = await pair()
    A.remove('journals/2026_09_15.md')
    B.remove('journals/2026_09_15.md')
    A.write('pages/Same.md', 'same on both')
    B.write('pages/Same.md', 'same on both')
    expect(await A.sync()).toMatchObject({ deletedRemote: 1, uploaded: 1 })
    const rB = await B.sync()
    expect(rB).toMatchObject({ baseUpdated: 2, uploaded: 0, downloaded: 0, deletedLocal: 0 })
    expect(w.driveFilesByPath().get('pages/Same.md')).toHaveLength(1)
    expect(B.files()).toEqual(synced(A))
    expect(B.bakFiles().size).toBe(0)
    const s = await B.state()
    expect(s.entries['journals/2026_09_15.md']).toBeUndefined()
    expect(s.entries['pages/Same.md'].driveId).toBe(w.driveFile('pages/Same.md')!.id)
  })

  it('ignored paths never reach Drive and an ignored path on Drive is never downloaded', async () => {
    const { w, A, B } = await pair()
    expect(w.driveFiles().has('.DS_Store')).toBe(false)
    expect(w.driveFiles().has('logseq/graphs-txid.edn')).toBe(false)
    // Something else put an ignored path into the mirror (say an older plugin version).
    const logseqDir = w.drive.childrenOf(w.graphFolderId).find((f) => f.name === 'logseq')!
    w.drive.addFile(logseqDir.id, 'pages-metadata.edn', 'cache')
    const r = await B.sync()
    expect(r).toMatchObject({ ...noOps, remoteFiles: 4 })
    expect(B.has('logseq/pages-metadata.edn')).toBe(false)
    expect(A.has('logseq/pages-metadata.edn')).toBe(false)
  })
})

describe('runSync: conflicts (D7)', () => {
  it('a skipped conflict comes back on the next run from the persisted remote view, with the token advanced', async () => {
    const { w, A, B } = await pair()
    A.write('pages/Alpha.md', 'A2')
    B.write('pages/Alpha.md', 'B2')
    await A.sync()
    const tokenBefore = (await B.state()).changesPageToken
    const r1 = await B.sync()
    expect(r1).toMatchObject({ conflicts: 1, conflictsSkipped: 1, conflictsResolved: 0, planned: 0, delta: 'changes' })
    expect(B.read('pages/Alpha.md')).toBe('B2')
    const s1 = await B.state()
    expect(s1.changesPageToken).not.toBe(tokenBefore)
    expect(s1.changesPageToken).toBe(w.drive.nextStartToken())
    expect(s1.remote['pages/Alpha.md'].sha256).toBe(await shaOf('A2'))
    expect(s1.entries['pages/Alpha.md'].sha256).toBe(await shaOf('alpha v1'))

    const changesBefore = w.drive.callsMatching(/^GET \/drive\/v3\/changes\?/).length
    const r2 = await B.sync()
    expect(r2).toMatchObject({ conflicts: 1, conflictsSkipped: 1, planned: 0 })
    expect(w.drive.callsMatching(/^GET \/drive\/v3\/changes\?/).length).toBe(changesBefore + 1) // one (empty) delta, no full listing
    expect(B.logs.some((l) => l.includes('left undecided'))).toBe(true)

    const r3 = await B.sync({ resolveConflicts: resolveAll('keep-remote') })
    expect(r3).toMatchObject({ conflicts: 1, conflictsResolved: 1, downloaded: 1, planned: 1 })
    expect(B.read('pages/Alpha.md')).toBe('A2')
    expect(B.bakFiles().get('pages/Alpha.md')).toBe('B2')
    expect(await B.sync()).toMatchObject(noOps)
  })

  it('keep-local uploads over the remote version; the other device then downloads it with a bak copy', async () => {
    const { w, A, B } = await pair()
    A.write('pages/Alpha.md', 'A3')
    B.write('pages/Alpha.md', 'B3')
    await A.sync()
    const r = await B.sync({ resolveConflicts: resolveAll('keep-local') })
    expect(r).toMatchObject({ conflictsResolved: 1, uploaded: 1 })
    expect(w.driveFiles().get('pages/Alpha.md')).toBe('B3')
    expect(w.driveFilesByPath().get('pages/Alpha.md')).toHaveLength(1) // updated in place
    expect(B.bakFiles().get('pages/Alpha.md')).toBe('A3') // the remote version it overwrote, stashed on the deciding device
    expect(await A.sync()).toMatchObject({ downloaded: 1 })
    expect(A.read('pages/Alpha.md')).toBe('B3')
    expect(A.bakFiles().get('pages/Alpha.md')).toBe('A3')
  })

  it('keep-both keeps the local version as a conflict copy and converges both devices on two files', async () => {
    const { w, A, B } = await pair()
    A.write('pages/Alpha.md', 'A4')
    B.write('pages/Alpha.md', 'B4')
    await A.sync()
    const r = await B.sync({ resolveConflicts: resolveAll('keep-both') })
    expect(r).toMatchObject({ conflictsResolved: 1, uploaded: 1, downloaded: 1 })
    const copy = [...B.files().keys()].find((p) => p.startsWith('pages/Alpha.conflict-'))!
    expect(copy).toMatch(/^pages\/Alpha\.conflict-B-\d{8}-\d{4}\.md$/)
    expect(B.read(copy)).toBe('B4')
    expect(B.read('pages/Alpha.md')).toBe('A4')
    expect(B.bakFiles().get('pages/Alpha.md')).toBe('B4')
    expect(w.driveFiles().get(copy)).toBe('B4')
    expect(await A.sync()).toMatchObject({ downloaded: 1 })
    expect(A.read(copy)).toBe('B4')
    expect(synced(A)).toEqual(B.files())
    expect(await B.sync()).toMatchObject(noOps)
  })

  it('delete conflicts: local-deleted keep-local trashes, remote-deleted keep-local re-creates, keep-remote on remote-deleted moves to bak', async () => {
    const { w, A, B } = await pair()
    // Beta: A modifies, B deletes → B sees local-deleted.
    A.write('pages/Beta.md', 'beta v2')
    B.remove('pages/Beta.md')
    // journal: A deletes, B modifies → B sees remote-deleted.
    A.remove('journals/2026_09_15.md')
    B.write('journals/2026_09_15.md', 'journal v2')
    // config: A deletes, B modifies → B will pick keep-remote (= delete locally).
    A.remove('logseq/config.edn')
    B.write('logseq/config.edn', '{:new true}')
    expect(await A.sync()).toMatchObject({ uploaded: 1, deletedRemote: 2 })
    const oldJournalId = (await B.state()).entries['journals/2026_09_15.md'].driveId

    const skipped = await B.sync()
    expect(skipped).toMatchObject({ conflicts: 3, conflictsSkipped: 3, planned: 0 })
    const r = await B.sync({ resolveConflicts: resolveWith({ 'pages/Beta.md': 'keep-local', 'journals/2026_09_15.md': 'keep-local', 'logseq/config.edn': 'keep-remote' }) })
    expect(r).toMatchObject({ conflictsResolved: 3, deletedRemote: 1, uploaded: 1, deletedLocal: 1 })
    expect(w.driveFiles().has('pages/Beta.md')).toBe(false)
    expect(w.driveFiles().get('journals/2026_09_15.md')).toBe('journal v2')
    expect(w.driveFile('journals/2026_09_15.md')!.id).not.toBe(oldJournalId)
    expect(B.has('logseq/config.edn')).toBe(false)
    expect(B.bakFiles().get('logseq/config.edn')).toBe('{:new true}')

    expect(await A.sync()).toMatchObject({ deletedLocal: 1, downloaded: 1 })
    expect(A.bakFiles().get('pages/Beta.md')).toBe('beta v2')
    expect(synced(A)).toEqual(B.files())
    expect(await A.sync()).toMatchObject(noOps)
    expect(await B.sync()).toMatchObject(noOps)
  })

  it('a resolution for a path the dialog was not asked about is ignored, and keep-both is normalised on a delete conflict', async () => {
    const { w, A, B } = await pair()
    A.write('pages/Beta.md', 'beta v2')
    B.remove('pages/Beta.md')
    await A.sync()
    const r = await B.sync({ resolveConflicts: async () => [{ path: 'pages/Beta.md', choice: 'keep-both' }, { path: 'pages/Alpha.md', choice: 'keep-local' }] })
    expect(r).toMatchObject({ conflictsResolved: 1, downloaded: 1, uploaded: 0 }) // keep-both → keep-remote (the side with content)
    expect(B.read('pages/Beta.md')).toBe('beta v2')
    expect(w.driveFiles().get('pages/Alpha.md')).toBe('alpha v1')
  })
})

describe('runSync: interruption and recovery (M6 step 4)', () => {
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`pages/p${i}.md`, `content ${i}`]))

  it('a crash after journaled ops: the next run folds them in, uploads the rest, and Drive has no duplicates', async () => {
    const w = await createWorld({ concurrency: 1 })
    const A = w.addDevice('A', files)
    A.deps.journalFlush = { ops: 1, ms: 0 }
    // Events with concurrency 1: start p0, done p0, start p1, done p1, start p2, done p2 (6th) → crash with 3 ops journaled.
    await expect(A.sync({ onProgress: crashAtExecuteEvent(6) })).rejects.toBeInstanceOf(SimulatedCrash)
    const journal = parseJournal(A.storage.files.get(journalKey(w.graphKey)))!
    expect(Object.keys(journal.done)).toEqual(['upload:pages/p0.md', 'upload:pages/p1.md', 'upload:pages/p2.md'])
    expect(journal.ops).toHaveLength(8)
    expect(w.driveFiles().size).toBe(3)
    expect((await A.state()).changesPageToken).toBeNull() // the crashed run never got to persist

    const r = await A.sync()
    expect(r).toMatchObject({ recovered: true, delta: 'full', uploaded: 5, baseUpdated: 0, unchanged: 3, planned: 5, failures: [] })
    expect(A.logs.some((l) => l.includes('recovered the interrupted run') && l.includes('3 completed'))).toBe(true)
    expect(w.driveFiles()).toEqual(A.files())
    for (const [, dupes] of w.driveFilesByPath()) expect(dupes).toHaveLength(1)
    expect(A.storage.files.get(journalKey(w.graphKey))).toBe('null')
    expect(await A.sync()).toMatchObject({ ...noOps, recovered: false, unchanged: 8 })
  })

  it('a crash before the journal was flushed: the re-plan sees L = R for the finished uploads and records them', async () => {
    const w = await createWorld({ concurrency: 1 })
    const A = w.addDevice('A', files)
    await expect(A.sync({ onProgress: crashAtExecuteEvent(6) })).rejects.toBeInstanceOf(SimulatedCrash)
    expect(Object.keys(parseJournal(A.storage.files.get(journalKey(w.graphKey)))!.done)).toEqual([])
    const r = await A.sync()
    expect(r).toMatchObject({ recovered: true, uploaded: 5, baseUpdated: 3, planned: 8 })
    expect(w.driveFiles()).toEqual(A.files())
    for (const [, dupes] of w.driveFilesByPath()) expect(dupes).toHaveLength(1)
  })

  it('a crash after the conflict dialog replays the answer instead of asking again', async () => {
    const { w, A, B } = await pair()
    A.write('pages/Alpha.md', 'A5')
    B.write('pages/Alpha.md', 'B5')
    await A.sync()
    await expect(B.sync({ resolveConflicts: resolveAll('keep-local'), onProgress: crashAtExecuteEvent(1) })).rejects.toBeInstanceOf(SimulatedCrash)
    const journal = parseJournal(B.storage.files.get(journalKey(w.graphKey)))!
    expect(journal.resolutions).toEqual([{ path: 'pages/Alpha.md', choice: 'keep-local', localSha: await shaOf('B5'), remoteSha: await shaOf('A5') }])
    expect(w.driveFiles().get('pages/Alpha.md')).toBe('A5')

    const r = await B.sync({ resolveConflicts: resolveNever() })
    expect(r).toMatchObject({ recovered: true, conflicts: 1, conflictsReplayed: 1, conflictsResolved: 1, uploaded: 1 })
    expect(w.driveFiles().get('pages/Alpha.md')).toBe('B5')

    // The remembered answer is not applied to a different conflict on the same path.
    A.write('pages/Alpha.md', 'A6')
    B.write('pages/Alpha.md', 'B6')
    expect(await A.sync({ resolveConflicts: resolveAll('keep-local') })).toMatchObject({ conflicts: 1, uploaded: 1 }) // A's own conflict: B5 had landed meanwhile
    expect(A.bakFiles().get('pages/Alpha.md')).toBe('B5') // the overwritten remote version is stashed
    await expect(B.sync({ resolveConflicts: resolveAll('keep-remote'), onProgress: crashAtExecuteEvent(1) })).rejects.toBeInstanceOf(SimulatedCrash)
    expect(parseJournal(B.storage.files.get(journalKey(w.graphKey)))!.resolutions[0]).toMatchObject({ choice: 'keep-remote', localSha: await shaOf('B6') })
    B.write('pages/Alpha.md', 'B7') // the user edits again before the retry
    let asked = 0
    const r2 = await B.sync({
      resolveConflicts: async (items) => {
        asked += items.length
        return items.map((i) => ({ path: i.path, choice: 'keep-local' as const }))
      },
    })
    expect(asked).toBe(1)
    expect(r2).toMatchObject({ conflictsReplayed: 0, conflictsResolved: 1, uploaded: 1 })
    expect(w.driveFiles().get('pages/Alpha.md')).toBe('B7')
  })

  it('a leftover temp file from a crashed download is moved to bak before the scan', async () => {
    const { A } = await pair()
    A.write('pages/.Alpha.md.gdsync-tmp', 'half written')
    const r = await A.sync()
    expect(r).toMatchObject({ ...noOps, tempFilesMoved: 1 })
    expect(A.has('pages/.Alpha.md.gdsync-tmp')).toBe(false)
    expect(A.bakFiles().get('pages/.Alpha.md.gdsync-tmp')).toBe('half written')
  })

  it('an aborted run persists its token and finished ops; the next run does the rest', async () => {
    const w = await createWorld({ concurrency: 1 })
    const A = w.addDevice('A', files)
    const ac = new AbortController()
    const r = await A.sync({
      signal: ac.signal,
      onProgress: (p) => {
        if (p.step === 'execute' && p.done === 2) ac.abort()
      },
    })
    expect(r).toMatchObject({ stoppedEarly: 'aborted', uploaded: 2, planned: 8 })
    const s = await A.state()
    expect(s.changesPageToken).not.toBeNull()
    expect(Object.keys(s.entries)).toHaveLength(2)
    expect(A.storage.files.get(journalKey(w.graphKey))).toBe('null')
    expect(await A.sync()).toMatchObject({ uploaded: 6, planned: 6, unchanged: 2, recovered: false })
    expect(w.driveFiles()).toEqual(A.files())
  })
})

describe('runSync: faults and races', () => {
  it('transient 5xx and network errors are absorbed by the transport', async () => {
    const { w, A, B } = await pair()
    A.write('pages/Alpha.md', 'A7')
    w.drive.failNext({ match: () => true, answer: jsonResponse(503, { error: { code: 503, message: 'backend' } }), times: 2 })
    w.drive.failNext({ match: (c) => c.url.pathname.startsWith('/upload/'), answer: networkError(), times: 1 })
    expect(await A.sync()).toMatchObject({ uploaded: 1, failures: [] })
    w.drive.failNext({ match: (c) => c.url.searchParams.get('alt') === 'media', answer: jsonResponse(500, { error: { code: 500, message: 'x' } }), times: 3 })
    expect(await B.sync()).toMatchObject({ downloaded: 1, failures: [] })
    expect(B.read('pages/Alpha.md')).toBe('A7')
  })

  it('a persistently failing upload is reported and done on the next run; the others go through', async () => {
    const w = await createWorld({ concurrency: 1 })
    const A = w.addDevice('A', { 'pages/a.md': 'a', 'pages/b.md': 'b', 'pages/c.md': 'c' })
    const decoder = new TextDecoder()
    w.drive.failNext({ match: (c) => c.url.pathname.startsWith('/upload/') && decoder.decode(c.body ?? new Uint8Array()).includes('"name":"b.md"'), answer: jsonResponse(500, { error: { code: 500, message: 'quota' } }), times: 6 })
    const r = await A.sync()
    expect(r.failures.map((f) => f.op.path)).toEqual(['pages/b.md'])
    expect(r).toMatchObject({ uploaded: 2, stoppedEarly: null })
    expect(w.driveFiles().has('pages/b.md')).toBe(false)
    const s = await A.state()
    expect(Object.keys(s.entries).sort()).toEqual(['pages/a.md', 'pages/c.md'])
    expect(await A.sync()).toMatchObject({ uploaded: 1, failures: [] })
    expect(w.driveFiles()).toEqual(A.files())
  })

  it('a create whose response was lost leaves a duplicate on Drive; both devices settle on the oldest copy', async () => {
    const { w, A, B } = await pair()
    A.write('pages/Dup.md', 'dup')
    w.drive.failNext({ match: (c) => c.method === 'POST' && c.url.pathname.startsWith('/upload/'), answer: networkError(), after: true })
    expect(await A.sync()).toMatchObject({ uploaded: 1, failures: [] })
    const dupes = w.driveFilesByPath().get('pages/Dup.md')!
    expect(dupes).toHaveLength(2)
    expect(new Set(dupes.map((f) => new TextDecoder().decode(f.content)))).toEqual(new Set(['dup']))
    const oldest = [...dupes].sort((x, y) => x.createdTime - y.createdTime)[0]
    expect((await A.state()).entries['pages/Dup.md'].driveId).not.toBe(oldest.id) // the retry's answer was the one heard
    expect(await A.sync()).toMatchObject({ baseUpdated: 1, duplicatesTrashed: 1, planned: 2 })
    expect((await A.state()).entries['pages/Dup.md'].driveId).toBe(oldest.id)
    expect(w.driveFilesByPath().get('pages/Dup.md')).toHaveLength(1)
    expect(w.drive.files.get(dupes.find((f) => f.id !== oldest.id)!.id)?.trashed).toBe(true)
    expect(await B.sync()).toMatchObject({ downloaded: 1, duplicatesTrashed: 0 })
    expect((await B.state()).entries['pages/Dup.md'].driveId).toBe(oldest.id)
    expect(await A.sync()).toMatchObject(noOps)
  })

  it('a folder created by the other device forces a full listing; a plain file change stays incremental; a restart keeps state', async () => {
    const { w, A, B } = await pair()
    A.write('draws/sketch.excalidraw', '{}')
    await A.sync()
    const B2 = w.restart(B)
    expect(await B2.sync()).toMatchObject({ delta: 'full', downloaded: 1 })
    A.write('draws/sketch.excalidraw', '{"v":2}')
    await A.sync()
    expect(await B2.sync()).toMatchObject({ delta: 'changes', downloaded: 1 })
    expect(B2.files()).toEqual(synced(A))
  })

  it('a file the user edits while the sync runs is not overwritten; it becomes a conflict next time', async () => {
    const { w, A, B } = await pair()
    A.write('pages/Alpha.md', 'A8')
    await A.sync()
    let edited = false
    const r = await B.sync({
      onProgress: (p) => {
        if (p.step === 'execute' && p.label === 'Downloading pages/Alpha.md' && !edited) {
          edited = true
          B.write('pages/Alpha.md', 'typed meanwhile')
        }
      },
    })
    expect(r.skippedOps.map((s) => [s.op.path, s.reason])).toEqual([['pages/Alpha.md', 'changed locally during the sync']])
    expect(r.downloaded).toBe(0)
    expect(B.read('pages/Alpha.md')).toBe('typed meanwhile')
    expect(B.bakFiles().size).toBe(0)
    expect(await B.sync()).toMatchObject({ conflicts: 1, conflictsSkipped: 1 })
    expect(w.driveFiles().get('pages/Alpha.md')).toBe('A8')
  })

  it('binary content above the multipart limit goes resumable and round-trips byte for byte', async () => {
    const w = await createWorld({ clientOverrides: { multipartMaxBytes: 64 * 1024, chunkBytes: 256 * 1024 } })
    const big = new Uint8Array(600 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff
    const A = w.addDevice('A', { 'assets/big.bin': big, 'pages/small.md': 'small' })
    expect(await A.sync()).toMatchObject({ uploaded: 2 })
    expect(w.drive.callsMatching(/uploadType=resumable/).length).toBeGreaterThan(0)
    expect(w.drive.callsMatching(/upload_id=/).length).toBeGreaterThanOrEqual(3) // 600 KB in 256 KiB chunks
    const B = w.addDevice('B')
    expect(await B.sync()).toMatchObject({ downloaded: 2 })
    const bytes = B.graph.host.files.get(`${B.graph.root}/assets/big.bin`)!.bytes
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(big))
    expect((await B.state()).entries['assets/big.bin']).toMatchObject({ size: big.length, sha256: await sha256Hex(big) })
  })

  it('reports progress through every step', async () => {
    const w = await createWorld({ concurrency: 1 })
    const A = w.addDevice('A', { 'pages/a.md': 'a', 'pages/b.md': 'b' })
    const steps: string[] = []
    const labels: string[] = []
    await A.sync({
      onProgress: (p) => {
        if (steps.at(-1) !== p.step) steps.push(p.step)
        if (p.step === 'execute') labels.push(`${p.label} ${p.done}/${p.total}`)
      },
    })
    expect(steps).toEqual(['scan', 'remote', 'plan', 'execute', 'finish'])
    expect(labels).toEqual(['Uploading pages/a.md 0/2', 'Uploading pages/a.md 1/2', 'Uploading pages/b.md 1/2', 'Uploading pages/b.md 2/2'])
  })
})
