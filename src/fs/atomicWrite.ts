// Plan §3.6 step 7: downloads use atomic writes, temp file then `rename`, so a crash mid-write never leaves
// a truncated page and the host's watcher sees one event for the final name. The temp name is DOT-PREFIXED
// (`pages/.Alpha.md.gdsync-tmp`): the host's `ignored-path?` (`logseq/common/graph.cljs`) hides every
// dot-prefixed segment from the chokidar watcher and from `readdir`, so Logseq never indexes a half-written
// temp file. Our own scanner ignores `*.gdsync-tmp` too (ignore.ts).

import { assertRelPath, baseName, parentDir, type FileData, type FileStat, type GraphFs } from './graphFs'

export const TMP_SUFFIX = '.gdsync-tmp'

export function tempPathFor(path: string): string {
  const dir = parentDir(path)
  return `${dir === '' ? '' : `${dir}/`}.${baseName(path)}${TMP_SUFFIX}`
}

export function isTempPath(path: string): boolean {
  return baseName(path).endsWith(TMP_SUFFIX)
}

/**
 * Writes `data` to a sibling temp file and renames it over `path`. Returns the stat of the written bytes,
 * which `rename` preserves, so the engine can store it as the file's cache entry (scanner.ts) without a
 * second `stat`. If the rename fails the temp file is left behind (invisible to Logseq, ignored by the
 * scanner); `listTempFiles` finds such leftovers for the next run to move into its bak folder.
 */
export async function writeFileAtomic(fs: GraphFs, path: string, data: FileData): Promise<FileStat> {
  assertRelPath(path)
  const tmp = tempPathFor(path)
  const stat = await fs.writeFile(tmp, data)
  await fs.rename(tmp, path)
  return stat
}

export async function listTempFiles(fs: GraphFs): Promise<string[]> {
  return (await fs.list()).filter(isTempPath).sort()
}
