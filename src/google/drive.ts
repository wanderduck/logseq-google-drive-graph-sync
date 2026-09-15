// Plan M4 steps 1–3: the Drive v3 client. Host-agnostic and built on one injected `fetch`, which in the
// plugin is `GoogleAuth.fetch` (Bearer header, one refresh on 401, backoff underneath). Every non-2xx
// that reaches here is final and becomes an `HttpError`. Transport facts are from the M0 spike (§2
// items 4, §3, §4 item 8): JSON endpoints, multipart and resumable uploads, `alt=media` downloads,
// `appProperties` and `changes.*` all work from the plugin iframe with plain `fetch`.

import { HttpError } from './errors'
import { createFolderCache, type FolderCache } from './folderCache'
import { FOLDER_MIME, appPropertyQuery, childByNameQuery, childrenQuery, type ChildFilter } from './driveQuery'
import {
  DEFAULT_CHUNK_BYTES,
  MULTIPART_MAX_BYTES,
  assertChunkSize,
  multipartBody,
  resumableUpload,
  toBlob,
  type TransferOptions,
  type UploadContent,
} from './driveUpload'
import type { FetchLike } from './http'

export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
/** Alias Drive accepts for the user's My Drive root, in queries and as a parent. */
export const ROOT_ID = 'root'
export const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents,appProperties,trashed'
export const DEFAULT_PAGE_SIZE = 1000

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  isFolder: boolean
  /** Bytes; `null` for folders. */
  size: number | null
  md5Checksum: string | null
  /** Epoch ms. */
  modifiedTime: number
  /** Epoch ms. */
  createdTime: number
  parents: string[]
  appProperties: Record<string, string>
  trashed: boolean
}

export interface TreeEntry {
  file: DriveFile
  /** Path segments below the listed folder, the file's own name last. */
  segments: string[]
}

export interface DriveChange {
  fileId: string
  /** Permanently deleted or no longer visible to this app; `file` is then `null`. */
  removed: boolean
  file: DriveFile | null
  /** Epoch ms. */
  time: number
}

export interface ChangesResult {
  changes: DriveChange[]
  /** Store this; the next `listChanges` starts here. */
  newStartPageToken: string
}

export interface CreateSpec {
  name: string
  parentId: string
  mimeType?: string
  appProperties?: Record<string, string>
  /** Epoch ms; Drive stores it as the file's `modifiedTime`. */
  modifiedTime?: number
}

export interface MetadataPatch {
  name?: string
  /** Keys are merged into the existing ones; a `null` value deletes that key (Drive semantics). */
  appProperties?: Record<string, string | null>
  trashed?: boolean
  modifiedTime?: number
}

/** `changes.list` rejected the page token (HTTP 400): fall back to a full listing (plan §3.6 step 4). */
export class InvalidPageTokenError extends Error {
  override readonly name = 'InvalidPageTokenError'
  readonly cause: HttpError
  constructor(cause: HttpError) {
    super(`Drive rejected the changes page token: ${cause.message}`)
    this.cause = cause
  }
}

export interface DriveClientDeps {
  /** The authorized fetch (`GoogleAuth.fetch`). */
  fetch: FetchLike
  log?: (line: string) => void
  pageSize?: number
  chunkBytes?: number
  /** Content up to this size goes multipart, above it resumable. */
  multipartMaxBytes?: number
}

