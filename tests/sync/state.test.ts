import { describe, expect, it } from 'vitest'
import type { RemoteFile } from '../../src/sync/remote'
import {
  DEVICE_KEY,
  applyCompletions,
  createSyncStateStore,
  ensureDevice,
  freshState,
  graphKey,
  journalKey,
  parseCompletion,
  parseJournal,
  parseSyncState,
  shortHash,
  stateKey,
  type Completion,
  type SyncEntry,
  type SyncJournal,
} from '../../src/sync/state'
import { fakeStorage } from '../google/helpers'

const entry = (sha256: string, driveId = 'f1'): SyncEntry => ({ sha256, size: 3, mtimeMs: 1000, driveId, driveModifiedTime: 2000, syncedAt: 3000 })
const remote = (path: string, id = 'f1', sha256: string | null = 'a'): RemoteFile => ({ path, id, sha256, size: 3, modifiedTime: 2000, createdTime: 1500, md5: null })

describe('graphKey', () => {
  it('sanitises the name and appends a stable hash so look-alike names stay apart', () => {
    expect(graphKey('gdsync-dev')).toBe(`gdsync-dev-${shortHash('gdsync-dev')}`)
    expect(graphKey('My Graph!')).toMatch(/^My-Graph-[0-9a-f]{8}$/)
    expect(graphKey('my graph')).not.toBe(graphKey('my_graph'))
    expect(graphKey('   ')).toMatch(/^graph-[0-9a-f]{8}$/)
    expect(graphKey('x'.repeat(100)).length).toBeLessThanOrEqual(48 + 9)
    // M7: keyed by the graph PATH so two graphs with one name (the D11 device-2 simulation) keep separate state.
    expect(graphKey('gdsync-dev', '/home/a/gdsync-dev')).not.toBe(graphKey('gdsync-dev', '/home/b/gdsync-dev'))
    expect(graphKey('gdsync-dev', '/home/a/gdsync-dev')).toMatch(/^gdsync-dev-[0-9a-f]{8}$/)
    expect(graphKey('gdsync-dev', 'gdsync-dev')).toBe(graphKey('gdsync-dev'))
    expect(shortHash('a')).toBe('e40c292c')
  })
})

describe('parseSyncState', () => {
  it('round-trips a saved state and drops entries or remote files that do not parse', () => {
    const s = freshState('k')
    s.driveRootId = 'r'
    s.graphFolderId = 'g'
    s.changesPageToken = '42'
    s.lastSyncAt = 5
    s.entries['pages/a.md'] = entry('aa')
    s.remote['pages/a.md'] = remote('pages/a.md')
    const parsed = parseSyncState(JSON.stringify(s), 'k')
    expect(parsed).toEqual(s)

    const dirty = JSON.parse(JSON.stringify(s)) as Record<string, unknown>
    ;(dirty.entries as Record<string, unknown>)['pages/bad.md'] = { sha256: '', size: 1 }
    ;(dirty.remote as Record<string, unknown>)['pages/wrong.md'] = remote('pages/other.md') // path mismatch
    ;(dirty.remote as Record<string, unknown>)['pages/n.md'] = { ...remote('pages/n.md'), sha256: 7, createdTime: 'x' }
    const p2 = parseSyncState(JSON.stringify(dirty), 'k')
    expect(Object.keys(p2.entries)).toEqual(['pages/a.md'])
    expect(Object.keys(p2.remote).sort()).toEqual(['pages/a.md', 'pages/n.md'])
    expect(p2.remote['pages/n.md']).toMatchObject({ sha256: null, createdTime: 0 })
  })

  it('reads anything unusable, or another graph key, as a fresh state', () => {
    expect(parseSyncState(null, 'k')).toEqual(freshState('k'))
    expect(parseSyncState('', 'k')).toEqual(freshState('k'))
    expect(parseSyncState('not json', 'k')).toEqual(freshState('k'))
    expect(parseSyncState('null', 'k')).toEqual(freshState('k'))
    expect(parseSyncState(JSON.stringify({ version: 2, graphKey: 'k' }), 'k')).toEqual(freshState('k'))
    expect(parseSyncState(JSON.stringify(freshState('other')), 'k')).toEqual(freshState('k'))
  })
})

