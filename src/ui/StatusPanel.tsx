import type { GdsyncSettings } from '../logseq/settings'
import type { MockSyncController } from '../mock/mockSyncController'
import { deriveSyncState, type RemoteStatus, type SyncState, type SyncStatus } from '../sync/status'
import { ConnectBox } from './ConnectBox'
import { DemoControls } from './DemoControls'
import { formatDateTime, formatRelativeTime, formatSummary } from './format'
import { useNow } from './useNow'

export interface StatusPanelProps {
  pluginId: string
  hostVersion: string
  status: SyncStatus
  settings: GdsyncSettings
  controller: MockSyncController
  onClose(): void
}

const STATE_LABELS: Record<SyncState, string> = {
  'signed-out': 'Not connected',
  idle: 'Up to date',
  syncing: 'Working…',
  conflict: 'Conflicts',
  error: 'Error',
}

function remoteText(remote: RemoteStatus, now: number): string {
  switch (remote.kind) {
    case 'unchecked':
      return 'not checked yet'
    case 'checking':
      return 'checking…'
    case 'unavailable':
      return `unavailable (${remote.reason}), checked ${formatRelativeTime(remote.checkedAt, now)}`
    case 'ok': {
      const n = remote.pendingChanges
      const changes = n === 0 ? 'no remote changes' : `${n} remote change${n === 1 ? '' : 's'} to download`
      const lock = remote.lock ? `; locked by ${remote.lock.deviceName} until ${formatDateTime(remote.lock.expiresAt)}` : ''
      return `${changes}${lock} (checked ${formatRelativeTime(remote.checkedAt, now)})`
    }
  }
}

function When({ at, now }: { at: number | null; now: number }) {
  if (at === null) return <span className="gdsync-muted">never</span>
  return <span title={formatDateTime(at)}>{formatRelativeTime(at, now)}</span>
}

function openSettings(onClose: () => void): void {
  // The overlay sits above the host's own modals (zIndex 11), so close it before opening settings.
  onClose()
  logseq.showSettingsUI()
}

export function StatusPanel({ pluginId, hostVersion, status, settings, controller, onClose }: StatusPanelProps) {
  const now = useNow()
  const state = deriveSyncState(status)
  const busy = status.running !== null
  const skipped = status.lastSync?.conflictsSkipped ?? 0

  return (
    <section
      className="gdsync-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gdsync-title"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header className="gdsync-panel__header">
        <h1 id="gdsync-title">Google Drive Graph Sync</h1>
        <span className={`gdsync-state gdsync-state--${state}`}>{STATE_LABELS[state]}</span>
        <button type="button" className="gdsync-panel__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <div className="gdsync-row">
        {status.account ? (
          <>
            <span>
              Connected as <strong>{status.account.email}</strong>
            </span>
            <button type="button" className="gdsync-btn gdsync-btn--ghost" disabled={busy} onClick={() => void controller.signOut()}>
              Sign out
            </button>
          </>
        ) : status.deviceFlow ? (
          <span>Connecting to Google Drive…</span>
        ) : (
          <>
            <span>Not connected to Google Drive.</span>
            <button type="button" className="gdsync-btn gdsync-btn--primary" onClick={() => void controller.connect()}>
              Connect Google
            </button>
          </>
        )}
      </div>

      {status.deviceFlow && <ConnectBox flow={status.deviceFlow} now={now} onCancel={() => controller.cancelConnect()} />}

      {status.running && (
        <div className="gdsync-banner gdsync-banner--info" role="status">
          <div className="gdsync-banner__title">{status.running.label}</div>
          {status.running.total > 0 ? (
            <progress className="gdsync-progress" value={status.running.done} max={status.running.total} />
          ) : (
            <progress className="gdsync-progress" />
          )}
        </div>
      )}

      {status.lastError && (
        <div className="gdsync-banner gdsync-banner--error" role="alert">
          <div className="gdsync-banner__title">Failed {formatRelativeTime(status.lastError.at, now)}</div>
          <div>{status.lastError.message}</div>
          <div className="gdsync-banner__actions">
            <button type="button" className="gdsync-btn gdsync-btn--ghost" onClick={() => controller.dismissError()}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {!status.running && skipped > 0 && (
        <div className="gdsync-banner gdsync-banner--warn">
          {skipped} conflict{skipped === 1 ? ' was' : 's were'} skipped in the last sync. You will be asked again on the next sync.
        </div>
      )}

      <dl className="gdsync-facts">
        <dt>Graph</dt>
        <dd>
          {status.graph ? (
            <>
              <strong>{status.graph.name}</strong> <span className="gdsync-muted gdsync-path">{status.graph.path}</span>
            </>
          ) : (
            <span className="gdsync-muted">no graph open</span>
          )}
        </dd>
        <dt>Last sync</dt>
        <dd>
          <When at={status.lastSync?.finishedAt ?? null} now={now} />
          {status.lastSync && <div className="gdsync-muted">{formatSummary(status.lastSync)}</div>}
        </dd>
        <dt>Last snapshot</dt>
        <dd>
          <When at={status.lastSnapshotAt} now={now} />
        </dd>
        <dt>Profile backup</dt>
        <dd>
          {settings.profileBackupEnabled ? (
            <When at={status.lastProfileBackupAt} now={now} />
          ) : (
            <span className="gdsync-muted">disabled in settings</span>
          )}
        </dd>
        <dt>Remote</dt>
        <dd>
          {status.account ? (
            <>
              {remoteText(status.remote, now)}{' '}
              <button
                type="button"
                className="gdsync-link"
                disabled={busy || status.remote.kind === 'checking'}
                onClick={() => void controller.checkRemote()}
              >
                Refresh
              </button>
            </>
          ) : (
            <span className="gdsync-muted">connect to check</span>
          )}
        </dd>
      </dl>

      <div className="gdsync-actions">
        <button
          type="button"
          className="gdsync-btn gdsync-btn--primary"
          disabled={!status.account || busy}
          onClick={() => void controller.syncNow()}
        >
          Sync now
        </button>
        <button type="button" className="gdsync-btn" disabled={!status.account || busy} onClick={() => void controller.backupNow()}>
          Backup now
        </button>
        <button type="button" className="gdsync-btn gdsync-btn--ghost" onClick={() => openSettings(onClose)}>
          Settings
        </button>
      </div>

      <DemoControls controller={controller} busy={busy} />

      <footer className="gdsync-footer gdsync-muted">
        <code>{pluginId}</code> · Logseq {hostVersion} · device “{settings.deviceName || 'unnamed'}” · Drive folder “
        {settings.rootFolderName}”
      </footer>
    </section>
  )
}