export interface DriveClient {
  readonly folders: FolderCache
  getFile(id: string, opts?: TransferOptions): Promise<DriveFile>
  listChildren(parentId: string, filter?: ChildFilter): Promise<DriveFile[]>
  /** Exact-name lookup; with duplicates the oldest wins (see `oldestFirst`). */
  findChild(parentId: string, name: string, folder: boolean): Promise<DriveFile | null>
  findByAppProperty(key: string, value: string): Promise<DriveFile[]>
  createFolder(parentId: string, name: string): Promise<DriveFile>
  /** Find-or-create through the cache; a folder created twice in a race is collapsed to the oldest. */
  ensureFolder(parentId: string, name: string): Promise<string>
  ensureFolderPath(parentId: string, segments: string[]): Promise<string>
  /** Every non-trashed file and folder below `folderId`, breadth first, with its path segments. */
  listTree(folderId: string): Promise<TreeEntry[]>
  /** Path segments of `file` below `ancestorId`, or `null` when it is not under it. Resolves unknown parents with `getFile`. */
  pathUnder(file: DriveFile, ancestorId: string): Promise<string[] | null>
  createFile(content: UploadContent, spec: CreateSpec, opts?: TransferOptions): Promise<DriveFile>
  updateFile(fileId: string, content: UploadContent, patch?: MetadataPatch, opts?: TransferOptions): Promise<DriveFile>
  updateMetadata(fileId: string, patch: MetadataPatch): Promise<DriveFile>
  download(fileId: string, opts?: TransferOptions): Promise<ArrayBuffer>
  downloadText(fileId: string, opts?: TransferOptions): Promise<string>
  /** `PATCH { trashed: true }`; the user can still recover it from the Drive trash. */
  trash(fileId: string): Promise<void>
  /** `DELETE files/{id}`: gone for good; on a folder it cascades (spike H13). For our own bookkeeping files only. */
  deleteForever(fileId: string): Promise<void>
  getStartPageToken(): Promise<string>
  /** All pages since `pageToken`; throws `InvalidPageTokenError` on HTTP 400. */
  listChanges(pageToken: string): Promise<ChangesResult>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function parseTime(v: unknown): number {
  if (typeof v !== 'string') return 0
  const t = Date.parse(v)
  return Number.isNaN(t) ? 0 : t
}

/** Drive sends int64s as strings. */
function parseSize(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return null
}

export function parseDriveFile(raw: unknown): DriveFile {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') throw new Error('Drive returned a file without an id.')
  const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : ''
  const isFolder = mimeType === FOLDER_MIME
  const appProperties: Record<string, string> = {}
  if (isRecord(raw.appProperties)) {
    for (const [k, v] of Object.entries(raw.appProperties)) if (typeof v === 'string') appProperties[k] = v
  }
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    mimeType,
    isFolder,
    size: isFolder ? null : parseSize(raw.size),
    md5Checksum: typeof raw.md5Checksum === 'string' ? raw.md5Checksum : null,
    modifiedTime: parseTime(raw.modifiedTime),
    createdTime: parseTime(raw.createdTime),
    parents: Array.isArray(raw.parents) ? raw.parents.filter((p): p is string => typeof p === 'string') : [],
    appProperties,
    trashed: raw.trashed === true,
  }
}

/** Duplicate names are resolved deterministically on every device: oldest `createdTime`, then smallest id. */
export function oldestFirst(a: DriveFile, b: DriveFile): number {
  return a.createdTime - b.createdTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404
}

function metadataOf(spec: CreateSpec): Record<string, unknown> {
  const m: Record<string, unknown> = { name: spec.name, parents: [spec.parentId] }
  if (spec.mimeType) m.mimeType = spec.mimeType
  if (spec.appProperties) m.appProperties = spec.appProperties
  if (spec.modifiedTime !== undefined) m.modifiedTime = new Date(spec.modifiedTime).toISOString()
  return m
}

function patchOf(patch: MetadataPatch): Record<string, unknown> {
  const m: Record<string, unknown> = {}
  if (patch.name !== undefined) m.name = patch.name
  if (patch.appProperties !== undefined) m.appProperties = patch.appProperties
  if (patch.trashed !== undefined) m.trashed = patch.trashed
  if (patch.modifiedTime !== undefined) m.modifiedTime = new Date(patch.modifiedTime).toISOString()
  return m
}

