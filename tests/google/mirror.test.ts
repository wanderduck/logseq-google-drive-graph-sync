import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../../src/fs/hash'
import { createDriveClient } from '../../src/google/drive'
import { LOCK_DIR, LOCK_FILE } from '../../src/google/lock'
import { PROP_DEVICE_ID, PROP_REL_PATH, PROP_SHA256, createDriveMirror, toRemoteFile } from '../../src/google/mirror'
import type { RemoteDelta } from '../../src/sync/remote'
import { createFakeDrive } from './fakeDrive'

const T0 = 1_700_000_000_000
const SHA_A = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' // sha256("a")

function world() {
  let t = T0
  const fake = createFakeDrive({ now: () => ++t })
  const graph = fake.addFolder('root', 'g')
  const logs: string[] = []
  const client = createDriveClient({ fetch: fake.fetch, log: (l) => logs.push(l) })
  const mirror = createDriveMirror({ client, graphFolderId: graph.id, log: (l) => logs.push(l) })
  /** A second device's client: its folder creations are unknown to `client`'s cache. */
  const other = createDriveClient({ fetch: fake.fetch })
  return { fake, graph, client, mirror, other, logs }
}

function changes(delta: RemoteDelta) {
  if (delta.kind !== 'changes') throw new Error(`expected a changes delta, got ${delta.kind}`)
  return { changed: delta.changed.map((f) => [f.path, f.id, f.sha256] as const).sort(), removedIds: [...delta.removedIds].sort(), token: delta.token }
}

