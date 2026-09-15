import { describe, expect, it } from 'vitest'
import type { SyncSummary } from '../../src/sync/status'
import { formatBytes, formatRelativeTime, formatSummary } from '../../src/ui/format'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const now = Date.UTC(2026, 8, 15, 12, 0, 0)

describe('formatRelativeTime', () => {
  it('buckets past instants', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * MIN, now)).toBe('5 min ago')
    expect(formatRelativeTime(now - 3 * HOUR, now)).toBe('3 h ago')
    expect(formatRelativeTime(now - 26 * HOUR, now)).toBe('yesterday')
    expect(formatRelativeTime(now - 3 * DAY, now)).toBe('3 days ago')
  })

  it('buckets future instants', () => {
    expect(formatRelativeTime(now + 12 * MIN, now)).toBe('in 12 min')
    expect(formatRelativeTime(now + 2 * HOUR, now)).toBe('in 2 h')
    expect(formatRelativeTime(now + 25 * HOUR, now)).toBe('tomorrow')
    expect(formatRelativeTime(now + 4 * DAY, now)).toBe('in 4 days')
  })

  it('falls back to a date after a week', () => {
    const text = formatRelativeTime(now - 10 * DAY, now)
    expect(text).not.toMatch(/ago|in /)
    expect(text).toMatch(/2026/)
  })
})

describe('formatBytes', () => {
  it('picks a unit and a sensible precision', () => {
    expect(formatBytes(812)).toBe('812 B')
    expect(formatBytes(2431)).toBe('2.4 KB')
    expect(formatBytes(120 * 1024)).toBe('120 KB')
    expect(formatBytes(3.2 * 1024 * 1024)).toBe('3.2 MB')
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.50 GB')
  })
})

describe('formatSummary', () => {
  const base: SyncSummary = {
    startedAt: 0,
    finishedAt: 1,
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflictsResolved: 0,
    conflictsSkipped: 0,
    snapshotTaken: false,
  }

  it('says when there was nothing to do', () => {
    expect(formatSummary(base)).toBe('Sync complete: nothing to do.')
  })

  it('lists only the non-zero counts, with plural forms', () => {
    expect(
      formatSummary({ ...base, uploaded: 3, downloaded: 1, deletedLocal: 1, deletedRemote: 1, conflictsResolved: 1, conflictsSkipped: 2, snapshotTaken: true }),
    ).toBe('Sync complete: 3 uploaded, 1 downloaded, 2 deleted, 1 conflict resolved, 2 conflicts skipped, snapshot taken.')
  })
})
