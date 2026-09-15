import { describe, expect, it } from 'vitest'
import { BAK_ROOT, bakDirFor, bakStamp, createBakSession } from '../../src/fs/bak'
import { isIgnoredGraphPath } from '../../src/fs/ignore'
import { createFakeGraphFs } from './fakeHost'

const AT = new Date(2026, 8, 15, 3, 45, 7) // local time

describe('bak sessions (plan §3.6 step 7 + amendment)', () => {
  it('names the folder by a local-time stamp under logseq/bak/gdsync, which the scanner ignores', () => {
    expect(bakStamp(AT)).toBe('20260915-034507')
    expect(bakDirFor(AT)).toBe(`${BAK_ROOT}/20260915-034507`)
    expect(bakDirFor(AT, 'restore')).toBe(`${BAK_ROOT}/restore-20260915-034507`)
    expect(BAK_ROOT).toBe('logseq/bak/gdsync')
    expect(isIgnoredGraphPath(`${bakDirFor(AT)}/pages/a.md`)).toBe(true)
    // Logseq's own `ignored-path?` also skips everything under logseq/bak.
    expect(bakDirFor(AT).startsWith('logseq/bak')).toBe(true)
  })

  it('backupCopy keeps the original and copies with the relative path preserved', async () => {
    const { fs, host } = createFakeGraphFs({ 'pages/Alpha.md': 'v1', 'assets/sub/pic.png': new Uint8Array([7]) })
    const bak = createBakSession(fs, AT)
    expect(bak.dir).toBe('logseq/bak/gdsync/20260915-034507')
    expect(await bak.backupCopy('pages/Alpha.md')).toBe('logseq/bak/gdsync/20260915-034507/pages/Alpha.md')
    expect(await bak.backupCopy('assets/sub/pic.png')).toBe('logseq/bak/gdsync/20260915-034507/assets/sub/pic.png')
    expect(await fs.readText('pages/Alpha.md')).toBe('v1')
    expect(await fs.readText('logseq/bak/gdsync/20260915-034507/pages/Alpha.md')).toBe('v1')
    expect([...(await fs.readBytes('logseq/bak/gdsync/20260915-034507/assets/sub/pic.png'))]).toEqual([7])
    expect(host.calls.filter((c) => c.action === 'copyFile')).toHaveLength(2)
    expect(host.calls.filter((c) => c.action === 'rename')).toHaveLength(0)
    await expect(bak.backupCopy('pages/missing.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('moveIn renames (never unlinks) and suffixes ~N when the same path lands twice', async () => {
    const { fs, host } = createFakeGraphFs({ 'pages/Alpha.md': 'v1' })
    const bak = createBakSession(fs, AT)
    expect(await bak.moveIn('pages/Alpha.md')).toBe('logseq/bak/gdsync/20260915-034507/pages/Alpha.md')
    expect(await fs.stat('pages/Alpha.md')).toBeNull()
    expect(host.has('/graphs/g/logseq/.recycle/pages_Alpha.md')).toBe(false)
    expect(host.calls.filter((c) => c.action === 'unlink')).toHaveLength(0)

    await fs.writeFile('pages/Alpha.md', 'v2')
    expect(await bak.backupCopy('pages/Alpha.md')).toBe('logseq/bak/gdsync/20260915-034507/pages/Alpha.md~1')
    expect(await bak.moveIn('pages/Alpha.md')).toBe('logseq/bak/gdsync/20260915-034507/pages/Alpha.md~2')
    expect(host.filesUnder('/graphs/g/logseq/bak')).toEqual([
      '/graphs/g/logseq/bak/gdsync/20260915-034507/pages/Alpha.md',
      '/graphs/g/logseq/bak/gdsync/20260915-034507/pages/Alpha.md~1',
      '/graphs/g/logseq/bak/gdsync/20260915-034507/pages/Alpha.md~2',
    ])
    expect(await fs.readText('logseq/bak/gdsync/20260915-034507/pages/Alpha.md')).toBe('v1')
    expect(await fs.readText('logseq/bak/gdsync/20260915-034507/pages/Alpha.md~2')).toBe('v2')
    await expect(bak.moveIn('pages/Alpha.md')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(bak.moveIn('/abs')).rejects.toMatchObject({ code: 'EINVAL' })
  })
})
