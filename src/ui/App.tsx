import { useEffect } from 'react'
import type { GdsyncSettings } from '../logseq/settings'
import type { MockSyncController } from '../mock/mockSyncController'
import type { SyncStatus } from '../sync/status'
import type { Store } from '../sync/store'
import { ConflictDialog } from './ConflictDialog'
import { StatusPanel } from './StatusPanel'
import { useMainUiVisible } from './useMainUiVisible'
import { useStore } from './useStore'

export interface AppProps {
  pluginId: string
  hostVersion: string
  status: Store<SyncStatus>
  settings: Store<GdsyncSettings>
  controller: MockSyncController
}

function closePanel(): void {
  logseq.hideMainUI({ restoreEditingCursor: true })
}

// The main UI is a full-window overlay (Ref §5.2); Escape and click-outside closing are the plugin's job.
// While conflicts wait for a decision the overlay shows the dialog instead of the panel, and the backdrop
// does not close it (the dialog handles Escape itself: it skips the remaining conflicts).
export function App({ pluginId, hostVersion, status, settings, controller }: AppProps) {
  const visible = useMainUiVisible()
  const s = useStore(status)
  const cfg = useStore(settings)
  const dialogOpen = s.pendingConflicts.length > 0

  useEffect(() => {
    if (!visible || dialogOpen) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible, dialogOpen])

  // D9: the only automatic remote call is a status check when the panel opens.
  useEffect(() => {
    if (!visible) return
    const current = status.get()
    if (current.account && !current.running) void controller.checkRemote()
  }, [visible, status, controller])

  if (!visible) return null

  return (
    <div className="gdsync-backdrop" onMouseDown={dialogOpen ? undefined : closePanel}>
      {dialogOpen ? (
        <ConflictDialog
          conflicts={s.pendingConflicts}
          deviceName={cfg.deviceName}
          onDone={(resolutions) => controller.resolveConflicts(resolutions)}
        />
      ) : (
        <StatusPanel
          pluginId={pluginId}
          hostVersion={hostVersion}
          status={s}
          settings={cfg}
          controller={controller}
          onClose={closePanel}
        />
      )}
    </div>
  )
}
