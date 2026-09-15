// Plan M4 step 2, the two upload protocols Drive offers over plain `fetch` (spike §2 items 4, §3):
//   - multipart (`uploadType=multipart`, one `multipart/related` body) for content up to 5 MB;
//   - resumable (`uploadType=resumable`) above that: an initiating request returns a session URL in
//     `Location`, then chunks go up with `PUT` + `Content-Range`; 308 carries the bytes received so far,
//     the last chunk answers 200 with the file JSON. Chunk sizes must be multiples of 256 KiB.
// Everything here is body-reusable (Blob slices), which the retrying transport requires.

import { HttpError } from './errors'
import type { FetchLike } from './http'

export type UploadContent = ArrayBuffer | Uint8Array | Blob | string

/** Google's documented ceiling for a multipart upload. */
export const MULTIPART_MAX_BYTES = 5 * 1024 * 1024
export const RESUMABLE_CHUNK_UNIT = 256 * 1024
/** 1 MiB, the size the spike verified (H6). */
export const DEFAULT_CHUNK_BYTES = 4 * RESUMABLE_CHUNK_UNIT

export interface TransferOptions {
  signal?: AbortSignal
  /** Bytes sent so far and the total; called after every accepted chunk and once at the end. */
  onProgress?: (done: number, total: number) => void
}

export interface ResumableDeps {
  fetch: FetchLike
  log?: (line: string) => void
  chunkBytes?: number
  /** How often a lost session (404/410) is restarted from byte 0. */
  maxRestarts?: number
  /** How many network failures mid-upload are recovered by asking the session for its status. */
  maxNetworkRecoveries?: number
}

export interface ResumableInit {
  /** The initiating request: `POST …/files?uploadType=resumable` (create) or `PATCH …/files/{id}?…` (update). */
  url: string
  method: 'POST' | 'PATCH'
  metadata: unknown
}

/** `Blob` only takes views over a plain `ArrayBuffer`; a view over shared memory is copied. */
function asBlobPart(view: Uint8Array): Uint8Array<ArrayBuffer> {
  if (view.buffer instanceof ArrayBuffer) return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  const copy = new Uint8Array(view.byteLength)
  copy.set(view)
  return copy
}

export function toBlob(content: UploadContent, mimeType: string): Blob {
  if (content instanceof Blob) return content.type === mimeType ? content : new Blob([content], { type: mimeType })
  if (content instanceof Uint8Array) return new Blob([asBlobPart(content)], { type: mimeType })
  return new Blob([content], { type: mimeType })
}

