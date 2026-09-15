// The two-device world of the M6 engine tests: one FakeDrive shared by any number of simulated devices,
// each with its own in-memory graph (the real `HostBridgeFs` over FakeHost), its own FileStorage, its own
// Drive client (own folder cache, so a "restart" is a fresh client) and the real `DriveMirror`. Requests go
// through the real backoff transport with instant sleeps, so injected 5xx/network faults exercise the retry
// path. One ticking clock feeds everything, so every write gets a distinct mtime and runs are deterministic.
// Not a test file (Vitest only picks up `*.test.ts`).

import { sha256Hex } from '../../src/fs/hash'
import { createDriveClient, type DriveClient, type DriveClientDeps } from '../../src/google/drive'
import { FOLDER_MIME } from '../../src/google/driveQuery'
import { createHttpClient, type HttpClient } from '../../src/google/http'
import { bootstrapLayout } from '../../src/google/layout'
import { LOCK_DIR } from '../../src/google/lock'
import { createDriveMirror } from '../../src/google/mirror'
import type { ConflictChoice, ConflictItem, ConflictResolution } from '../../src/sync/conflict'
import { runSync, type SyncEngineDeps, type SyncRunHooks, type SyncRunResult } from '../../src/sync/engine'
import { createSyncStateStore, graphKey, type SyncState, type SyncStateStore } from '../../src/sync/state'
import { createFakeGraphFs, type FakeGraph } from '../fs/fakeHost'
import { createFakeDrive, type FakeDrive, type FakeFile } from '../google/fakeDrive'
import { fakeStorage, type FakeStorage } from '../google/helpers'

export const T0 = 1_700_000_000_000
export const GRAPH_NAME = 'gdsync-dev'
export const BAK_PREFIX = 'logseq/bak/'

const decoder = new TextDecoder()

export interface Clock {
  /** Every call advances by 1 ms, so two writes never share an mtime and all timestamps are strictly ordered. */
  now(): number
  advance(ms: number): void
  peek(): number
}

export function createClock(start = T0): Clock {
  let t = start
  return {
    now: () => ++t,
    advance: (ms) => {
      t += ms
    },
    peek: () => t,
  }
}

export interface Device {
  name: string
  deviceId: string
  graph: FakeGraph
  storage: FakeStorage
  store: SyncStateStore
  client: DriveClient
  deps: SyncEngineDeps
  logs: string[]
  sync(hooks?: SyncRunHooks): Promise<SyncRunResult>
  /** A user edit: writes the file with the clock's next tick as mtime. */
  write(path: string, content: string | Uint8Array): void
  /** A user delete (the file simply disappears, like a delete outside Logseq). */
  remove(path: string): void
  read(path: string): string
  has(path: string): boolean
  /** Synced content of the graph: root-relative path → text, `logseq/bak/**` excluded. */
  files(): Map<string, string>
  /** Everything under `logseq/bak/gdsync/`, as `<path below the run folder>` → text (the run folder name is dropped). */
  bakFiles(): Map<string, string>
  /** Text of every file in the graph including bak. */
  allContents(): Set<string>
  state(): Promise<SyncState>
}

export interface WorldOptions {
  clientOverrides?: Partial<Omit<DriveClientDeps, 'fetch'>>
  concurrency?: number
}

export interface World {
  drive: FakeDrive
  clock: Clock
  http: HttpClient
  graphFolderId: string
  graphKey: string
  addDevice(name: string, initial?: Record<string, string | Uint8Array>): Device
  /** Same graph, storage and state; a fresh Drive client (empty folder cache), like Logseq restarting. */
  restart(device: Device): Device
  /** Live (non-trashed) files under the graph folder: path → text, `.gdsync/` excluded. */
  driveFiles(): Map<string, string>
  /** Live files under the graph folder: path → every FakeFile with that path (duplicates included). */
  driveFilesByPath(): Map<string, FakeFile[]>
  driveFile(path: string): FakeFile | undefined
  /** Text of every non-folder file the fake knows, trashed and orphaned included. */
  allDriveContents(): Set<string>
}

export function createWorld(opts: WorldOptions = {}): Promise<World> {
  return buildWorld(opts)
}

