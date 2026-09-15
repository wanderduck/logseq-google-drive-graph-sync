import { describe, expect, it } from 'vitest'
import { isIgnoredGraphPath } from '../../src/fs/ignore'

describe('isIgnoredGraphPath (plan §3.4)', () => {
  it('ignores the listed directories, names and suffixes', () => {
    const ignored = [
      'logseq/bak/pages/a/2026.Desktop.md',
      'logseq/bak',
      'logseq/.recycle/pages_a.md',
      'logseq/version-files/local/pages/a/x.md',
      '.git/HEAD',
      '.git',
      'sub/.git/config',
      '.DS_Store',
      'assets/.DS_Store',
      'Thumbs.db',
      'assets/thumbs.db',
      'pages/.a.md.swp',
      'pages/a.md~',
      'pages/.a.md.gdsync-tmp',
      'logseq/bak/gdsync/20260915-120000/pages/a.md',
      'logseq/graphs-txid.edn',
      'logseq/pages-metadata.edn',
    ]
    for (const p of ignored) expect(isIgnoredGraphPath(p), p).toBe(true)
  })

  it('keeps everything else, including dot files and near-miss names', () => {
    const kept = [
      'pages/a.md',
      'journals/2026_09_15.md',
      'logseq/config.edn',
      'logseq/custom.css',
      'logseq/bakery.md',
      'logseq/recycle.md',
      'assets/img_1.png',
      '.gitignore',
      'pages/git/notes.md',
      'pages/tilde~notes.md',
      'pages/swp.md',
      'draws/x.excalidraw',
      'DS_Store.md',
      'pages/graphs-txid.edn',
      'logseq/graphs-txid.edn.bak',
    ]
    for (const p of kept) expect(isIgnoredGraphPath(p), p).toBe(false)
  })
})
