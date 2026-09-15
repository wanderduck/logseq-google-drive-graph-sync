// FakeDrive (plan M4 step 5): an in-memory Google Drive v3 that answers `fetch` calls. The real
// `DriveClient` is tested end to end against it, and the M6 engine tests share one FakeDrive between two
// simulated devices. It emulates the endpoints and wire shapes the client uses (JSON, multipart/related,
// resumable sessions with 308 + Range, `alt=media`, `changes`), applies the `fields` mask so a forgotten
// field comes back missing like it would from Google, validates a few things Google validates (parents
// exist, chunk sizes are multiples of 256 KiB, `fields` is mandatory for `about`), and supports fault
// injection. Not a test file (Vitest only picks up `*.test.ts`).

import { createHash } from 'node:crypto'
import { FOLDER_MIME } from '../../src/google/driveQuery'
import type { FetchLike } from '../../src/google/http'

export interface FakeFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  trashed: boolean
  appProperties: Record<string, string>
  content: Uint8Array
  /** Epoch ms. */
  createdTime: number
  modifiedTime: number
}

export interface FakeCall {
  method: string
  url: URL
  headers: Headers
  body: Uint8Array | null
}

export type FakeAnswer = Response | Error | ((call: FakeCall) => Response | Error)

export interface Fault {
  match: (call: FakeCall) => boolean
  answer: FakeAnswer
  /** Handle the request normally first, then substitute the answer: the server did the work, the client never heard. */
  after?: boolean
  /** How many matching calls are affected (default 1). */
  times?: number
}

export interface ChangeEntry {
  seq: number
  fileId: string
  removed: boolean
  time: number
}

interface Session {
  id: string
  method: 'POST' | 'PATCH'
  fileId: string | null
  metadata: Record<string, unknown>
  total: number | null
  mimeType: string
  chunks: Uint8Array[]
  receivedBytes: number
  fields: string | null
  result: unknown | null
}

export interface FakeDriveOptions {
  now?: () => number
  email?: string
  /** When set, requests must carry `Authorization: Bearer <token>` or get a 401. */
  token?: string | null
}

export interface FakeDrive {
  fetch: FetchLike
  files: Map<string, FakeFile>
  calls: FakeCall[]
  changeLog: ChangeEntry[]
  sessions: Map<string, Session>
  email: string
  token: string | null
  now: () => number
  failNext(fault: Fault): void
  addFolder(parentId: string, name: string, extra?: Partial<FakeFile>): FakeFile
  addFile(parentId: string, name: string, content: string | Uint8Array, extra?: Partial<FakeFile>): FakeFile
  /** Direct, non-trashed children. */
  childrenOf(parentId: string): FakeFile[]
  textOf(id: string): string
  /** Calls matching a URL pattern or predicate. */
  callsMatching(pattern: RegExp | ((c: FakeCall) => boolean)): FakeCall[]
  nextStartToken(): string
}

const FILE_DEFAULT_MASK: Mask = { kind: true, id: true, name: true, mimeType: true }
const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Mask = { [key: string]: true | Mask }

/** `a,b(c,d),e` → nested mask. */
export function parseFieldMask(spec: string): Mask {
  const mask: Mask = {}
  let i = 0
  function parseList(into: Mask): void {
    for (;;) {
      let name = ''
      while (i < spec.length && /[A-Za-z0-9_*]/.test(spec[i])) name += spec[i++]
      if (name === '') throw new Error(`bad fields spec at ${i}: ${spec}`)
      if (spec[i] === '(') {
        i++
        const sub: Mask = {}
        parseList(sub)
        if (spec[i] !== ')') throw new Error(`bad fields spec (missing ')'): ${spec}`)
        i++
        into[name] = sub
      } else {
        into[name] = true
      }
      if (spec[i] === ',') {
        i++
        continue
      }
      return
    }
  }
  parseList(mask)
  if (i !== spec.length) throw new Error(`bad fields spec (trailing input): ${spec}`)
  return mask
}

