// Settings schema (plan M2 step 1) and a typed, validated view of `logseq.settings`.
// `resolveSettings` is pure and unit-tested; `installSettings` is the host wiring.

import type { SettingSchemaDesc } from '@logseq/libs/dist/LSPlugin.user'
import type { Store } from '../sync/store'

export interface GdsyncSettings {
  /** Drive folder under "My Drive" that holds mirrors, snapshots and profile backups (plan §3.3). */
  rootFolderName: string
  /** Raw value; `sanitizeDeviceName` (src/sync/conflict.ts) makes it file-name safe. Empty = derive from the device id. */
  deviceName: string
  /** C2: auto-snapshot during Sync when the last one is older than this. Integer ≥ 1. */
  snapshotIntervalHours: number
  /** C2: keep this many graph snapshots. Integer ≥ 1. */
  graphSnapshotRetention: number
  /** C2: keep this many profile snapshots. Integer ≥ 1. */
  profileSnapshotRetention: number
  /** D8: back up `~/.logseq` (config, preferences, plugins). */
  profileBackupEnabled: boolean
  /** C1: include `~/.logseq/settings/*.json` in the profile bundle (may contain other plugins' API keys). */
  profileBackupIncludePluginSettings: boolean
  /** D9: off by default. */
  syncOnStartup: boolean
  /** D5: overrides `VITE_GOOGLE_CLIENT_ID` when non-empty. */
  googleClientId: string
  /** D5: overrides `VITE_GOOGLE_CLIENT_SECRET` when non-empty. Plaintext on disk. */
  googleClientSecret: string
}

export const DEFAULT_SETTINGS: GdsyncSettings = {
  rootFolderName: 'Logseq Graph Sync',
  deviceName: '',
  snapshotIntervalHours: 24,
  graphSnapshotRetention: 10,
  profileSnapshotRetention: 3,
  profileBackupEnabled: true,
  profileBackupIncludePluginSettings: true,
  syncOnStartup: false,
  googleClientId: '',
  googleClientSecret: '',
}