describe('createDriveMirror.fetchDelta', () => {
  it('lists the whole graph folder on the first sync: files by path, no folders, no .gdsync, no trashed, sha only when valid', async () => {
    const w = world()
    const pages = w.fake.addFolder(w.graph.id, 'pages')
    const a = w.fake.addFile(pages.id, 'a.md', 'a', { appProperties: { [PROP_SHA256]: SHA_A } })
    const assets = w.fake.addFolder(w.graph.id, 'assets')
    const x = w.fake.addFile(assets.id, 'x.png', 'xx', { appProperties: { [PROP_SHA256]: 'not-a-hash' } })
    w.fake.addFile(pages.id, 'gone.md', 'g', { trashed: true })
    w.fake.addFolder(w.graph.id, 'draws')
    const lockDir = w.fake.addFolder(w.graph.id, LOCK_DIR)
    w.fake.addFile(lockDir.id, LOCK_FILE, '{}')
    w.fake.addFile('root', 'outside.md', 'o')
    const tokenBefore = w.fake.nextStartToken()

    const delta = await w.mirror.fetchDelta(null)
    expect(delta.kind).toBe('full')
    if (delta.kind !== 'full') return
    expect(delta.token).toBe(tokenBefore)
    expect(delta.files.map((f) => f.path).sort()).toEqual(['assets/x.png', 'pages/a.md'])
    expect(delta.files.find((f) => f.path === 'pages/a.md')).toEqual({ path: 'pages/a.md', id: a.id, sha256: SHA_A, size: 1, modifiedTime: a.modifiedTime, createdTime: a.createdTime, md5: expect.any(String) })
    expect(delta.files.find((f) => f.path === 'assets/x.png')).toMatchObject({ id: x.id, sha256: null, size: 2 })
    expect(w.client.folders.get(w.graph.id, 'pages')).toBe(pages.id) // the listing seeds the cache
  })

  it('turns the changes feed into current states and removals, resolving paths from parents and skipping the lock', async () => {
    const w = world()
    const pages = w.fake.addFolder(w.graph.id, 'pages')
    const a = w.fake.addFile(pages.id, 'a.md', 'a', { appProperties: { [PROP_SHA256]: SHA_A } })
    const b = w.fake.addFile(pages.id, 'b.md', 'b')
    const c = w.fake.addFile(pages.id, 'c.md', 'c')
    const first = await w.mirror.fetchDelta(null)
    expect(first.kind).toBe('full')

    const sha2 = await sha256Hex('a2')
    await w.other.updateFile(a.id, 'a2', { appProperties: { [PROP_SHA256]: sha2 } })
    await w.other.trash(b.id)
    await w.other.deleteForever(c.id)
    const d = await w.other.createFile('d', { name: 'd.md', parentId: pages.id, appProperties: { [PROP_SHA256]: SHA_A } })
    const lockDirId = await w.other.ensureFolder(w.graph.id, LOCK_DIR)
    await w.other.createFile('{}', { name: LOCK_FILE, parentId: lockDirId })
    // Visible to the app but outside the graph folder: "not under the graph" reads as removed (the engine ignores unknown ids).
    const elsewhere = w.fake.addFile('root', 'elsewhere.md', 'e')

    const delta = await w.mirror.fetchDelta(first.token)
    expect(changes(delta)).toEqual({
      changed: [
        ['pages/a.md', a.id, sha2],
        ['pages/d.md', d.id, SHA_A],
      ],
      removedIds: [b.id, c.id, elsewhere.id].sort(),
      token: w.fake.nextStartToken(),
    })
    expect(w.logs.some((l) => l.includes('listing the whole'))).toBe(false)

    // Nothing new: an empty changes delta.
    expect(changes(await w.mirror.fetchDelta(delta.token))).toEqual({ changed: [], removedIds: [], token: delta.token })
  })

  it('reports a file moved out of the graph folder as removed', async () => {
    const w = world()
    const pages = w.fake.addFolder(w.graph.id, 'pages')
    const a = w.fake.addFile(pages.id, 'a.md', 'a')
    const first = await w.mirror.fetchDelta(null)
    a.parents = ['root'] // moved in the Drive UI; the metadata patch records the change
    await w.other.updateMetadata(a.id, { appProperties: { touched: '1' } })
    expect(changes(await w.mirror.fetchDelta(first.token))).toMatchObject({ changed: [], removedIds: [a.id] })
  })

  it('falls back to a full listing when the token is rejected, and when the feed shows a folder the cache cannot vouch for', async () => {
    const w = world()
    const pages = w.fake.addFolder(w.graph.id, 'pages')
    w.fake.addFile(pages.id, 'a.md', 'a')
    const first = await w.mirror.fetchDelta(null)

    const bad = await w.mirror.fetchDelta('999999')
    expect(bad.kind).toBe('full')
    expect(w.logs.some((l) => l.includes('token was rejected'))).toBe(true)

    // The other device creates a folder: unknown here → full listing that includes the new file.
    const journals = await w.other.ensureFolder(w.graph.id, 'journals')
    await w.other.createFile('j', { name: 'j.md', parentId: journals })
    const afterNewFolder = await w.mirror.fetchDelta(first.token)
    expect(afterNewFolder.kind).toBe('full')
    if (afterNewFolder.kind === 'full') expect(afterNewFolder.files.map((f) => f.path).sort()).toEqual(['journals/j.md', 'pages/a.md'])

    // A folder change the cache agrees with (same parent and name) stays incremental.
    await w.other.updateMetadata(pages.id, { appProperties: { colour: 'blue' } })
    const meta = await w.mirror.fetchDelta(afterNewFolder.token)
    expect(meta.kind).toBe('changes')

    // A rename moves every file below it: full listing again.
    await w.other.updateMetadata(pages.id, { name: 'notes' })
    const renamed = await w.mirror.fetchDelta(meta.token)
    expect(renamed.kind).toBe('full')
    if (renamed.kind === 'full') expect(renamed.files.map((f) => f.path).sort()).toEqual(['journals/j.md', 'notes/a.md'])

    // A trashed folder as well; its files vanish from the listing.
    await w.other.trash(journals)
    const trashed = await w.mirror.fetchDelta(renamed.token)
    expect(trashed.kind).toBe('full')
    if (trashed.kind === 'full') expect(trashed.files.map((f) => f.path)).toEqual(['notes/a.md'])

    // The lock folder appearing is not a reason to re-list.
    await w.other.ensureFolder(w.graph.id, LOCK_DIR)
    expect((await w.mirror.fetchDelta(trashed.token)).kind).toBe('changes')
  })
})

