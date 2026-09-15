import '@logseq/libs'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { isSupportedHostVersion } from './logseq/hostVersion'
import { registerToolbar } from './logseq/toolbar'
import { App } from './ui/App'
import './ui/App.css'

async function readHostVersion(): Promise<string> {
  try {
    const info: unknown = await logseq.App.getInfo('version')
    return typeof info === 'string' ? info : 'unknown'
  } catch (err) {
    console.error('[gdsync] App.getInfo(version) failed', err)
    return 'unknown'
  }
}

async function main(): Promise<void> {
  const pluginId = logseq.baseInfo.id
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('[gdsync] #root is missing from index.html')

  // Stay above the host's own overlays (same value as the official React template).
  logseq.setMainUIInlineStyle({ zIndex: 11 })
  registerToolbar()

  const hostVersion = await readHostVersion()
  createRoot(rootEl).render(
    <StrictMode>
      <App pluginId={pluginId} hostVersion={hostVersion} />
    </StrictMode>,
  )

  if (!isSupportedHostVersion(hostVersion)) {
    void logseq.UI.showMsg(
      `Google Drive Graph Sync targets Logseq 0.10.x. This host reports "${hostVersion}"; sync is untested here.`,
      'warning',
      { timeout: 8000 },
    )
  }
  console.info(`[gdsync] ${pluginId} ready (host ${hostVersion})`)
}

logseq.ready(main).catch((err: unknown) => console.error('[gdsync] startup failed', err))
