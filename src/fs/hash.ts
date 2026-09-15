// SHA-256 via SubtleCrypto (plan M5 step 3; available in the plugin iframe, spike §2 item 2d, and in
// Node 22 for the tests). Pulled forward for M4's Drive smoke test, which compares upload and download.

export type Hashable = ArrayBuffer | Uint8Array | string

function toArrayBuffer(data: Hashable): ArrayBuffer {
  if (typeof data === 'string') return new TextEncoder().encode(data).buffer as ArrayBuffer
  if (data instanceof ArrayBuffer) return data
  if (data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy.buffer
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (const b of view) out += b.toString(16).padStart(2, '0')
  return out
}

export async function sha256Hex(data: Hashable): Promise<string> {
  return bytesToHex(await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(data)))
}
