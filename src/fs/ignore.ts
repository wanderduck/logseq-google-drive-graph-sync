// Plan §3.4 sync scope for the graph folder: everything except `logseq/bak/`, `logseq/.recycle/`,
// `logseq/version-files/`, `.git/`, `.DS_Store`, `Thumbs.db`, `*.swp`, `*~`, plus (amendment approved
// 2026-09-15) Logseq's own caches `logseq/graphs-txid.edn` (per-device Logseq Sync state) and
// `logseq/pages-metadata.edn` (legacy), which the host itself never indexes (`ignored-path?`), and this
// plugin's atomic-write temp files (`*.gdsync-tmp`, atomicWrite.ts), which must never be synced.
// The host lists everything (`listdir`, spike §4 item 1), so these rules are applied here, not by the host.

import { TMP_SUFFIX } from './atomicWrite'

/** Directory prefixes, root-relative. */
export const GRAPH_IGNORED_DIRS: readonly string[] = ['logseq/bak', 'logseq/.recycle', 'logseq/version-files']
/** Exact root-relative file paths. */
export const GRAPH_IGNORED_FILES: readonly string[] = ['logseq/graphs-txid.edn', 'logseq/pages-metadata.edn']
/** Path segments ignored at any depth (a git checkout anywhere under the graph). */
export const GRAPH_IGNORED_SEGMENTS: readonly string[] = ['.git']
/** File names, compared case-insensitively (Windows writes `thumbs.db` too). */
export const GRAPH_IGNORED_NAMES: readonly string[] = ['.DS_Store', 'Thumbs.db']
/** File name suffixes (editor swap/backup files and our own temp files). */
export const GRAPH_IGNORED_SUFFIXES: readonly string[] = ['.swp', '~', TMP_SUFFIX]

const ignoredNamesLower = new Set(GRAPH_IGNORED_NAMES.map((n) => n.toLowerCase()))

/** `path` is root-relative with forward slashes. */
export function isIgnoredGraphPath(path: string): boolean {
  for (const dir of GRAPH_IGNORED_DIRS) {
    if (path === dir || path.startsWith(`${dir}/`)) return true
  }
  if (GRAPH_IGNORED_FILES.includes(path)) return true
  const segments = path.split('/')
  if (segments.some((s) => GRAPH_IGNORED_SEGMENTS.includes(s))) return true
  const name = segments[segments.length - 1]
  if (ignoredNamesLower.has(name.toLowerCase())) return true
  return GRAPH_IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix))
}
