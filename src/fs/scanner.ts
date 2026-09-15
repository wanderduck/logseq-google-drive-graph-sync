// Plan M5 step 3 / §3.6 step 3: the local scan. Lists the root, applies the ignore rules, stats every
// candidate and re-hashes (SHA-256) only when size or mtime differ from the caller's cache (the engine's
// `state.entries`). Bridge calls run with bounded concurrency. The recorded stat is the one taken BEFORE the
// read, so a file modified between stat and read is re-hashed on the next scan rather than trusted.

import { isFsNotFound, type GraphFs } from './graphFs'
import { sha256Hex } from './hash'
import { isIgnoredGraphPath } from './ignore'
import { mapLimit } from './limit'

export interface ScanCacheEntry {
  size: number
  mtimeMs: number
  sha256: string
}

export interface ScannedFile extends ScanCacheEntry {
  /** Root-relative, forward slashes. */
  path: string
}

export interface ScanOptions {
  /** Last known stat + hash per path (plan §3.5 `entries`); a hit on size AND mtime skips the read. */
  cache?: (path: string) => ScanCacheEntry | undefined
  /** Defaults to the plan §3.4 graph rules. */
  isIgnored?: (path: string) => boolean
  concurrency?: number
  /** Called once with `(0, total)` and after every file. */
  onProgress?: (done: number, total: number) => void
}

export interface ScanResult {
  /** Sorted by path. */
  files: ScannedFile[]
  hashed: number
  reused: number
  ignored: number
  /** Listed but gone by the time it was stat'ed or read (a file being deleted right now). */
  vanished: number
}

export const DEFAULT_SCAN_CONCURRENCY = 8

export async function scanFiles(fs: GraphFs, opts: ScanOptions = {}): Promise<ScanResult> {
  const isIgnored = opts.isIgnored ?? isIgnoredGraphPath
  const all = await fs.list()
  const candidates = all.filter((p) => !isIgnored(p)).sort()
  const total = candidates.length
  let hashed = 0
  let reused = 0
  let vanished = 0
  let done = 0
  opts.onProgress?.(0, total)

  const scanned = await mapLimit(candidates, opts.concurrency ?? DEFAULT_SCAN_CONCURRENCY, async (path): Promise<ScannedFile | null> => {
    let file: ScannedFile | null = null
    const stat = await fs.stat(path)
    if (stat === null) {
      vanished++
    } else {
      const cached = opts.cache?.(path)
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        reused++
        file = { path, size: stat.size, mtimeMs: stat.mtimeMs, sha256: cached.sha256 }
      } else {
        try {
          const bytes = await fs.readBytes(path)
          hashed++
          file = { path, size: stat.size, mtimeMs: stat.mtimeMs, sha256: await sha256Hex(bytes) }
        } catch (err) {
          if (!isFsNotFound(err)) throw err
          vanished++
        }
      }
    }
    done++
    opts.onProgress?.(done, total)
    return file
  })

  return {
    files: scanned.filter((f): f is ScannedFile => f !== null),
    hashed,
    reused,
    ignored: all.length - candidates.length,
    vanished,
  }
}
