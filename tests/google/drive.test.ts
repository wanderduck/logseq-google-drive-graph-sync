import { describe, expect, it } from 'vitest'
import { FILE_FIELDS, InvalidPageTokenError, createDriveClient, isNotFound, oldestFirst, parseDriveFile, type DriveClientDeps, type DriveFile } from '../../src/google/drive'
import { FOLDER_MIME } from '../../src/google/driveQuery'
import { RESUMABLE_CHUNK_UNIT, multipartBody, receivedBytesFromRange } from '../../src/google/driveUpload'
import { HttpError } from '../../src/google/errors'
import { createHttpClient, type FetchLike } from '../../src/google/http'
import { createFakeDrive, type FakeDrive } from './fakeDrive'
import { jsonResponse, networkError } from './helpers'

const KIB = 1024
const T0 = 1_700_000_000_000

function harness(deps: Partial<DriveClientDeps> = {}, fake: FakeDrive = createFakeDrive({ now: () => T0 })) {
  const logs: string[] = []
  const client = createDriveClient({ fetch: fake.fetch, log: (l) => logs.push(l), ...deps })
  return { fake, client, logs }
}

function bytes(n: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * seed + 13) & 0xff
  return out
}

describe('parseDriveFile', () => {
  it('converts Drive JSON (string sizes, RFC 3339 times) and fills defaults', () => {
    const f = parseDriveFile({ id: 'x', name: 'a.md', mimeType: 'text/markdown', size: '12', md5Checksum: 'm', modifiedTime: '2026-09-15T10:00:00.000Z', createdTime: '2026-09-15T09:00:00Z', parents: ['p'], appProperties: { sha256: 'h', n: 1 }, trashed: true })
    expect(f).toEqual({ id: 'x', name: 'a.md', mimeType: 'text/markdown', isFolder: false, size: 12, md5Checksum: 'm', modifiedTime: Date.parse('2026-09-15T10:00:00Z'), createdTime: Date.parse('2026-09-15T09:00:00Z'), parents: ['p'], appProperties: { sha256: 'h' }, trashed: true })
    const folder = parseDriveFile({ id: 'd', name: 'pages', mimeType: FOLDER_MIME })
    expect(folder).toMatchObject({ isFolder: true, size: null, md5Checksum: null, parents: [], appProperties: {}, trashed: false, modifiedTime: 0 })
    expect(() => parseDriveFile({ name: 'no id' })).toThrow(/without an id/)
  })

  it('oldestFirst orders by createdTime then id', () => {
    const mk = (id: string, createdTime: number): DriveFile => ({ ...parseDriveFile({ id, name: id }), createdTime })
    expect([mk('b', 2), mk('a', 2), mk('c', 1)].sort(oldestFirst).map((f) => f.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('getFile / listChildren / findChild', () => {
  it('reads a file and a folder with every field the sync needs', async () => {
    const { fake, client } = harness()
    const dir = fake.addFolder('root', 'pages')
    const file = fake.addFile(dir.id, 'a.md', 'hello', { mimeType: 'text/markdown', appProperties: { sha256: 'h1', relPath: 'pages/a.md' } })
    const got = await client.getFile(file.id)
    expect(got).toMatchObject({ id: file.id, name: 'a.md', mimeType: 'text/markdown', isFolder: false, size: 5, parents: [dir.id], appProperties: { sha256: 'h1', relPath: 'pages/a.md' }, trashed: false, modifiedTime: T0 })
    expect(got.md5Checksum).toMatch(/^[0-9a-f]{32}$/)
    expect(await client.getFile(dir.id)).toMatchObject({ isFolder: true, size: null, name: 'pages' })
    expect(fake.calls[0].url.searchParams.get('fields')).toBe(FILE_FIELDS)
  })

  it('turns a 404 into an HttpError that isNotFound recognises', async () => {
    const { client } = harness()
    const err = await client.getFile('missing').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(404)
    expect((err as HttpError).info.reasons).toEqual(['notFound'])
    expect(isNotFound(err)).toBe(true)
    expect(isNotFound(new Error('x'))).toBe(false)
  })

  it('pages through a listing and filters folders or files, skipping trashed entries', async () => {
    const { fake, client } = harness({ pageSize: 2 })
    const dir = fake.addFolder('root', 'g')
    for (const n of ['a', 'b', 'c']) fake.addFile(dir.id, `${n}.md`, n)
    fake.addFolder(dir.id, 'sub')
    fake.addFolder(dir.id, 'sub2')
    fake.addFile(dir.id, 'gone.md', 'x', { trashed: true })
    const all = await client.listChildren(dir.id)
    expect(all.map((f) => f.name).sort()).toEqual(['a.md', 'b.md', 'c.md', 'sub', 'sub2'])
    expect(fake.callsMatching(/^GET \/drive\/v3\/files\?/)).toHaveLength(3)
    expect((await client.listChildren(dir.id, 'folders')).map((f) => f.name)).toEqual(['sub', 'sub2'])
    expect((await client.listChildren(dir.id, 'files')).map((f) => f.name)).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('findChild returns null, a single match, or the oldest of duplicates, and escapes quotes', async () => {
    const { fake, client, logs } = harness()
    const dir = fake.addFolder('root', 'g')
    expect(await client.findChild(dir.id, "it's.md", false)).toBeNull()
    const f = fake.addFile(dir.id, "it's.md", 'x')
    expect((await client.findChild(dir.id, "it's.md", false))?.id).toBe(f.id)
    expect(await client.findChild(dir.id, "it's.md", true)).toBeNull()
    fake.addFolder(dir.id, 'pages', { createdTime: T0 + 10 })
    const older = fake.addFolder(dir.id, 'pages', { createdTime: T0 - 10 })
    expect((await client.findChild(dir.id, 'pages', true))?.id).toBe(older.id)
    expect(logs.at(-1)).toMatch(/2 entries named "pages"/)
  })

  it('findByAppProperty queries the tag', async () => {
    const { fake, client } = harness()
    const a = fake.addFile('root', 'a', 'x', { appProperties: { sha256: 'h1' } })
    fake.addFile('root', 'b', 'y', { appProperties: { sha256: 'h2' } })
    expect((await client.findByAppProperty('sha256', 'h1')).map((f) => f.id)).toEqual([a.id])
  })
})

describe('ensureFolder / ensureFolderPath / listTree / pathUnder', () => {
  it('creates missing folders once and serves repeats from the cache', async () => {
    const { fake, client } = harness()
    const id = await client.ensureFolderPath('root', ['Sync', 'graphs', 'g'])
    expect(fake.files.get(id)).toMatchObject({ name: 'g', mimeType: FOLDER_MIME })
    expect(fake.childrenOf('root').map((f) => f.name)).toEqual(['Sync'])
    const before = fake.calls.length
    expect(await client.ensureFolderPath('root', ['Sync', 'graphs', 'g'])).toBe(id)
    expect(fake.calls.length).toBe(before)
    expect(client.folders.entry(id)).toMatchObject({ name: 'g' })
  })

  it('reuses an existing folder instead of creating a duplicate', async () => {
    const { fake, client } = harness()
    const existing = fake.addFolder('root', 'Sync')
    expect(await client.ensureFolder('root', 'Sync')).toBe(existing.id)
    expect(fake.callsMatching(/^POST/)).toHaveLength(0)
  })

  it('collapses a folder created concurrently by another device onto the oldest one', async () => {
    const { fake, client, logs } = harness()
    const parent = fake.addFolder('root', 'Sync')
    // The other device's folder exists but this device's first lookup happened just before it appeared.
    const theirs = fake.addFolder(parent.id, 'graphs', { createdTime: T0 - 1000 })
    fake.failNext({ match: (c) => c.method === 'GET' && (c.url.searchParams.get('q') ?? '').includes("name = 'graphs'"), answer: jsonResponse(200, { files: [] }) })
    const id = await client.ensureFolder(parent.id, 'graphs')
    expect(id).toBe(theirs.id)
    expect(fake.childrenOf(parent.id).map((f) => f.id)).toEqual([theirs.id])
    expect(logs.some((l) => l.includes('created concurrently'))).toBe(true)
    expect(client.folders.get(parent.id, 'graphs')).toBe(theirs.id)
  })

  it('listTree walks nested folders breadth first with path segments and seeds the folder cache', async () => {
    const { fake, client } = harness()
    const g = fake.addFolder('root', 'g')
    const pages = fake.addFolder(g.id, 'pages')
    const assets = fake.addFolder(g.id, 'assets')
    const sub = fake.addFolder(assets.id, 'sub')
    fake.addFile(pages.id, 'a.md', 'a')
    fake.addFile(sub.id, 'x.png', 'p')
    fake.addFile(g.id, 'trashed.md', 't', { trashed: true })
    const tree = await client.listTree(g.id)
    expect(tree.map((e) => e.segments.join('/')).sort()).toEqual(['assets', 'assets/sub', 'assets/sub/x.png', 'pages', 'pages/a.md'])
    expect(tree.find((e) => e.file.id === sub.id)?.file.isFolder).toBe(true)
    expect(client.folders.get(assets.id, 'sub')).toBe(sub.id)
  })

  it('pathUnder resolves parents from the cache, then Drive, and reports files outside the ancestor', async () => {
    const { fake, client } = harness()
    const g = fake.addFolder('root', 'g')
    const pages = fake.addFolder(g.id, 'pages')
    const deep = fake.addFolder(pages.id, 'deep')
    const file = fake.addFile(deep.id, 'a.md', 'a')
    const other = fake.addFile('root', 'elsewhere.md', 'e')
    const f = await client.getFile(file.id)
    const before = fake.calls.length
    expect(await client.pathUnder(f, g.id)).toEqual(['pages', 'deep', 'a.md'])
    expect(fake.calls.length - before).toBe(2) // deep and pages looked up once…
    expect(await client.pathUnder(f, g.id)).toEqual(['pages', 'deep', 'a.md'])
    expect(fake.calls.length - before).toBe(2) // …then cached
    expect(await client.pathUnder(f, pages.id)).toEqual(['deep', 'a.md'])
    expect(await client.pathUnder(await client.getFile(other.id), g.id)).toBeNull()
    fake.files.delete(deep.id)
    client.folders.forget(deep.id)
    expect(await client.pathUnder(f, g.id)).toBeNull()
  })
})

describe('uploads (plan M4 step 2)', () => {
  it('multipartBody has the two parts Drive expects', async () => {
    const { body, contentType } = multipartBody({ name: 'a.md' }, new Blob(['hi'], { type: 'text/markdown' }), 'B')
    expect(contentType).toBe('multipart/related; boundary=B')
    expect(await body.text()).toBe('--B\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.md"}\r\n--B\r\nContent-Type: text/markdown\r\n\r\nhi\r\n--B--')
  })

  it('creates a small file with one multipart request, carrying appProperties and modifiedTime', async () => {
    const { fake, client } = harness()
    const dir = fake.addFolder('root', 'pages')
    const progress: Array<[number, number]> = []
    const file = await client.createFile('# Hello', { name: 'a.md', parentId: dir.id, mimeType: 'text/markdown', appProperties: { sha256: 'h1', relPath: 'pages/a.md' }, modifiedTime: T0 - 5000 }, { onProgress: (d, t) => progress.push([d, t]) })
    expect(file).toMatchObject({ name: 'a.md', mimeType: 'text/markdown', size: 7, parents: [dir.id], appProperties: { sha256: 'h1', relPath: 'pages/a.md' }, modifiedTime: T0 - 5000 })
    expect(fake.textOf(file.id)).toBe('# Hello')
    const call = fake.calls.at(-1)!
    expect(`${call.method} ${call.url.pathname}`).toBe('POST /upload/drive/v3/files')
    expect(call.url.searchParams.get('uploadType')).toBe('multipart')
    expect(call.url.searchParams.get('fields')).toBe(FILE_FIELDS)
    expect(call.headers.get('content-type')).toMatch(/^multipart\/related; boundary=/)
    expect(progress).toEqual([[7, 7]])
  })

  it('accepts ArrayBuffer, Uint8Array and Blob content', async () => {
    const { fake, client } = harness()
    const data = bytes(300)
    const a = await client.createFile(data.buffer as ArrayBuffer, { name: 'a', parentId: 'root' })
    const b = await client.createFile(data, { name: 'b', parentId: 'root' })
    const c = await client.createFile(new Blob([data], { type: 'image/png' }), { name: 'c', parentId: 'root', mimeType: 'image/png' })
    for (const f of [a, b, c]) expect([...fake.files.get(f.id)!.content]).toEqual([...data])
    expect(c.mimeType).toBe('image/png')
    expect(fake.files.get(a.id)!.mimeType).toBe('application/octet-stream')
  })

  it('switches to a resumable session above the multipart limit and sends 256 KiB-multiple chunks', async () => {
    const { fake, client } = harness({ multipartMaxBytes: 1024, chunkBytes: RESUMABLE_CHUNK_UNIT })
    const data = bytes(600 * KIB)
    const progress: number[] = []
    const file = await client.createFile(data, { name: 'big.png', parentId: 'root', mimeType: 'image/png', appProperties: { sha256: 'h' } }, { onProgress: (d) => progress.push(d) })
    expect(file).toMatchObject({ name: 'big.png', size: 600 * KIB, mimeType: 'image/png', appProperties: { sha256: 'h' } })
    expect([...fake.files.get(file.id)!.content]).toEqual([...data])
    const init = fake.callsMatching(/^POST \/upload\/drive\/v3\/files\?uploadType=resumable/)
    expect(init).toHaveLength(1)
    expect(init[0].headers.get('x-upload-content-type')).toBe('image/png')
    expect(init[0].headers.get('x-upload-content-length')).toBe(String(600 * KIB))
    const puts = fake.callsMatching((c) => c.method === 'PUT')
    expect(puts.map((c) => c.headers.get('content-range'))).toEqual([`bytes 0-262143/614400`, `bytes 262144-524287/614400`, `bytes 524288-614399/614400`])
    expect(progress).toEqual([256 * KIB, 512 * KIB, 600 * KIB])
  })

  it('receivedBytesFromRange reads the 308 Range header', () => {
    expect(receivedBytesFromRange(null)).toBe(0)
    expect(receivedBytesFromRange('bytes=0-262143')).toBe(262144)
    expect(receivedBytesFromRange('garbage')).toBe(0)
  })

  it('after a network failure mid-chunk it asks the session for its status and continues', async () => {
    const { fake, client, logs } = harness({ multipartMaxBytes: 1024, chunkBytes: RESUMABLE_CHUNK_UNIT })
    const data = bytes(600 * KIB)
    // The server stores chunk 2 but the client never hears the answer.
    fake.failNext({ match: (c) => c.method === 'PUT' && c.headers.get('content-range') === 'bytes 262144-524287/614400', after: true, answer: networkError() })
    const file = await client.createFile(data, { name: 'big', parentId: 'root' })
    expect([...fake.files.get(file.id)!.content]).toEqual([...data])
    const puts = fake.callsMatching((c) => c.method === 'PUT').map((c) => c.headers.get('content-range'))
    expect(puts).toEqual(['bytes 0-262143/614400', 'bytes 262144-524287/614400', 'bytes */614400', 'bytes 524288-614399/614400'])
    expect(logs.some((l) => l.includes('asking the session for its status'))).toBe(true)
  })

  it('restarts from byte 0 once when the session is lost (404)', async () => {
    const { fake, client } = harness({ multipartMaxBytes: 1024, chunkBytes: RESUMABLE_CHUNK_UNIT })
    const data = bytes(600 * KIB)
    fake.failNext({ match: (c) => c.method === 'PUT' && c.headers.get('content-range')?.startsWith('bytes 262144') === true, answer: jsonResponse(404, { error: { code: 404, message: 'Not Found' } }) })
    const file = await client.createFile(data, { name: 'big', parentId: 'root' })
    expect([...fake.files.get(file.id)!.content]).toEqual([...data])
    expect(fake.callsMatching(/^POST \/upload\/drive\/v3\/files\?uploadType=resumable/)).toHaveLength(2)
    expect(fake.sessions.size).toBe(2)
    // A second loss is final.
    fake.failNext({ match: (c) => c.method === 'PUT', answer: jsonResponse(404, { error: { code: 404, message: 'Not Found' } }), times: 2 })
    const err = await client.createFile(data, { name: 'big2', parentId: 'root' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(404)
  })

  it('gives up when the server never advances', async () => {
    const { fake, client } = harness({ multipartMaxBytes: 1024, chunkBytes: RESUMABLE_CHUNK_UNIT })
    fake.failNext({ match: (c) => c.method === 'PUT', answer: () => new Response(null, { status: 308 }), times: 3 })
    await expect(client.createFile(bytes(600 * KIB), { name: 'big', parentId: 'root' })).rejects.toThrow(/not progressing/)
  })

  it('lets the backoff transport retry a 5xx chunk underneath', async () => {
    const fake = createFakeDrive({ now: () => T0 })
    const http = createHttpClient({ fetch: fake.fetch, sleep: async () => undefined, random: () => 0 })
    const client = createDriveClient({ fetch: (url, init) => http.request(url, init), multipartMaxBytes: 1024, chunkBytes: RESUMABLE_CHUNK_UNIT })
    const data = bytes(600 * KIB)
    fake.failNext({ match: (c) => c.method === 'PUT', answer: new Response('', { status: 503 }) })
    const file = await client.createFile(data, { name: 'big', parentId: 'root' })
    expect([...fake.files.get(file.id)!.content]).toEqual([...data])
    expect(fake.callsMatching((c) => c.method === 'PUT')).toHaveLength(4)
  })

  it('surfaces a final upload error as HttpError with the Drive reason', async () => {
    const { fake, client } = harness()
    fake.failNext({ match: (c) => c.method === 'POST', answer: jsonResponse(403, { error: { code: 403, message: 'quota', errors: [{ reason: 'storageQuotaExceeded' }] } }) })
    const err = await client.createFile('x', { name: 'a', parentId: 'root' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).info.reasons).toEqual(['storageQuotaExceeded'])
  })

  it('rejects an already-aborted signal without touching Drive', async () => {
    const { fake, client } = harness()
    const abort = new AbortController()
    abort.abort()
    await expect(client.createFile('x', { name: 'a', parentId: 'root' }, { signal: abort.signal })).rejects.toThrow(/aborted/)
    expect(fake.files.size).toBe(1)
  })

  it('updateFile replaces content (multipart or resumable) and merges metadata', async () => {
    const { fake, client } = harness({ multipartMaxBytes: 1024, chunkBytes: RESUMABLE_CHUNK_UNIT })
    const file = fake.addFile('root', 'a.md', 'old', { mimeType: 'text/markdown', appProperties: { sha256: 'h1', relPath: 'a.md' } })
    const small = await client.updateFile(file.id, new Blob(['new'], { type: 'text/markdown' }), { appProperties: { sha256: 'h2' }, modifiedTime: T0 + 1 })
    expect(small).toMatchObject({ id: file.id, size: 3, appProperties: { sha256: 'h2', relPath: 'a.md' }, modifiedTime: T0 + 1 })
    expect(fake.textOf(file.id)).toBe('new')
    expect(fake.calls.at(-1)!.url.searchParams.get('uploadType')).toBe('multipart')
    const big = bytes(300 * KIB)
    const large = await client.updateFile(file.id, big, { appProperties: { sha256: 'h3' } })
    expect(large.size).toBe(300 * KIB)
    expect([...fake.files.get(file.id)!.content]).toEqual([...big])
    expect(fake.callsMatching(/^PATCH \/upload\/drive\/v3\/files\/f\d+\?uploadType=resumable/)).toHaveLength(1)
    await expect(client.updateFile('missing', 'x')).rejects.toBeInstanceOf(HttpError)
  })
})

describe('metadata, download, trash, delete', () => {
  it('updateMetadata merges appProperties, deletes keys set to null, and sets name/trashed/modifiedTime', async () => {
    const { fake, client } = harness()
    const file = fake.addFile('root', 'a.md', 'x', { appProperties: { sha256: 'h1', deviceId: 'd1' } })
    const updated = await client.updateMetadata(file.id, { name: 'b.md', appProperties: { sha256: 'h2', deviceId: null, relPath: 'b.md' }, modifiedTime: T0 + 99 })
    expect(updated).toMatchObject({ name: 'b.md', appProperties: { sha256: 'h2', relPath: 'b.md' }, modifiedTime: T0 + 99, trashed: false })
    expect(fake.calls.at(-1)!.headers.get('content-type')).toBe('application/json; charset=UTF-8')
  })

  it('downloads bytes and text', async () => {
    const { fake, client } = harness()
    const data = bytes(5000)
    const bin = fake.addFile('root', 'b.png', data)
    const txt = fake.addFile('root', 'a.md', 'héllo')
    expect([...new Uint8Array(await client.download(bin.id))]).toEqual([...data])
    expect(await client.downloadText(txt.id)).toBe('héllo')
    expect(fake.calls.at(-1)!.url.searchParams.get('alt')).toBe('media')
    await expect(client.download('nope')).rejects.toBeInstanceOf(HttpError)
  })

  it('trash hides a file from listings; deleteForever removes it and cascades over folders', async () => {
    const { fake, client } = harness()
    const dir = fake.addFolder('root', 'd')
    const a = fake.addFile(dir.id, 'a.md', 'a')
    const b = fake.addFile(dir.id, 'b.md', 'b')
    await client.trash(a.id)
    expect((await client.getFile(a.id)).trashed).toBe(true)
    expect((await client.listChildren(dir.id)).map((f) => f.id)).toEqual([b.id])
    client.folders.set('root', 'd', dir.id)
    await client.deleteForever(dir.id)
    expect(fake.files.has(dir.id)).toBe(false)
    expect(fake.files.has(b.id)).toBe(false)
    expect(client.folders.get('root', 'd')).toBeNull()
    await expect(client.deleteForever(dir.id)).rejects.toBeInstanceOf(HttpError)
  })
})

describe('changes (plan M4 step 3)', () => {
  it('lists every change since a token, pages, and hands back the next start token', async () => {
    const { fake, client } = harness({ pageSize: 2 })
    const dir = fake.addFolder('root', 'g')
    const token = await client.getStartPageToken()
    expect(token).toBe(fake.nextStartToken())
    expect(await client.listChanges(token)).toEqual({ changes: [], newStartPageToken: token })

    const a = await client.createFile('a', { name: 'a.md', parentId: dir.id })
    const b = fake.addFile(dir.id, 'b.md', 'b')
    await client.trash(b.id)
    await client.deleteForever(a.id)
    const result = await client.listChanges(token)
    // Like Google, every entry carries the file's *current* state: a file that is gone reads as removed
    // on all of its entries, and a file trashed later reads as trashed on its earlier entries too.
    expect(result.changes.map((c) => [c.fileId, c.removed, c.file?.trashed ?? null])).toEqual([
      [a.id, true, null],
      [b.id, false, true],
      [b.id, false, true],
      [a.id, true, null],
    ])
    expect(result.changes[0].time).toBe(T0)
    expect(fake.callsMatching(/^GET \/drive\/v3\/changes\?/)).toHaveLength(3)
    expect(result.newStartPageToken).toBe(fake.nextStartToken())
    expect((await client.listChanges(result.newStartPageToken)).changes).toEqual([])
  })

  it('rejects an unusable page token with InvalidPageTokenError', async () => {
    const { client } = harness()
    const err = await client.listChanges('not-a-token').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidPageTokenError)
    expect((err as InvalidPageTokenError).cause.status).toBe(400)
  })
})

describe('authorization pass-through', () => {
  it('sends whatever the injected fetch adds; without a Bearer token Drive answers 401', async () => {
    const fake = createFakeDrive({ token: 'tok' })
    const authorized: FetchLike = (url, init) => {
      const headers = new Headers(init?.headers)
      headers.set('Authorization', 'Bearer tok')
      return fake.fetch(url, { ...init, headers })
    }
    const good = createDriveClient({ fetch: authorized })
    expect((await good.getFile('root')).name).toBe('My Drive')
    const bad = createDriveClient({ fetch: fake.fetch })
    const err = await bad.getFile('root').catch((e: unknown) => e)
    expect((err as HttpError).status).toBe(401)
  })
})
