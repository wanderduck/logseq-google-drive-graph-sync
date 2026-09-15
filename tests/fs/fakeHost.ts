// FakeHost (plan M5 step 4 "FakeGraphFs"): an in-memory emulation of the host's Electron IPC handlers
// (`window.top.apis.doAction`) and of `fetch('file://…')`, with the exact quirks of Logseq 0.10.15's
// `electron/handler.cljs` / `electron/utils.js` / `logseq/common/graph.cljs` (see src/fs/hostBridgeFs.ts):
// sync handlers RESOLVE with an Error, async handlers (`copyFile`, `listdir`) REJECT with the Electron prefix,
// a failed `writeFile` resolves `null` after "showing a notification", `unlink` recycles under a graph root
// and deletes under the dot root, `stat` cannot tell directories. The real `HostBridgeFs` runs on top of it,
// so there is exactly one `GraphFs` implementation (same decision as FakeDrive in M4).
// Not a test file (Vitest only picks up `*.test.ts`).

import { createHostBridgeFs, type BridgeCall, type FileFetch } from '../../src/fs/hostBridgeFs'
import type { GraphFs } from '../../src/fs/graphFs'

export interface FakeFile {
  bytes: Uint8Array
  mtimeMs: number
}

export interface FakeHostCall {
  action: string
  args: unknown[]
}

export interface HostFault {
  match: (call: FakeHostCall) => boolean
  /** An `Error` is delivered the way the host delivers one for that action (see `mode`); a function computes the value to resolve with; anything else is resolved as is. */
  answer: Error | ((call: FakeHostCall) => unknown) | unknown
  /** How an `Error` answer is delivered. Default: per action (`copyFile`/`listdir` reject, the rest resolve). */
  mode?: 'resolve' | 'reject'
  /** Matching calls affected (default 1). */
  times?: number
}

export interface FakeHostOptions {
  now?: () => number
  /** Emulated `~/.logseq`. */
  dotRoot?: string
}

export interface FakeHost {
  /** Absolute path → file. */
  files: Map<string, FakeFile>
  /** Absolute directory paths that exist (`/` always). */
  dirs: Set<string>
  calls: FakeHostCall[]
  /** Error notifications the host would have shown (swallowed `writeFile` failures). */
  notifications: string[]
  dotRoot: string
  now: () => number
  doAction: BridgeCall
  fetch: FileFetch
  failNext(fault: HostFault): void
  addDir(abs: string): void
  addFile(abs: string, content: string | Uint8Array, opts?: { mtimeMs?: number }): void
  textOf(abs: string): string
  has(abs: string): boolean
  /** Sorted absolute paths of the files under `abs`. */
  filesUnder(abs: string): string[]
}

const ASYNC_ACTIONS = new Set(['copyFile', 'listdir'])
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function nodeError(code: string, text: string, syscall: string, paths: string[]): Error {
  return new Error(`${code}: ${text}, ${syscall} ${paths.map((p) => `'${p}'`).join(' -> ')}`)
}

function remoteError(inner: Error): Error {
  return new Error(`Error invoking remote method 'main': ${inner}`)
}

