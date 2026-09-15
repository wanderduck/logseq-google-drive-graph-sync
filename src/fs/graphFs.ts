// Plan M5 step 1: the one file-system seam of the plugin. Everything that touches the graph directory or
// ~/.logseq goes through `GraphFs`, so the unofficial host bridge behind `HostBridgeFs` (plan D4, spike §1)
// can be swapped out if a Logseq update breaks it (plan §7 risk table). Pure TS: no host imports here.
//
// Paths handed to a `GraphFs` are root-relative, forward-slash, without `.`/`..` or empty segments;
// `''` names the root itself where a directory is expected. Roots: the graph directory (`App.getCurrentGraph().path`)
// or `~/.logseq` for the profile bundle (M8).

export interface FileStat {
  size: number
  /** Epoch ms, integer (the host's `Date` via `getTime()`). */
  mtimeMs: number
}

export type FileData = string | Uint8Array | ArrayBuffer

export interface GraphFs {
  /** Absolute root, forward slashes, no trailing slash. */
  readonly root: string
  /**
   * Every non-directory under `dir` (default: the whole root) as root-relative paths, in no particular
   * order. Dot files and dot directories are included; the ignore rules (ignore.ts) are the scanner's job.
   * A missing directory lists as empty.
   */
  list(dir?: string): Promise<string[]>
  /**
   * `null` when nothing exists at `path`. A directory stats too (the bridge cannot tell them apart,
   * spike §2 item 2b), so "is it a directory" is answered by `list`, not `stat`.
   */
  stat(path: string): Promise<FileStat | null>
  /** Exact bytes. Rejects with an `ENOENT` `FsError` when the file is missing. */
  readBytes(path: string): Promise<Uint8Array<ArrayBuffer>>
  /** UTF-8 decoded without dropping a BOM, so `writeFile(readText())` is byte-identical. */
  readText(path: string): Promise<string>
  /** Overwrites in place (NOT atomic, see atomicWrite.ts), creating parent directories. Strings are written as UTF-8. */
  writeFile(path: string, data: FileData): Promise<FileStat>
  /** Moves a file (or a directory), creating the parents of `to`; an existing file at `to` is replaced. */
  rename(from: string, to: string): Promise<void>
  /** Copies a file, creating the parents of `to`. */
  copyFile(from: string, to: string): Promise<void>
  /** `mkdir -p`; a no-op for `''` or an existing directory. */
  mkdirp(dir: string): Promise<void>
  /**
   * Host semantics (spike §2 item 2b, `handler.cljs :unlink`): under a graph root the host MOVES the file
   * to `logseq/.recycle/`; under ~/.logseq it really deletes. Sync deletions never use this: they go to
   * `logseq/bak/gdsync/<ts>/` by `rename` (bak.ts).
   */
  unlink(path: string): Promise<void>
}

/**
 * Every failure of a `GraphFs` operation. `code` is the Node error code when the host reported one
 * (`ENOENT`, `EEXIST`, `EACCES`, …), `EINVAL` for a rejected path, `EBRIDGE` when the bridge answered
 * with something unexpected, `EWRITE` when the host swallowed a write failure, `EIO` for a failed read.
 */
export class FsError extends Error {
  readonly op: string
  readonly path: string
  readonly code: string

  constructor(op: string, path: string, code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'FsError'
    this.op = op
    this.path = path
    this.code = code
  }
}

export function isFsNotFound(err: unknown): boolean {
  return err instanceof FsError && err.code === 'ENOENT'
}

function slashes(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Absolute (`/…` or `X:/…`), forward slashes, no trailing slash (except the bare `/`). */
export function normalizeRoot(root: string): string {
  let r = slashes(root.trim())
  if (r.length > 1) r = r.replace(/\/+$/, '')
  if (!(r.startsWith('/') || /^[A-Za-z]:\//.test(r) || /^[A-Za-z]:$/.test(r))) {
    throw new FsError('root', root, 'EINVAL', `the root must be an absolute path, got "${root}"`)
  }
  return r
}

/** Validates a root-relative path. Returns it unchanged. `allowRoot` accepts `''` (the root itself). */
export function assertRelPath(path: string, allowRoot = false): string {
  if (path === '') {
    if (allowRoot) return path
    throw new FsError('path', path, 'EINVAL', 'an empty path names the root; a file path is needed here')
  }
  if (path.includes('\\')) throw new FsError('path', path, 'EINVAL', `use forward slashes: "${path}"`)
  if (path.startsWith('/')) throw new FsError('path', path, 'EINVAL', `paths are root-relative, not absolute: "${path}"`)
  if (path.endsWith('/')) throw new FsError('path', path, 'EINVAL', `no trailing slash: "${path}"`)
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new FsError('path', path, 'EINVAL', `"${path}" has an empty, "." or ".." segment`)
    }
  }
  return path
}

function prefixOf(root: string): string {
  return root.endsWith('/') ? root : `${root}/`
}

/** `root` + `rel`; `rel === ''` gives the root. */
export function joinAbs(root: string, rel: string): string {
  return rel === '' ? root : prefixOf(root) + rel
}

/** The root-relative form of an absolute path (backslashes accepted), `''` for the root itself, `null` when outside. */
export function relativeTo(root: string, abs: string): string | null {
  const a = slashes(abs)
  if (a === root) return ''
  const prefix = prefixOf(root)
  return a.startsWith(prefix) ? a.slice(prefix.length) : null
}

/** `'pages/a.md'` → `'pages'`; `'a.md'` → `''`. */
export function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * `file://` URL for `fetch` (spike §2 item 2c: exact bytes, needs escaping). Every segment is
 * percent-encoded (so `#`, `?`, `%` and spaces survive, which `encodeURI` would not guarantee); a Windows
 * drive letter is kept literal and given the leading slash Chromium expects (`file:///C:/…`).
 */
export function fileUrl(absPath: string): string {
  const p = slashes(absPath)
  const segments = p.split('/')
  const encoded = segments.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)))
  const path = encoded.join('/')
  return `file://${path.startsWith('/') ? '' : '/'}${path}`
}
