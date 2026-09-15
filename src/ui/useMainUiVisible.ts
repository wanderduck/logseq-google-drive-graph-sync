import { useSyncExternalStore } from 'react'

// SDK 0.0.17 gotcha (lsplugin.user.js): `showMainUI`/`hideMainUI` emit 'ui:visible:changed' BEFORE they
// update the internal map behind `logseq.isMainUIVisible`, so a snapshot that reads the getter inside the
// listener sees the stale value and React never re-renders. Track visibility from the event payload instead.

interface UiVisiblePayload {
  visible?: boolean
}

let visible: boolean | null = null

function subscribe(onChange: () => void): () => void {
  const handler = (payload: UiVisiblePayload): void => {
    visible = Boolean(payload?.visible)
    onChange()
  }
  logseq.on('ui:visible:changed', handler)
  return () => {
    logseq.off('ui:visible:changed', handler)
  }
}

function getSnapshot(): boolean {
  return visible ?? logseq.isMainUIVisible
}

/** True while the plugin's main UI overlay is shown by the host. */
export function useMainUiVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot)
}