async function buildWorld(opts: WorldOptions): Promise<World> {
  const clock = createClock()
  const drive = createFakeDrive({ now: clock.now })
  const http = createHttpClient({ fetch: drive.fetch, sleep: async () => undefined, random: () => 0, now: clock.now })
  const newClient = (log: (line: string) => void): DriveClient => createDriveClient({ fetch: http.request, log, ...opts.clientOverrides })
  const layout = await bootstrapLayout(newClient(() => undefined), { rootFolderName: 'Logseq Graph Sync', graphName: GRAPH_NAME })
  const graphFolderId = layout.graphFolderId
  const key = graphKey(GRAPH_NAME)

  function walk(): Array<{ path: string; file: FakeFile }> {
    const out: Array<{ path: string; file: FakeFile }> = []
    const queue: Array<{ id: string; prefix: string }> = [{ id: graphFolderId, prefix: '' }]
    while (queue.length > 0) {
      const { id, prefix } = queue.shift()!
      for (const child of drive.childrenOf(id)) {
        const path = prefix + child.name
        if (child.mimeType === FOLDER_MIME) {
          if (prefix === '' && child.name === LOCK_DIR) continue
          queue.push({ id: child.id, prefix: `${path}/` })
        } else {
          out.push({ path, file: child })
        }
      }
    }
    return out
  }

  function driveFilesByPath(): Map<string, FakeFile[]> {
    const out = new Map<string, FakeFile[]>()
    for (const { path, file } of walk()) out.set(path, [...(out.get(path) ?? []), file])
    return out
  }

  /** What the sync sees when a path has duplicates: the oldest, `createdTime` then id. */
  const oldestOf = (files: FakeFile[]): FakeFile => [...files].sort((a, b) => a.createdTime - b.createdTime || (a.id < b.id ? -1 : 1))[0]

  function driveFiles(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [path, files] of driveFilesByPath()) out.set(path, decoder.decode(oldestOf(files).content))
    return out
  }

  function makeDevice(name: string, graph: FakeGraph, storage: FakeStorage): Device {
    const logs: string[] = []
    const log = (line: string): void => {
      logs.push(line)
    }
    const client = newClient((l) => log(`drive: ${l}`))
    const store = createSyncStateStore(storage)
    const deps: SyncEngineDeps = {
      fs: graph.fs,
      remote: createDriveMirror({ client, graphFolderId, log: (l) => log(`mirror: ${l}`) }),
      store,
      graphKey: key,
      deviceId: `dev-${name}`,
      deviceName: name,
      now: clock.now,
      log,
      concurrency: opts.concurrency,
      newRunId: () => `run-${name}-${clock.now()}`,
    }
    const abs = (path: string): string => `${graph.root}/${path}`
    const device: Device = {
      name,
      deviceId: deps.deviceId,
      graph,
      storage,
      store,
      client,
      deps,
      logs,
      sync: (hooks) => runSync(deps, hooks),
      write: (path, content) => graph.host.addFile(abs(path), content, { mtimeMs: clock.now() }),
      remove: (path) => {
        if (!graph.host.files.delete(abs(path))) throw new Error(`${name}: no file ${path} to remove`)
      },
      read: (path) => graph.host.textOf(abs(path)),
      has: (path) => graph.host.has(abs(path)),
      files: () => {
        const out = new Map<string, string>()
        for (const p of graph.host.filesUnder(graph.root)) {
          const rel = p.slice(graph.root.length + 1)
          if (!rel.startsWith(BAK_PREFIX)) out.set(rel, graph.host.textOf(p))
        }
        return out
      },
      bakFiles: () => {
        const out = new Map<string, string>()
        for (const p of graph.host.filesUnder(`${graph.root}/logseq/bak/gdsync`)) {
          const rel = p.slice(`${graph.root}/logseq/bak/gdsync/`.length)
          out.set(rel.slice(rel.indexOf('/') + 1), graph.host.textOf(p))
        }
        return out
      },
      allContents: () => new Set(graph.host.filesUnder(graph.root).map((p) => graph.host.textOf(p))),
      state: () => store.loadState(key),
    }
    return device
  }

  const roots = new Set<string>()
  return {
    drive,
    clock,
    http,
    graphFolderId,
    graphKey: key,
    addDevice(name, initial = {}) {
      const root = `/graphs/${name}`
      if (roots.has(root)) throw new Error(`device ${name} already exists`)
      roots.add(root)
      const graph = createFakeGraphFs(initial, { root, now: clock.now })
      return makeDevice(name, graph, fakeStorage())
    },
    restart: (device) => makeDevice(device.name, device.graph, device.storage),
    driveFiles,
    driveFilesByPath,
    driveFile: (path) => {
      const files = driveFilesByPath().get(path)
      return files ? oldestOf(files) : undefined
    },
    allDriveContents: () => new Set([...drive.files.values()].filter((f) => f.mimeType !== FOLDER_MIME).map((f) => decoder.decode(f.content))),
  }
}

/** Answers every conflict with `choice`. */
export function resolveAll(choice: ConflictChoice): (items: ConflictItem[]) => Promise<ConflictResolution[]> {
  return async (items) => items.map((i) => ({ path: i.path, choice }))
}

/** Per-path answers; paths not listed are skipped. */
export function resolveWith(answers: Record<string, ConflictChoice>): (items: ConflictItem[]) => Promise<ConflictResolution[]> {
  return async (items) => items.filter((i) => i.path in answers).map((i) => ({ path: i.path, choice: answers[i.path] }))
}

/** A resolver that must not be called (the answers should come from the journal). */
export function resolveNever(): (items: ConflictItem[]) => Promise<ConflictResolution[]> {
  return async (items) => {
    throw new Error(`the conflict dialog was opened for ${items.map((i) => i.path).join(', ')}`)
  }
}

export async function shaOf(text: string): Promise<string> {
  return sha256Hex(text)
}

export class SimulatedCrash extends Error {
  override readonly name = 'SimulatedCrash'
  constructor(where: string) {
    super(`simulated crash at ${where}`)
  }
}

/** Throws `SimulatedCrash` from the progress hook once the `n`-th execute event is seen (1 = before the first op runs). */
export function crashAtExecuteEvent(n: number): SyncRunHooks['onProgress'] {
  let seen = 0
  return (p) => {
    if (p.step !== 'execute') return
    seen++
    if (seen === n) throw new SimulatedCrash(`execute event ${n}: ${p.label}`)
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
