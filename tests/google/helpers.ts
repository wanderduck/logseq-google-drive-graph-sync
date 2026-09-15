// Fakes for the Google layer: a scripted `fetch`, an in-memory `FileStorage`, and instant sleeps.
// Not a test file (Vitest only picks up `*.test.ts`).

import type { FetchLike } from '../../src/google/http'
import type { KeyValueStorage } from '../../src/google/tokenStore'

export interface RecordedCall {
  url: string
  method: string
  headers: Headers
  /** The raw body string, or `null` when absent. */
  body: string | null
  /** `body` parsed as a form; empty for non-form bodies. */
  form: URLSearchParams
}

/** One scripted answer: a `Response`, an `Error` to reject with, or a function that builds one per call. */
export type ScriptStep = Response | Error | ((call: RecordedCall) => Response | Error)

export interface ScriptedFetch {
  fetch: FetchLike
  calls: RecordedCall[]
  /** Steps not consumed yet. */
  remaining(): number
}

function bodyToString(body: BodyInit | null | undefined): string | null {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  throw new Error(`test helper: unsupported body type ${Object.prototype.toString.call(body)}`)
}

/** Answers calls in order; a call past the end of the script fails the test loudly. */
export function scriptedFetch(script: ScriptStep[]): ScriptedFetch {
  const calls: RecordedCall[] = []
  const queue = [...script]
  const fetch: FetchLike = async (url, init) => {
    const body = bodyToString(init?.body)
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
      form: new URLSearchParams(body ?? ''),
    }
    calls.push(call)
    const step = queue.shift()
    if (step === undefined) throw new Error(`test helper: unexpected fetch #${calls.length} to ${url}`)
    const answer = typeof step === 'function' ? step(call) : step
    if (answer instanceof Error) throw answer
    return answer
  }
  return { fetch, calls, remaining: () => queue.length }
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

export function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

export function networkError(): TypeError {
  return new TypeError('Failed to fetch')
}

/** Drive-style 403 with one `errors[].reason`. */
export function driveError(status: number, reason: string, message = reason): Response {
  return jsonResponse(status, { error: { code: status, message, errors: [{ domain: 'usageLimits', reason, message }] } })
}

/** OAuth-style error body (`{ error, error_description }`). */
export function oauthError(status: number, error: string, description?: string): Response {
  return jsonResponse(status, description === undefined ? { error } : { error, error_description: description })
}

export interface FakeStorage extends KeyValueStorage {
  files: Map<string, string>
  /** Makes `getItem` reject like the host does for a missing file, even when `hasItem` said true. */
  failReads: boolean
}

/** Mirrors host 0.10.15: `getItem` of a missing key rejects ("file not existed"), `hasItem` never does. */
export function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const files = new Map(Object.entries(initial))
  const storage: FakeStorage = {
    files,
    failReads: false,
    async getItem(key) {
      if (storage.failReads || !files.has(key)) throw new Error('file not existed')
      return files.get(key)
    },
    async setItem(key, value) {
      files.set(key, value)
    },
    async hasItem(key) {
      return files.has(key)
    },
  }
  return storage
}

export interface SleepRecorder {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  delays: number[]
}

/** Resolves immediately, records every requested delay, and honours an already-aborted signal. */
export function recordingSleep(): SleepRecorder {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms)
    },
  }
}
