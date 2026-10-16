import { createContext, useContext, type PointerEvent } from 'react'

// In a split, a pane whose item draws its own top bar (the chat header) has no strip above it: that
// bar is the pane's one header. Dragging its empty space moves the pane and its right end carries
// the close button on hover. PaneArea provides this to every pane while the area is split; a top bar
// claims it while mounted, and a pane nothing claimed (a GitHub item, one loading or gone) keeps its strip.

export interface PaneChrome {
  title: string
  /** Starts moving the pane; call from a press on the bar's empty space. */
  onDrag: (event: PointerEvent<HTMLElement>) => void
  onClose: () => void
  /** Marks the pane as having a top bar of its own; returns the release. Call from a layout effect. */
  claim: () => () => void
}

export const PaneChromeContext = createContext<PaneChrome | null>(null)

export const usePaneChrome = () => useContext(PaneChromeContext)
