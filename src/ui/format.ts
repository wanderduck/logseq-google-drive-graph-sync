// Pure display helpers for the panel and toasts.

import type { SyncSummary } from '../sync/status'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", or the date when older than a week.
 * Future instants read "in 5 min", "in 3 h", "tomorrow", "in 4 days".
 */
export function formatRelativeTime(then: number, now: number): string {
  const diff = now - then
  const abs = Math.abs(diff)
  if (abs < 45_000) return 'just now'
  const future = diff < 0

  const minutes = Math.round(abs / MINUTE)
  if (minutes < 60) return future ? `in ${minutes} min` : `${minutes} min ago`

  const hours = Math.round(abs / HOUR)
  if (hours < 24) return future ? `in ${hours} h` : `${hours} h ago`

  const days = Math.round(abs / DAY)
  if (days === 1) return future ? 'tomorrow' : 'yesterday'
  if (days < 7) return future ? `in ${days} days` : `${days} days ago`

  return formatDate(then)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** One line for the summary toast and the panel, e.g. "Sync complete: 3 uploaded, 1 conflict resolved, snapshot taken." */
export function formatSummary(s: SyncSummary): string {
  const parts: string[] = []
  if (s.uploaded > 0) parts.push(`${s.uploaded} uploaded`)
  if (s.downloaded > 0) parts.push(`${s.downloaded} downloaded`)
  const deleted = s.deletedLocal + s.deletedRemote
  if (deleted > 0) parts.push(`${deleted} deleted`)
  if (s.conflictsResolved > 0) parts.push(`${plural(s.conflictsResolved, 'conflict')} resolved`)
  if (s.conflictsSkipped > 0) parts.push(`${plural(s.conflictsSkipped, 'conflict')} skipped`)
  if (s.snapshotTaken) parts.push('snapshot taken')
  return parts.length > 0 ? `Sync complete: ${parts.join(', ')}.` : 'Sync complete: nothing to do.'
}