// Host 0.10.15 renders string/number/boolean/enum/object/heading only; `button` is silently dropped
// (spike §2 item 2e), so every action lives in the panel or the command palette.
export const settingsSchema: SettingSchemaDesc[] = [
  { key: 'driveHeading', type: 'heading', default: null, title: 'Google Drive', description: '' },
  {
    key: 'rootFolderName',
    type: 'string',
    default: DEFAULT_SETTINGS.rootFolderName,
    title: 'Root folder name',
    description:
      'Folder created at the top of your Google Drive. Graph mirrors, snapshots and profile backups all live under it. ' +
      'Changing it after the first sync starts a fresh remote copy.',
  },
  {
    key: 'deviceName',
    type: 'string',
    default: DEFAULT_SETTINGS.deviceName,
    title: 'Device name',
    description:
      'Identifies this computer in the Drive lock and in `*.conflict-<device>-<time>` copies. ' +
      'Letters, digits, `-` and `_` only; other characters are replaced. Leave empty to derive a name from the device id.',
  },
  { key: 'snapshotHeading', type: 'heading', default: null, title: 'Snapshots', description: '' },
  {
    key: 'snapshotIntervalHours',
    type: 'number',
    default: DEFAULT_SETTINGS.snapshotIntervalHours,
    title: 'Snapshot interval (hours)',
    description: 'A zip snapshot of the graph is taken during Sync when the last one is older than this. Minimum 1.',
  },
  {
    key: 'graphSnapshotRetention',
    type: 'number',
    default: DEFAULT_SETTINGS.graphSnapshotRetention,
    title: 'Graph snapshots to keep',
    description: 'Older graph snapshots are deleted from Drive after a new one is uploaded. Minimum 1.',
  },
  {
    key: 'profileSnapshotRetention',
    type: 'number',
    default: DEFAULT_SETTINGS.profileSnapshotRetention,
    title: 'Profile backups to keep',
    description: 'Older profile backups are deleted from Drive after a new one is uploaded. Minimum 1.',
  },
  { key: 'profileHeading', type: 'heading', default: null, title: 'Profile backup', description: '' },
  {
    key: 'profileBackupEnabled',
    type: 'boolean',
    default: DEFAULT_SETTINGS.profileBackupEnabled,
    title: 'Back up the Logseq profile',
    description:
      'Zips `~/.logseq` (config, preferences, installed plugins) so a new device can be restored to the same setup. ' +
      'Uploaded only when its content changed.',
  },
  {
    key: 'profileBackupIncludePluginSettings',
    type: 'boolean',
    default: DEFAULT_SETTINGS.profileBackupIncludePluginSettings,
    title: 'Include plugin settings files',
    description:
      '⚠️ Adds `~/.logseq/settings/*.json` to the profile backup. Several plugins keep **API keys and tokens** there, ' +
      'and the zip is stored **unencrypted** in your Drive. This plugin’s own settings and Google tokens are always excluded.',
  },
  { key: 'behaviourHeading', type: 'heading', default: null, title: 'Behaviour', description: '' },
  {
    key: 'syncOnStartup',
    type: 'boolean',
    default: DEFAULT_SETTINGS.syncOnStartup,
    title: 'Sync on startup',
    description:
      'Run a sync when Logseq starts. Off by default: sync is manual (toolbar button or command palette) and nothing runs in the background.',
  },
  { key: 'advancedHeading', type: 'heading', default: null, title: 'Advanced', description: '' },
  {
    key: 'googleClientId',
    type: 'string',
    default: DEFAULT_SETTINGS.googleClientId,
    title: 'Google OAuth client ID (override)',
    description:
      'Leave empty to use the client compiled into the plugin. Must be a **"TVs and Limited Input devices"** client ' +
      'in a Google Cloud project with the Drive API enabled and the consent screen published ("In production").',
  },
  {
    key: 'googleClientSecret',
    type: 'string',
    default: DEFAULT_SETTINGS.googleClientSecret,
    title: 'Google OAuth client secret (override)',
    description: 'Leave empty to use the built-in secret. Stored in plaintext in `~/.logseq/settings/<plugin-id>.json`.',
  },
]

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback
}

function asInt(v: unknown, fallback: number, min: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.round(n))
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** Validates the raw settings object; wrong types fall back to the defaults and numbers are clamped. */
export function resolveSettings(raw: unknown): GdsyncSettings {
  const r: Record<string, unknown> = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_SETTINGS
  const rootFolderName = asString(r.rootFolderName, d.rootFolderName)
  return {
    rootFolderName: rootFolderName === '' ? d.rootFolderName : rootFolderName,
    deviceName: asString(r.deviceName, d.deviceName),
    snapshotIntervalHours: asInt(r.snapshotIntervalHours, d.snapshotIntervalHours, 1),
    graphSnapshotRetention: asInt(r.graphSnapshotRetention, d.graphSnapshotRetention, 1),
    profileSnapshotRetention: asInt(r.profileSnapshotRetention, d.profileSnapshotRetention, 1),
    profileBackupEnabled: asBool(r.profileBackupEnabled, d.profileBackupEnabled),
    profileBackupIncludePluginSettings: asBool(r.profileBackupIncludePluginSettings, d.profileBackupIncludePluginSettings),
    syncOnStartup: asBool(r.syncOnStartup, d.syncOnStartup),
    googleClientId: asString(r.googleClientId, d.googleClientId),
    googleClientSecret: asString(r.googleClientSecret, d.googleClientSecret),
  }
}

export type SettingsStore = Store<GdsyncSettings>

/**
 * Registers the schema and keeps `store` in sync with the host. `logseq.updateSettings()` does not update
 * `logseq.settings` synchronously (Ref §5.1), so fresh values are read from the `settings:changed` payload.
 */
export function installSettings(store: SettingsStore): () => void {
  logseq.useSettingsSchema(settingsSchema)
  store.set(resolveSettings(logseq.settings))
  return logseq.onSettingsChanged<unknown>((next) => {
    store.set(resolveSettings(next))
  })
}
