import { describe, expect, it } from 'vitest'
import { FsError, assertRelPath, baseName, fileUrl, isFsNotFound, joinAbs, normalizeRoot, parentDir, relativeTo } from '../../src/fs/graphFs'

describe('path helpers (plan M5 step 1)', () => {
  it('normalizeRoot accepts absolute roots, strips trailing slashes and backslashes, rejects the rest', () => {
    expect(normalizeRoot('/home/u/graph/')).toBe('/home/u/graph')
    expect(normalizeRoot(' /home/u/graph ')).toBe('/home/u/graph')
    expect(normalizeRoot('C:\\Users\\u\\graph\\')).toBe('C:/Users/u/graph')
    expect(normalizeRoot('/')).toBe('/')
    for (const bad of ['', 'graph', './graph', 'home/u']) {
      expect(() => normalizeRoot(bad)).toThrow(FsError)
      expect(() => normalizeRoot(bad)).toThrow(/absolute/)
    }
  })

  it('assertRelPath accepts clean relative paths and rejects the rest', () => {
    for (const ok of ['a.md', 'pages/a.md', 'a/b/c', '.hidden', 'pages/.a.md.gdsync-tmp', 'Meeting Notes – Café.md']) {
      expect(assertRelPath(ok)).toBe(ok)
    }
    expect(assertRelPath('', true)).toBe('')
    const bad: Array<[string, RegExp]> = [
      ['', /empty path/],
      ['/a.md', /absolute/],
      ['a/', /trailing/],
      ['a//b', /segment/],
      ['./a', /segment/],
      ['a/../b', /segment/],
      ['..', /segment/],
      ['a\\b', /forward slashes/],
    ]
    for (const [p, re] of bad) {
      expect(() => assertRelPath(p)).toThrow(re)
      try {
        assertRelPath(p)
      } catch (err) {
        expect(err).toBeInstanceOf(FsError)
        expect((err as FsError).code).toBe('EINVAL')
      }
    }
  })

  it('joinAbs / relativeTo are inverses and relativeTo rejects paths outside the root', () => {
    expect(joinAbs('/g', 'pages/a.md')).toBe('/g/pages/a.md')
    expect(joinAbs('/g', '')).toBe('/g')
    expect(joinAbs('/', 'a')).toBe('/a')
    expect(relativeTo('/g', '/g/pages/a.md')).toBe('pages/a.md')
    expect(relativeTo('/g', '/g')).toBe('')
    expect(relativeTo('/g', '/gx/a.md')).toBeNull()
    expect(relativeTo('/g', '/other/a.md')).toBeNull()
    expect(relativeTo('C:/g', 'C:\\g\\pages\\a.md')).toBe('pages/a.md')
    expect(relativeTo('/', '/a')).toBe('a')
  })

  it('parentDir / baseName', () => {
    expect(parentDir('pages/a.md')).toBe('pages')
    expect(parentDir('a/b/c.md')).toBe('a/b')
    expect(parentDir('a.md')).toBe('')
    expect(baseName('pages/a.md')).toBe('a.md')
    expect(baseName('a.md')).toBe('a.md')
  })

  it('fileUrl percent-encodes every segment and keeps a Windows drive letter', () => {
    expect(fileUrl('/home/u/g/pages/a.md')).toBe('file:///home/u/g/pages/a.md')
    expect(fileUrl('/g/pages/Meeting Notes – Café.md')).toBe('file:///g/pages/Meeting%20Notes%20%E2%80%93%20Caf%C3%A9.md')
    expect(fileUrl('/g/a#b?c%d.md')).toBe('file:///g/a%23b%3Fc%25d.md')
    expect(fileUrl('C:/Users/u/g/a.md')).toBe('file:///C:/Users/u/g/a.md')
    expect(fileUrl('C:\\Users\\u\\a b.md')).toBe('file:///C:/Users/u/a%20b.md')
    // Round trip through the decoder a file:// consumer applies.
    const original = '/g/assets/100% sure #1.png'
    expect(decodeURIComponent(fileUrl(original).slice('file://'.length))).toBe(original)
  })

  it('FsError carries op/path/code and isFsNotFound only matches ENOENT', () => {
    const e = new FsError('stat', 'a.md', 'ENOENT', 'gone', new Error('raw'))
    expect(e.name).toBe('FsError')
    expect(e.op).toBe('stat')
    expect(e.path).toBe('a.md')
    expect(e.cause).toBeInstanceOf(Error)
    expect(isFsNotFound(e)).toBe(true)
    expect(isFsNotFound(new FsError('stat', 'a.md', 'EACCES', 'no'))).toBe(false)
    expect(isFsNotFound(new Error('ENOENT'))).toBe(false)
  })
})
