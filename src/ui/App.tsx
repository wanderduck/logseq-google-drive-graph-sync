import { useEffect } from 'react'
import { useMainUiVisible } from './useMainUiVisible'

export interface AppProps {
  pluginId: string
  hostVersion: string
}

function closePanel(): void {
  logseq.hideMainUI({ restoreEditingCursor: true })
}

// The main UI is a full-window overlay (Ref §5.2); Escape and click-outside closing are the plugin's job.
export function App({ pluginId, hostVersion }: AppProps) {
  const visible = useMainUiVisible()

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible])

  if (!visible) return null

  return (
    <div className="gdsync-backdrop" onMouseDown={closePanel}>
      <section
        className="gdsync-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gdsync-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="gdsync-panel__header">
          <h1 id="gdsync-title">Google Drive Graph Sync</h1>
          <button type="button" className="gdsync-panel__close" onClick={closePanel} aria-label="Close">
            ×
          </button>
        </header>
        <p>Scaffold loaded (milestone M1). Sync is not implemented yet.</p>
        <dl className="gdsync-facts">
          <dt>Plugin id</dt>
          <dd>
            <code>{pluginId}</code>
          </dd>
          <dt>Logseq</dt>
          <dd>
            <code>{hostVersion}</code>
          </dd>
        </dl>
        <p className="gdsync-hint">Press Escape or click outside to close.</p>
      </section>
    </div>
  )
}
