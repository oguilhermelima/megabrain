import { createContext, useContext, type ReactNode } from 'react'
import type { PaneView, WorktreeFacts } from '@/chat/action-bar-model'

/** The pane's action bar: its worktree, the view it chose and how to choose another. */
export interface PaneViewControls {
  facts: WorktreeFacts
  view: PaneView
  /** The focused pane takes ⌘1 to ⌘4. */
  focused: boolean
  setView: (view: PaneView) => void
  /** What the Code view shows under the bar: the slot Code is laid over. */
  code: ReactNode
}

/** Set for every item with a worktree but the launcher; null hides the bar. */
export const PaneViewContext = createContext<PaneViewControls | null>(null)

export const usePaneView = () => useContext(PaneViewContext)
