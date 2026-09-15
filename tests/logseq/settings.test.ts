import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, resolveSettings, settingsSchema } from '../../src/logseq/settings'

describe('settingsSchema', () => {
  const items = settingsSchema.filter((s) => s.type !== 'heading')

  it('has one item per setting, with the same default as DEFAULT_SETTINGS', () => {
    const keys = items.map((s) => s.key).sort()
    expect(keys).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
    for (const item of items) {
      expect(item.default).toBe(DEFAULT_SETTINGS[item.key as keyof typeof DEFAULT_SETTINGS])
    }
  })

  it('uses only the item types host 0.10.15 renders (no "button", spike §2 item 2e)', () => {
    for (const item of settingsSchema) {
      expect(['string', 'number', 'boolean', 'heading']).toContain(item.type)
      expect(item.key).toBeTruthy()
      expect(item.title).toBeTruthy()
    }
  })

  it('encodes the approved defaults (C1, C2, D9)', () => {
    expect(DEFAULT_SETTINGS.snapshotIntervalHours).toBe(24)
    expect(DEFAULT_SETTINGS.graphSnapshotRetention).toBe(10)
    expect(DEFAULT_SETTINGS.profileSnapshotRetention).toBe(3)
    expect(DEFAULT_SETTINGS.profileBackupIncludePluginSettings).toBe(true)
    expect(DEFAULT_SETTINGS.syncOnStartup).toBe(false)
  })
})

describe('resolveSettings', () => {
  it('returns the defaults for missing or malformed input', () => {
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(resolveSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(resolveSettings({ disabled: false })).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps well-typed values and trims strings', () => {
    const out = resolveSettings({
      rootFolderName: '  My Sync  ',
      deviceName: ' Laptop ',
      snapshotIntervalHours: 6,
      graphSnapshotRetention: 20,
      profileSnapshotRetention: 5,
      profileBackupEnabled: false,
      profileBackupIncludePluginSettings: false,
      syncOnStartup: true,
      googleClientId: ' id ',
      googleClientSecret: 'secret',
    })
    expect(out).toEqual({
      rootFolderName: 'My Sync',
      deviceName: 'Laptop',
      snapshotIntervalHours: 6,
      graphSnapshotRetention: 20,
      profileSnapshotRetention: 5,
      profileBackupEnabled: false,
      profileBackupIncludePluginSettings: false,
      syncOnStartup: true,
      googleClientId: 'id',
      googleClientSecret: 'secret',
    })
  })

  it('falls back to the default folder name when it is blank', () => {
    expect(resolveSettings({ rootFolderName: '   ' }).rootFolderName).toBe(DEFAULT_SETTINGS.rootFolderName)
  })

  it('rejects wrong types per field instead of failing the whole object', () => {
    const out = resolveSettings({ rootFolderName: 42, syncOnStartup: 'yes', snapshotIntervalHours: 'abc' })
    expect(out.rootFolderName).toBe(DEFAULT_SETTINGS.rootFolderName)
    expect(out.syncOnStartup).toBe(false)
    expect(out.snapshotIntervalHours).toBe(24)
  })

  it('clamps and rounds numbers, accepting numeric strings from the settings form', () => {
    expect(resolveSettings({ snapshotIntervalHours: 0 }).snapshotIntervalHours).toBe(1)
    expect(resolveSettings({ graphSnapshotRetention: -5 }).graphSnapshotRetention).toBe(1)
    expect(resolveSettings({ profileSnapshotRetention: 2.6 }).profileSnapshotRetention).toBe(3)
    expect(resolveSettings({ snapshotIntervalHours: '12' }).snapshotIntervalHours).toBe(12)
    expect(resolveSettings({ snapshotIntervalHours: Infinity }).snapshotIntervalHours).toBe(24)
  })
})
