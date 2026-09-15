// Toolbar Sync button with the five states of plan M2 step 2. The host renders the template inside
// `div[data-injected-ui=<key>-<pluginId>]` and routes `data-on-click` to the `provideModel` method (Ref §5.2).
// State changes re-register the item with the same key: verified in `frontend/handler/plugin.cljs` @0.10.15,
// `register-plugin-ui-item` filters out the existing entry with that key before adding the new one.

import type { Store } from '../sync/store'
import { deriveSyncState, type SyncState, type SyncStatus } from '../sync/status'

export const TOOLBAR_KEY = 'gdsync-toolbar'
const STYLE_KEY = 'gdsync-toolbar-style'
const MODEL_TOGGLE_PANEL = 'gdsyncTogglePanel'

// Cloud with an up arrow, stroke = currentColor so it follows the host theme.
const TOOLBAR_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M7.5 17.5a3.75 3.75 0 0 1-.45-7.47A5.25 5.25 0 0 1 17.2 9.4a4 4 0 0 1 .3 7.98L17 17.5H7.5z"/>' +
  '<path d="M10 13.2 12 11.2l2 2M12 11.2v5"/>' +
  '</svg>'

export const TOOLBAR_TITLES: Record<SyncState, string> = {
  'signed-out': 'Google Drive Graph Sync: not connected',
  idle: 'Google Drive Graph Sync',
  syncing: 'Google Drive Graph Sync: syncing…',
  conflict: 'Google Drive Graph Sync: conflicts need your decision',
  error: 'Google Drive Graph Sync: the last sync failed',
}

export function toolbarTemplate(state: SyncState): string {
  return (
    `<a class="button gdsync-tb" data-state="${state}" data-on-click="${MODEL_TOGGLE_PANEL}" ` +
    `title="${TOOLBAR_TITLES[state]}" aria-label="${TOOLBAR_TITLES[state]}">` +
    `${TOOLBAR_ICON}<i class="gdsync-tb__badge" aria-hidden="true"></i></a>`
  )
}

/**
 * CSS injected into the host document once; state is switched through `data-state` on the template.
 * Scoped by our own `gdsync-` class names rather than by the host container: on 0.10.15 the item wrapper
 * is `div#injected-ui-item-<key>-<pid>` (`components/plugins.cljs` `ui-item-renderer`), and it may sit
 * inline on the toolbar or inside the "plugins" dropdown depending on the user's pinned items.
 */
export function toolbarStyle(): string {
  return [
    '.gdsync-tb{position:relative;display:flex;align-items:center;justify-content:center}',
    '.gdsync-tb__badge{position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-radius:50%;' +
      'box-sizing:border-box;display:none}',
    '.gdsync-tb[data-state="signed-out"]{opacity:.55}',
    '.gdsync-tb[data-state="signed-out"] .gdsync-tb__badge{display:block;background:#9ca3af}',
    '.gdsync-tb[data-state="conflict"] .gdsync-tb__badge{display:block;background:#f59e0b}',
    '.gdsync-tb[data-state="error"] .gdsync-tb__badge{display:block;background:#ef4444}',
    '.gdsync-tb[data-state="syncing"] .gdsync-tb__badge{display:block;width:10px;height:10px;right:1px;bottom:1px;' +
      'background:transparent;border:2px solid #3b82f6;border-top-color:transparent;animation:gdsync-spin .9s linear infinite}',
    '@keyframes gdsync-spin{to{transform:rotate(360deg)}}',
  ].join('\n')
}

function togglePanel(): void {
  if (logseq.isMainUIVisible) {
    logseq.hideMainUI({ restoreEditingCursor: true })
  } else {
    logseq.showMainUI({ autoFocus: true })
  }
}

/** Registers the button, injects its CSS, and re-renders it whenever the derived state changes. */
export function registerToolbar(status: Store<SyncStatus>): () => void {
  logseq.provideModel({ [MODEL_TOGGLE_PANEL]: togglePanel })
  logseq.provideStyle({ key: STYLE_KEY, style: toolbarStyle() })

  let current = deriveSyncState(status.get())
  logseq.App.registerUIItem('toolbar', { key: TOOLBAR_KEY, template: toolbarTemplate(current) })

  return status.subscribe((s) => {
    const next = deriveSyncState(s)
    if (next === current) return
    current = next
    logseq.App.registerUIItem('toolbar', { key: TOOLBAR_KEY, template: toolbarTemplate(next) })
  })
}