export function applyFieldMask(value: unknown, mask: Mask | true): unknown {
  if (mask === true) return value
  if (Array.isArray(value)) return value.map((v) => applyFieldMask(v, mask))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  const record = value as Record<string, unknown>
  for (const [key, sub] of Object.entries(mask)) {
    if (key === '*') {
      for (const [k, v] of Object.entries(record)) if (v !== undefined) out[k] = applyFieldMask(v, sub)
      continue
    }
    if (record[key] !== undefined) out[key] = applyFieldMask(record[key], sub)
  }
  return out
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

interface MultipartPart {
  headers: Record<string, string>
  body: Uint8Array
}

/** Splits a `multipart/related` body into its parts; throws on anything malformed. */
export function parseMultipart(body: Uint8Array, contentType: string): MultipartPart[] {
  const m = /boundary=("?)([^";]+)\1/.exec(contentType)
  if (!m) throw new Error('multipart: no boundary in Content-Type')
  const delimiter = encoder.encode(`--${m[2]}`)
  const crlf = encoder.encode('\r\n')
  const parts: MultipartPart[] = []
  let pos = indexOfBytes(body, delimiter)
  if (pos !== 0) throw new Error('multipart: body does not start with the boundary')
  for (;;) {
    pos += delimiter.length
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return parts // closing "--"
    if (indexOfBytes(body, crlf, pos) !== pos) throw new Error('multipart: boundary not followed by CRLF')
    pos += crlf.length
    const headerEnd = indexOfBytes(body, encoder.encode('\r\n\r\n'), pos)
    if (headerEnd < 0) throw new Error('multipart: part without header terminator')
    const headers: Record<string, string> = {}
    for (const line of decoder.decode(body.subarray(pos, headerEnd)).split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
    }
    const bodyStart = headerEnd + 4
    const next = indexOfBytes(body, encoder.encode(`\r\n--${m[2]}`), bodyStart)
    if (next < 0) throw new Error('multipart: unterminated part')
    parts.push({ headers, body: body.slice(bodyStart, next) })
    pos = next + crlf.length
  }
}

type Predicate = (f: FakeFile, drive: FakeDriveState) => boolean

function unescapeQuery(v: string): string {
  return v.replace(/\\(['\\])/g, '$1')
}

/** Parses the grammar of src/google/driveQuery.ts back into a predicate; unknown clauses throw. */
export function parseQuery(q: string): Predicate {
  const clauses: Predicate[] = []
  let rest = q.trim()
  const value = "'((?:[^'\\\\]|\\\\.)*)'"
  const rules: Array<[RegExp, (m: RegExpExecArray) => Predicate]> = [
    [new RegExp(`^${value} in parents`), (m) => (f) => f.parents.includes(unescapeQuery(m[1]))],
    [new RegExp(`^name = ${value}`), (m) => (f) => f.name === unescapeQuery(m[1])],
    [new RegExp(`^mimeType (=|!=) ${value}`), (m) => (f) => (f.mimeType === unescapeQuery(m[2])) === (m[1] === '=')],
    [/^trashed = (true|false)/, (m) => (f, d) => d.isTrashed(f) === (m[1] === 'true')],
    [
      new RegExp(`^appProperties has \\{ key=${value} and value=${value} \\}`),
      (m) => (f) => f.appProperties[unescapeQuery(m[1])] === unescapeQuery(m[2]),
    ],
  ]
  while (rest !== '') {
    let matched = false
    for (const [re, build] of rules) {
      const m = re.exec(rest)
      if (!m) continue
      clauses.push(build(m))
      rest = rest.slice(m[0].length)
      matched = true
      break
    }
    if (!matched) throw new Error(`unsupported query clause: ${rest}`)
    if (rest === '') break
    if (!rest.startsWith(' and ')) throw new Error(`expected " and " in query at: ${rest}`)
    rest = rest.slice(5)
  }
  return (f, d) => clauses.every((c) => c(f, d))
}

interface FakeDriveState {
  isTrashed(f: FakeFile): boolean
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return encoder.encode(body)
  if (body instanceof URLSearchParams) return encoder.encode(body.toString())
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice()
  throw new Error(`fakeDrive: unsupported body type ${Object.prototype.toString.call(body)}`)
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...headers } })
}

