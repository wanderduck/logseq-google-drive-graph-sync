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
      <p className="gdsync-muted gdsync-small">The mock runs below touch neither Google Drive nor the graph. The real engine replaces them in M7.</p>
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
      <div className="gdsync-demo__row">
        <span>M4 Drive layer:</span>
        <button type="button" className="gdsync-btn gdsync-btn--small" disabled={busy} onClick={() => void controller.runDriveSmoke()}>
          Run Drive smoke test
        </button>
      </div>
      <p className="gdsync-muted gdsync-small">
        Talks to the real Google Drive: creates a throwaway “&lt;root folder&gt; smoke-…” folder, exercises uploads, downloads, changes and the lock, then
        deletes it again. Needs a connected account and a graph under ~/logseq-test-graphs/. Progress is logged as [gdsync] smoke in the console.
      </p>
      <div className="gdsync-demo__row">
        <span>M5 local file layer:</span>
        <button type="button" className="gdsync-btn gdsync-btn--small" disabled={busy} onClick={() => void controller.runFsSmoke()}>
          Run file smoke test
        </button>
      </div>
      <p className="gdsync-muted gdsync-small">
        Writes to the open graph through the host bridge: scans it, creates and overwrites pages/gdsync-smoke.md atomically, round-trips a 300 KB asset,
        renames, and moves everything it made into logseq/bak/gdsync/smoke-…/. Reads ~/.logseq read-only. Refuses unless the graph is under
        ~/logseq-test-graphs/. Progress is logged as [gdsync] fs smoke in the console.
      </p>
    </details>
  )
}
