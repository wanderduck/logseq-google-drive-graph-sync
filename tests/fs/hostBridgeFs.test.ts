import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { FsError, isFsNotFound } from '../../src/fs/graphFs'
import { createHostBridgeFs, errorCode, isHostError, toEpochMs } from '../../src/fs/hostBridgeFs'
import { createFakeGraphFs, createFakeHost } from './fakeHost'

describe('cross-realm helpers', () => {
  it('isHostError / toEpochMs recognise objects from another JS realm', () => {
    const foreignError: unknown = runInNewContext('new Error("ENOENT: no such file or directory, stat \'/x\'")')
    const foreignDate: unknown = runInNewContext('new Date(1700000000123)')
    expect(foreignError instanceof Error).toBe(false)
    expect(isHostError(foreignError)).toBe(true)
    expect(isHostError(new Error('x'))).toBe(true)
    expect(isHostError({ message: 'x' })).toBe(false)
    expect(isHostError(null)).toBe(false)
    expect(foreignDate instanceof Date).toBe(false)
    expect(toEpochMs(foreignDate)).toBe(1700000000123)
    expect(toEpochMs(new Date(5))).toBe(5)
    expect(toEpochMs(1700000000123.7)).toBe(1700000000123)
    expect(toEpochMs('2026-09-15T00:00:00.000Z')).toBe(Date.UTC(2026, 8, 15))
    expect(toEpochMs('nope')).toBeNull()
    expect(toEpochMs(new Date(Number.NaN))).toBeNull()
    expect(toEpochMs(null)).toBeNull()
  })

  it('errorCode reads the Node code off a message', () => {
    expect(errorCode("ENOENT: no such file or directory, stat '/x'")).toBe('ENOENT')
    expect(errorCode('EEXIST: file already exists, mkdir')).toBe('EEXIST')
    expect(errorCode('something else')).toBeNull()
  })
})

