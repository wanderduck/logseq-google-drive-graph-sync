// Keeps `status.graph` equal to the graph currently open in the host (plan M7 step 3: the controller
// watches that field to switch its per-graph facts and to stop a run whose graph went away).

import type { Store } from '../sync/store'
import type { SyncStatus } from '../sync/status'

export interface GraphTracker {
  /** Resolves once the first `getCurrentGraph` answer is in `status` ("sync on startup" waits for it). */
  ready: Promise<void>
  dispose(): void
}

export function trackCurrentGraph(status: Store<SyncStatus>): GraphTracker {
  const refresh = async (): Promise<void> => {
    try {
      const g = await logseq.App.getCurrentGraph()
      const graph = g ? { name: g.name, path: g.path } : null
      status.update((s) => (s.graph?.name === graph?.name && s.graph?.path === graph?.path ? s : { ...s, graph }))
    } catch (err) {
      console.error('[gdsync] getCurrentGraph failed', err)
    }
  }
  const ready = refresh()
  // No payload on this hook (Ref §5.3): re-query.
  const off = logseq.App.onCurrentGraphChanged(() => {
    void refresh()
  })
  return { ready, dispose: off }
}
