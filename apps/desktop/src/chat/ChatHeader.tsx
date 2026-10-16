import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { ActionBar, PaneViewBody, useWorktreeChanges } from '@/chat/ActionBar'
import { changedFileCount, headerMode, paneViewKey, segments, shownView, type PaneView } from '@/chat/action-bar-model'
import { usePaneView } from '@/chat/pane-view-context'
import { useWindowRowInset } from '@/panes/window-row'
import { usePaneChrome, type PaneChrome } from '@/panes/pane-chrome'
import { RemoveFromSplitIcon } from '@/panes/PaneArea'
import type { AgentActivity } from '@/components/agent-activity'
import { AgentIcon } from '@/components/agent-icons'
import { RunButton, RunPanelToggle } from '@/run-panel/RunButton'

/**
 * The top bar every chat view and the launcher share: the agent's mark, live while it works (none on the launcher), one-line title and one small metadata line,
 * then the Run button and the run panel's toggle once anything ran on the right. An item with a worktree (a launcher once it has one) also gets the action bar in the
 * bar's true centre, Agent, Code, PR and Diff, each shown in the pane under the bar; the view's own controls (the chat or terminal switch) belong to Agent and show only there. It sits about 12px
 * below the window top. When the sidebar is hidden and this bar joins the window row (panes/window-row) it shrinks to the lights' 44px band, centred on their line, and leaves
 * room at its left for them and the show-sidebar button; only the left side is inset, so the action bar keeps the true centre. In a split it is also the pane's
 * header (panes/pane-chrome): its empty space drags the pane instead of the window, and the button at its right end takes the pane out of the split. Narrower than 640px
 * (action-bar-model's headerMode) it stacks: the mark, title and Remove from split on the first row, the action bar and the view's controls on the second. Under a split's
 * shared bar (panes/group-bar) it is slim instead: one 36px row of the mark, the title, the view's controls and that button.
 */
export function ChatHeader({ agent, activity = 'idle', title, meta, metaTitle, actions }: { agent: string | null; activity?: AgentActivity; title: string; meta: string; metaTitle?: string; actions?: ReactNode }) {
  const pane = usePaneView()
  const changes = useWorktreeChanges(pane?.facts ?? null)
  const header = useRef<HTMLElement>(null)
  const mode = headerMode(usePaneWidth(header, pane === null))
  const stacked = mode === 'stacked'
  const inset = useWindowRowInset()
  const chrome = usePaneChrome()
  useLayoutEffect(() => chrome?.claim(), [chrome])
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

  // No native tooltip while the bar drags its pane: one shown as the press under it turns into a drag
  // can stay floating over the panes, and the title and metadata already show on the bar.
  const tip = (text: string) => (chrome === null ? text : undefined)
  const identity = (
    <>
      {agent !== null && <AgentIcon agent={agent} activity={activity} size={stacked ? 20 : 22} className="shrink-0 text-ink-300" />}
      <div className="min-w-0 flex-1">
        <h1 title={tip(title)} className={`truncate ${stacked ? 'text-[14px]' : 'text-[15px]'} leading-5 font-semibold tracking-[-0.01em] text-ink-100`}>{title}</h1>
        <p title={tip(metaTitle ?? meta)} className="truncate text-[12px] leading-4 text-ink-400">{meta}</p>
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
  const band = inset === null ? 'pt-3 pb-2.5' : 'py-1'
  const slide: CSSProperties = { transition: 'padding var(--motion-panel) var(--motion-ease-panel)' }

  // Under a split's shared bar (panes/group-bar) the pane keeps only what is its own: no action bar, no Run, one short row.
  if (chrome?.slim === true) {
    return (
      <header ref={header} data-slim-header="" onPointerDown={grab} className="group/pane flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-white/[0.06] pr-2 pl-3 select-none active:cursor-grabbing">
        {agent !== null && <AgentIcon agent={agent} activity={activity} size={16} className="shrink-0 text-ink-300" />}
        <h1 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold tracking-[-0.01em] text-ink-100">
          {title}
        </h1>
        {actions}
        {close}
      </header>
    )
  }

  if (pane === null || available === null) {
    return (
      <header ref={header} {...region} onPointerDown={grab} style={{ ...slide, paddingLeft: inset ?? 24 }} className={`@container/header group/pane flex shrink-0 items-center gap-3 border-b border-white/[0.06] ${chrome === null ? 'pr-6' : 'cursor-grab pr-3 active:cursor-grabbing'} ${band}`}>
        {identity}
        {actions}
        <RunButton />
        <RunPanelToggle />
        {close}
      </header>
    )
  }

  const shown = shownView(pane.view, available)

  const body = shown !== 'agent' && <PaneViewBody view={shown} facts={pane.facts} changes={changes} code={pane.code} header={header} />

  // Stacked, the first row gives the title the width and the second carries every control; the Agent
  // view shows a chat glyph there, the agent's own mark being right above it.
  if (stacked) {
    return (
      <>
        <header ref={header} {...region} onPointerDown={grab} style={slide} className={`group/pane shrink-0 border-b border-white/[0.06] ${chrome === null ? 'px-4' : 'cursor-grab pr-2 pl-4 active:cursor-grabbing'} ${inset === null ? 'pt-2.5 pb-2' : 'py-1'}`}>
          <div {...region} style={{ ...slide, paddingLeft: inset === null ? 0 : inset - 16 }} className="flex h-9 min-w-0 items-center gap-2.5">
            {identity}
            {close}
          </div>
          <div {...region} className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
            <ActionBar agent={null} segments={available} shown={shown} onSelect={select} />
            <div {...region} className="flex min-w-0 items-center justify-end gap-2">
              {shown === 'agent' && actions}
              <RunButton />
              <RunPanelToggle />
            </div>
          </div>
        </header>
        {body}
      </>
    )
  }

  // Equal side columns put the bar in the bar's true centre; each side truncates or clips inside its own half.
  return (
    <>
      <header
        ref={header}
        {...region}
        onPointerDown={grab}
        style={slide}
        className={`@container/header group/pane shrink-0 border-b border-white/[0.06] ${chrome === null ? 'px-6' : 'cursor-grab pr-3 pl-6 active:cursor-grabbing'} ${band}`}
      >
        <div {...region} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
          <div {...region} style={{ ...slide, paddingLeft: inset === null ? 0 : inset - 24 }} className="flex min-w-0 items-center gap-3">
            {identity}
          </div>
          <ActionBar agent={agent} segments={available} shown={shown} onSelect={select} />
          <div {...region} className="flex min-w-0 items-center justify-end gap-3">
            {shown === 'agent' && actions}
            <RunButton />
            <RunPanelToggle />
            {close}
          </div>
        </div>
      </header>
      {body}
    </>
  )
}

/**
 * The width of the pane holding the element (the element's own outside a pane), read before paint
 * and on every resize; null until it mounts. `shape` changes when another element takes the ref.
 * The pane, not the bar: a pane's left border would make a 640px pane's bar read 639. offsetWidth,
 * not the bounding box: a pane rising into view is scaled while it animates, and the bounding box
 * would read that smaller width.
 */
function usePaneWidth(ref: RefObject<HTMLElement | null>, shape: unknown): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = ref.current?.closest<HTMLElement>('[data-pane-id]') ?? ref.current
    if (element === null) return
    const measure = () => setWidth(element.offsetWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, shape])
  return width
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