describe('createHostBridgeFs (plan M5 step 2)', () => {
  it('normalises the root and rejects bad paths before touching the bridge', async () => {
    const { fs, host } = createFakeGraphFs({}, { root: '/graphs/g/' })
    expect(fs.root).toBe('/graphs/g')
    await expect(fs.stat('/abs')).rejects.toThrow(FsError)
    await expect(fs.readBytes('')).rejects.toThrow(/empty path/)
    await expect(fs.writeFile('a/../b', 'x')).rejects.toThrow(/segment/)
    expect(host.calls).toHaveLength(0)
  })

  it('list returns root-relative paths, hides paths outside the root, normalises backslashes, and treats null as empty', async () => {
    const { fs, host } = createFakeGraphFs({ 'pages/a.md': 'a', 'logseq/.recycle/x': 'x', '.gitignore': '' })
    host.addFile('/graphs/other/z.md', 'z')
    expect((await fs.list()).sort()).toEqual(['.gitignore', 'logseq/.recycle/x', 'pages/a.md'])
    expect(await fs.list('pages')).toEqual(['pages/a.md'])
    expect(await fs.list('missing')).toEqual([])
    expect(host.calls.at(-1)).toEqual({ action: 'listdir', args: ['/graphs/g/missing', true] })
    host.failNext({ match: (c) => c.action === 'listdir', answer: () => ['/graphs/g\\pages\\w.md', '/graphs/g', 42] })
    expect(await fs.list()).toEqual(['pages/w.md'])
    host.failNext({ match: (c) => c.action === 'listdir', answer: () => 'not an array' })
    await expect(fs.list()).rejects.toMatchObject({ code: 'EBRIDGE' })
  })

  it('stat converts the host Date, returns null for ENOENT and throws other errors', async () => {
    const { fs, host } = createFakeGraphFs({ 'pages/a.md': 'abc' }, { now: () => 1234 })
    expect(await fs.stat('pages/a.md')).toEqual({ size: 3, mtimeMs: 1234 })
    expect(await fs.stat('')).toMatchObject({ size: 4096 })
    expect(await fs.stat('pages/missing.md')).toBeNull()
    host.failNext({ match: (c) => c.action === 'stat', answer: runInNewContext("new Error(\"EACCES: permission denied, stat '/graphs/g/pages/a.md'\")") })
    await expect(fs.stat('pages/a.md')).rejects.toMatchObject({ code: 'EACCES', op: 'stat', path: 'pages/a.md' })
    host.failNext({ match: (c) => c.action === 'stat', answer: () => ({ size: 'big', mtime: null }) })
    await expect(fs.stat('pages/a.md')).rejects.toMatchObject({ code: 'EBRIDGE' })
    host.failNext({ match: (c) => c.action === 'stat', answer: new Error('boom'), mode: 'reject' })
    await expect(fs.stat('pages/a.md')).rejects.toMatchObject({ code: 'EBRIDGE', message: 'stat pages/a.md: boom' })
  })

  it('readBytes / readText fetch file:// with escaping, keep a BOM, and classify failures', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])
    const { fs, host } = createFakeGraphFs({ 'pages/Meeting Notes – Café.md': 'café', 'bom.md': bom })
    expect(await fs.readText('pages/Meeting Notes – Café.md')).toBe('café')
    expect([...(await fs.readBytes('bom.md'))]).toEqual([...bom])
    expect(await fs.readText('bom.md')).toBe('﻿hi')
    try {
      await fs.readBytes('pages/missing.md')
      expect.unreachable()
    } catch (err) {
      expect(isFsNotFound(err)).toBe(true)
      expect((err as FsError).op).toBe('read')
    }
    // Exists per stat (a directory) but fetch fails → EIO, not ENOENT.
    host.addDir('/graphs/g/somedir')
    await expect(fs.readBytes('somedir')).rejects.toMatchObject({ code: 'EIO' })
  })

  it('writeFile creates parents, sends strings and exact ArrayBuffers, returns the stat, and detects a swallowed failure', async () => {
    const { fs, host } = createFakeGraphFs({}, { now: () => 77 })
    expect(await fs.writeFile('pages/new/deep.md', 'text')).toEqual({ size: 4, mtimeMs: 77 })
    expect(host.dirs.has('/graphs/g/pages/new')).toBe(true)
    expect(host.textOf('/graphs/g/pages/new/deep.md')).toBe('text')
    expect(host.calls.map((c) => c.action)).toEqual(['mkdir-recur', 'writeFile'])
    expect(host.calls[1].args).toEqual(['/graphs/g', '/graphs/g/pages/new/deep.md', 'text'])

    // A view into a bigger buffer must be sent as an exactly-sized ArrayBuffer.
    const big = new Uint8Array([9, 9, 1, 2, 3, 9])
    await fs.writeFile('assets/x.bin', big.subarray(2, 5))
    const sent = host.calls.at(-1)!.args[2]
    expect(sent).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(sent as ArrayBuffer)]).toEqual([1, 2, 3])
    expect([...(await fs.readBytes('assets/x.bin'))]).toEqual([1, 2, 3])
    const exact = new Uint8Array([4, 5])
    await fs.writeFile('assets/y.bin', exact)
    expect(host.calls.at(-1)!.args[2]).toBe(exact.buffer)
    await fs.writeFile('assets/z.bin', new Uint8Array([6]).buffer)
    expect([...(await fs.readBytes('assets/z.bin'))]).toEqual([6])

    host.failNext({ match: (c) => c.action === 'writeFile', answer: null })
    await expect(fs.writeFile('pages/a.md', 'x')).rejects.toMatchObject({ code: 'EWRITE' })
  })

  it('rename and copyFile create the parents of the target; copy failures arrive as rejections', async () => {
    const { fs, host } = createFakeGraphFs({ 'pages/a.md': 'a', 'pages/b.md': 'b' })
    await fs.rename('pages/a.md', 'logseq/bak/gdsync/1/pages/a.md')
    expect(host.textOf('/graphs/g/logseq/bak/gdsync/1/pages/a.md')).toBe('a')
    expect(await fs.stat('pages/a.md')).toBeNull()
    await fs.rename('logseq/bak/gdsync/1/pages/a.md', 'pages/b.md') // replaces
    expect(await fs.readText('pages/b.md')).toBe('a')
    await expect(fs.rename('pages/nope.md', 'pages/x.md')).rejects.toMatchObject({ code: 'ENOENT', op: 'rename' })

    await fs.copyFile('pages/b.md', 'logseq/bak/gdsync/2/pages/b.md')
    expect(await fs.readText('logseq/bak/gdsync/2/pages/b.md')).toBe('a')
    expect(await fs.readText('pages/b.md')).toBe('a')
    expect(host.calls.at(-1)).toEqual({ action: 'copyFile', args: ['/graphs/g', '/graphs/g/pages/b.md', '/graphs/g/logseq/bak/gdsync/2/pages/b.md'] })
    try {
      await fs.copyFile('pages/nope.md', 'x/y.md')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(FsError)
      expect((err as FsError).code).toBe('ENOENT')
      expect((err as FsError).message).toBe("copy pages/nope.md: ENOENT: no such file or directory, lstat '/graphs/g/pages/nope.md'")
    }
  })

  it('mkdirp is a no-op for the root and unlink passes the repo through (recycle semantics live in the host)', async () => {
    const { fs, host } = createFakeGraphFs({ 'pages/a.md': 'a' })
    await fs.mkdirp('')
    expect(host.calls).toHaveLength(0)
    await fs.mkdirp('a/b/c')
    expect(host.dirs.has('/graphs/g/a/b/c')).toBe(true)
    await fs.unlink('pages/a.md')
    expect(host.calls.at(-1)).toEqual({ action: 'unlink', args: ['/graphs/g', '/graphs/g/pages/a.md'] })
    expect(host.textOf('/graphs/g/logseq/.recycle/pages_a.md')).toBe('a')
    await fs.unlink('pages/a.md') // the host swallows a missing file
  })

  it('a profile root under ~/.logseq deletes on unlink and uses its own repo', async () => {
    const host = createFakeHost({ dotRoot: '/home/u/.logseq' })
    host.addFile('/home/u/.logseq/settings/x.json', '{}')
    const fs = createHostBridgeFs({ root: '/home/u/.logseq', bridge: host.doAction, fetch: host.fetch })
    expect(await fs.list('settings')).toEqual(['settings/x.json'])
    await fs.unlink('settings/x.json')
    expect(host.has('/home/u/.logseq/settings/x.json')).toBe(false)
    expect(host.filesUnder('/home/u/.logseq')).toEqual([])
    const custom = createHostBridgeFs({ root: '/graphs/g', repo: '/graphs/g/', bridge: host.doAction, fetch: host.fetch })
    host.addFile('/graphs/g/a.md', 'a')
    await custom.writeFile('b.md', 'b')
    expect(host.calls.at(-1)!.args[0]).toBe('/graphs/g')
  })
})
