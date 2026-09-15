// M2-ONLY: buttons that drive the mock controller so every state is demoable. Removed with src/mock/ in M7.

import type { MockSyncController } from '../mock/mockSyncController'
import type { SyncState } from '../sync/status'

const STATES: SyncState[] = ['signed-out', 'idle', 'syncing', 'conflict', 'error']

export interface DemoControlsProps {
  controller: MockSyncController
  busy: boolean
}

export function DemoControls({ controller, busy }: DemoControlsProps) {
  return (
    <details className="gdsync-demo">
      <summary>Demo controls (M2 mock data)</summary>
      <p className="gdsync-muted gdsync-small">Nothing here touches Google Drive or the graph. The real engine replaces it in M7.</p>
      <div className="gdsync-demo__row">
        <span>Run a mock sync:</span>
        <button type="button" className="gdsync-btn gdsync-btn--small" disabled={busy} onClick={() => void controller.runDemo('clean')}>
          clean
        </button>
        <button type="button" className="gdsync-btn gdsync-btn--small" disabled={busy} onClick={() => void controller.runDemo('conflicts')}>
          with conflicts
        </button>
        <button type="button" className="gdsync-btn gdsync-btn--small" disabled={busy} onClick={() => void controller.runDemo('error')}>
          failing
        </button>
      </div>
      <div className="gdsync-demo__row">
        <span>Show state:</span>
        {STATES.map((s) => (
          <button key={s} type="button" className="gdsync-btn gdsync-btn--small" disabled={busy} onClick={() => controller.showState(s)}>
            {s}
          </button>
        ))}
      </div>
    </details>
  )
}
