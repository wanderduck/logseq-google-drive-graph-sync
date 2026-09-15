import { describe, expect, it } from 'vitest'
import { createFakeHost } from './fakeHost'

// Sanity checks of the emulator itself against the host semantics documented in src/fs/hostBridgeFs.ts.
describe('FakeHost', () => {
  it('listdir: null for a missing dir, flat absolute file paths incl. dot files, ENOTDIR rejects', async () => {
    const h = createFakeHost()
    h.addFile('/g/pages/a.md', 'a')
    h.addFile('/g/logseq/.recycle/pages_old.md', 'old')
    h.addDir('/g/empty')
    expect(await h.doAction(['listdir', '/nope', true])).toBeNull()
    expect(((await h.doAction(['listdir', '/g', true])) as string[]).sort()).toEqual(['/g/logseq/.recycle/pages_old.md', '/g/pages/a.md'])
    expect(await h.doAction(['listdir', '/g/empty', true])).toEqual([])
    await expect(h.doAction(['listdir', '/g/pages/a.md', true])).rejects.toThrow(/Error invoking remote method 'main': Error: ENOTDIR/)
  })

  it('stat resolves a stat for files and dirs and RESOLVES an Error for a missing path', async () => {
    const h = createFakeHost({ now: () => 1000 })
    h.addFile('/g/a.md', 'abc')
    expect(await h.doAction(['stat', '/g/a.md'])).toEqual({ size: 3, mtime: new Date(1000), ctime: new Date(1000) })
    expect((await h.doAction(['stat', '/g'])) as { size: number }).toMatchObject({ size: 4096 })
    const r = await h.doAction(['stat', '/g/missing'])
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toBe("ENOENT: no such file or directory, stat '/g/missing'")
  })

  it('writeFile needs an existing parent, else resolves null and "shows a notification"', async () => {
    const h = createFakeHost({ now: () => 5 })
    h.addDir('/g')
    expect(await h.doAction(['writeFile', '/g', '/g/new.md', 'x'])).toEqual({ size: 1, mtime: new Date(5), ctime: new Date(5) })
    expect(await h.doAction(['writeFile', '/g', '/g/sub/new.md', 'x'])).toBeNull()
    expect(h.notifications).toEqual(['Write to the file /g/sub/new.md failed'])
    const buf = new Uint8Array([1, 2, 3]).buffer
    expect(await h.doAction(['writeFile', '/g', '/g/b.bin', buf])).toMatchObject({ size: 3 })
    expect([...h.files.get('/g/b.bin')!.bytes]).toEqual([1, 2, 3])
  })

  it('rename replaces files, moves directories, and resolves ENOENT errors', async () => {
    const h = createFakeHost()
    h.addFile('/g/a.md', 'a')
    h.addFile('/g/b.md', 'b')
    h.addFile('/g/d/x.md', 'x')
    expect(await h.doAction(['rename', '/g/a.md', '/g/b.md'])).toBeUndefined()
    expect(h.textOf('/g/b.md')).toBe('a')
    expect(h.has('/g/a.md')).toBe(false)
    expect(await h.doAction(['rename', '/g/d', '/g/e'])).toBeUndefined()
    expect(h.has('/g/e/x.md')).toBe(true)
    expect(h.dirs.has('/g/e')).toBe(true)
    expect(h.dirs.has('/g/d')).toBe(false)
    expect((await h.doAction(['rename', '/g/zz', '/g/yy'])) as Error).toMatchObject({ message: "ENOENT: no such file or directory, rename '/g/zz' -> '/g/yy'" })
    expect((await h.doAction(['rename', '/g/b.md', '/g/nodir/b.md'])) as Error).toBeInstanceOf(Error)
  })

  it('copyFile creates parents and REJECTS with the Electron prefix when the source is missing', async () => {
    const h = createFakeHost()
    h.addFile('/g/a.md', 'a')
    await h.doAction(['copyFile', '/g', '/g/a.md', '/g/bak/x/a.md'])
    expect(h.textOf('/g/bak/x/a.md')).toBe('a')
    expect(h.has('/g/a.md')).toBe(true)
    await expect(h.doAction(['copyFile', '/g', '/g/nope', '/g/y'])).rejects.toThrow("Error invoking remote method 'main': Error: ENOENT: no such file or directory, lstat '/g/nope'")
  })

  it('unlink recycles under a graph root and deletes under the dot root', async () => {
    const h = createFakeHost({ dotRoot: '/home/u/.logseq' })
    h.addFile('/g/pages/a.md', 'a')
    h.addFile('/home/u/.logseq/storages/p/x.json', '{}')
    expect(await h.doAction(['unlink', '/g', '/g/pages/a.md'])).toBeNull()
    expect(h.has('/g/pages/a.md')).toBe(false)
    expect(h.textOf('/g/logseq/.recycle/pages_a.md')).toBe('a')
    expect(await h.doAction(['unlink', '/g', '/g/pages/gone.md'])).toBeNull()
    expect(await h.doAction(['unlink', '/home/u/.logseq', '/home/u/.logseq/storages/p/x.json'])).toBeUndefined()
    expect(h.has('/home/u/.logseq/storages/p/x.json')).toBe(false)
    expect((await h.doAction(['unlink', '/home/u/.logseq', '/home/u/.logseq/nope'])) as Error).toBeInstanceOf(Error)
    expect(await h.doAction(['getLogseqDotDirRoot'])).toBe('/home/u/.logseq')
    expect(await h.doAction(['no-such-action'])).toBeNull()
  })

  it('fetch serves file:// bytes and fails like Chromium otherwise', async () => {
    const h = createFakeHost()
    h.addFile('/g/a b.md', 'hi')
    expect(await (await h.fetch('file:///g/a%20b.md')).text()).toBe('hi')
    await expect(h.fetch('file:///g/missing')).rejects.toThrow(TypeError)
    await expect(h.fetch('https://example.com')).rejects.toThrow('Failed to fetch')
  })

  it('failNext substitutes answers per action semantics and counts down', async () => {
    const h = createFakeHost()
    h.addFile('/g/a.md', 'a')
    h.failNext({ match: (c) => c.action === 'stat', answer: new Error('EACCES: permission denied, stat'), times: 2 })
    expect(await h.doAction(['stat', '/g/a.md'])).toBeInstanceOf(Error)
    expect(await h.doAction(['stat', '/g/a.md'])).toBeInstanceOf(Error)
    expect(await h.doAction(['stat', '/g/a.md'])).toMatchObject({ size: 1 })
    h.failNext({ match: (c) => c.action === 'copyFile', answer: new Error('boom') })
    await expect(h.doAction(['copyFile', '/g', '/g/a.md', '/g/b.md'])).rejects.toThrow('boom')
    h.failNext({ match: (c) => c.action === 'rename', answer: new Error('forced reject'), mode: 'reject' })
    await expect(h.doAction(['rename', '/g/a.md', '/g/c.md'])).rejects.toThrow('forced reject')
    h.failNext({ match: (c) => c.action === 'listdir', answer: () => ['/g/from-fault.md'] })
    expect(await h.doAction(['listdir', '/g', true])).toEqual(['/g/from-fault.md'])
    expect(h.calls.filter((c) => c.action === 'stat')).toHaveLength(3)
  })
})