describe('journal + completions', () => {
  it('parses completions strictly: a broken half drops the whole completion', () => {
    expect(parseCompletion({ path: 'p', entry: null, remote: null })).toEqual({ path: 'p', entry: null, remote: null })
    expect(parseCompletion({ path: 'p', entry: entry('a'), remote: remote('p') })).toEqual({ path: 'p', entry: entry('a'), remote: remote('p') })
    expect(parseCompletion({ path: 'p', entry: { sha256: 'a' }, remote: null })).toBeNull()
    expect(parseCompletion({ path: 'p', entry: null, remote: { id: 'x' } })).toBeNull()
    expect(parseCompletion({ entry: null, remote: null })).toBeNull()
  })

  it('round-trips a journal and treats the cleared file as absent', () => {
    const j: SyncJournal = {
      version: 1,
      runId: 'r1',
      startedAt: 10,
      bakDir: 'logseq/bak/gdsync/20260915-000000',
      ops: [{ kind: 'drop-base', path: 'pages/x.md' }],
      done: { 'drop-base:pages/x.md': [{ path: 'pages/x.md', entry: null, remote: null }], bad: [{ nope: true } as unknown as Completion] },
      resolutions: [{ path: 'pages/c.md', choice: 'keep-both', localSha: 'l', remoteSha: null }],
    }
    const parsed = parseJournal(JSON.stringify(j))
    expect(parsed).toEqual({ ...j, done: { 'drop-base:pages/x.md': j.done['drop-base:pages/x.md'], bad: [] } })
    expect(parseJournal('null')).toBeNull()
    expect(parseJournal(JSON.stringify({ ...j, runId: '' }))).toBeNull()
    expect(parseJournal(JSON.stringify({ ...j, resolutions: [{ path: 'p', choice: 'eat' }] }))?.resolutions).toEqual([])
  })

  it('applyCompletions sets or drops both halves per path', () => {
    const s = freshState('k')
    s.entries.a = entry('a')
    s.remote.a = remote('a')
    s.entries.b = entry('b', 'f2')
    s.remote.b = remote('b', 'f2', 'b')
    applyCompletions(s, [
      { path: 'a', entry: null, remote: null },
      { path: 'b', entry: entry('b2', 'f2'), remote: remote('b', 'f2', 'b2') },
      { path: 'c', entry: entry('c', 'f3'), remote: remote('c', 'f3', 'c') },
    ])
    expect(Object.keys(s.entries).sort()).toEqual(['b', 'c'])
    expect(s.entries.b.sha256).toBe('b2')
    expect(Object.keys(s.remote).sort()).toEqual(['b', 'c'])
  })
})

describe('createSyncStateStore + ensureDevice', () => {
  it('stores state, journal and device under the documented keys and survives a rejecting getItem', async () => {
    const storage = fakeStorage()
    const store = createSyncStateStore(storage)
    expect(await store.loadState('k')).toEqual(freshState('k'))
    const s = freshState('k')
    s.entries['a.md'] = entry('a')
    await store.saveState(s)
    expect(storage.files.has(stateKey('k'))).toBe(true)
    expect(await store.loadState('k')).toEqual(s)

    expect(await store.loadJournal('k')).toBeNull()
    const j: SyncJournal = { version: 1, runId: 'r', startedAt: 1, bakDir: 'd', ops: [], done: {}, resolutions: [] }
    await store.saveJournal('k', j)
    expect(await store.loadJournal('k')).toEqual(j)
    await store.clearJournal('k')
    expect(storage.files.get(journalKey('k'))).toBe('null')
    expect(await store.loadJournal('k')).toBeNull()

    let ids = 0
    const opts = { newId: () => `id-${++ids}`, now: () => 77 }
    const d1 = await ensureDevice(store, opts)
    expect(d1).toEqual({ deviceId: 'id-1', createdAt: 77 })
    expect(JSON.parse(storage.files.get(DEVICE_KEY)!)).toEqual(d1)
    expect(await ensureDevice(store, opts)).toEqual(d1) // created once

    storage.failReads = true
    expect(await store.loadState('k')).toEqual(freshState('k'))
    expect(await store.loadDevice()).toBeNull()
  })
})
