import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { ActionBar, PaneViewBody, useWorktreeChanges } from '@/chat/ActionBar'
import { changedFileCount, paneViewKey, segments, shownView, type PaneView } from '@/chat/action-bar-model'
import { usePaneView } from '@/chat/pane-view-context'
import { useWindowRowInset } from '@/panes/window-row'
import type { AgentActivity } from '@/components/agent-activity'
import { AgentIcon } from '@/components/agent-icons'
import { RunButton, RunPanelToggle } from '@/run-panel/RunButton'

/**
 * The top bar every chat view and the launcher share: the agent's mark, live while it works (none on the launcher), one-line title and one small metadata line,
 * then the Run button and the run panel's toggle once anything ran on the right. An item with a worktree (a launcher once it has one) also gets the action bar in the
 * bar's true centre, Agent, Code, PR and Diff, each shown in the pane under the bar; the view's own controls (the chat or terminal switch) belong to Agent and show only there. It sits about 12px
 * below the window top. When the sidebar is hidden and this bar joins the window row (panes/window-row) it shrinks to the lights' 44px band, centred on their line, and leaves
 * room at its left for them and the show-sidebar button; only the left side is inset, so the action bar keeps the true centre.
 */
export function ChatHeader({ agent, activity = 'idle', title, meta, metaTitle, actions }: { agent: string | null; activity?: AgentActivity; title: string; meta: string; metaTitle?: string; actions?: ReactNode }) {
  const pane = usePaneView()
  const changes = useWorktreeChanges(pane?.facts ?? null)
  const header = useRef<HTMLElement>(null)
  const inset = useWindowRowInset()
  const available = pane === null ? null : segments({ facts: pane.facts, changed: changes.read ? changedFileCount(changes.uncommitted, changes.branch) : null, codeAvailable: true })
  const select = (view: PaneView) => pane?.setView(view)
  const latest = useRef({ available, select })
  latest.current = { available, select }

  // ⌘1 to ⌘4 in the capture phase, so a terminal or an editor in the pane does not keep them; a disabled view ignores its key.
  // Inside Code they never reach this window, and they are left alone should one arrive while it has the keyboard.
  const focused = pane?.focused === true
  useEffect(() => {
    if (!focused) return
    const onKey = (event: KeyboardEvent) => {
      const view = paneViewKey(event, { focused: true, inEditor: document.activeElement instanceof HTMLIFrameElement })
      if (view === null) return
      event.preventDefault()
      event.stopPropagation()
      const { available: now, select: choose } = latest.current
      if (now?.find((segment) => segment.view === view)?.enabled === true) choose(view)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [focused])

  const identity = (
    <>
      {agent !== null && <AgentIcon agent={agent} activity={activity} size={22} className="shrink-0 text-ink-300" />}
      <div className="min-w-0 flex-1">
        <h1 title={title} className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em] text-ink-100">{title}</h1>
        <p title={metaTitle ?? meta} className="truncate text-[12px] leading-4 text-ink-400">{meta}</p>
      </div>
    </>
  )

  // In the window row: 4px above and below the 36px title make the 44px band; the padding slides between the two with the sidebar.
  const band = inset === null ? 'pt-3 pb-2.5' : 'py-1'
  const slide: CSSProperties = { transition: 'padding var(--motion-panel) var(--motion-ease-panel)' }

  if (pane === null || available === null) {
    return (
      <header data-tauri-drag-region style={{ ...slide, paddingLeft: inset ?? 24 }} className={`@container/header flex shrink-0 items-center gap-3 border-b border-white/[0.06] pr-6 ${band}`}>
        {identity}
        {actions}
        <RunButton />
        <RunPanelToggle />
      </header>
    )
  }

  const shown = shownView(pane.view, available)

  // Equal side columns put the bar in the bar's true centre; each side truncates or clips inside its own half.
  // In a narrow pane the right side keeps its own width and the title gives way instead, so nothing overlaps.
  return (
    <>
      <header ref={header} data-tauri-drag-region style={slide} className={`@container/header shrink-0 border-b border-white/[0.06] px-6 ${band}`}>
        <div data-tauri-drag-region className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 @max-[640px]/header:grid-cols-[minmax(0,1fr)_auto_auto]">
          <div data-tauri-drag-region style={{ ...slide, paddingLeft: inset === null ? 0 : inset - 24 }} className="flex min-w-0 items-center gap-3">
            {identity}
          </div>
          <ActionBar agent={agent} segments={available} shown={shown} onSelect={select} />
          <div data-tauri-drag-region className="flex min-w-0 items-center justify-end gap-3">
            {shown === 'agent' && actions}
            <RunButton />
            <RunPanelToggle />
          </div>
        </div>
      </header>
      {shown !== 'agent' && <PaneViewBody view={shown} facts={pane.facts} changes={changes} code={pane.code} header={header} />}
    </>
  )
}
