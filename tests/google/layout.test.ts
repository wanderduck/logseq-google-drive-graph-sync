import { describe, expect, it } from 'vitest'
import { createDriveClient } from '../../src/google/drive'
import { FOLDER_MIME } from '../../src/google/driveQuery'
import { bootstrapLayout, driveFolderName, findLayout, resolveLayout, verifyLayout } from '../../src/google/layout'
import { createFakeDrive } from './fakeDrive'

describe('driveFolderName', () => {
  it('trims, replaces slashes, and falls back when empty', () => {
    expect(driveFolderName('  My Graph ', 'x')).toBe('My Graph')
    expect(driveFolderName('a/b', 'x')).toBe('a_b')
    expect(driveFolderName('   ', 'graph')).toBe('graph')
  })
})

describe('bootstrapLayout (plan M4 step 1, §3.3)', () => {
  it('creates root/graphs/<g>, snapshots/<g> and profile under My Drive, once', async () => {
    const fake = createFakeDrive()
    const client = createDriveClient({ fetch: fake.fetch })
    const layout = await bootstrapLayout(client, { rootFolderName: 'Logseq Graph Sync', graphName: 'my graph' })
    const name = (id: string) => fake.files.get(id)!.name
    const parent = (id: string) => fake.files.get(id)!.parents[0]
    expect(name(layout.rootId)).toBe('Logseq Graph Sync')
    expect(parent(layout.rootId)).toBe('root')
    expect([name(layout.graphsId), parent(layout.graphsId)]).toEqual(['graphs', layout.rootId])
    expect([name(layout.graphFolderId), parent(layout.graphFolderId)]).toEqual(['my graph', layout.graphsId])
    expect([name(layout.snapshotsId), parent(layout.snapshotsId)]).toEqual(['snapshots', layout.rootId])
    expect([name(layout.snapshotsGraphId), parent(layout.snapshotsGraphId)]).toEqual(['my graph', layout.snapshotsId])
    expect([name(layout.profileId), parent(layout.profileId)]).toEqual(['profile', layout.rootId])
    expect([...fake.files.values()].filter((f) => f.mimeType === FOLDER_MIME && f.id !== 'root')).toHaveLength(6)

    const calls = fake.calls.length
    expect(await bootstrapLayout(client, { rootFolderName: 'Logseq Graph Sync', graphName: 'my graph' })).toEqual(layout)
    expect(fake.calls.length).toBe(calls) // all cached

    // A fresh client (new device / restart) finds the same folders without creating any.
    const other = createDriveClient({ fetch: fake.fetch })
    expect(await bootstrapLayout(other, { rootFolderName: 'Logseq Graph Sync', graphName: 'my graph' })).toEqual(layout)
    expect(fake.callsMatching(/^POST/)).toHaveLength(6)
  })

  it('keeps graphs apart and sanitizes names', async () => {
    const fake = createFakeDrive()
    const client = createDriveClient({ fetch: fake.fetch })
    const a = await bootstrapLayout(client, { rootFolderName: ' Sync ', graphName: 'work/notes' })
    const b = await bootstrapLayout(client, { rootFolderName: 'Sync', graphName: 'home' })
    expect(a.rootId).toBe(b.rootId)
    expect(a.graphsId).toBe(b.graphsId)
    expect(a.graphFolderId).not.toBe(b.graphFolderId)
    expect(fake.files.get(a.graphFolderId)!.name).toBe('work_notes')
    expect(fake.childrenOf(a.graphsId).map((f) => f.name).sort()).toEqual(['home', 'work_notes'])
  })
})

describe('verifyLayout / resolveLayout / findLayout (M7: persisted ids)', () => {
  const spec = { rootFolderName: 'Logseq Graph Sync', graphName: 'my graph' }

  it('verifies persisted ids with files.get only and reuses them; a missing, trashed, renamed or moved folder fails the check', async () => {
    const fake = createFakeDrive()
    const layout = await bootstrapLayout(createDriveClient({ fetch: fake.fetch }), spec)
    const known = { driveRootId: layout.rootId, graphFolderId: layout.graphFolderId }

    const fresh = createDriveClient({ fetch: fake.fetch })
    const before = fake.calls.length
    expect(await verifyLayout(fresh, spec, known)).toBe(true)
    const during = fake.calls.slice(before)
    expect(during.every((c) => c.method === 'GET' && /\/files\/[^/?]+/.test(c.url.pathname))).toBe(true)
    expect(during.length).toBe(3) // root, graph folder, and the `graphs` parent for the path
    expect(await resolveLayout(fresh, spec, known)).toEqual({ ...known, reused: true })
    expect(await findLayout(fresh, spec, known)).toEqual(known)

    // Root renamed in settings.
    expect(await verifyLayout(fresh, { ...spec, rootFolderName: 'Other' }, known)).toBe(false)
    // Graph folder moved out of graphs/.
    const other = fake.addFolder(layout.rootId, 'elsewhere')
    fake.files.get(layout.graphFolderId)!.parents = [other.id]
    expect(await verifyLayout(createDriveClient({ fetch: fake.fetch }), spec, known)).toBe(false)
    fake.files.get(layout.graphFolderId)!.parents = [layout.graphsId]
    // Trashed root.
    fake.files.get(layout.rootId)!.trashed = true
    expect(await verifyLayout(createDriveClient({ fetch: fake.fetch }), spec, known)).toBe(false)
    fake.files.get(layout.rootId)!.trashed = false
    // Deleted graph folder (404).
    fake.files.delete(layout.graphFolderId)
    expect(await verifyLayout(createDriveClient({ fetch: fake.fetch }), spec, known)).toBe(false)
  })

  it('resolveLayout bootstraps when the ids do not verify; findLayout finds without creating', async () => {
    const fake = createFakeDrive()
    const client = createDriveClient({ fetch: fake.fetch })
    const folders = () => [...fake.files.values()].filter((f) => f.mimeType === FOLDER_MIME && f.id !== 'root').length

    expect(await findLayout(client, spec, null)).toBeNull()
    expect(await findLayout(client, spec, { driveRootId: 'nope', graphFolderId: 'nope' })).toBeNull()
    expect(folders()).toBe(0)

    const r = await resolveLayout(client, spec, { driveRootId: 'nope', graphFolderId: 'nope' })
    expect(r.reused).toBe(false)
    expect(folders()).toBe(6)
    expect(fake.files.get(r.graphFolderId)!.name).toBe('my graph')

    const found = await findLayout(createDriveClient({ fetch: fake.fetch }), spec, null)
    expect(found).toEqual({ driveRootId: r.driveRootId, graphFolderId: r.graphFolderId })
    expect(await findLayout(createDriveClient({ fetch: fake.fetch }), { ...spec, graphName: 'another' }, null)).toBeNull()
    expect(folders()).toBe(6)
  })
})
