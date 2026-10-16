import { createContext, useContext } from 'react'
import type { Rect } from '@/panes/pane-model'

// With the sidebar hidden the window has one top row: the traffic lights, the show-sidebar button,
// then the header of the pane in the window's top-left corner. Which header that is, and whether
// one can join at all, is decided here.

/** What joins the window row: the pane's own top bar, or, once the area is split, its pane strip. */
export type WindowRowHeader = 'top-bar' | 'strip'

export interface WindowRowJoin {
  paneId: string
  header: WindowRowHeader
}

/**
 * The header that sits beside the traffic lights, or null when none can and the lights keep a row
 * of their own: the sidebar is shown, something covers the panes (a GitHub page), no pane sits in
 * the top-left corner, or an unsplit pane's item draws no top bar. Split, the top-left pane's strip
 * joins (it is the pane's topmost header and every pane has one); the other panes keep theirs.
 */
export function windowRowJoin({
  collapsed,
  covered,
  panes,
  hasTopBar,
}: {
  collapsed: boolean
  covered: boolean
  panes: readonly { id: string; item: string; rect: Rect }[]
  hasTopBar: (item: string) => boolean
}): WindowRowJoin | null {
  if (!collapsed || covered) return null
  const corner = panes.find((pane) => pane.rect.x === 0 && pane.rect.y === 0)
  if (corner === undefined) return null
  if (panes.length > 1) return { paneId: corner.id, header: 'strip' }
  return hasTopBar(corner.item) ? { paneId: corner.id, header: 'top-bar' } : null
}

/** The room a header in the window row leaves at its left for the lights and the show-sidebar button, in px; null outside the row. */
export const WindowRowContext = createContext<number | null>(null)

export const useWindowRowInset = () => useContext(WindowRowContext)
