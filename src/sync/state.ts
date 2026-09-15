// Plan §3.5, the local sync state as JSON strings in `logseq.FileStorage` (plaintext under ~/.logseq):
//   device.json             { deviceId, createdAt }
//   state/<graph-key>.json  { version, driveRootId, graphFolderId, changesPageToken, lastSyncAt, lastSnapshotAt,
//                             lastProfileHash, entries, remote }
//   journal/<graph-key>.json the run in progress: planned ops, completed ops, conflict answers
// `entries` is the three-way BASE (what this device last synced, per path). `remote` is the persisted REMOTE
// VIEW (remote.ts): Drive as of `changesPageToken`, which may be ahead of the base for paths whose remote
// change was not applied locally yet (skipped conflict, failed download). Storing it lets the token advance
// on every run without losing those changes.
//
// Everything parses defensively (like tokenStore.ts): an unreadable file reads as "no state", which the
// three-way plan turns into an add/add merge, never into data loss. Host facts (Ref §6.6): `getItem` of a
// missing key rejects, so `hasItem` runs first; `removeItem` is fire-and-forget, so a cleared file holds `null`.

import type { ConflictChoice } from './conflict'
import type { SyncOp } from './planner'
import type { RemoteFile } from './remote'

export const STATE_VERSION = 1
export const DEVICE_KEY = 'device.json'

/** The `logseq.FileStorage` subset used here (structurally identical to `KeyValueStorage` in src/google/tokenStore.ts). */
export interface JsonStorage {
  getItem(key: string): Promise<string | null | undefined>
  setItem(key: string, value: string): Promise<void>
  hasItem(key: string): Promise<boolean>
}

export interface DeviceInfo {
  deviceId: string
  /** Epoch ms. */
  createdAt: number
}

/** The base of one path: the local file and its Drive counterpart as they were when last synced. */
export interface SyncEntry {
  sha256: string
  size: number
  /** Local mtime, epoch ms; with `size` the scanner's cache key (scanner.ts). */
  mtimeMs: number
  driveId: string
  /** Drive `modifiedTime`, epoch ms. */
  driveModifiedTime: number
  /** Epoch ms of the run that wrote this entry. */
  syncedAt: number
}

export interface SyncState {
  version: typeof STATE_VERSION
  graphKey: string
  /** Filled by the M7 wiring after `bootstrapLayout`, so the six folder lookups run once per graph. */
  driveRootId: string | null
  graphFolderId: string | null
  /** `null` until the first sync: the next delta is a full listing. */
  changesPageToken: string | null
  lastSyncAt: number | null
  lastSnapshotAt: number | null
  lastProfileHash: string | null
  entries: Record<string, SyncEntry>
  remote: Record<string, RemoteFile>
}

/** What one finished operation means for the state: the new base entry (or none) and the new remote file (or none) of `path`. */
export interface Completion {
  path: string
  entry: SyncEntry | null
  remote: RemoteFile | null
}

/** A conflict answer, remembered so a crash between the dialog and the execution does not ask again (engine.ts). */
export interface JournalResolution {
  path: string
  choice: ConflictChoice
  localSha: string | null
  remoteSha: string | null
}

export interface SyncJournal {
  version: typeof STATE_VERSION
  runId: string
  startedAt: number
  /** The run's `logseq/bak/gdsync/<ts>` folder. */
  bakDir: string
  /** The plan, for the log; recovery re-plans instead of replaying it (engine.ts). */
  ops: SyncOp[]
  /** `opKey(op)` → the completions of operations that finished, flushed in batches during the run. */
  done: Record<string, Completion[]>
  resolutions: JournalResolution[]
}

export function stateKey(graphKey: string): string {
  return `state/${graphKey}.json`
}

export function journalKey(graphKey: string): string {
  return `journal/${graphKey}.json`
}

/** FNV-1a 32-bit, hex; keeps two graph names that sanitize alike apart. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * `<sanitized graph name>-<hash of the graph path>`, safe as a FileStorage file name on every OS. The base
 * describes the files at one local PATH, so two graphs that share a name but not a directory (the D11
 * device-2 simulation, or a graph moved and re-added) keep separate state; the Drive folder is named after
 * the graph NAME (layout.ts), so they still meet in the same remote mirror. `path` defaults to the name.
 */
