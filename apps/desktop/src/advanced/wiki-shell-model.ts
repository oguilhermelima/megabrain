import { sidebarLimits, type WidthLimits, type WidthStorage } from '@/lib/panel-width'

// The Knowledge and Artifacts pages share one shell (WikiShell.tsx): a top bar across the pane and a
// navigation panel on the right, shown or hidden and resized like the run panel. Each page remembers
// its own panel per viewer.

/** Where each page keeps its panel's width and whether it is open. */
export const wikiPanels = {
  knowledge: { width: 'megabrain.knowledge.panel.width', open: 'megabrain.knowledge.panel.open' },
  artifacts: { width: 'megabrain.artifacts.panel.width', open: 'megabrain.artifacts.panel.open' },
} as const

export type WikiPanel = (typeof wikiPanels)[keyof typeof wikiPanels]

/** The panel is a list like the left sidebar, so it may be as narrow and as wide as that. */
export const wikiPanelLimits: WidthLimits = sidebarLimits

// Like a width, a remembered open state is a convenience: storage missing, blocked or holding
// something else leaves the panel open.
export function readPanelOpen(storage: () => WidthStorage, key: string): boolean {
  try {
    return storage().getItem(key) !== '0'
  } catch {
    return true
  }
}

export function writePanelOpen(storage: () => WidthStorage, key: string, open: boolean): boolean {
  try {
    storage().setItem(key, open ? '1' : '0')
  } catch {
    // Not remembering it is fine.
  }
  return open
}