export function createFakeHost(opts: FakeHostOptions = {}): FakeHost {
  const files = new Map<string, FakeFile>()
  const dirs = new Set<string>(['/'])
  const calls: FakeHostCall[] = []
  const notifications: string[] = []
  const faults: HostFault[] = []
  const now = opts.now ?? Date.now
  const dotRoot = opts.dotRoot ?? '/home/user/.logseq'

  const addDir = (abs: string): void => {
    let d = abs
    while (d !== '/' && !dirs.has(d)) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  addDir(dotRoot)

  const under = (dir: string, p: string): boolean => p.startsWith(dir === '/' ? '/' : `${dir}/`)
  const statOf = (abs: string): unknown => {
    const f = files.get(abs)
    if (f) return { size: f.bytes.byteLength, mtime: new Date(f.mtimeMs), ctime: new Date(f.mtimeMs) }
    if (dirs.has(abs)) return { size: 4096, mtime: new Date(now()), ctime: new Date(now()) }
    return nodeError('ENOENT', 'no such file or directory', 'stat', [abs])
  }
  const toBytes = (content: unknown): Uint8Array | null => {
    if (typeof content === 'string') return encoder.encode(content)
    if (content instanceof ArrayBuffer) return new Uint8Array(content.slice(0))
    if (content instanceof Uint8Array) return content.slice()
    return null
  }
  const moveDir = (from: string, to: string): void => {
    for (const d of [...dirs]) {
      if (d === from || under(from, d)) {
        dirs.delete(d)
        dirs.add(to + d.slice(from.length))
      }
    }
    for (const [p, f] of [...files]) {
      if (under(from, p)) {
        files.delete(p)
        files.set(to + p.slice(from.length), f)
      }
    }
  }

  /** The host's `handle` multimethod. Returns a value to resolve with, or throws to reject (async handlers). */
  function handle(action: string, args: unknown[]): unknown {
    const str = (i: number): string => String(args[i])
    switch (action) {
      case 'getLogseqDotDirRoot':
        return dotRoot
      case 'listdir': {
        const dir = str(0)
        if (files.has(dir)) throw remoteError(nodeError('ENOTDIR', 'not a directory', 'scandir', [dir]))
        if (!dirs.has(dir)) return null
        return [...files.keys()].filter((p) => under(dir, p))
      }
      case 'stat':
        return statOf(str(0))
      case 'mkdir-recur': {
        const dir = str(0)
        if (files.has(dir)) return nodeError('EEXIST', 'file already exists', 'mkdir', [dir])
        addDir(dir)
        return undefined
      }
      case 'writeFile': {
        const path = str(1)
        const bytes = toBytes(args[2])
        if (bytes === null || !dirs.has(dirname(path)) || dirs.has(path)) {
          notifications.push(`Write to the file ${path} failed`)
          return null
        }
        files.set(path, { bytes, mtimeMs: now() })
        return statOf(path)
      }
      case 'rename': {
        const [from, to] = [str(0), str(1)]
        if (!dirs.has(dirname(to))) return nodeError('ENOENT', 'no such file or directory', 'rename', [from, to])
        if (dirs.has(from)) {
          if (files.has(to)) return nodeError('ENOTDIR', 'not a directory', 'rename', [from, to])
          moveDir(from, to)
          return undefined
        }
        const f = files.get(from)
        if (!f) return nodeError('ENOENT', 'no such file or directory', 'rename', [from, to])
        if (dirs.has(to)) return nodeError('EISDIR', 'illegal operation on a directory', 'rename', [from, to])
        files.delete(from)
        files.set(to, f)
        return undefined
      }
      case 'copyFile': {
        const [from, to] = [str(1), str(2)]
        const f = files.get(from)
        if (!f) throw remoteError(nodeError('ENOENT', 'no such file or directory', 'lstat', [from]))
        if (dirs.has(to)) throw remoteError(new Error(`Cannot overwrite directory '${to}' with non-directory '${from}'.`))
        addDir(dirname(to))
        files.set(to, { bytes: f.bytes.slice(), mtimeMs: now() })
        return undefined
      }
      case 'unlink': {
        const [repo, path] = [str(0), str(1)]
        if (under(dotRoot, path)) {
          if (!files.delete(path)) return nodeError('ENOENT', 'no such file or directory', 'unlink', [path])
          return undefined
        }
        const f = files.get(path)
        if (!f) return null // the host logs and swallows
        const recycle = `${repo}/logseq/.recycle`
        addDir(recycle)
        const name = path.replace(`${repo}/`, '').replace(/\//g, '_')
        files.delete(path)
        files.set(`${recycle}/${name}`, f)
        return null
      }
      default:
        return null // `:default` logs "no ipc handler" and returns nil
    }
  }

  const doAction: BridgeCall = async (args) => {
    const action = String(args[0])
    const call: FakeHostCall = { action, args: args.slice(1) }
    calls.push(call)
    const i = faults.findIndex((f) => f.match(call))
    if (i !== -1) {
      const fault = faults[i]
      fault.times = (fault.times ?? 1) - 1
      if (fault.times <= 0) faults.splice(i, 1)
      const answer = typeof fault.answer === 'function' ? (fault.answer as (c: FakeHostCall) => unknown)(call) : fault.answer
      if (answer instanceof Error) {
        const mode = fault.mode ?? (ASYNC_ACTIONS.has(action) ? 'reject' : 'resolve')
        if (mode === 'reject') throw answer
        return answer
      }
      return answer
    }
    return handle(action, call.args)
  }

  const fetch: FileFetch = async (url) => {
    if (!url.startsWith('file://')) throw new TypeError('Failed to fetch')
    const abs = decodeURIComponent(url.slice('file://'.length))
    const f = files.get(abs)
    if (!f) throw new TypeError('Failed to fetch')
    return new Response(f.bytes.slice())
  }

  return {
    files,
    dirs,
    calls,
    notifications,
    dotRoot,
    now,
    doAction,
    fetch,
    failNext: (fault) => {
      faults.push(fault)
    },
    addDir,
    addFile: (abs, content, o = {}) => {
      addDir(dirname(abs))
      files.set(abs, { bytes: typeof content === 'string' ? encoder.encode(content) : content.slice(), mtimeMs: o.mtimeMs ?? now() })
    },
    textOf: (abs) => {
      const f = files.get(abs)
      if (!f) throw new Error(`fake host: no file ${abs}`)
      return decoder.decode(f.bytes)
    },
    has: (abs) => files.has(abs),
    filesUnder: (abs) => [...files.keys()].filter((p) => under(abs, p)).sort(),
  }
}

export interface FakeGraph {
  fs: GraphFs
  host: FakeHost
  root: string
}

/**
 * The real `HostBridgeFs` over a fresh fake host, seeded with `initial` (root-relative path → content):
 * what src/sync/ tests use as their in-memory graph.
 */
export function createFakeGraphFs(initial: Record<string, string | Uint8Array> = {}, opts: FakeHostOptions & { root?: string } = {}): FakeGraph {
  const root = opts.root ?? '/graphs/g'
  const host = createFakeHost(opts)
  host.addDir(root)
  for (const [rel, content] of Object.entries(initial)) host.addFile(`${root}/${rel}`, content)
  return { fs: createHostBridgeFs({ root, bridge: host.doAction, fetch: host.fetch }), host, root }
}
