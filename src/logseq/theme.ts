// Mirrors the host's light/dark mode onto the plugin document so App.css can follow Logseq rather than the OS.

function applyThemeMode(mode: unknown): void {
  document.documentElement.dataset.theme = mode === 'dark' ? 'dark' : 'light'
}

export async function installThemeMode(): Promise<() => void> {
  try {
    const cfg = await logseq.App.getUserConfigs()
    applyThemeMode(cfg.preferredThemeMode)
  } catch (err) {
    console.warn('[gdsync] getUserConfigs failed; keeping the OS colour scheme', err)
  }
  return logseq.App.onThemeModeChanged(({ mode }) => applyThemeMode(mode))
}
