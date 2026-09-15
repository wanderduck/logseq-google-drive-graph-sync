// The fake is test infrastructure for M4 and M6, so its parsers get their own checks.
import { describe, expect, it } from 'vitest'
import { FOLDER_MIME } from '../../src/google/driveQuery'
import { applyFieldMask, createFakeDrive, parseFieldMask, parseMultipart, parseQuery } from './fakeDrive'

describe('parseFieldMask / applyFieldMask', () => {
  it('parses nested masks and keeps only the listed keys', () => {
    const mask = parseFieldMask('nextPageToken,files(id,name,appProperties)')
    expect(mask).toEqual({ nextPageToken: true, files: { id: true, name: true, appProperties: true } })
    const out = applyFieldMask({ kind: 'x', nextPageToken: 't', files: [{ id: '1', name: 'a', size: '3', appProperties: { k: 'v' } }] }, mask)
    expect(out).toEqual({ nextPageToken: 't', files: [{ id: '1', name: 'a', appProperties: { k: 'v' } }] })
  })

  it('rejects malformed specs', () => {
    expect(() => parseFieldMask('files(id')).toThrow()
    expect(() => parseFieldMask('a,,b')).toThrow()
  })
})

describe('parseMultipart', () => {
  it('splits a multipart/related body into metadata and binary media', () => {
    const media = new Uint8Array([0, 1, 2, 13, 10, 45, 45, 255])
    const head = new TextEncoder().encode('--B\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"x"}\r\n--B\r\nContent-Type: image/png\r\n\r\n')
    const tail = new TextEncoder().encode('\r\n--B--')
    const body = new Uint8Array([...head, ...media, ...tail])
    const parts = parseMultipart(body, 'multipart/related; boundary=B')
    expect(parts).toHaveLength(2)
    expect(parts[0].headers['content-type']).toBe('application/json; charset=UTF-8')
    expect(new TextDecoder().decode(parts[0].body)).toBe('{"name":"x"}')
    expect(parts[1].headers['content-type']).toBe('image/png')
    expect([...parts[1].body]).toEqual([...media])
  })
})

describe('parseQuery', () => {
  const drive = createFakeDrive()
  const folder = drive.addFolder('root', "Bob's")
  const file = drive.addFile(folder.id, 'a.md', 'x', { mimeType: 'text/markdown', appProperties: { sha256: 'h1' } })
  const trashed = drive.addFile(folder.id, 'gone.md', 'y', { trashed: true })
  const state = { isTrashed: (f: { trashed: boolean }) => f.trashed }

  it('matches every clause shape the client builds', () => {
    const under = parseQuery(`'${folder.id}' in parents and trashed = false`)
    expect(under(file, state)).toBe(true)
    expect(under(trashed, state)).toBe(false)
    expect(under(folder, state)).toBe(false)
    expect(parseQuery("'root' in parents and name = 'Bob\\'s' and mimeType = '" + FOLDER_MIME + "'")(folder, state)).toBe(true)
    expect(parseQuery(`mimeType != '${FOLDER_MIME}'`)(folder, state)).toBe(false)
    expect(parseQuery("appProperties has { key='sha256' and value='h1' }")(file, state)).toBe(true)
    expect(parseQuery("appProperties has { key='sha256' and value='h2' }")(file, state)).toBe(false)
  })

  it('throws on clauses outside the grammar so client query bugs surface', () => {
    expect(() => parseQuery("name contains 'x'")).toThrow(/unsupported query clause/)
    expect(() => parseQuery("trashed = false or name = 'x'")).toThrow(/expected " and "/)
  })
})
