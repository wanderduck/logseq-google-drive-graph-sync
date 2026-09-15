// Plan M5 step 2: `GraphFs` over the host's Electron IPC bridge, `window.top.apis.doAction([...])`
// (spike §1, §2). The bridge function and the `file://` fetch are injected, so this module has no host
// import and tests drive it through an emulator of the host handlers (tests/fs/fakeHost.ts).
//
// Facts this adapter is built on (verified in the 0.10.15 `electron/handler.cljs`, `electron/utils.js`,
// `logseq/common/graph.cljs`, extracted from the shipped source map, and live in the M0 spike):
// - `['listdir', dir, true]`  → flat array of ABSOLUTE non-directory paths, dot files included, `null` when
//   `dir` does not exist (`deepReadDir`). Backslashes on Windows (no `fix-win-path!` on this handler).
// - `['stat', path]`          → `{size, mtime, ctime}`; `mtime` is a host-realm `Date`; no `isDirectory`.
// - `['writeFile', repo, path, content]` → the stat of the written file. A FAILURE IS SWALLOWED: the host
//   writes a backup under `logseq/bak/`, shows an error notification and resolves `null`/`undefined`.
//   `content` may be a string (UTF-8) or an ArrayBuffer. Parent directories are not created.
// - `['rename', from, to]`, `['mkdir-recur', dir]`, `['stat', …]` are synchronous handlers: a failure
//   RESOLVES with a host-realm `Error` (`instanceof` fails across realms). `['copyFile', repo, from, to]`
//   (`fs-extra.copy`) and `listdir` are async handlers: a failure REJECTS with
//   "Error invoking remote method 'main': Error: ENOENT: …".
// - `['unlink', repo, path]`: under `~/.logseq` a real delete; elsewhere a move to `<repo>/logseq/.recycle/`,
//   with errors swallowed (resolves `null`).
// - Bytes are read with `fetch('file://…')` (`readFile` is text-only). Chromium reports any failure as
//   `TypeError: Failed to fetch`, so a failed read asks `stat` whether the file exists.

import {
  FsError,
  assertRelPath,
  fileUrl,
  isFsNotFound,
  joinAbs,
  normalizeRoot,
  parentDir,
  relativeTo,
  type FileData,
  type FileStat,
  type GraphFs,
} from './graphFs'

/** `window.top.apis.doAction` or a fake of it. */
export type BridgeCall = (args: unknown[]) => Promise<unknown>
export type FileFetch = (url: string) => Promise<Response>

export interface HostBridgeFsDeps {
  root: string
  bridge: BridgeCall
  fetch: FileFetch
  /**
   * The host's `repo` argument of `writeFile`/`copyFile`/`unlink`: the directory whose `logseq/bak/` gets
   * the failure backup and whose `logseq/.recycle/` gets unlinked files. Defaults to `root`.
   */
  repo?: string
}

const REMOTE_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/

function tag(v: unknown): string {
  return Object.prototype.toString.call(v)
}

/** Cross-realm safe `instanceof Error`: the host's Error objects come from another JS realm. */
export function isHostError(v: unknown): v is Error {
  return tag(v) === '[object Error]'
}

