import { describe, expect, it } from 'vitest'
import { createFolderCache } from '../../src/google/folderCache'

describe('createFolderCache (plan M4 step 1)', () => {
  it('maps (parent, name) to an id and back', () => {
    const c = createFolderCache()
    expect(c.get('root', 'Sync')).toBeNull()
    c.set('root', 'Sync', 'f1')
    c.set('f1', 'graphs', 'f2')
    expect(c.get('root', 'Sync')).toBe('f1')
    expect(c.get('f1', 'graphs')).toBe('f2')
    expect(c.entry('f2')).toEqual({ parentId: 'f1', name: 'graphs' })
    expect(c.entry('nope')).toBeNull()
    expect(c.size).toBe(2)
  })

  it('replaces a stale id for the same path and drops the old reverse entry', () => {
    const c = createFolderCache()
    c.set('root', 'Sync', 'f1')
    c.set('root', 'Sync', 'f9')
    expect(c.get('root', 'Sync')).toBe('f9')
    expect(c.entry('f1')).toBeNull()
    expect(c.size).toBe(1)
  })

  it('forget drops the id and every descendant, leaving siblings alone', () => {
    const c = createFolderCache()
    c.set('root', 'Sync', 'f1')
    c.set('f1', 'graphs', 'f2')
    c.set('f2', 'g', 'f3')
    c.set('f3', 'pages', 'f4')
    c.set('f1', 'snapshots', 'f5')
    c.forget('f2')
    expect(c.get('f1', 'graphs')).toBeNull()
    expect(c.entry('f3')).toBeNull()
    expect(c.entry('f4')).toBeNull()
    expect(c.get('f1', 'snapshots')).toBe('f5')
    expect(c.get('root', 'Sync')).toBe('f1')
    c.clear()
    expect(c.size).toBe(0)
  })
})