export function createDriveClient(deps: DriveClientDeps): DriveClient {
  const log = deps.log ?? (() => undefined)
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE
  const chunkBytes = deps.chunkBytes ?? DEFAULT_CHUNK_BYTES
  assertChunkSize(chunkBytes)
  const multipartMax = deps.multipartMaxBytes ?? MULTIPART_MAX_BYTES
  const folders = createFolderCache()

  async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
    const res = await deps.fetch(url, init)
    if (!res.ok) throw await HttpError.fromResponse(res, url)
    return res.json()
  }

  const jsonInit = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  function fileUrl(id: string, params: Record<string, string>): string {
    return `${DRIVE_API}/files/${encodeURIComponent(id)}?${new URLSearchParams(params).toString()}`
  }

  async function listAll(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken: string | null = null
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: String(pageSize), spaces: 'drive' })
      if (pageToken) params.set('pageToken', pageToken)
      const url = `${DRIVE_API}/files?${params.toString()}`
      const json = await requestJson(url, { method: 'GET', headers: { Accept: 'application/json' } })
      if (!isRecord(json)) throw new Error('Drive files.list returned no object.')
      if (Array.isArray(json.files)) for (const f of json.files) out.push(parseDriveFile(f))
      pageToken = typeof json.nextPageToken === 'string' && json.nextPageToken !== '' ? json.nextPageToken : null
    } while (pageToken)
    return out
  }

  async function getFile(id: string, opts: TransferOptions = {}): Promise<DriveFile> {
    const url = fileUrl(id, { fields: FILE_FIELDS })
    return parseDriveFile(await requestJson(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: opts.signal }))
  }

  const listChildren = (parentId: string, filter: ChildFilter = 'all'): Promise<DriveFile[]> => listAll(childrenQuery(parentId, filter))

  async function findChild(parentId: string, name: string, folder: boolean): Promise<DriveFile | null> {
    const matches = (await listAll(childByNameQuery(parentId, name, folder))).sort(oldestFirst)
    if (matches.length > 1) log(`${matches.length} entries named "${name}" under ${parentId}; using the oldest (${matches[0].id})`)
    return matches[0] ?? null
  }

  const findByAppProperty = (key: string, value: string): Promise<DriveFile[]> => listAll(appPropertyQuery(key, value))

  async function createFolder(parentId: string, name: string): Promise<DriveFile> {
    const url = `${DRIVE_API}/files?fields=${FILE_FIELDS}`
    return parseDriveFile(await requestJson(url, jsonInit('POST', { name, mimeType: FOLDER_MIME, parents: [parentId] })))
  }

  async function ensureFolder(parentId: string, name: string): Promise<string> {
    const cached = folders.get(parentId, name)
    if (cached !== null) return cached
    let folder = await findChild(parentId, name, true)
    if (!folder) {
      const created = await createFolder(parentId, name)
      // Two devices can create the same folder at once (no atomic create-if-absent on Drive): re-list and
      // keep the oldest, so both sides converge on one id and the loser's empty folder is removed.
      const winner = await findChild(parentId, name, true)
      if (winner && winner.id !== created.id) {
        log(`folder "${name}" was created concurrently; keeping ${winner.id}, removing ours (${created.id})`)
        await deleteForever(created.id)
        folder = winner
      } else {
        folder = created
      }
    }
    folders.set(parentId, name, folder.id)
    return folder.id
  }

  async function ensureFolderPath(parentId: string, segments: string[]): Promise<string> {
    let id = parentId
    for (const segment of segments) id = await ensureFolder(id, segment)
    return id
  }

  async function listTree(folderId: string): Promise<TreeEntry[]> {
    const out: TreeEntry[] = []
    const queue: Array<{ id: string; segments: string[] }> = [{ id: folderId, segments: [] }]
    while (queue.length > 0) {
      const { id, segments } = queue.shift()!
      const children = await listChildren(id)
      const nameCount = new Map<string, number>()
      for (const c of children) if (c.isFolder) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1)
      for (const child of children) {
        const path = [...segments, child.name]
        out.push({ file: child, segments: path })
        if (child.isFolder) {
          if (nameCount.get(child.name) === 1) folders.set(id, child.name, child.id)
          queue.push({ id: child.id, segments: path })
        }
      }
    }
    return out
  }

  async function pathUnder(file: DriveFile, ancestorId: string): Promise<string[] | null> {
    const segments = [file.name]
    let parentId: string | undefined = file.parents[0]
    for (let depth = 0; parentId !== undefined && depth < 64; depth++) {
      if (parentId === ancestorId) return segments
      const known = folders.entry(parentId)
      if (known) {
        segments.unshift(known.name)
        parentId = known.parentId
        continue
      }
      let parent: DriveFile
      try {
        parent = await getFile(parentId)
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
      if (parent.parents[0] !== undefined) folders.set(parent.parents[0], parent.name, parent.id)
      segments.unshift(parent.name)
      parentId = parent.parents[0]
    }
    return null
  }

  async function upload(url: string, method: 'POST' | 'PATCH', metadata: unknown, media: Blob, opts: TransferOptions): Promise<DriveFile> {
    if (media.size <= multipartMax) {
      const { body, contentType } = multipartBody(metadata, media)
      const res = await deps.fetch(`${url}?uploadType=multipart&fields=${FILE_FIELDS}`, {
        method,
        headers: { 'Content-Type': contentType, Accept: 'application/json' },
        body,
        signal: opts.signal,
      })
      if (!res.ok) throw await HttpError.fromResponse(res, url)
      const file = parseDriveFile(await res.json())
      opts.onProgress?.(media.size, media.size)
      return file
    }
    const json = await resumableUpload({ fetch: deps.fetch, log, chunkBytes }, { url: `${url}?uploadType=resumable&fields=${FILE_FIELDS}`, method, metadata }, media, opts)
    return parseDriveFile(json)
  }

  function createFile(content: UploadContent, spec: CreateSpec, opts: TransferOptions = {}): Promise<DriveFile> {
    const mimeType = spec.mimeType ?? 'application/octet-stream'
    return upload(`${DRIVE_UPLOAD_API}/files`, 'POST', metadataOf({ ...spec, mimeType }), toBlob(content, mimeType), opts)
  }

  async function updateFile(fileId: string, content: UploadContent, patch: MetadataPatch = {}, opts: TransferOptions = {}): Promise<DriveFile> {
    const media = content instanceof Blob ? content : toBlob(content, 'application/octet-stream')
    return upload(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}`, 'PATCH', patchOf(patch), media, opts)
  }

  async function updateMetadata(fileId: string, patch: MetadataPatch): Promise<DriveFile> {
    return parseDriveFile(await requestJson(fileUrl(fileId, { fields: FILE_FIELDS }), jsonInit('PATCH', patchOf(patch))))
  }

  async function download(fileId: string, opts: TransferOptions = {}): Promise<ArrayBuffer> {
    const url = fileUrl(fileId, { alt: 'media' })
    const res = await deps.fetch(url, { method: 'GET', signal: opts.signal })
    if (!res.ok) throw await HttpError.fromResponse(res, url)
    const bytes = await res.arrayBuffer()
    opts.onProgress?.(bytes.byteLength, bytes.byteLength)
    return bytes
  }

  async function downloadText(fileId: string, opts: TransferOptions = {}): Promise<string> {
    return new TextDecoder().decode(await download(fileId, opts))
  }

  async function trash(fileId: string): Promise<void> {
    await updateMetadata(fileId, { trashed: true })
  }

  async function deleteForever(fileId: string): Promise<void> {
    const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}`
    const res = await deps.fetch(url, { method: 'DELETE' })
    if (!res.ok) throw await HttpError.fromResponse(res, url)
    folders.forget(fileId)
  }

  async function getStartPageToken(): Promise<string> {
    const json = await requestJson(`${DRIVE_API}/changes/startPageToken`, { method: 'GET', headers: { Accept: 'application/json' } })
    if (!isRecord(json) || typeof json.startPageToken !== 'string' || json.startPageToken === '') {
      throw new Error('Drive changes.getStartPageToken returned no token.')
    }
    return json.startPageToken
  }

  async function listChanges(pageToken: string): Promise<ChangesResult> {
    const changes: DriveChange[] = []
    let token = pageToken
    for (;;) {
      const params = new URLSearchParams({
        pageToken: token,
        pageSize: String(pageSize),
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,time,changeType,file(${FILE_FIELDS}))`,
        includeRemoved: 'true',
        restrictToMyDrive: 'true',
        spaces: 'drive',
      })
      const url = `${DRIVE_API}/changes?${params.toString()}`
      const res = await deps.fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
      if (res.status === 400) throw new InvalidPageTokenError(await HttpError.fromResponse(res, url))
      if (!res.ok) throw await HttpError.fromResponse(res, url)
      const json: unknown = await res.json()
      if (!isRecord(json)) throw new Error('Drive changes.list returned no object.')
      if (Array.isArray(json.changes)) {
        for (const c of json.changes) {
          if (!isRecord(c) || typeof c.fileId !== 'string') continue
          if (typeof c.changeType === 'string' && c.changeType !== 'file') continue
          const removed = c.removed === true
          changes.push({ fileId: c.fileId, removed, file: !removed && isRecord(c.file) ? parseDriveFile(c.file) : null, time: parseTime(c.time) })
        }
      }
      if (typeof json.nextPageToken === 'string' && json.nextPageToken !== '') {
        token = json.nextPageToken
        continue
      }
      if (typeof json.newStartPageToken !== 'string' || json.newStartPageToken === '') throw new Error('Drive changes.list returned no newStartPageToken.')
      return { changes, newStartPageToken: json.newStartPageToken }
    }
  }

  return {
    folders,
    getFile,
    listChildren,
    findChild,
    findByAppProperty,
    createFolder,
    ensureFolder,
    ensureFolderPath,
    listTree,
    pathUnder,
    createFile,
    updateFile,
    updateMetadata,
    download,
    downloadText,
    trash,
    deleteForever,
    getStartPageToken,
    listChanges,
  }
}
