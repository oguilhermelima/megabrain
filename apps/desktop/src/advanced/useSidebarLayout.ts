import { api } from '@/api'
import { parseOrder } from '@/advanced/project-order'
import { emptyLayout, parseLayout, serialiseLayout, type SidebarLayout } from '@/advanced/sidebar-folders'
import { emptySidebarState, isEmptySidebarState, legacySidebarState, parseSidebarState, serialiseSidebarState, type SidebarState } from '@/advanced/sidebar-state'
import { useSavedSetting } from '@/advanced/useSavedSetting'

// The sidebar's saved settings (useSavedSetting): its folders and top-level order, and what it folded
// with each worktree's row order.

/** The flat project order the sidebar kept before folders; it seeds the layout once. */
const legacyOrderKey = 'megabrain.sidebar.order'

function storedItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const isEmptyLayout = (layout: SidebarLayout) => layout.folders.length === 0 && layout.order.length === 0

export function useSidebarLayout(): { layout: SidebarLayout; change: (next: SidebarLayout) => void; error: unknown; ready: boolean } {
  const { value, change, error, ready } = useSavedSetting({
    cacheKey: 'megabrain.sidebar.folders',
    seed: () => ({ ...emptyLayout, order: parseOrder(storedItem(legacyOrderKey)) }),
    parse: parseLayout,
    serialise: serialiseLayout,
    isEmpty: isEmptyLayout,
    read: () => api.sidebarFolders(),
    write: (json) => api.setSidebarFolders(json),
  })
  return { layout: value, change, error, ready }
}

export function useSidebarState(): { state: SidebarState; change: (next: SidebarState) => void; error: unknown; ready: boolean } {
  const { value, change, error, ready } = useSavedSetting({
    cacheKey: 'megabrain.sidebar.state',
    // The collapsed keys and row order this viewer kept on its own before the CLI held them.
    seed: () => {
      const legacy = legacySidebarState(storedItem('megabrain.sidebar.collapsed'), storedItem('megabrain.sidebar.rows'))
      return isEmptySidebarState(legacy) ? emptySidebarState : legacy
    },
    parse: parseSidebarState,
    serialise: serialiseSidebarState,
    isEmpty: isEmptySidebarState,
    read: () => api.sidebarState(),
    write: (json) => api.setSidebarState(json),
  })
  return { state: value, change, error, ready }
}
