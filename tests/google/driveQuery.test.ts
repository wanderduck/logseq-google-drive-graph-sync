import { describe, expect, it } from 'vitest'
import { FOLDER_MIME, appPropertyQuery, buildQuery, childByNameQuery, childrenQuery, escapeQueryValue } from '../../src/google/driveQuery'

describe('escapeQueryValue', () => {
  it('backslash-escapes quotes and backslashes', () => {
    expect(escapeQueryValue("It's a \\ path")).toBe("It\\'s a \\\\ path")
    expect(escapeQueryValue('plain')).toBe('plain')
  })
})

describe('buildQuery', () => {
  it('joins clauses with " and " in the Drive grammar', () => {
    expect(
      buildQuery([
        { kind: 'parent', id: 'p1' },
        { kind: 'name', value: "Bob's" },
        { kind: 'mimeType', value: FOLDER_MIME, negate: true },
        { kind: 'trashed', value: false },
        { kind: 'appProperty', key: 'sha256', value: 'abc' },
      ]),
    ).toBe(`'p1' in parents and name = 'Bob\\'s' and mimeType != '${FOLDER_MIME}' and trashed = false and appProperties has { key='sha256' and value='abc' }`)
  })

  it('has helpers for the three lookups the client makes', () => {
    expect(childrenQuery('p1')).toBe("'p1' in parents and trashed = false")
    expect(childrenQuery('p1', 'folders')).toBe(`'p1' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`)
    expect(childrenQuery('p1', 'files')).toBe(`'p1' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`)
    expect(childByNameQuery('p1', 'pages', true)).toBe(`'p1' in parents and name = 'pages' and mimeType = '${FOLDER_MIME}' and trashed = false`)
    expect(childByNameQuery('p1', 'a.md', false)).toBe(`'p1' in parents and name = 'a.md' and mimeType != '${FOLDER_MIME}' and trashed = false`)
    expect(appPropertyQuery('relPath', 'pages/a.md')).toBe("appProperties has { key='relPath' and value='pages/a.md' } and trashed = false")
  })
})
