// Command palette entries (plan M2 step 3). Keys are namespaced by the host per plugin id.

import type { SyncController } from '../sync/controller'

export function openPanel(): void {
  logseq.showMainUI({ autoFocus: true })
}

export function registerCommands(controller: SyncController): void {
  logseq.App.registerCommandPalette({ key: 'gdsync-sync-now', label: 'Google Drive Sync: Sync now' }, () => {
    void controller.syncNow()
  })
  logseq.App.registerCommandPalette({ key: 'gdsync-backup-now', label: 'Google Drive Sync: Backup now' }, () => {
    void controller.backupNow()
  })
  logseq.App.registerCommandPalette({ key: 'gdsync-open-panel', label: 'Google Drive Sync: Open sync panel' }, () => {
    openPanel()
  })
}