export function graphKey(graphName: string, graphPath: string = graphName): string {
  const cleaned = graphName
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return `${cleaned === '' ? 'graph' : cleaned}-${shortHash(graphPath)}`
}

export function freshState(key: string): SyncState {
  return {
    version: STATE_VERSION,
    graphKey: key,
    driveRootId: null,
    graphFolderId: null,
    changesPageToken: null,
    lastSyncAt: null,
    lastSnapshotAt: null,
    lastProfileHash: null,
    entries: {},
    remote: {},
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v !== ''
}

function numOrNull(v: unknown): number | null {
  return isNum(v) ? v : null
}

function strOrNull(v: unknown): string | null {
  return isStr(v) ? v : null
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parseSyncEntry(v: unknown): SyncEntry | null {
  if (!isRecord(v)) return null
  const { sha256, size, mtimeMs, driveId, driveModifiedTime, syncedAt } = v
  if (!isStr(sha256) || !isNum(size) || !isNum(mtimeMs) || !isStr(driveId) || !isNum(driveModifiedTime)) return null
  return { sha256, size, mtimeMs, driveId, driveModifiedTime, syncedAt: isNum(syncedAt) ? syncedAt : 0 }
}

export function parseRemoteFile(v: unknown): RemoteFile | null {
  if (!isRecord(v)) return null
  const { path, id, sha256, size, modifiedTime, createdTime, md5 } = v
  if (!isStr(path) || !isStr(id) || !isNum(size) || !isNum(modifiedTime)) return null
  return {
    path,
    id,
    sha256: strOrNull(sha256),
    size,
    modifiedTime,
    createdTime: isNum(createdTime) ? createdTime : 0,
    md5: strOrNull(md5),
  }
}

function parseEntries(v: unknown): Record<string, SyncEntry> {
  const out: Record<string, SyncEntry> = {}
  if (!isRecord(v)) return out
  for (const [path, raw] of Object.entries(v)) {
    const entry = parseSyncEntry(raw)
    if (entry && path !== '') out[path] = entry
  }
  return out
}

function parseRemote(v: unknown): Record<string, RemoteFile> {
  const out: Record<string, RemoteFile> = {}
  if (!isRecord(v)) return out
  for (const [path, raw] of Object.entries(v)) {
    const file = parseRemoteFile(raw)
    if (file && file.path === path) out[path] = file
  }
  return out
}

/** Never throws; anything not written by `saveState` (or a different graph key) reads as a fresh state. */
export function parseSyncState(text: unknown, key: string): SyncState {
  const json = parseJson(text)
  if (!isRecord(json) || json.version !== STATE_VERSION || json.graphKey !== key) return freshState(key)
  return {
    version: STATE_VERSION,
    graphKey: key,
    driveRootId: strOrNull(json.driveRootId),
    graphFolderId: strOrNull(json.graphFolderId),
    changesPageToken: strOrNull(json.changesPageToken),
    lastSyncAt: numOrNull(json.lastSyncAt),
    lastSnapshotAt: numOrNull(json.lastSnapshotAt),
    lastProfileHash: strOrNull(json.lastProfileHash),
    entries: parseEntries(json.entries),
    remote: parseRemote(json.remote),
  }
}

/** A completion whose non-null half does not parse is dropped whole: half-applying it could desynchronise base and remote view. */
export function parseCompletion(v: unknown): Completion | null {
  if (!isRecord(v) || !isStr(v.path)) return null
  let entry: SyncEntry | null = null
  if (v.entry !== null && v.entry !== undefined) {
    entry = parseSyncEntry(v.entry)
    if (!entry) return null
  }
  let remote: RemoteFile | null = null
  if (v.remote !== null && v.remote !== undefined) {
    remote = parseRemoteFile(v.remote)
    if (!remote) return null
  }
  return { path: v.path, entry, remote }
}

const CHOICES: ReadonlySet<string> = new Set<ConflictChoice>(['keep-local', 'keep-remote', 'keep-both'])

export function parseJournal(text: unknown): SyncJournal | null {
  const json = parseJson(text)
  if (!isRecord(json) || json.version !== STATE_VERSION || !isStr(json.runId) || !isNum(json.startedAt) || !isStr(json.bakDir)) return null
  const ops: SyncOp[] = []
  if (Array.isArray(json.ops)) {
    for (const op of json.ops) if (isRecord(op) && isStr(op.kind) && isStr(op.path)) ops.push(op as unknown as SyncOp)
  }
  const done: Record<string, Completion[]> = {}
  if (isRecord(json.done)) {
    for (const [key, list] of Object.entries(json.done)) {
      if (!Array.isArray(list)) continue
      const completions = list.map(parseCompletion).filter((c): c is Completion => c !== null)
      done[key] = completions
    }
  }
  const resolutions: JournalResolution[] = []
  if (Array.isArray(json.resolutions)) {
    for (const r of json.resolutions) {
      if (!isRecord(r) || !isStr(r.path) || typeof r.choice !== 'string' || !CHOICES.has(r.choice)) continue
      resolutions.push({ path: r.path, choice: r.choice as ConflictChoice, localSha: strOrNull(r.localSha), remoteSha: strOrNull(r.remoteSha) })
    }
  }
  return { version: STATE_VERSION, runId: json.runId, startedAt: json.startedAt, bakDir: json.bakDir, ops, done, resolutions }
}

export function parseDeviceInfo(text: unknown): DeviceInfo | null {
  const json = parseJson(text)
  if (!isRecord(json) || !isStr(json.deviceId)) return null
  return { deviceId: json.deviceId, createdAt: isNum(json.createdAt) ? json.createdAt : 0 }
}

/** Folds completions into `state` in place: a `null` entry or remote drops that path. */
export function applyCompletions(state: SyncState, completions: Iterable<Completion>): void {
  for (const c of completions) {
    if (c.entry) state.entries[c.path] = c.entry
    else delete state.entries[c.path]
    if (c.remote) state.remote[c.path] = c.remote
    else delete state.remote[c.path]
  }
}

export interface SyncStateStore {
  loadState(key: string): Promise<SyncState>
  saveState(state: SyncState): Promise<void>
  loadJournal(key: string): Promise<SyncJournal | null>
  saveJournal(key: string, journal: SyncJournal): Promise<void>
  clearJournal(key: string): Promise<void>
  loadDevice(): Promise<DeviceInfo | null>
  saveDevice(device: DeviceInfo): Promise<void>
}

export function createSyncStateStore(storage: JsonStorage): SyncStateStore {
  async function read(key: string): Promise<string | null> {
    if (!(await storage.hasItem(key))) return null
    try {
      const text = await storage.getItem(key)
      return typeof text === 'string' ? text : null
    } catch {
      return null
    }
  }
  return {
    loadState: async (key) => parseSyncState(await read(stateKey(key)), key),
    saveState: (state) => storage.setItem(stateKey(state.graphKey), JSON.stringify(state)),
    loadJournal: async (key) => parseJournal(await read(journalKey(key))),
    saveJournal: (key, journal) => storage.setItem(journalKey(key), JSON.stringify(journal)),
    clearJournal: (key) => storage.setItem(journalKey(key), 'null'),
    loadDevice: async () => parseDeviceInfo(await read(DEVICE_KEY)),
    saveDevice: (device) => storage.setItem(DEVICE_KEY, JSON.stringify(device)),
  }
}

export interface EnsureDeviceOpts {
  /** A fresh id, e.g. `crypto.randomUUID`. */
  newId: () => string
  now: () => number
}

/** Loads `device.json` or creates it once; the id identifies this device in `appProperties` and the Drive lock for its whole life. */
export async function ensureDevice(store: SyncStateStore, opts: EnsureDeviceOpts): Promise<DeviceInfo> {
  const existing = await store.loadDevice()
  if (existing) return existing
  const device: DeviceInfo = { deviceId: opts.newId(), createdAt: opts.now() }
  await store.saveDevice(device)
  return device
}
