import { describe, expect, it } from 'vitest'
import { conflictCopyName, type ConflictResolution } from '../../src/sync/conflict'
import { conflictOps, opKey, planSync, remoteChanged, type LocalFile, type PlannedConflict, type SyncOp } from '../../src/sync/planner'
import { remoteViewOf, type RemoteFile } from '../../src/sync/remote'
import type { SyncEntry } from '../../src/sync/state'

const L = (path: string, sha256: string, extra: Partial<LocalFile> = {}): LocalFile => ({ path, sha256, size: 10, mtimeMs: 100, ...extra })
const R = (path: string, sha256: string | null, extra: Partial<RemoteFile> = {}): RemoteFile => ({ path, id: `id-${path}`, sha256, size: 10, modifiedTime: 200, createdTime: 150, md5: null, ...extra })
const B = (sha256: string, path: string, extra: Partial<SyncEntry> = {}): SyncEntry => ({ sha256, size: 10, mtimeMs: 100, driveId: `id-${path}`, driveModifiedTime: 200, syncedAt: 50, ...extra })

function plan(local: LocalFile[], remote: RemoteFile[], base: Record<string, SyncEntry>) {
  return planSync({ local, remote: remoteViewOf(remote), base })
}

const kinds = (ops: SyncOp[]) => ops.map(opKey)

describe('planSync (plan §3.6 step 5)', () => {
  it('with no base: new local uploads, new remote downloads, identical add/add records the base, different add/add conflicts', () => {
    const p = plan([L('up.md', 'u'), L('same.md', 's'), L('diff.md', 'd1')], [R('down.md', 'w'), R('same.md', 's'), R('diff.md', 'd2')], {})
    expect(kinds(p.ops)).toEqual(['download:down.md', 'update-base:same.md', 'upload:up.md'])
    expect(p.ops[0]).toMatchObject({ kind: 'download', expectLocal: null })
    expect(p.ops[2]).toMatchObject({ kind: 'upload', existingId: null })
    expect(p.conflicts.map((c) => c.item)).toEqual([
      { path: 'diff.md', kind: 'both-modified', local: { size: 10, modifiedAt: 100, sha256: 'd1' }, remote: { size: 10, modifiedAt: 200, sha256: 'd2' } },
    ])
    expect(p.unchanged).toBe(0)
  })

  it('walks the three-way table for a path present everywhere', () => {
    const base = { 'a.md': B('b', 'a.md') }
    expect(plan([L('a.md', 'b')], [R('a.md', 'b')], base)).toMatchObject({ ops: [], conflicts: [], unchanged: 1 })
    expect(kinds(plan([L('a.md', 'l')], [R('a.md', 'b')], base).ops)).toEqual(['upload:a.md'])
    expect(plan([L('a.md', 'l')], [R('a.md', 'b')], base).ops[0]).toMatchObject({ existingId: 'id-a.md' })
    const down = plan([L('a.md', 'b')], [R('a.md', 'r')], base)
    expect(down.ops[0]).toMatchObject({ kind: 'download', expectLocal: { size: 10, mtimeMs: 100 } })
    expect(kinds(plan([L('a.md', 'x')], [R('a.md', 'x')], base).ops)).toEqual(['update-base:a.md'])
    const c = plan([L('a.md', 'l')], [R('a.md', 'r')], base)
    expect(c.ops).toEqual([])
    expect(c.conflicts[0].item.kind).toBe('both-modified')
  })

  it('handles deletes: plain on one side, conflict when the other side modified, drop when both deleted', () => {
    const base = { 'a.md': B('b', 'a.md'), 'c.md': B('b', 'c.md'), 'e.md': B('b', 'e.md') }
    // a: deleted locally, unchanged remotely → trash. c: deleted remotely, unchanged locally → move to bak. e: gone on both → drop.
    const p = plan([L('c.md', 'b')], [R('a.md', 'b')], base)
    expect(kinds(p.ops)).toEqual(['delete-remote:a.md', 'delete-local:c.md', 'drop-base:e.md'])
    expect(p.ops[1]).toMatchObject({ expectLocal: { size: 10, mtimeMs: 100 } })

    const q = plan([L('c.md', 'changed')], [R('a.md', 'changed')], base)
    expect(q.ops).toEqual([{ kind: 'drop-base', path: 'e.md' }])
    expect(q.conflicts.map((c) => [c.item.path, c.item.kind, c.item.local === null, c.item.remote === null])).toEqual([
      ['a.md', 'local-deleted', true, false],
      ['c.md', 'remote-deleted', false, true],
    ])
  })

  it('refreshes the base when only stats or Drive identity drifted, and detects remote change without a sha by identity', () => {
    const base = { 'a.md': B('b', 'a.md') }
    const drift = plan([L('a.md', 'b', { mtimeMs: 999 })], [R('a.md', 'b')], base)
    expect(kinds(drift.ops)).toEqual(['update-base:a.md'])
    const newId = plan([L('a.md', 'b')], [R('a.md', 'b', { id: 'recreated' })], base)
    expect(kinds(newId.ops)).toEqual(['update-base:a.md'])

    const same = R('a.md', null)
    expect(remoteChanged(same, base['a.md'])).toBe(false)
    expect(remoteChanged(R('a.md', null, { modifiedTime: 201 }), base['a.md'])).toBe(true)
    expect(remoteChanged(R('a.md', null, { size: 11 }), base['a.md'])).toBe(true)
    expect(remoteChanged(R('a.md', null, { id: 'other' }), base['a.md'])).toBe(true)
    // Unknown remote hash never counts as "same content" as a changed local file.
    const c = plan([L('a.md', 'l')], [R('a.md', null, { modifiedTime: 201 })], base)
    expect(c.conflicts).toHaveLength(1)
    expect(kinds(plan([L('a.md', 'b')], [R('a.md', null, { modifiedTime: 201 })], base).ops)).toEqual(['download:a.md'])
  })

  it('sorts ops and conflicts by path; opKey tells duplicates of one path apart', () => {
    const p = plan([L('z.md', 'z'), L('a.md', 'a'), L('m.md', 'm1')], [R('m.md', 'm2')], {})
    expect(kinds(p.ops)).toEqual(['upload:a.md', 'upload:z.md'])
    expect(p.conflicts.map((c) => c.item.path)).toEqual(['m.md'])
    expect(opKey({ kind: 'trash-duplicate', path: 'a.md', remote: R('a.md', 'x', { id: 'dup' }) })).toBe('trash-duplicate:a.md#dup')
  })
})

