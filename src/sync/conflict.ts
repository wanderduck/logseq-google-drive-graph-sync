// Conflict model shared by the planner (M6), the executor (M7) and the conflict dialog (plan D7, §3.6 step 6).
// Pure TS.

/**
 * `both-modified`: L ≠ B, R ≠ B, L ≠ R.
 * `local-deleted`: the file is gone locally but was modified remotely.
 * `remote-deleted`: the file was modified locally but is gone remotely.
 */
export type ConflictKind = 'both-modified' | 'local-deleted' | 'remote-deleted'

export interface ConflictSide {
  size: number
  /** Epoch ms. */
  modifiedAt: number
  sha256: string
}

export interface ConflictItem {
  /** Graph-relative path with forward slashes, e.g. `pages/Alpha.md`. */
  path: string
  kind: ConflictKind
  local: ConflictSide | null
  remote: ConflictSide | null
}

export type ConflictChoice = 'keep-local' | 'keep-remote' | 'keep-both'

export interface ConflictResolution {
  path: string
  choice: ConflictChoice
}

/** `keep-both` needs two versions to keep; delete conflicts offer only the two "keep" choices. */
export function availableChoices(item: ConflictItem): ConflictChoice[] {
  return item.local && item.remote ? ['keep-local', 'keep-remote', 'keep-both'] : ['keep-local', 'keep-remote']
}

/**
 * Maps a choice applied "to all remaining" onto an item that cannot take it: `keep-both` on a delete
 * conflict keeps the side that still has content.
 */
export function normalizeChoice(item: ConflictItem, choice: ConflictChoice): ConflictChoice {
  if (choice !== 'keep-both' || (item.local && item.remote)) return choice
  return item.local ? 'keep-local' : 'keep-remote'
}

const DEVICE_NAME_MAX = 32

/** Makes a settings-provided device name safe for file names and the Drive lock: `[A-Za-z0-9_-]`, ≤ 32 chars. */
export function sanitizeDeviceName(raw: string, fallback = 'device'): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, DEVICE_NAME_MAX)
    .replace(/-+$/g, '')
  return cleaned.length > 0 ? cleaned : fallback
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `YYYYMMDD-HHmm` in local time, as used in conflict copy names. */
export function conflictStamp(at: Date): string {
  return (
    `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}` + `-${pad2(at.getHours())}${pad2(at.getMinutes())}`
  )
}

/**
 * Name of the "keep both" copy (plan §3.6 step 6): `name.conflict-<deviceName>-<YYYYMMDD-HHmm>.ext`.
 * The directory part is preserved; a name without an extension gets the suffix appended.
 */
export function conflictCopyName(path: string, deviceName: string, at: Date): string {
  const slash = path.lastIndexOf('/')
  const dir = slash === -1 ? '' : path.slice(0, slash + 1)
  const base = slash === -1 ? path : path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const hasExt = dot > 0
  const stem = hasExt ? base.slice(0, dot) : base
  const ext = hasExt ? base.slice(dot) : ''
  return `${dir}${stem}.conflict-${sanitizeDeviceName(deviceName)}-${conflictStamp(at)}${ext}`
}
