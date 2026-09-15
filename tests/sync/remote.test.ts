import { describe, expect, it } from 'vitest'
import { applyDelta, applyDeltaWithDuplicates, olderRemote, remoteViewOf, type RemoteFile } from '../../src/sync/remote'

const rf = (path: string, id: string, extra: Partial<RemoteFile> = {}): RemoteFile => ({
  path,
  id,
  sha256: `sha-${id}`,
  size: 1,
  modifiedTime: 10,
  createdTime: 5,
  md5: null,
  ...extra,
})

describe('applyDelta (plan §3.6 step 4)', () => {
  it('a full listing replaces the view and keeps the oldest of duplicate paths', () => {
    const view = remoteViewOf([rf('stale.md', 'old')])
    const next = applyDelta(view, {
      kind: 'full',
      token: '9',
      files: [rf('a.md', 'a2', { createdTime: 9 }), rf('a.md', 'a1', { createdTime: 3 }), rf('b.md', 'b1'), rf('c.md', 'c2', { createdTime: 5 }), rf('c.md', 'c1', { createdTime: 5 })],
    })
    expect([...next.keys()].sort()).toEqual(['a.md', 'b.md', 'c.md'])
    expect(next.get('a.md')?.id).toBe('a1')
    expect(next.get('c.md')?.id).toBe('c1') // same createdTime: smallest id
    expect(view.has('stale.md')).toBe(true) // input untouched
    expect(olderRemote(rf('x', 'b', { createdTime: 1 }), rf('x', 'a', { createdTime: 2 })).id).toBe('b')
  })

  it('a changes delta removes ids, moves a file whose path changed, and ignores unknown removals', () => {
    const view = remoteViewOf([rf('a.md', 'a'), rf('b.md', 'b'), rf('c.md', 'c')])
    const next = applyDelta(view, {
      kind: 'changes',
      token: '10',
      removedIds: ['b', 'ghost'],
      changed: [rf('renamed.md', 'c'), rf('d.md', 'd'), rf('a.md', 'a', { sha256: 'new' })],
    })
    expect([...next.keys()].sort()).toEqual(['a.md', 'd.md', 'renamed.md'])
    expect(next.get('a.md')?.sha256).toBe('new')
    expect(next.get('renamed.md')?.id).toBe('c')
    expect(view.size).toBe(3)
  })

  it('a repeated id in the feed counts once, and a younger duplicate never displaces the oldest', () => {
    const view = remoteViewOf([rf('a.md', 'a', { createdTime: 1 })])
    const next = applyDelta(view, {
      kind: 'changes',
      token: '11',
      removedIds: [],
      changed: [rf('a.md', 'a', { sha256: 'v1', createdTime: 1 }), rf('a.md', 'a', { sha256: 'v2', createdTime: 1 }), rf('a.md', 'dup', { createdTime: 7 })],
    })
    expect(next.size).toBe(1)
    expect(next.get('a.md')).toMatchObject({ id: 'a', sha256: 'v2' })

    // The older file arrives later: it wins and the younger incumbent goes.
    const flipped = applyDelta(remoteViewOf([rf('a.md', 'young', { createdTime: 7 })]), { kind: 'changes', token: '12', removedIds: [], changed: [rf('a.md', 'old', { createdTime: 1 })] })
    expect(flipped.get('a.md')?.id).toBe('old')
  })

  it('reports the younger duplicates it hid, from a full listing and from a changes feed', () => {
    const full = applyDeltaWithDuplicates(remoteViewOf([]), {
      kind: 'full',
      token: '1',
      files: [rf('a.md', 'a2', { createdTime: 9 }), rf('a.md', 'a1', { createdTime: 3 }), rf('a.md', 'a3', { createdTime: 12 }), rf('b.md', 'b')],
    })
    expect(full.view.get('a.md')?.id).toBe('a1')
    expect(full.duplicates.map((f) => f.id).sort()).toEqual(['a2', 'a3'])

    const changed = applyDeltaWithDuplicates(remoteViewOf([rf('a.md', 'young', { createdTime: 7 })]), {
      kind: 'changes',
      token: '2',
      removedIds: [],
      changed: [rf('a.md', 'old', { createdTime: 1 }), rf('a.md', 'younger', { createdTime: 9 })],
    })
    expect(changed.view.get('a.md')?.id).toBe('old')
    expect(changed.duplicates.map((f) => f.id).sort()).toEqual(['young', 'younger'])

    // Both twins in one feed while the view held the younger one: the twin is reported once.
    const twins = applyDeltaWithDuplicates(remoteViewOf([rf('t.md', 'f2', { createdTime: 5 })]), {
      kind: 'changes',
      token: '4',
      removedIds: [],
      changed: [rf('t.md', 'f1', { createdTime: 4 }), rf('t.md', 'f2', { createdTime: 5 })],
    })
    expect(twins.view.get('t.md')?.id).toBe('f1')
    expect(twins.duplicates.map((f) => f.id)).toEqual(['f2'])
    // A twin that is already known and re-reported is not a duplicate of itself.
    expect(applyDeltaWithDuplicates(changed.view, { kind: 'changes', token: '3', removedIds: [], changed: [rf('a.md', 'old', { createdTime: 1 })] }).duplicates).toEqual([])
  })

  it('a removal after a change in the same feed wins (both describe the current state: gone)', () => {
    const next = applyDelta(remoteViewOf([]), { kind: 'changes', token: '13', removedIds: ['x'], changed: [rf('x.md', 'x')] })
    // The mirror never emits both for one id, but if it did the view must not resurrect the file.
    expect(next.has('x.md')).toBe(false)
  })
})
