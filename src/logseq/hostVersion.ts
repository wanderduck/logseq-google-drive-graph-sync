// Pure helpers for the host-version preflight (plan §3.6 step 1). No `logseq` import: unit-tested directly.

export interface HostVersion {
  major: number
  minor: number
  patch: number
  /** Pre-release / build suffix after the numeric core, e.g. "beta" in "2.0.1-beta". Empty when absent. */
  suffix: string
}

const VERSION_RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+](.+))?$/

/** Parse "0.10.15", "v0.10.15", "2.0.1-beta". Returns null for anything else. */
export function parseHostVersion(raw: unknown): HostVersion | null {
  if (typeof raw !== 'string') return null
  const m = VERSION_RE.exec(raw.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    suffix: m[4] ?? '',
  }
}

/** The plugin targets the file-based 0.10.x line only (plan D3). */
export function isSupportedHostVersion(raw: unknown): boolean {
  const v = parseHostVersion(raw)
  return v !== null && v.major === 0 && v.minor === 10
}