/** Host-realm `Date`, epoch number or ISO string → epoch ms; `null` for anything else. */
export function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  if (tag(v) === '[object Date]') {
    const t = (v as Date).getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** The Node error code at the start of a message (`ENOENT: no such file or directory, stat '/x'`). */
export function errorCode(message: string): string | null {
  const m = /^([A-Z][A-Z0-9]+):/.exec(message)
  return m ? m[1] : null
}

function messageOf(e: unknown): string {
  if (typeof e === 'string') return e
  if (e !== null && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

function fsErrorFrom(op: string, path: string, raw: unknown): FsError {
  const message = messageOf(raw).replace(REMOTE_PREFIX, '')
  return new FsError(op, path, errorCode(message) ?? 'EBRIDGE', `${op} ${path}: ${message}`, raw)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

function parseStat(op: string, path: string, r: unknown): FileStat {
  const size = isRecord(r) ? r.size : undefined
  const mtimeMs = isRecord(r) ? toEpochMs(r.mtime) : null
  if (typeof size !== 'number' || !Number.isFinite(size) || mtimeMs === null) {
    throw new FsError(op, path, 'EBRIDGE', `${op} ${path}: the host returned ${tag(r)} instead of a stat`)
  }
  return { size, mtimeMs }
}

/** A string as is; a Uint8Array as an exactly-sized ArrayBuffer (the host's `instanceof ArrayBuffer` branch). */
function toPayload(data: FileData): string | ArrayBuffer {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return data
  if (data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer
  return data.slice().buffer
}

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true })

export function createHostBridgeFs(deps: HostBridgeFsDeps): GraphFs {
  const root = normalizeRoot(deps.root)
  const repo = deps.repo === undefined ? root : normalizeRoot(deps.repo)
  const { bridge, fetch } = deps
  const abs = (rel: string): string => joinAbs(root, rel)

  /** One bridge call with both failure surfaces (resolved Error, rejection) turned into `FsError`. */
  async function call(op: string, path: string, args: unknown[]): Promise<unknown> {
    let result: unknown
    try {
      result = await bridge(args)
    } catch (err) {
      throw fsErrorFrom(op, path, err)
    }
    if (isHostError(result)) throw fsErrorFrom(op, path, result)
    return result
  }

  async function stat(path: string): Promise<FileStat | null> {
    assertRelPath(path, true)
    let r: unknown
    try {
      r = await call('stat', path, ['stat', abs(path)])
    } catch (err) {
      if (isFsNotFound(err)) return null
      throw err
    }
    return parseStat('stat', path, r)
  }

  async function mkdirp(dir: string): Promise<void> {
    assertRelPath(dir, true)
    if (dir === '') return
    await call('mkdir', dir, ['mkdir-recur', abs(dir)])
  }

  async function readBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
    assertRelPath(path)
    let res: Response
    try {
      res = await fetch(fileUrl(abs(path)))
    } catch (err) {
      if ((await stat(path)) === null) throw new FsError('read', path, 'ENOENT', `read ${path}: no such file`, err)
      throw new FsError('read', path, 'EIO', `read ${path}: ${messageOf(err)} (a directory or a symlink cannot be read)`, err)
    }
    if (!res.ok) throw new FsError('read', path, 'EIO', `read ${path}: HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  return {
    root,

    async list(dir = '') {
      assertRelPath(dir, true)
      const r = await call('list', dir, ['listdir', abs(dir), true])
      if (r === null || r === undefined) return []
      if (!Array.isArray(r)) throw new FsError('list', dir, 'EBRIDGE', `list ${dir}: the host returned ${tag(r)} instead of an array`)
      const out: string[] = []
      for (const item of r) {
        if (typeof item !== 'string') continue
        const rel = relativeTo(root, item)
        if (rel !== null && rel !== '') out.push(rel)
      }
      return out
    },

    stat,
    readBytes,

    async readText(path) {
      return utf8.decode(await readBytes(path))
    },

    async writeFile(path, data) {
      assertRelPath(path)
      await mkdirp(parentDir(path))
      const r = await call('write', path, ['writeFile', repo, abs(path), toPayload(data)])
      if (r === null || r === undefined) {
        throw new FsError('write', path, 'EWRITE', `write ${path}: the host could not write the file (it shows the reason as a Logseq notification)`)
      }
      return parseStat('write', path, r)
    },

    async rename(from, to) {
      assertRelPath(from)
      assertRelPath(to)
      await mkdirp(parentDir(to))
      await call('rename', from, ['rename', abs(from), abs(to)])
    },

    async copyFile(from, to) {
      assertRelPath(from)
      assertRelPath(to)
      await mkdirp(parentDir(to))
      await call('copy', from, ['copyFile', repo, abs(from), abs(to)])
    },

    mkdirp,

    async unlink(path) {
      assertRelPath(path)
      await call('unlink', path, ['unlink', repo, abs(path)])
    },
  }
}