describe('createDriveMirror.upload / download / trash', () => {
  const meta = { sha256: SHA_A, deviceId: 'dev-1', modifiedTime: T0 - 5000 }

  it('creates a file with its folders and appProperties, updates in place, and recreates a file that is gone', async () => {
    const w = world()
    const created = await w.mirror.upload('deep/er/a.md', new TextEncoder().encode('a'), meta, null)
    expect(created).toMatchObject({ path: 'deep/er/a.md', sha256: SHA_A, size: 1, modifiedTime: T0 - 5000 })
    const deep = w.fake.childrenOf(w.graph.id).find((f) => f.name === 'deep')!
    const er = w.fake.childrenOf(deep.id).find((f) => f.name === 'er')!
    const file = w.fake.childrenOf(er.id)[0]
    expect(file.id).toBe(created.id)
    expect(file.appProperties).toEqual({ [PROP_SHA256]: SHA_A, [PROP_REL_PATH]: 'deep/er/a.md', [PROP_DEVICE_ID]: 'dev-1' })
    expect(w.fake.textOf(file.id)).toBe('a')

    const sha2 = await sha256Hex('aa')
    const updated = await w.mirror.upload('deep/er/a.md', new TextEncoder().encode('aa'), { ...meta, sha256: sha2, modifiedTime: T0 - 1000 }, created.id)
    expect(updated).toMatchObject({ id: created.id, sha256: sha2, size: 2, modifiedTime: T0 - 1000 })
    expect(w.fake.textOf(created.id)).toBe('aa')
    expect(w.fake.childrenOf(er.id)).toHaveLength(1)

    w.fake.files.delete(created.id)
    const again = await w.mirror.upload('deep/er/a.md', new TextEncoder().encode('a'), meta, created.id)
    expect(again.id).not.toBe(created.id)
    expect(w.fake.childrenOf(er.id).map((f) => f.id)).toEqual([again.id])
    expect(w.logs.some((l) => l.includes('is gone; creating it anew'))).toBe(true)
  })

  it('shares one folder creation between concurrent uploads into a new directory', async () => {
    const w = world()
    const posts = () => w.fake.callsMatching((c) => c.method === 'POST' && c.url.pathname === '/drive/v3/files').length
    const before = posts()
    const [a, b, c] = await Promise.all([
      w.mirror.upload('n/a.md', new Uint8Array([1]), meta, null),
      w.mirror.upload('n/b.md', new Uint8Array([2]), meta, null),
      w.mirror.upload('n/sub/c.md', new Uint8Array([3]), meta, null),
    ])
    const n = w.fake.childrenOf(w.graph.id).filter((f) => f.name === 'n')
    expect(n).toHaveLength(1)
    expect(posts() - before).toBe(2) // `n` and `n/sub`, each created exactly once
    expect(w.fake.childrenOf(n[0].id).map((f) => f.name).sort()).toEqual(['a.md', 'b.md', 'sub'])
    expect([a.path, b.path, c.path]).toEqual(['n/a.md', 'n/b.md', 'n/sub/c.md'])
  })

  it('downloads bytes and trashes tolerantly', async () => {
    const w = world()
    const f = w.fake.addFile(w.graph.id, 'x.bin', new Uint8Array([1, 2, 3]))
    expect([...(await w.mirror.download(f.id))]).toEqual([1, 2, 3])
    await w.mirror.trash(f.id)
    expect(w.fake.files.get(f.id)?.trashed).toBe(true)
    await w.mirror.trash('no-such-id') // 404 is not an error
    await expect(w.mirror.download('no-such-id')).rejects.toMatchObject({ status: 404 })
  })

  it('toRemoteFile validates the sha and defaults the size', () => {
    const base = { id: 'i', name: 'n', mimeType: 'x', isFolder: false, size: null, md5Checksum: 'm', modifiedTime: 1, createdTime: 2, parents: [], trashed: false }
    expect(toRemoteFile({ ...base, appProperties: { [PROP_SHA256]: SHA_A.toUpperCase() } }, 'p')).toMatchObject({ sha256: null, size: 0, md5: 'm' })
    expect(toRemoteFile({ ...base, size: 7, appProperties: { [PROP_SHA256]: SHA_A } }, 'p')).toEqual({ path: 'p', id: 'i', sha256: SHA_A, size: 7, modifiedTime: 1, createdTime: 2, md5: 'm' })
  })
})
