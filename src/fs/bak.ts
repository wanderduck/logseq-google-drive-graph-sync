// Plan §3.6 step 7 (+ the 2026-09-15 amendment): the previous content of a file is COPIED to
// `logseq/bak/gdsync/<ts>/<relPath>` before a download overwrites it, and a local deletion MOVES the file
// there. Logseq's own `bak/` only fires on deletions (spike §4.3), so this folder is the safety net for our
// writes. It lives under `logseq/bak/`, which both Logseq (`ignored-path?`) and our scanner ignore.
// Moves are `rename`, never `unlink` (which the host turns into a move to `logseq/.recycle/`, spike §4 item 1).
// One session = one folder per sync run; the restore wizard uses the `restore` label (plan §3.7 step 3).

import { assertRelPath, type GraphFs } from './graphFs'

export const BAK_ROOT = 'logseq/bak/gdsync'
const MAX_COLLISIONS = 1000

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `YYYYMMDD-HHmmss` in local time: sortable, file-name safe on every OS. */
export function bakStamp(at: Date): string {
  return (
    `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}` +
    `-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`
  )
}

/** `logseq/bak/gdsync/<stamp>` or `logseq/bak/gdsync/<label>-<stamp>`. */
export function bakDirFor(at: Date, label?: string): string {
  return `${BAK_ROOT}/${label ? `${label}-` : ''}${bakStamp(at)}`
}

export interface BakSession {
  /** Root-relative folder of this session, e.g. `logseq/bak/gdsync/20260915-034512`. */
  readonly dir: string
  /** Copies the current file to `<dir>/<path>` (the original stays); returns the bak path. `ENOENT` when `path` is missing. */
  backupCopy(path: string): Promise<string>
  /** Moves the file to `<dir>/<path>`; returns the bak path. `ENOENT` when `path` is missing. */
  moveIn(path: string): Promise<string>
}

export function createBakSession(fs: GraphFs, at: Date = new Date(), label?: string): BakSession {
  const dir = bakDirFor(at, label)

  /** `<dir>/<path>`, or `<dir>/<path>~N` when the same path lands twice in one session. */
  async function freeTarget(path: string): Promise<string> {
    const base = `${dir}/${path}`
    if ((await fs.stat(base)) === null) return base
    for (let n = 1; n <= MAX_COLLISIONS; n++) {
      const candidate = `${base}~${n}`
      if ((await fs.stat(candidate)) === null) return candidate
    }
    throw new Error(`bak: more than ${MAX_COLLISIONS} copies of ${path} in ${dir}`)
  }

  return {
    dir,
    async backupCopy(path) {
      assertRelPath(path)
      const target = await freeTarget(path)
      await fs.copyFile(path, target)
      return target
    },
    async moveIn(path) {
      assertRelPath(path)
      const target = await freeTarget(path)
      await fs.rename(path, target)
      return target
    },
  }
}
