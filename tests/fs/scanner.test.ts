import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../../src/fs/hash'
import { scanFiles, type ScanCacheEntry } from '../../src/fs/scanner'
import { createFakeGraphFs } from './fakeHost'

const SHA_A = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' // sha256("a")

function graph(now = () => 1000) {
  return createFakeGraphFs(
    {
      'pages/Alpha.md': 'a',
      'pages/Beta.md': 'bb',
      'journals/2026_09_15.md': 'j',
      'assets/pic.png': new Uint8Array([1, 2, 3]),
      'logseq/config.edn': '{}',
      'logseq/bak/pages/Alpha/old.md': 'old',
      'logseq/.recycle/pages_gone.md': 'gone',
      '.git/HEAD': 'ref',
      'pages/.Beta.md.gdsync-tmp': 'partial',
    },
    { now },
  )
}

describe('scanFiles (plan M5 step 3)', () => {
  it('lists, filters ignored paths, hashes everything on a cold run, sorted by path', async () => {
    const { fs } = graph()
    const progress: Array<[number, number]> = []
    const r = await scanFiles(fs, { onProgress: (d, t) => progress.push([d, t]) })
    expect(r.files.map((f) => f.path)).toEqual(['assets/pic.png', 'journals/2026_09_15.md', 'logseq/config.edn', 'pages/Alpha.md', 'pages/Beta.md'])
    expect(r).toMatchObject({ hashed: 5, reused: 0, ignored: 4, vanished: 0 })
    expect(r.files[3]).toEqual({ path: 'pages/Alpha.md', size: 1, mtimeMs: 1000, sha256: SHA_A })
    expect(r.files[0].sha256).toBe(await sha256Hex(new Uint8Array([1, 2, 3])))
    expect(progress[0]).toEqual([0, 5])
    expect(progress.at(-1)).toEqual([5, 5])
    expect(progress).toHaveLength(6)
  })

  it('reuses cached hashes only when size and mtime both match', async () => {
    let t = 1000
    const { fs, host } = graph(() => t)
    const first = await scanFiles(fs)
    const cache = new Map(first.files.map((f) => [f.path, f as ScanCacheEntry]))
    const readsBefore = host.calls.length

    const second = await scanFiles(fs, { cache: (p) => cache.get(p) })
    expect(second).toMatchObject({ hashed: 0, reused: 5 })
    expect(second.files).toEqual(first.files)
    // A warm scan is one listdir + one stat per file; no fetches (those are not bridge calls, so count stats only).
    expect(host.calls.slice(readsBefore).map((c) => c.action)).toEqual(['listdir', 'stat', 'stat', 'stat', 'stat', 'stat'])

    // Same size, new mtime → re-hash. Same mtime, new size → re-hash. Both same → reuse.
    t = 2000
    host.addFile('/graphs/g/pages/Alpha.md', 'z')
    host.addFile('/graphs/g/pages/Beta.md', 'bbb', { mtimeMs: 1000 })
    const third = await scanFiles(fs, { cache: (p) => cache.get(p) })
    expect(third).toMatchObject({ hashed: 2, reused: 3 })
    const alpha = third.files.find((f) => f.path === 'pages/Alpha.md')!
    expect(alpha).toEqual({ path: 'pages/Alpha.md', size: 1, mtimeMs: 2000, sha256: await sha256Hex('z') })
    expect(third.files.find((f) => f.path === 'pages/Beta.md')).toMatchObject({ size: 3, sha256: await sha256Hex('bbb') })
    // A stale cache hash is never trusted when the stat moved on.
    expect(alpha.sha256).not.toBe(SHA_A)
  })

  it('counts a file that vanishes between list and stat, or between stat and read, without failing', async () => {
    const { fs, host } = graph()
    host.failNext({ match: (c) => c.action === 'listdir', answer: () => ['/graphs/g/pages/Alpha.md', '/graphs/g/pages/Ghost.md'] })
    const r = await scanFiles(fs)
    expect(r).toMatchObject({ hashed: 1, vanished: 1, ignored: 0 })
    expect(r.files.map((f) => f.path)).toEqual(['pages/Alpha.md'])

    // Stat says it exists, then the read finds nothing.
    host.failNext({ match: (c) => c.action === 'listdir', answer: () => ['/graphs/g/pages/Alpha.md'] })
    host.failNext({ match: (c) => c.action === 'stat', answer: () => ({ size: 1, mtime: new Date(1) }) })
    host.files.delete('/graphs/g/pages/Alpha.md')
    const r2 = await scanFiles(fs)
    expect(r2).toMatchObject({ hashed: 0, vanished: 1 })
    expect(r2.files).toEqual([])
  })

  it('propagates other errors, honours a custom ignore rule and the concurrency limit', async () => {
    const { fs, host } = graph()
    host.failNext({ match: (c) => c.action === 'stat' && String(c.args[0]).endsWith('Beta.md'), answer: new Error('EACCES: permission denied, stat') })
    await expect(scanFiles(fs)).rejects.toMatchObject({ code: 'EACCES', path: 'pages/Beta.md' })

    const onlyPages = await scanFiles(fs, { isIgnored: (p) => !p.startsWith('pages/') || p.endsWith('.gdsync-tmp') })
    expect(onlyPages.files.map((f) => f.path)).toEqual(['pages/Alpha.md', 'pages/Beta.md'])
    expect(onlyPages.ignored).toBe(7)

    let inFlight = 0
    let peak = 0
    const slowFs = {
      ...fs,
      stat: async (p: string) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 2))
        inFlight--
        return fs.stat(p)
      },
    }
    await scanFiles(slowFs, { concurrency: 2 })
    expect(peak).toBe(2)
  })
})