describe('conflictOps (plan §3.6 step 6, D7)', () => {
  const at = new Date(2026, 8, 15, 10, 30)
  const both: PlannedConflict = { item: { path: 'p/a.md', kind: 'both-modified', local: { size: 1, modifiedAt: 1, sha256: 'l' }, remote: { size: 2, modifiedAt: 2, sha256: 'r' } }, local: L('p/a.md', 'l'), remote: R('p/a.md', 'r') }
  const localDeleted: PlannedConflict = { item: { path: 'ld.md', kind: 'local-deleted', local: null, remote: { size: 2, modifiedAt: 2, sha256: 'r' } }, local: null, remote: R('ld.md', 'r') }
  const remoteDeleted: PlannedConflict = { item: { path: 'rd.md', kind: 'remote-deleted', local: { size: 1, modifiedAt: 1, sha256: 'l' }, remote: null }, local: L('rd.md', 'l'), remote: null }

  const answer = (choice: ConflictResolution['choice']): ConflictResolution[] => [
    { path: 'p/a.md', choice },
    { path: 'ld.md', choice },
    { path: 'rd.md', choice },
  ]

  it('keep-local uploads or trashes, keep-remote downloads or moves to bak', () => {
    const kl = conflictOps([both, localDeleted, remoteDeleted], answer('keep-local'), 'Laptop', at)
    expect(kinds(kl.ops)).toEqual(['upload:p/a.md', 'delete-remote:ld.md', 'upload:rd.md'])
    expect(kl.ops[0]).toEqual({ kind: 'upload', path: 'p/a.md', local: both.local, existingId: 'id-p/a.md', stashRemote: both.remote })
    expect(kl.ops[2]).toEqual({ kind: 'upload', path: 'rd.md', local: remoteDeleted.local, existingId: null })
    expect(kl.applied).toEqual([
      { path: 'p/a.md', choice: 'keep-local', localSha: 'l', remoteSha: 'r' },
      { path: 'ld.md', choice: 'keep-local', localSha: null, remoteSha: 'r' },
      { path: 'rd.md', choice: 'keep-local', localSha: 'l', remoteSha: null },
    ])
    expect(kl.skipped).toEqual([])

    const kr = conflictOps([both, localDeleted, remoteDeleted], answer('keep-remote'), 'Laptop', at)
    expect(kinds(kr.ops)).toEqual(['download:p/a.md', 'download:ld.md', 'delete-local:rd.md'])
    expect(kr.ops[0]).toMatchObject({ expectLocal: { size: 10, mtimeMs: 100 } })
    expect(kr.ops[1]).toMatchObject({ expectLocal: null })
  })

  it('keep-both makes a conflict copy for both-modified and is normalised on delete conflicts; unanswered paths are skipped', () => {
    const kb = conflictOps([both, localDeleted, remoteDeleted], answer('keep-both'), 'My Laptop', at)
    expect(kinds(kb.ops)).toEqual(['keep-both:p/a.md', 'download:ld.md', 'upload:rd.md'])
    expect(kb.ops[0]).toMatchObject({ copyPath: conflictCopyName('p/a.md', 'My Laptop', at) })
    expect((kb.ops[0] as { copyPath: string }).copyPath).toBe('p/a.conflict-My-Laptop-20260915-1030.md')
    expect(kb.applied.map((a) => a.choice)).toEqual(['keep-both', 'keep-remote', 'keep-local'])

    const partial = conflictOps([both, localDeleted], [{ path: 'ld.md', choice: 'keep-local' }, { path: 'unrelated.md', choice: 'keep-local' }], 'x', at)
    expect(kinds(partial.ops)).toEqual(['delete-remote:ld.md'])
    expect(partial.skipped).toEqual([both.item])
    expect(partial.applied).toHaveLength(1)
  })
})