/** Builds the `multipart/related` body Drive expects: a JSON metadata part followed by the media part. */
export function multipartBody(metadata: unknown, media: Blob, boundary = `gdsync-${Math.random().toString(36).slice(2)}`): { body: Blob; contentType: string } {
  const head =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${media.type || 'application/octet-stream'}\r\n\r\n`
  const tail = `\r\n--${boundary}--`
  return { body: new Blob([head, media, tail]), contentType: `multipart/related; boundary=${boundary}` }
}

/** `Range: bytes=0-N` on a 308 means N+1 bytes are stored; no header means none. */
export function receivedBytesFromRange(range: string | null): number {
  if (range === null) return 0
  const m = /^bytes=0-(\d+)$/.exec(range.trim())
  if (!m) return 0
  return Number(m[1]) + 1
}

export function assertChunkSize(bytes: number): void {
  if (!Number.isInteger(bytes) || bytes < RESUMABLE_CHUNK_UNIT || bytes % RESUMABLE_CHUNK_UNIT !== 0) {
    throw new Error(`resumable chunk size must be a positive multiple of ${RESUMABLE_CHUNK_UNIT} bytes, got ${bytes}`)
  }
}

class SessionLost extends Error {
  override readonly name = 'SessionLost'
  readonly cause: HttpError
  constructor(cause: HttpError) {
    super(cause.message)
    this.cause = cause
  }
}

/**
 * Runs one resumable upload end to end and resolves with the parsed file JSON of the final response.
 * Transport retries (5xx, 429) happen per request underneath; this layer handles the protocol:
 * partial acceptance (308 + Range), a lost session (restart once), and a network failure mid-chunk
 * (ask the session where it stands, then continue).
 */
export async function resumableUpload(deps: ResumableDeps, init: ResumableInit, media: Blob, opts: TransferOptions = {}): Promise<unknown> {
  const chunkBytes = deps.chunkBytes ?? DEFAULT_CHUNK_BYTES
  assertChunkSize(chunkBytes)
  const log = deps.log ?? (() => undefined)
  const maxRestarts = deps.maxRestarts ?? 1
  const maxNetworkRecoveries = deps.maxNetworkRecoveries ?? 3
  const total = media.size
  if (total === 0) throw new Error('resumable upload of an empty file is not supported; use multipart')

  async function startSession(): Promise<string> {
    const res = await deps.fetch(init.url, {
      method: init.method,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': media.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(total),
      },
      body: JSON.stringify(init.metadata),
      signal: opts.signal,
    })
    if (!res.ok) throw await HttpError.fromResponse(res, init.url)
    const location = res.headers.get('location')
    if (!location) throw new Error('Drive did not return a resumable session URL (Location header missing).')
    return location
  }

  /** A `Content-Range` of "bytes star/total" with no body asks how much the session holds: the next offset, or the file JSON when it is complete. */
  async function queryStatus(session: string): Promise<{ offset: number; done: unknown | null }> {
    const res = await deps.fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` }, signal: opts.signal })
    if (res.status === 308) return { offset: receivedBytesFromRange(res.headers.get('range')), done: null }
    if (res.ok) return { offset: total, done: await res.json() }
    const err = await HttpError.fromResponse(res, session)
    if (res.status === 404 || res.status === 410) throw new SessionLost(err)
    throw err
  }

  let restarts = 0
  let networkRecoveries = 0
  for (;;) {
    const session = await startSession()
    let offset = 0
    let stalls = 0
    try {
      for (;;) {
        const end = Math.min(offset + chunkBytes, total)
        let res: Response
        try {
          res = await deps.fetch(session, {
            method: 'PUT',
            headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
            body: media.slice(offset, end),
            signal: opts.signal,
          })
        } catch (err) {
          if (opts.signal?.aborted || !(err instanceof TypeError) || networkRecoveries >= maxNetworkRecoveries) throw err
          networkRecoveries++
          log(`network failure while sending bytes ${offset}-${end - 1}; asking the session for its status (${networkRecoveries}/${maxNetworkRecoveries})`)
          const status = await queryStatus(session)
          if (status.done !== null) {
            opts.onProgress?.(total, total)
            return status.done
          }
          offset = status.offset
          continue
        }
        if (res.status === 308) {
          const received = receivedBytesFromRange(res.headers.get('range'))
          if (received <= offset) {
            stalls++
            if (stalls >= 3) {
              const hint = res.headers.get('range') === null ? '; the 308 carried no readable Range header' : ''
              throw new Error(`resumable upload is not progressing (server holds ${received} of ${total} bytes${hint})`)
            }
            log(`server holds ${received} bytes after sending up to ${end}; re-sending`)
          } else {
            stalls = 0
          }
          offset = received
          opts.onProgress?.(offset, total)
          continue
        }
        if (res.ok) {
          opts.onProgress?.(total, total)
          return await res.json()
        }
        const err = await HttpError.fromResponse(res, session)
        if (res.status === 404 || res.status === 410) throw new SessionLost(err)
        throw err
      }
    } catch (err) {
      if (err instanceof SessionLost && restarts < maxRestarts) {
        restarts++
        log(`resumable session lost (HTTP ${err.cause.status}); restarting the upload (${restarts}/${maxRestarts})`)
        continue
      }
      if (err instanceof SessionLost) throw err.cause
      throw err
    }
  }
}
