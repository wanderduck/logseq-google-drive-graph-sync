// Drive `files.list` query strings (the `q` parameter). Only the clause shapes the sync needs. The test
// fake (tests/google/fakeDrive.ts) parses exactly this grammar back, so keep the two in step.

export const FOLDER_MIME = 'application/vnd.google-apps.folder'

export type QueryClause =
  | { kind: 'parent'; id: string }
  | { kind: 'name'; value: string }
  | { kind: 'mimeType'; value: string; negate?: boolean }
  | { kind: 'trashed'; value: boolean }
  | { kind: 'appProperty'; key: string; value: string }

/** Drive escapes `\` and `'` inside single-quoted values with a backslash. */
export function escapeQueryValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function clauseText(c: QueryClause): string {
  switch (c.kind) {
    case 'parent':
      return `'${escapeQueryValue(c.id)}' in parents`
    case 'name':
      return `name = '${escapeQueryValue(c.value)}'`
    case 'mimeType':
      return `mimeType ${c.negate ? '!=' : '='} '${escapeQueryValue(c.value)}'`
    case 'trashed':
      return `trashed = ${c.value ? 'true' : 'false'}`
    case 'appProperty':
      return `appProperties has { key='${escapeQueryValue(c.key)}' and value='${escapeQueryValue(c.value)}' }`
  }
}

export function buildQuery(clauses: QueryClause[]): string {
  return clauses.map(clauseText).join(' and ')
}

export type ChildFilter = 'all' | 'folders' | 'files'

/** Non-trashed children of a folder, optionally only sub-folders or only files. */
export function childrenQuery(parentId: string, filter: ChildFilter = 'all'): string {
  const clauses: QueryClause[] = [{ kind: 'parent', id: parentId }, { kind: 'trashed', value: false }]
  if (filter === 'folders') clauses.push({ kind: 'mimeType', value: FOLDER_MIME })
  if (filter === 'files') clauses.push({ kind: 'mimeType', value: FOLDER_MIME, negate: true })
  return buildQuery(clauses)
}

/** A non-trashed child by exact name; `folder` picks between the folder and the file namespace. */
export function childByNameQuery(parentId: string, name: string, folder: boolean): string {
  return buildQuery([
    { kind: 'parent', id: parentId },
    { kind: 'name', value: name },
    { kind: 'mimeType', value: FOLDER_MIME, negate: !folder },
    { kind: 'trashed', value: false },
  ])
}

/** Non-trashed files tagged with one `appProperties` key/value (spike §4 item 8). */
export function appPropertyQuery(key: string, value: string): string {
  return buildQuery([{ kind: 'appProperty', key, value }, { kind: 'trashed', value: false }])
}
