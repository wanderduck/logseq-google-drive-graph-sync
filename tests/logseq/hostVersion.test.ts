import { describe, expect, it } from 'vitest'
import { isSupportedHostVersion, parseHostVersion } from '../../src/logseq/hostVersion'

describe('parseHostVersion', () => {
  it('parses the target host version', () => {
    expect(parseHostVersion('0.10.15')).toEqual({ major: 0, minor: 10, patch: 15, suffix: '' })
  })

  it('accepts a leading "v", surrounding whitespace, and a missing patch', () => {
    expect(parseHostVersion(' v0.10 ')).toEqual({ major: 0, minor: 10, patch: 0, suffix: '' })
  })

  it('keeps a pre-release suffix', () => {
    expect(parseHostVersion('2.0.1-beta')).toEqual({ major: 2, minor: 0, patch: 1, suffix: 'beta' })
  })

  it('returns null for non-strings and garbage', () => {
    expect(parseHostVersion(undefined)).toBeNull()
    expect(parseHostVersion(1015)).toBeNull()
    expect(parseHostVersion('')).toBeNull()
    expect(parseHostVersion('latest')).toBeNull()
    expect(parseHostVersion('0.10.15.1')).toBeNull()
  })
})

describe('isSupportedHostVersion', () => {
  it('accepts every 0.10.x build', () => {
    expect(isSupportedHostVersion('0.10.0')).toBe(true)
    expect(isSupportedHostVersion('0.10.15')).toBe(true)
    expect(isSupportedHostVersion('0.10.99-rc1')).toBe(true)
  })

  it('rejects older file-based releases and the DB line', () => {
    expect(isSupportedHostVersion('0.9.20')).toBe(false)
    expect(isSupportedHostVersion('0.11.0')).toBe(false)
    expect(isSupportedHostVersion('2.0.1-beta')).toBe(false)
    expect(isSupportedHostVersion(null)).toBe(false)
  })
})
