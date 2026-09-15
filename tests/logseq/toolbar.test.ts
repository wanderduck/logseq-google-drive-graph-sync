import { describe, expect, it } from 'vitest'
import { TOOLBAR_KEY, TOOLBAR_TITLES, toolbarStyle, toolbarTemplate } from '../../src/logseq/toolbar'
import type { SyncState } from '../../src/sync/status'

const STATES: SyncState[] = ['signed-out', 'idle', 'syncing', 'conflict', 'error']

describe('toolbarTemplate', () => {
  it('renders one anchor per state carrying data-state, a distinct title, and the click model', () => {
    const titles = new Set<string>()
    for (const state of STATES) {
      const html = toolbarTemplate(state)
      expect(html).toContain(`data-state="${state}"`)
      expect(html).toContain('data-on-click="gdsyncTogglePanel"')
      expect(html).toContain(`title="${TOOLBAR_TITLES[state]}"`)
      expect(html).toContain('gdsync-tb__badge')
      titles.add(TOOLBAR_TITLES[state])
    }
    expect(titles.size).toBe(STATES.length)
  })
})

describe('toolbarStyle', () => {
  it('scopes every rule to our own gdsync- class names and styles each non-idle state', () => {
    const css = toolbarStyle()
    const rules = css.split('\n').filter((line) => !line.startsWith('@keyframes'))
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) expect(rule.startsWith('.gdsync-tb')).toBe(true)
    for (const state of STATES.filter((s) => s !== 'idle')) expect(css).toContain(`[data-state="${state}"]`)
    expect(css).toContain('@keyframes gdsync-spin')
  })

  it('keeps the stable item key the host dedupes on', () => {
    expect(TOOLBAR_KEY).toBe('gdsync-toolbar')
  })
})
