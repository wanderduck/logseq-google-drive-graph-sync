import { describe, expect, it } from 'vitest'
import {
  availableChoices,
  conflictCopyName,
  conflictStamp,
  normalizeChoice,
  sanitizeDeviceName,
  type ConflictItem,
} from '../../src/sync/conflict'

const side = { size: 1, modifiedAt: 0, sha256: 'x' }
const both: ConflictItem = { path: 'pages/A.md', kind: 'both-modified', local: side, remote: side }
const remoteDeleted: ConflictItem = { path: 'pages/A.md', kind: 'remote-deleted', local: side, remote: null }
const localDeleted: ConflictItem = { path: 'pages/A.md', kind: 'local-deleted', local: null, remote: side }

// Local-time constructor, so the expected stamp does not depend on the machine's zone.
const at = new Date(2026, 8, 15, 14, 32, 59)

describe('sanitizeDeviceName', () => {
  it('keeps letters, digits, dash and underscore', () => {
    expect(sanitizeDeviceName('Office-PC_2')).toBe('Office-PC_2')
  })

  it('replaces runs of other characters with one dash and trims the ends', () => {
    expect(sanitizeDeviceName('  wander duck / laptop!  ')).toBe('wander-duck-laptop')
    expect(sanitizeDeviceName('Ünïcödé name')).toBe('n-c-d-name')
  })

  it('falls back when nothing usable is left', () => {
    expect(sanitizeDeviceName('')).toBe('device')
    expect(sanitizeDeviceName('///')).toBe('device')
    expect(sanitizeDeviceName('', 'dev-1a2b')).toBe('dev-1a2b')
  })

  it('caps the length at 32 without leaving a trailing dash', () => {
    const long = 'a'.repeat(31) + '-bbbbbbbb'
    expect(sanitizeDeviceName(long)).toBe('a'.repeat(31))
    expect(sanitizeDeviceName('x'.repeat(50))).toHaveLength(32)
  })
})

describe('conflictStamp', () => {
  it('formats YYYYMMDD-HHmm in local time', () => {
    expect(conflictStamp(at)).toBe('20260915-1432')
    expect(conflictStamp(new Date(2026, 0, 5, 7, 3))).toBe('20260105-0703')
  })
})

describe('conflictCopyName', () => {
  it('inserts the suffix before the extension and keeps the directory', () => {
    expect(conflictCopyName('pages/Alpha.md', 'Laptop', at)).toBe('pages/Alpha.conflict-Laptop-20260915-1432.md')
  })

  it('uses only the last extension and sanitizes the device name', () => {
    expect(conflictCopyName('assets/paper.v2.pdf', 'my laptop', at)).toBe('assets/paper.v2.conflict-my-laptop-20260915-1432.pdf')
  })

  it('appends the suffix when there is no extension or the name is a dotfile', () => {
    expect(conflictCopyName('logseq/config', 'A', at)).toBe('logseq/config.conflict-A-20260915-1432')
    expect(conflictCopyName('.gitignore', 'A', at)).toBe('.gitignore.conflict-A-20260915-1432')
    expect(conflictCopyName('README', '', at)).toBe('README.conflict-device-20260915-1432')
  })
})

describe('availableChoices / normalizeChoice', () => {
  it('offers keep-both only when both versions exist', () => {
    expect(availableChoices(both)).toEqual(['keep-local', 'keep-remote', 'keep-both'])
    expect(availableChoices(remoteDeleted)).toEqual(['keep-local', 'keep-remote'])
    expect(availableChoices(localDeleted)).toEqual(['keep-local', 'keep-remote'])
  })

  it('maps keep-both on a delete conflict to the side that still has content', () => {
    expect(normalizeChoice(both, 'keep-both')).toBe('keep-both')
    expect(normalizeChoice(remoteDeleted, 'keep-both')).toBe('keep-local')
    expect(normalizeChoice(localDeleted, 'keep-both')).toBe('keep-remote')
    expect(normalizeChoice(localDeleted, 'keep-local')).toBe('keep-local')
  })
})
