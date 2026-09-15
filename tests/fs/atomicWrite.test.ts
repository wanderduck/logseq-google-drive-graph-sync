import { describe, expect, it } from 'vitest'
import { TMP_SUFFIX, isTempPath, listTempFiles, tempPathFor, writeFileAtomic } from '../../src/fs/atomicWrite'
import { isIgnoredGraphPath } from '../../src/fs/ignore'
import { createFakeGraphFs } from './fakeHost'

describe('atomic writes (plan §3.6 step 7)', () => {
  it('temp names are dot-prefixed siblings that the ignore rules hide', () => {
    expect(tempPathFor('pages/Alpha.md')).toBe(`pages/.Alpha.md${TMP_SUFFIX}`)
    expect(tempPathFor('a.md')).toBe(`.a.md${TMP_SUFFIX}`)
    expect(isTempPath('pages/.Alpha.md.gdsync-tmp')).toBe(true)
    expect(isTempPath('pages/Alpha.md')).toBe(false)
    expect(isIgnoredGraphPath(tempPathFor('pages/Alpha.md'))).toBe(true)
    // Dot-prefixed, so the host's own `ignored-path?` (`/\.[^.]+`) hides it from the watcher too.
    expect(/(^|\/)\.[^.]+/.test(tempPathFor('pages/Alpha.md'))).toBe(true)
  })

  it('writes the temp file, renames it over the target, returns the stat, and leaves no temp file', async () => {
    const { fs, host } = createFakeGraphFs({ 'pages/Alpha.md': 'old' }, { now: () => 42 })
    const stat = await writeFileAtomic(fs, 'pages/Alpha.md', 'new content')
    const calls = [...host.calls]
    expect(stat).toEqual({ size: 11, mtimeMs: 42 })
    expect(await fs.stat('pages/Alpha.md')).toEqual(stat)
    expect(await fs.readText('pages/Alpha.md')).toBe('new content')
    expect(host.filesUnder('/graphs/g')).toEqual(['/graphs/g/pages/Alpha.md'])
    expect(calls.map((c) => c.action)).toEqual(['mkdir-recur', 'writeFile', 'mkdir-recur', 'rename'])
    expect(calls[1].args[1]).toBe('/graphs/g/pages/.Alpha.md.gdsync-tmp')
    expect(calls[3].args).toEqual(['/graphs/g/pages/.Alpha.md.gdsync-tmp', '/graphs/g/pages/Alpha.md'])
  })

  it('creates parent directories for a new file and writes bytes exactly', async () => {
    const { fs } = createFakeGraphFs()
    const bytes = new Uint8Array([0, 255, 1, 2])
    await writeFileAtomic(fs, 'assets/new/dir/x.bin', bytes)
    expect([...(await fs.readBytes('assets/new/dir/x.bin'))]).toEqual([0, 255, 1, 2])
    expect(await listTempFiles(fs)).toEqual([])
  })

  it('a failed rename leaves the original untouched and the temp file behind for listTempFiles', async () => {
    const { fs, host } = createFakeGraphFs({ 'pages/Alpha.md': 'old' })
    host.failNext({ match: (c) => c.action === 'rename', answer: new Error("EACCES: permission denied, rename '/x' -> '/y'") })
    await expect(writeFileAtomic(fs, 'pages/Alpha.md', 'new')).rejects.toMatchObject({ code: 'EACCES', op: 'rename' })
    expect(await fs.readText('pages/Alpha.md')).toBe('old')
    expect(await listTempFiles(fs)).toEqual(['pages/.Alpha.md.gdsync-tmp'])
    expect(await fs.readText('pages/.Alpha.md.gdsync-tmp')).toBe('new')
    // A failed write never gets as far as the rename.
    host.failNext({ match: (c) => c.action === 'writeFile', answer: null })
    await expect(writeFileAtomic(fs, 'pages/Beta.md', 'b')).rejects.toMatchObject({ code: 'EWRITE' })
    expect(host.calls.filter((c) => c.action === 'rename')).toHaveLength(1)
    expect(await fs.stat('pages/Beta.md')).toBeNull()
  })
})
