// Keeps `status.graph` equal to the graph currently open in the host.

import type { Store } from '../sync/store'
import type { SyncStatus } from '../sync/status'

export function trackCurrentGraph(status: Store<SyncStatus>): () => void {
  const refresh = async (): Promise<void> => {
    try {
      const g = await logseq.App.getCurrentGraph()
      const graph = g ? { name: g.name, path: g.path } : null
      status.update((s) => ({ ...s, graph }))
    } catch (err) {
      console.error('[gdsync] getCurrentGraph failed', err)
    }
  }
  void refresh()
  // No payload on this hook (Ref §5.3): re-query.
  return logseq.App.onCurrentGraphChanged(() => {
    void refresh()
  })
}
