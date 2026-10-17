import { useEffect, useLayoutEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { ActionBar, PaneViewBody, useWorktreeChanges } from '@/chat/ActionBar'
import { changedFileCount, paneViewKey, segments, shownView, type PaneView } from '@/chat/action-bar-model'
import { headerTitle } from '@/chat/header-model'
import { usePaneView } from '@/chat/pane-view-context'
import { useWindowRowInset } from '@/panes/window-row'
import { usePaneChrome, type PaneChrome } from '@/panes/pane-chrome'
import { RemoveFromSplitIcon } from '@/panes/PaneArea'
import type { AgentActivity } from '@/components/agent-activity'
import { AgentIcon } from '@/components/agent-icons'
import { RunButton, RunPanelToggle } from '@/run-panel/RunButton'

/**
 * The top bar every chat view and the launcher share. Its first row is the agent's mark, live while it works (none on the launcher), and the title on one line (header-model),
 * truncating before the controls on the right: the view's own controls (the chat or terminal switch, shown only in Agent), the Run button and the run panel's toggle once
 * anything ran. An item with a worktree (a launcher once it has one) also gets a second row, the view tabs (Agent, Code, PR, Diff and Device, each shown in the pane under the bar),
 * one segmented control starting at the mark's left edge and scrolling sideways when the pane is too narrow for it. The first row sits about 12px below
 * the window top. When the sidebar is hidden and this bar joins the window row (panes/window-row) that row shrinks to the lights' 44px band, centred on their line, and
 * both rows leave room at their left for the lights and the show-sidebar button. In a split it is also the pane's header (panes/pane-chrome): its empty space drags the
 * pane instead of the window, and the button at its right end takes the pane out of the split. Under a split's shared bar (panes/group-bar) it is slim instead: one 36px
 * row of the mark, the title, the view's controls and that button; the tabs are the shared bar's.
 */
export function ChatHeader({ agent, activity = 'idle', title, actions }: { agent: string | null; activity?: AgentActivity; title: string; actions?: ReactNode }) {
  const pane = usePaneView()
  const changes = useWorktreeChanges(pane?.facts ?? null)
  const header = useRef<HTMLElement>(null)
  const inset = useWindowRowInset()
  const chrome = usePaneChrome()
  useLayoutEffect(() => chrome?.claim(), [chrome])
  const available = pane === null ? null : segments({ facts: pane.facts, changed: changes.read ? changedFileCount(changes.uncommitted, changes.branch) : null, codeAvailable: true })
  const select = (view: PaneView) => pane?.setView(view)
  const latest = useRef({ available, select })
  latest.current = { available, select }

  // ⌘1 to ⌘5 in the capture phase, so a terminal or an editor in the pane does not keep them; a disabled view ignores its key.
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

  const text = headerTitle(title)

  // No native tooltip while the bar drags its pane: one shown as the press under it turns into a drag
  // can stay floating over the panes.
  const tip = (value: string) => (chrome === null ? value : undefined)
  const identity = (
    <>
      {agent !== null && <AgentIcon agent={agent} activity={activity} size={18} className="shrink-0 text-ink-300" />}
      {/* At least 36px tall whatever the controls beside it, so the window row's 44px band holds. */}
      <div className="flex min-h-9 min-w-0 flex-1 flex-col justify-center">
        <h1 title={tip(text)} className="truncate text-[13px] leading-[18px] font-medium text-ink-100">{text}</h1>
      </div>
    </>
  )

  // Split, the bar's empty space moves the pane rather than the window; its controls keep their own presses.
  const region = chrome === null ? { 'data-tauri-drag-region': true } : {}
  const grab =
    chrome === null
      ? undefined
      : (event: PointerEvent<HTMLElement>) => {
          if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, [role="tab"], [role="button"], [role="tablist"]') !== null) return
          chrome.onDrag(event)
        }
  const close = chrome === null ? null : <PaneClose chrome={chrome} />

  // In the window row: 4px above and below the 36px title make the 44px band; the padding slides between the two with the sidebar.
  const band = inset === null ? 'pt-3' : 'pt-1'
  const slide: CSSProperties = { transition: 'padding var(--motion-panel) var(--motion-ease-panel)', paddingLeft: inset ?? 24 }
  const side = chrome === null ? 'pr-6' : 'cursor-grab pr-3 active:cursor-grabbing'

  // Under a split's shared bar (panes/group-bar) the pane keeps only what is its own: no view tabs, no Run, one short row.
  if (chrome?.slim === true) {
    return (
      <header ref={header} data-slim-header="" onPointerDown={grab} className="group/pane flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-white/[0.06] pr-2 pl-3 select-none active:cursor-grabbing">
        {agent !== null && <AgentIcon agent={agent} activity={activity} size={16} className="shrink-0 text-ink-300" />}
        <h1 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-ink-100">
          {text}
        </h1>
        {actions}
        {close}
      </header>
    )
  }

  const controls = (own: ReactNode) => (
    <div {...region} className="flex shrink-0 items-center justify-end gap-2">
      {own}
      <RunButton />
      <RunPanelToggle />
      {close}
    </div>
  )

  if (pane === null || available === null) {
    return (
      <header ref={header} {...region} onPointerDown={grab} style={slide} className={`@container/header group/pane flex shrink-0 items-center gap-2 border-b border-white/[0.06] ${side} ${band} ${inset === null ? 'pb-2.5' : 'pb-1'}`}>
        {identity}
        {controls(actions)}
      </header>
    )
  }

  const shown = shownView(pane.view, available)

  const body = shown !== 'agent' && <PaneViewBody view={shown} facts={pane.facts} changes={changes} code={pane.code} openFile={pane.openFile} header={header} />

  // Both rows share one left edge, the bar's padding: the tabs' track starts under the mark. The view's controls belong to Agent and show only there.
  return (
    <>
      <header ref={header} {...region} onPointerDown={grab} style={slide} className={`@container/header group/pane shrink-0 border-b border-white/[0.06] ${side} ${band}`}>
        <div {...region} className="flex min-w-0 items-center gap-2">
          {identity}
          {controls(shown === 'agent' && actions)}
        </div>
        <div {...region} className="mt-1 flex min-w-0 pb-2">
          <ActionBar segments={available} shown={shown} onSelect={select} />
        </div>
      </header>
      {body}
    </>
  )
}

/** A split pane's button at the bar's right end, always shown: it takes the pane out of the split; the chat stays open in the sidebar. */
function PaneClose({ chrome }: { chrome: PaneChrome }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${chrome.title} from split`}
      title="Remove from split"
      onClick={chrome.onClose}
      className="-ml-1.5 flex size-6 shrink-0 items-center justify-center rounded-full text-ink-400 transition-colors duration-[var(--motion-enter)] hover:bg-white/[0.1] hover:text-ink-100"
    >
      <RemoveFromSplitIcon />
    </button>
  )
}
