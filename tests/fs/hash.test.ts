import { describe, expect, it } from 'vitest'
import { bytesToHex, sha256Hex } from '../../src/fs/hash'

describe('sha256Hex', () => {
  it('hashes strings, buffers and views identically', async () => {
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' // sha256("abc")
    const bytes = new TextEncoder().encode('abc')
    expect(await sha256Hex('abc')).toBe(expected)
    expect(await sha256Hex(bytes)).toBe(expected)
    expect(await sha256Hex(bytes.buffer as ArrayBuffer)).toBe(expected)
    // A view into a bigger buffer must hash only its window.
    const padded = new Uint8Array([9, 9, ...bytes, 9])
    expect(await sha256Hex(padded.subarray(2, 5))).toBe(expected)
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('bytesToHex pads every byte', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 16, 255]))).toBe('000f10ff')
  })
})
