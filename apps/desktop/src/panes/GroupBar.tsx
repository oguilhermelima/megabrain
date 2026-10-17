import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { ActionBar, useWorktreeChanges, WorktreeView } from '@/chat/ActionBar'
import { changedFileCount, paneViewKey, segments, shownView, type PaneView, type WorktreeFacts } from '@/chat/action-bar-model'
import type { GroupIdentity } from '@/panes/group-bar'
import { RunButton, RunPanelToggle } from '@/run-panel/RunButton'

/** The bar a split on one worktree shares (panes/group-bar): its worktree, the view the split shows and how to choose another. */
export interface SharedBar {
  facts: WorktreeFacts
  identity: GroupIdentity
  view: PaneView
  setView: (view: PaneView) => void
  /** The split takes ⌘1 to ⌘4 (nothing covers it). */
  focused: boolean
  /** What the Code view shows: the slot the worktree's Code is laid over. */
  code: ReactNode
}

/**
 * The split area and what it shows once for all its panes. A split on one worktree gets one bar on
 * top: the project and branch at its left (the pull request's number is on the PR tab), Run and the
 * run panel's toggle at its right, and under them the view tabs, Agent, Code, PR and Diff (Agent is
 * the split itself; the others lie over the whole area, the panes kept mounted beneath). With the
 * sidebar hidden its first row joins the window row, 44px tall, and both rows are inset past the lights. A split across worktrees keeps each pane's own bar. `children` is told whether a view covers them.
 */
export function SplitFrame({ shared, inset, children }: { shared: SharedBar | null; inset: number | null; children: (covered: boolean) => ReactNode }) {
  const facts = shared?.facts ?? null
  const changes = useWorktreeChanges(facts)
  const available = facts === null ? null : segments({ facts, changed: changes.read ? changedFileCount(changes.uncommitted, changes.branch) : null, codeAvailable: true })
  const shown = shared === null || available === null ? 'agent' : shownView(shared.view, available)
  const latest = useRef({ available, setView: shared?.setView })
  latest.current = { available, setView: shared?.setView }

  // ⌘1 to ⌘4 in the capture phase, as a pane's own bar takes them; never while the keyboard is in Code.
  const focused = shared?.focused === true
  useEffect(() => {
    if (!focused) return
    const onKey = (event: KeyboardEvent) => {
      const view = paneViewKey(event, { focused: true, inEditor: document.activeElement instanceof HTMLIFrameElement })
      if (view === null) return
      event.preventDefault()
      event.stopPropagation()
      const { available: now, setView } = latest.current
      if (now?.find((segment) => segment.view === view)?.enabled === true) setView?.(view)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [focused])

  // One tree whether the bar shows or not, so the panes under it never remount when a split starts or stops sharing one worktree.
  const bar = shared !== null && facts !== null && available !== null ? { shared, facts, available } : null
  // In the window row: 4px above and below the 36px first row make the lights' 44px band.
  const slide: CSSProperties = { transition: 'padding var(--motion-panel) var(--motion-ease-panel)', paddingLeft: inset ?? 24 }
  return (
    <>
      {bar !== null && (
        <header data-tauri-drag-region data-group-bar="" style={slide} className={`@container/header shrink-0 border-b border-white/[0.06] pr-6 ${inset === null ? 'pt-3' : 'pt-1'}`}>
          <div data-tauri-drag-region className="flex h-9 min-w-0 items-center gap-2.5">
            {bar.shared.identity.project !== null && <ProjectPicture project={bar.shared.identity.project} />}
            <div data-tauri-drag-region className="min-w-0 flex-1">
              <h1 title={bar.facts.root} className="truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink-100">
                {bar.shared.identity.name}
              </h1>
              {bar.shared.identity.branch !== null && <p className="truncate text-[12px] leading-4 text-ink-400">{bar.shared.identity.branch}</p>}
            </div>
            <div data-tauri-drag-region className="flex shrink-0 items-center justify-end gap-3">
              <RunButton />
              <RunPanelToggle />
            </div>
          </div>
          {/* The tabs start at the picture's left edge, the bar's padding, as a pane's own bar does. */}
          <div data-tauri-drag-region className="mt-1 flex min-w-0">
            <ActionBar segments={bar.available} shown={shown} onSelect={bar.shared.setView} />
          </div>
        </header>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children(shown !== 'agent')}
        {bar !== null && shown !== 'agent' && (
          <div data-group-view={shown} className="absolute inset-0 z-30 flex min-h-0 flex-col bg-ink-950">
            <WorktreeView view={shown} facts={bar.facts} changes={changes} code={bar.shared.code} />
          </div>
        )}
      </div>
    </>
  )
}
