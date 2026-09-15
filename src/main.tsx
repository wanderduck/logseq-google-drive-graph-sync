import '@logseq/libs'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerCommands } from './logseq/commands'
import { trackCurrentGraph } from './logseq/graph'
import { isSupportedHostVersion } from './logseq/hostVersion'
import { DEFAULT_SETTINGS, installSettings } from './logseq/settings'
import { installThemeMode } from './logseq/theme'
import { registerToolbar } from './logseq/toolbar'
import { createMockSyncController } from './mock/mockSyncController'
import { initialSyncStatus } from './sync/status'
import { createStore } from './sync/store'
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

  const status = createStore(initialSyncStatus())
  const settings = createStore(DEFAULT_SETTINGS)
  installSettings(settings)

  // M2: mock engine. M7 swaps in the real one behind the same `SyncController` interface.
  const controller = createMockSyncController({ status, settings })

  registerToolbar(status)
  registerCommands(controller)
  trackCurrentGraph(status)
  void installThemeMode()

  const hostVersion = await readHostVersion()
  createRoot(rootEl).render(
    <StrictMode>
      <App pluginId={pluginId} hostVersion={hostVersion} status={status} settings={settings} controller={controller} />
    </StrictMode>,
  )

  if (!isSupportedHostVersion(hostVersion)) {
    void logseq.UI.showMsg(
      `Google Drive Graph Sync targets Logseq 0.10.x. This host reports "${hostVersion}"; sync is untested here.`,
      'warning',
      { timeout: 8000 },
    )
  }

  // D9: off by default; when enabled it is the same manual action, just triggered at load time.
  if (settings.get().syncOnStartup) void controller.syncNow()

  logseq.beforeunload(async () => {
    controller.dispose()
  })

  console.info(`[gdsync] ${pluginId} ready (host ${hostVersion})`)
}

logseq.ready(main).catch((err: unknown) => console.error('[gdsync] startup failed', err))