function googleError(status: number, reason: string, message: string, location?: string): Response {
  return json(status, { error: { code: status, message, errors: [{ domain: 'global', reason, message, ...(location ? { location, locationType: 'parameter' } : {}) }] } })
}

function notFound(id: string): Response {
  return googleError(404, 'notFound', `File not found: ${id}.`, 'fileId')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function createFakeDrive(opts: FakeDriveOptions = {}): FakeDrive {
  const files = new Map<string, FakeFile>()
  const calls: FakeCall[] = []
  const changeLog: ChangeEntry[] = []
  const sessions = new Map<string, Session>()
  const faults: Fault[] = []
  let now = opts.now ?? (() => 1_700_000_000_000)
  let seq = 1
  let ids = 0

  const root: FakeFile = { id: 'root', name: 'My Drive', mimeType: FOLDER_MIME, parents: [], trashed: false, appProperties: {}, content: new Uint8Array(), createdTime: 0, modifiedTime: 0 }
  files.set(root.id, root)

  const state: FakeDriveState = {
    isTrashed(f) {
      let cur: FakeFile | undefined = f
      for (let depth = 0; cur && depth < 64; depth++) {
        if (cur.trashed) return true
        cur = cur.parents[0] === undefined ? undefined : files.get(cur.parents[0])
      }
      return false
    },
  }

  function record(fileId: string, removed: boolean): void {
    changeLog.push({ seq: seq++, fileId, removed, time: now() })
  }

  function fileJson(f: FakeFile): Record<string, unknown> {
    const isFolder = f.mimeType === FOLDER_MIME
    return {
      kind: 'drive#file',
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      ...(isFolder ? {} : { size: String(f.content.length), md5Checksum: createHash('md5').update(f.content).digest('hex') }),
      createdTime: new Date(f.createdTime).toISOString(),
      modifiedTime: new Date(f.modifiedTime).toISOString(),
      parents: f.parents,
      ...(Object.keys(f.appProperties).length > 0 ? { appProperties: { ...f.appProperties } } : {}),
      trashed: state.isTrashed(f),
    }
  }

  function masked(value: unknown, fields: string | null, fallback: Mask): unknown {
    return applyFieldMask(value, fields === null ? fallback : parseFieldMask(fields))
  }

  function newId(): string {
    ids++
    return `f${ids}`
  }

  function addFolder(parentId: string, name: string, extra: Partial<FakeFile> = {}): FakeFile {
    return addFile(parentId, name, new Uint8Array(), { ...extra, mimeType: FOLDER_MIME })
  }

  function addFile(parentId: string, name: string, content: string | Uint8Array, extra: Partial<FakeFile> = {}): FakeFile {
    if (!files.has(parentId)) throw new Error(`fakeDrive: parent ${parentId} does not exist`)
    const t = now()
    const f: FakeFile = {
      id: extra.id ?? newId(),
      name,
      mimeType: extra.mimeType ?? 'application/octet-stream',
      parents: [parentId],
      trashed: extra.trashed ?? false,
      appProperties: { ...(extra.appProperties ?? {}) },
      content: typeof content === 'string' ? encoder.encode(content) : content.slice(),
      createdTime: extra.createdTime ?? t,
      modifiedTime: extra.modifiedTime ?? t,
    }
    files.set(f.id, f)
    record(f.id, false)
    return f
  }

  function applyMetadata(f: FakeFile, meta: Record<string, unknown>, creating: boolean): Response | null {
    if (!creating && meta.parents !== undefined) return googleError(400, 'fieldNotWritable', 'The parents field is not directly writable in update requests.')
    if (typeof meta.name === 'string') f.name = meta.name
    if (creating && typeof meta.mimeType === 'string') f.mimeType = meta.mimeType
    if (typeof meta.trashed === 'boolean') f.trashed = meta.trashed
    if (typeof meta.modifiedTime === 'string') {
      const t = Date.parse(meta.modifiedTime)
      if (Number.isNaN(t)) return googleError(400, 'invalid', 'Invalid value for modifiedTime')
      f.modifiedTime = t
    }
    if (meta.appProperties !== undefined) {
      if (!isRecord(meta.appProperties)) return googleError(400, 'invalid', 'Invalid value for appProperties')
      for (const [k, v] of Object.entries(meta.appProperties)) {
        if (v === null) delete f.appProperties[k]
        else if (typeof v === 'string') f.appProperties[k] = v
        else return googleError(400, 'invalid', `Invalid value for appProperties.${k}`)
      }
    }
    return null
  }

  function createFromMetadata(meta: Record<string, unknown>, content: Uint8Array, mimeType: string | null): Response {
    const parents = Array.isArray(meta.parents) ? meta.parents.filter((p): p is string => typeof p === 'string') : ['root']
    for (const p of parents) if (!files.has(p)) return notFound(p)
    if (typeof meta.name !== 'string' || meta.name === '') return googleError(400, 'invalid', 'Invalid value for name')
    const t = now()
    const f: FakeFile = { id: newId(), name: '', mimeType: mimeType ?? 'application/octet-stream', parents, trashed: false, appProperties: {}, content, createdTime: t, modifiedTime: t }
    const bad = applyMetadata(f, meta, true)
    if (bad) return bad
    files.set(f.id, f)
    record(f.id, false)
    return json(200, fileJson(f))
  }

  type ContentRange = { kind: 'chunk'; start: number; end: number; total: number } | { kind: 'status'; total: number }

  function parseContentRange(header: string | null): ContentRange | Response {
    if (header === null) return googleError(400, 'invalid', 'Content-Range header is required')
    let m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header)
    if (m) return { kind: 'chunk', start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) }
    m = /^bytes \*\/(\d+)$/.exec(header)
    if (m) return { kind: 'status', total: Number(m[1]) }
    return googleError(400, 'invalid', `Invalid Content-Range header: ${header}`)
  }

  function sessionProgress(s: Session): Response {
    const headers: Record<string, string> = s.receivedBytes > 0 ? { Range: `bytes=0-${s.receivedBytes - 1}` } : {}
    return new Response(null, { status: 308, headers })
  }

  function finishSession(s: Session): Response {
    const content = new Uint8Array(s.receivedBytes)
    let at = 0
    for (const c of s.chunks) {
      content.set(c, at)
      at += c.length
    }
    let res: Response
    if (s.method === 'POST') {
      res = createFromMetadata(s.metadata, content, s.mimeType)
    } else {
      const f = files.get(s.fileId ?? '')
      if (!f) return notFound(s.fileId ?? '')
      const bad = applyMetadata(f, s.metadata, false)
      if (bad) return bad
      f.content = content
      f.mimeType = s.mimeType
      f.modifiedTime = typeof s.metadata.modifiedTime === 'string' ? f.modifiedTime : now()
      record(f.id, false)
      res = json(200, fileJson(f))
    }
    return res
  }

  async function handleChunk(call: FakeCall): Promise<Response> {
    const s = sessions.get(call.url.searchParams.get('upload_id') ?? '')
    if (!s) return googleError(404, 'notFound', 'Upload session not found.')
    const range = parseContentRange(call.headers.get('content-range'))
    if (range instanceof Response) return range
    if (s.total === null) s.total = range.total
    if (range.total !== s.total) return googleError(400, 'invalid', 'Content-Range total does not match the session')
    if (s.result !== null) return json(200, masked(s.result, s.fields, FILE_DEFAULT_MASK))
    if (range.kind === 'status') return sessionProgress(s)
    const body = call.body ?? new Uint8Array()
    if (body.length !== range.end - range.start + 1) return googleError(400, 'invalid', 'Content-Range does not match the body length')
    const isLast = range.end + 1 === s.total
    if (!isLast && body.length % (256 * 1024) !== 0) return googleError(400, 'invalid', 'Chunk size must be a multiple of 256 KiB')
    if (range.start > s.receivedBytes) return sessionProgress(s) // a gap: tell the client where we are
    if (range.end + 1 > s.receivedBytes) {
      const fresh = body.subarray(s.receivedBytes - range.start)
      s.chunks.push(fresh.slice())
      s.receivedBytes += fresh.length
    }
    if (s.receivedBytes < s.total) return sessionProgress(s)
    const res = finishSession(s)
    if (res.ok) {
      const body = (await res.clone().json()) as unknown
      s.result = body
      return json(200, masked(body, s.fields, FILE_DEFAULT_MASK))
    }
    return res
  }

  async function startSession(call: FakeCall, method: 'POST' | 'PATCH', fileId: string | null): Promise<Response> {
    let metadata: unknown = {}
    if (call.body && call.body.length > 0) {
      try {
        metadata = JSON.parse(decoder.decode(call.body))
      } catch {
        return googleError(400, 'parseError', 'Parse Error')
      }
    }
    if (!isRecord(metadata)) return googleError(400, 'invalid', 'Invalid metadata')
    if (fileId !== null && !files.has(fileId)) return notFound(fileId)
    const lengthHeader = call.headers.get('x-upload-content-length')
    const id = `sess${sessions.size + 1}-${newId()}`
    sessions.set(id, {
      id,
      method,
      fileId,
      metadata,
      total: lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null,
      mimeType: call.headers.get('x-upload-content-type') ?? 'application/octet-stream',
      chunks: [],
      receivedBytes: 0,
      fields: call.url.searchParams.get('fields'),
      result: null,
    })
    const location = `https://www.googleapis.com/upload/drive/v3/files${fileId ? `/${fileId}` : ''}?uploadType=resumable&upload_id=${id}`
    return new Response(null, { status: 200, headers: { Location: location, 'x-guploader-uploadid': id } })
  }

  function handleMultipart(call: FakeCall, fileId: string | null): Response {
    let parts: MultipartPart[]
    try {
      parts = parseMultipart(call.body ?? new Uint8Array(), call.headers.get('content-type') ?? '')
    } catch (err) {
      return new Response(`Invalid multipart request: ${err instanceof Error ? err.message : String(err)}`, { status: 400, headers: { 'Content-Type': 'text/plain' } })
    }
    if (parts.length !== 2 || !(parts[0].headers['content-type'] ?? '').startsWith('application/json')) {
      return new Response('Invalid multipart request with 2 mime parts expected', { status: 400, headers: { 'Content-Type': 'text/plain' } })
    }
    let metadata: unknown
    try {
      metadata = JSON.parse(decoder.decode(parts[0].body))
    } catch {
      return googleError(400, 'parseError', 'Parse Error')
    }
    if (!isRecord(metadata)) return googleError(400, 'invalid', 'Invalid metadata')
    const mediaType = parts[1].headers['content-type'] ?? 'application/octet-stream'
    if (fileId === null) return createFromMetadata(metadata, parts[1].body, typeof metadata.mimeType === 'string' ? metadata.mimeType : mediaType)
    const f = files.get(fileId)
    if (!f) return notFound(fileId)
    const bad = applyMetadata(f, metadata, false)
    if (bad) return bad
    f.content = parts[1].body
    f.mimeType = mediaType
    if (typeof metadata.modifiedTime !== 'string') f.modifiedTime = now()
    record(f.id, false)
    return json(200, fileJson(f))
  }

  function handleList(call: FakeCall): Response {
    const q = call.url.searchParams.get('q')
    let predicate: Predicate = () => true
    if (q !== null) {
      try {
        predicate = parseQuery(q)
      } catch (err) {
        return googleError(400, 'invalid', `Invalid Value: ${err instanceof Error ? err.message : String(err)}`, 'q')
      }
    }
    const all = [...files.values()].filter((f) => f.id !== 'root' && predicate(f, state))
    const pageSize = Math.min(1000, Math.max(1, Number(call.url.searchParams.get('pageSize') ?? 100)))
    const token = call.url.searchParams.get('pageToken')
    const offset = token === null ? 0 : Number(token)
    if (!Number.isInteger(offset) || offset < 0 || offset > all.length) return googleError(400, 'invalid', 'Invalid Value', 'pageToken')
    const page = all.slice(offset, offset + pageSize)
    const body: Record<string, unknown> = { kind: 'drive#fileList', incompleteSearch: false, files: page.map(fileJson) }
    if (offset + pageSize < all.length) body.nextPageToken = String(offset + pageSize)
    const fallback: Mask = { kind: true, nextPageToken: true, incompleteSearch: true, files: FILE_DEFAULT_MASK }
    return json(200, masked(body, call.url.searchParams.get('fields'), fallback))
  }

  function handleChanges(call: FakeCall): Response {
    const token = call.url.searchParams.get('pageToken')
    const from = token === null ? NaN : Number(token)
    if (!Number.isInteger(from) || from < 1 || from > seq) return googleError(400, 'invalid', 'Invalid Value', 'pageToken')
    const pending = changeLog.filter((c) => c.seq >= from)
    const pageSize = Math.min(1000, Math.max(1, Number(call.url.searchParams.get('pageSize') ?? 100)))
    const page = pending.slice(0, pageSize)
    const body: Record<string, unknown> = {
      kind: 'drive#changeList',
      // Like Google: each entry reports the file's current state, so a file deleted since reads as removed.
      changes: page.map((c) => {
        const f = files.get(c.fileId)
        return {
          kind: 'drive#change',
          type: 'file',
          changeType: 'file',
          time: new Date(c.time).toISOString(),
          removed: c.removed || !f,
          fileId: c.fileId,
          ...(f ? { file: fileJson(f) } : {}),
        }
      }),
    }
    if (pending.length > pageSize) body.nextPageToken = String(page[page.length - 1].seq + 1)
    else body.newStartPageToken = String(seq)
    const fallback: Mask = { kind: true, nextPageToken: true, newStartPageToken: true, changes: { kind: true, type: true, changeType: true, time: true, removed: true, fileId: true, file: FILE_DEFAULT_MASK } }
    return json(200, masked(body, call.url.searchParams.get('fields'), fallback))
  }

  function deleteTree(id: string): void {
    for (const f of [...files.values()]) if (f.parents.includes(id)) deleteTree(f.id)
    files.delete(id)
    record(id, true)
  }

  async function route(call: FakeCall): Promise<Response> {
    if (drive.token !== null && call.headers.get('authorization') !== `Bearer ${drive.token}`) {
      return googleError(401, 'authError', 'Invalid Credentials')
    }
    const { method } = call
    const path = call.url.pathname
    const fields = call.url.searchParams.get('fields')

    if (call.url.searchParams.has('upload_id')) return method === 'PUT' ? handleChunk(call) : googleError(400, 'invalid', 'Bad upload request')

    if (path === '/drive/v3/about' && method === 'GET') {
      if (fields === null) return googleError(400, 'required', "The 'fields' parameter is required for this method.", 'fields')
      return json(200, masked({ kind: 'drive#about', user: { kind: 'drive#user', displayName: 'Test User', emailAddress: drive.email } }, fields, {}))
    }
    if (path === '/drive/v3/changes/startPageToken' && method === 'GET') return json(200, { kind: 'drive#startPageToken', startPageToken: String(seq) })
    if (path === '/drive/v3/changes' && method === 'GET') return handleChanges(call)

    if (path === '/drive/v3/files' && method === 'GET') return handleList(call)
    if (path === '/drive/v3/files' && method === 'POST') {
      let meta: unknown
      try {
        meta = JSON.parse(decoder.decode(call.body ?? new Uint8Array()))
      } catch {
        return googleError(400, 'parseError', 'Parse Error')
      }
      if (!isRecord(meta)) return googleError(400, 'invalid', 'Invalid metadata')
      const res = createFromMetadata(meta, new Uint8Array(), null)
      return res.ok ? json(200, masked(await res.json(), fields, FILE_DEFAULT_MASK)) : res
    }

    if (path === '/upload/drive/v3/files' && method === 'POST') {
      const type = call.url.searchParams.get('uploadType')
      if (type === 'resumable') return startSession(call, 'POST', null)
      if (type === 'multipart') {
        const res = handleMultipart(call, null)
        return res.ok ? json(200, masked(await res.json(), fields, FILE_DEFAULT_MASK)) : res
      }
      return googleError(400, 'invalid', `Unsupported uploadType ${type}`)
    }
    const uploadMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path)
    if (uploadMatch && method === 'PATCH') {
      const id = decodeURIComponent(uploadMatch[1])
      const type = call.url.searchParams.get('uploadType')
      if (type === 'resumable') return startSession(call, 'PATCH', id)
      if (type === 'multipart') {
        const res = handleMultipart(call, id)
        return res.ok ? json(200, masked(await res.json(), fields, FILE_DEFAULT_MASK)) : res
      }
      return googleError(400, 'invalid', `Unsupported uploadType ${type}`)
    }

    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path)
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1])
      const f = files.get(id)
      if (!f) return notFound(id)
      if (method === 'GET') {
        if (call.url.searchParams.get('alt') === 'media') {
          if (f.mimeType === FOLDER_MIME) return googleError(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded.')
          return new Response(f.content.slice(), { status: 200, headers: { 'Content-Type': f.mimeType, 'Content-Length': String(f.content.length) } })
        }
        return json(200, masked(fileJson(f), fields, FILE_DEFAULT_MASK))
      }
      if (method === 'PATCH') {
        let meta: unknown
        try {
          meta = JSON.parse(decoder.decode(call.body ?? new Uint8Array()))
        } catch {
          return googleError(400, 'parseError', 'Parse Error')
        }
        if (!isRecord(meta)) return googleError(400, 'invalid', 'Invalid metadata')
        const bad = applyMetadata(f, meta, false)
        if (bad) return bad
        record(f.id, false)
        return json(200, masked(fileJson(f), fields, FILE_DEFAULT_MASK))
      }
      if (method === 'DELETE') {
        if (id === 'root') return googleError(403, 'cannotDeleteRootFolder', 'The root folder cannot be deleted.')
        deleteTree(id)
        return new Response(null, { status: 204 })
      }
    }
    return googleError(404, 'notFound', `No route for ${method} ${path}`)
  }

  const fetch: FetchLike = async (url, init) => {
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const call: FakeCall = { method: init?.method ?? 'GET', url: new URL(url), headers: new Headers(init?.headers), body: await bodyBytes(init?.body) }
    calls.push(call)
    const faultIndex = faults.findIndex((f) => f.match(call))
    const fault = faultIndex >= 0 ? faults[faultIndex] : null
    if (fault) {
      fault.times = (fault.times ?? 1) - 1
      if (fault.times <= 0) faults.splice(faultIndex, 1)
      if (fault.after) await route(call)
      const answer = typeof fault.answer === 'function' ? fault.answer(call) : fault.answer
      if (answer instanceof Error) throw answer
      return answer
    }
    return route(call)
  }

  const drive: FakeDrive = {
    fetch,
    files,
    calls,
    changeLog,
    sessions,
    email: opts.email ?? 'me@example.com',
    token: opts.token ?? null,
    get now() {
      return now
    },
    set now(fn: () => number) {
      now = fn
    },
    failNext: (fault) => {
      faults.push({ ...fault })
    },
    addFolder,
    addFile,
    childrenOf: (parentId) => [...files.values()].filter((f) => f.parents.includes(parentId) && !state.isTrashed(f)),
    textOf: (id) => {
      const f = files.get(id)
      if (!f) throw new Error(`fakeDrive: no file ${id}`)
      return decoder.decode(f.content)
    },
    callsMatching: (pattern) => calls.filter((c) => (pattern instanceof RegExp ? pattern.test(`${c.method} ${c.url.pathname}${c.url.search}`) : pattern(c))),
    nextStartToken: () => String(seq),
  }
  return drive
}
