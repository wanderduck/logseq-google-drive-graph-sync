// Toolbar entry point. The host renders the template inside `div[data-injected-ui=<key>-<pluginId>]`
// and routes `data-on-click` to the method of the same name registered via `provideModel` (Ref §5.2).

const TOOLBAR_KEY = 'gdsync-toolbar'
const MODEL_TOGGLE_PANEL = 'gdsyncTogglePanel'

// Cloud with an up arrow, stroke = currentColor so it follows the host theme.
const TOOLBAR_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M7.5 17.5a3.75 3.75 0 0 1-.45-7.47A5.25 5.25 0 0 1 17.2 9.4a4 4 0 0 1 .3 7.98L17 17.5H7.5z"/>' +
  '<path d="M10 13.2 12 11.2l2 2M12 11.2v5"/>' +
  '</svg>'

export function toolbarTemplate(): string {
  return (
    `<a class="button" data-on-click="${MODEL_TOGGLE_PANEL}" title="Google Drive Graph Sync" ` +
    `style="display:flex;align-items:center;justify-content:center">${TOOLBAR_ICON}</a>`
  )
}

function togglePanel(): void {
  if (logseq.isMainUIVisible) {
    logseq.hideMainUI({ restoreEditingCursor: true })
  } else {
    logseq.showMainUI({ autoFocus: true })
  }
}

/** Registers the toolbar button and its click handler. Call once after `logseq.ready`. */
export function registerToolbar(): void {
  logseq.provideModel({ [MODEL_TOGGLE_PANEL]: togglePanel })
  logseq.App.registerUIItem('toolbar', { key: TOOLBAR_KEY, template: toolbarTemplate() })
}
