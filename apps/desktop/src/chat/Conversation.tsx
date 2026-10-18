import { useVirtualizer } from '@tanstack/react-virtual'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type { Project, Transcript, TranscriptEvent } from '@/api/schema'
import { ContextMenu } from '@/components/ContextMenu'
import type { MenuIcon } from '@/components/menu-icons'
import { TranscriptSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { deriveConversation, type DerivedConversation } from '@/chat/conversation-derive'
import { mergeEvents, type LiveRow } from '@/chat/conversation-model'
import { WriteBasesContext } from '@/chat/WriteBasesContext'
import { writeBases } from '@/chat/edit-diff'
import { chatMenu, quoteText, type ChatAction } from '@/chat/chat-menu-model'
import { markedParts, toSections, type ComposeChannel } from '@/chat/chat-menu'
import { imageBytes, pngBytes, saveName } from '@/lib/image-bytes'
import { collapseNotices, type NoticeDisplayItem } from '@/chat/notice-model'
import { PathLinksContext, type PathLinks } from '@/chat/path-links'
import { localFileTarget } from '@/code/chat-paths'
import { reuse } from '@/lib/reuse'
import { isMissingLog } from '@/chat/session-open-model'
import { pageMx } from '@/lib/page'
import { chatTurns, railShown, turnLanding } from '@/native-chat/navigator-rail'
import { NavigatorRail, railMargin } from '@/native-chat/NavigatorRail'
import { usePaneWidth } from '@/native-chat/usePaneWidth'
import { BackgroundTasksContext, Item, LatestCommandContext, ShareCard } from '@/chat/ConversationRow'
export { ApprovalRendererContext } from '@/chat/ConversationRow'
import { MessageActionsContext } from '@/native-chat/MessageActions'
import { ConversationActionBars, useConversationActions } from '@/native-chat/useConversationActions'
import { useConversationSearch } from '@/native-chat/useConversationSearch'
import { taskRows } from '@/chat/background-tasks'

const noLive: LiveRow[] = []

export type OpenChat = (target: { dispatchId: string } | { sessionId: string }) => void
/** Opens a file under a chat's worktree in Code, at a line when one was named. */
export type OpenPath = (root: string, path: string, line: number | null) => void

// Every listed project and worktree: a chat's link to a local file under one opens there in Code.
const CodeRootsContext = createContext<readonly string[]>([])

/** Gives the conversations under it the listed projects and worktrees their file links open in. */
export function CodeRootsProvider({ projects, children }: { projects: readonly Project[]; children: ReactNode }) {
  const roots = useMemo(() => projects.flatMap((project) => [project.path, ...project.worktrees.map((worktree) => worktree.path)]), [projects])
  return <CodeRootsContext.Provider value={roots}>{children}</CodeRootsContext.Provider>
}


// A streamed message keys by its messageId, so the row its chunks grew is the row the complete
// event fills, measured once and never remounted.
const itemKey = (item: NoticeDisplayItem | undefined) => {
  if (item === undefined) return ''
  if (item.type !== 'message') return item.id
  const messageId = item.event.messageId
  return messageId === undefined ? item.event.id : `${item.event.kind}:${messageId}`
}
const footerRow = 'footer'
// Rows are measured once shown; the estimate only places rows not yet seen.
const estimatedRowHeight = 48
const rowGap = 12
const listPadding = 20

export function Conversation({
  target,
  live,
  onOpenChat,
  root = null,
  onOpenPath,
  channel,
  missingLog,
}: {
  target: { dispatchId: string } | { sessionId: string }
  live: boolean
  onOpenChat?: OpenChat
  /** The chat's worktree: only paths under it become links. */
  root?: string | null
  onOpenPath?: OpenPath
  /** The chat's composer, which quotes and code blocks from the right-click menu go into. */
  channel?: ComposeChannel
  /** Shown in place of the error when the session has no log yet. */
  missingLog?: ReactNode
}) {
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [error, setError] = useState<unknown>(null)
  const key = 'dispatchId' in target ? target.dispatchId : target.sessionId
  const cursorRef = useRef<string | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    cursorRef.current = null
    setTranscript(null)
    setError(null)
    const tick = async () => {
      try {
        const next = await api.transcript(target, cursorRef.current ?? undefined)
        if (stopped) return
        cursorRef.current = next.cursor
        // A poll with nothing new keeps the same transcript, so nothing renders.
        setTranscript((previous) => {
          if (previous === null) return next
          const events = mergeEvents(previous.events, next.events)
          if (events.length > previous.events.length) return { ...next, events }
          return reuse(previous, { ...next, events: previous.events })
        })
        setError(null)
      } catch (caught) {
        if (!stopped) setError(caught)
      }
      if (!stopped && live) timer = setTimeout(tick, 2_000)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live])

  if (error !== null && missingLog !== undefined && isMissingLog(error)) return <div className={`${pageMx} my-5`}>{missingLog}</div>
  if (error !== null) return <div className={`${pageMx} my-5`}><ErrorNote error={error} /></div>
  if (transcript === null) {
    return <TranscriptSkeleton />
  }
  return <ConversationList events={transcript.events} onOpenChat={onOpenChat} root={root} onOpenPath={onOpenPath} channel={channel} />
}

/**
 * The rows of a conversation, virtualised and pinned to the newest while the person has not scrolled
 * up. Fed by Conversation's poll for sessions and dispatches, and by a native chat's live follow.
 */
export function ConversationList({
  events,
  onOpenChat,
  root = null,
  onOpenPath,
  live = noLive,
  footer = null,
  channel,
  navigator = false,
  jumpRef,
  searchRef,
  busy = false,
  onEditLast,
  onBranch,
  shareTitle = null,
  divider = null,
  onAtLatest,
}: {
  events: TranscriptEvent[]
  onOpenChat?: OpenChat
  root?: string | null
  onOpenPath?: OpenPath
  /** Rows after the history that are still changing: streaming messages and sent ones not yet echoed. */
  live?: LiveRow[]
  /** The last row, under everything: a native chat's working indicator. */
  footer?: ReactNode
  /** The chat's composer, which quotes and code blocks from the right-click menu go into. */
  channel?: ComposeChannel
  /** A rail of the person's messages on the right edge, to jump between turns. */
  navigator?: boolean
  /** Set while the list shows: scrolls to a background task's row by the task's id. */
  jumpRef?: { current: ((taskId: string) => void) | null }
  /** Set while the list shows: opens the search bar at the transcript's top (Cmd+F in the chat). */
  searchRef?: { current: (() => void) | null }
  /** A turn runs: the latest message cannot be edited and the running turn cannot be branched from. */
  busy?: boolean
  /** Edit on the latest message of the person: its text and images go back to the composer. */
  onEditLast?: (event: TranscriptEvent) => void
  /** Branch from here on the last answer of a turn. */
  onBranch?: (event: TranscriptEvent) => void
  /** The chat's title, under a shared image. */
  shareTitle?: string | null
  /** The event a New divider goes above: where the messages the person has not seen begin. */
  divider?: string | null
  /** Told whether the list shows its newest row, as it changes. */
  onAtLatest?: (atLatest: boolean) => void
}) {
  const [pinned, setPinned] = useState(true)
  const list = useRef<HTMLDivElement>(null)
  const codeRoots = useContext(CodeRootsContext)
  const links = useMemo<PathLinks | null>(() => {
    if (onOpenPath === undefined) return null
    const base = root === null || root === '' ? null : root
    return {
      root: base,
      open: (path, line) => {
        if (base !== null) onOpenPath(base, path, line)
      },
      roots: base === null ? codeRoots : [base, ...codeRoots],
      openFile: (target) => onOpenPath(target.root, target.path, target.line),
    }
  }, [root, onOpenPath, codeRoots])

  // A background task shows once, where it started; its later states reach its row through the context.
  const tasks = useMemo(() => taskRows(events), [events])
  // Only the new events are derived on each poll; the settled rows are kept.
  const derived = useRef<DerivedConversation | null>(null)
  const collapsed = useRef<NoticeDisplayItem[]>([])
  const settled = useMemo(() => {
    const next = deriveConversation(derived.current, tasks.events)
    derived.current = next
    collapsed.current = collapseNotices(next.display, collapsed.current)
    return collapsed.current
  }, [tasks.events])
  // The live rows change with every chunk; the settled ones above keep their identity.
  const items = useMemo<NoticeDisplayItem[]>(
    () => (live.length === 0 ? settled : settled.concat(live.map((row) => ({ type: 'message', event: row.event, streaming: row.streaming, pending: row.pending })))),
    [settled, live],
  )
  const bases = useMemo(
    () => writeBases(events.flatMap((event) => (event.kind === 'tool-call' && event.tool !== undefined ? [{ id: event.id, name: event.tool.name, input: event.tool.input }] : []))),
    [events],
  )
  const latestCommand = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item?.type === 'message' && (item.event.kind === 'command-output' || (item.event.kind === 'assistant' && item.event.command !== undefined))) return item.event.id
    }
    return null
  }, [items])
  const hasFooter = footer !== null
  const turns = useMemo(() => (navigator ? chatTurns(items) : []), [navigator, items])
  const width = usePaneWidth()
  const rail = railShown(turns.length, width.width)
  const count = items.length + (hasFooter ? 1 : 0)

  // Only the rows near the viewport are in the DOM; each is measured as it renders.
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => list.current,
    estimateSize: () => estimatedRowHeight,
    getItemKey: (index) => (index === items.length ? footerRow : itemKey(items[index])),
    gap: rowGap,
    paddingStart: listPadding,
    paddingEnd: listPadding,
    // A jump to a turn (align start) lands it where the rail reads the turn in view.
    scrollPaddingStart: navigator ? turnLanding(list.current?.clientHeight ?? 0) : 0,
    overscan: 6,
  })

  const { search, marked, closeSearch } = useConversationSearch({ items, turns, virtualizer, list, searchRef, setPinned })

  const scrollToLatest = () => {
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: 'end' })
  }

  // A jump to a task lights its row for a moment, so the eye finds it.
  const [flashed, setFlashed] = useState<string | null>(null)
  useEffect(() => {
    if (flashed === null) return
    const timer = setTimeout(() => setFlashed(null), 1_200)
    return () => clearTimeout(timer)
  }, [flashed])
  useEffect(() => {
    if (jumpRef === undefined) return
    jumpRef.current = (taskId) => {
      const index = items.findIndex((item) => item.type === 'message' && item.event.kind === 'background-task' && item.event.backgroundTask?.id === taskId)
      if (index === -1) return
      setPinned(false)
      virtualizer.scrollToIndex(index, { align: 'center' })
      setFlashed(taskId)
    }
    return () => {
      jumpRef.current = null
    }
  }, [jumpRef, items, virtualizer])
  const taskContext = useMemo(() => ({ latest: tasks.latest, flashed }), [tasks.latest, flashed])

  useEffect(() => {
    if (pinned) scrollToLatest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, hasFooter, pinned])

  useEffect(() => onAtLatest?.(pinned), [onAtLatest, pinned])

  const onScroll = () => {
    const element = list.current
    if (element === null) return
    setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 40)
  }

  // What an action did (an image copied) or could not do (a clipboard or a save refused), shown for a few seconds.
  const [flash, setFlash] = useState<{ text: string; bad: boolean } | null>(null)
  useEffect(() => {
    if (flash === null) return
    const timer = setTimeout(() => setFlash(null), 4_000)
    return () => clearTimeout(timer)
  }, [flash])
  const setMenuError = (text: string) => setFlash({ text, bad: true })
  const failed = (caught: unknown) => setMenuError(caught instanceof Error ? caught.message : String(caught))

  const messageActions = useConversationActions({ items, list, busy, onEditLast, onBranch, shareTitle: shareTitle ?? null, renderCard: (events, agent, title, width) => <ShareCard events={events} agent={agent} title={title} width={width} />, setFlash, failed })
  const { actions, selecting, selection, shareImage, shareMenu, stopSelecting, chosen, contextMenu } = messageActions

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const marked = markedParts(event)
    const element = event.target instanceof Element ? event.target : null
    const selected = window.getSelection()
    const selection = selected !== null && !selected.isCollapsed && list.current?.contains(selected.anchorNode) === true ? selected.toString() : ''
    const link = element?.closest<HTMLElement>('[data-link]')?.dataset.link ?? null
    const file = link === null || links === null ? null : localFileTarget(link, links.root, links.roots)
    const image = marked.image ?? (element instanceof HTMLImageElement ? { src: element.currentSrc || element.src, name: element.alt || 'Image', open: null } : null)
    // A tool's input and output are <pre> too; the tool's own actions cover them.
    const code = marked.tool === undefined ? (element?.closest('pre')?.textContent ?? null) : null
    const message = marked.message ?? null
    const tool = marked.tool ?? null
    const insert = channel?.current ?? null
    const copy = (text: string) => void api.copyText(text).catch(failed)
    const run = (action: ChatAction) => {
      switch (action) {
        case 'open-link':
          if (link !== null) void api.openUrl(link).catch(failed)
          return
        case 'open-file':
          if (file !== null) links?.openFile(file)
          return
        case 'copy-link':
          if (link !== null) copy(link)
          return
        case 'copy-image':
          if (image !== null) void pngBytes(image.src).then(api.copyImage).catch(failed)
          return
        case 'save-image':
          if (image !== null) void imageBytes(image.src).then(({ bytes, type }) => api.saveImageAs(bytes, saveName(image.name, type))).catch(failed)
          return
        case 'open-image':
          image?.open?.()
          return
        case 'copy-code':
          if (code !== null) copy(code)
          return
        case 'insert-code':
          if (code !== null) insert?.(`\`\`\`\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`)
          return
        case 'copy-input':
          if (tool !== null) copy(tool.command ?? tool.input ?? '')
          return
        case 'copy-output':
          if (tool !== null && tool.output !== null) copy(tool.output)
          return
        case 'copy':
          copy(selection !== '' ? selection : (message?.markdown ?? ''))
          return
        case 'copy-plain':
          copy(selection !== '' ? selection : (message?.element.innerText ?? ''))
          return
        case 'quote':
          insert?.(quoteText(selection !== '' ? selection : (message?.markdown ?? '')))
          return
        case 'select-message': {
          if (message === null) return
          const range = document.createRange()
          range.selectNodeContents(message.element)
          selected?.removeAllRanges()
          selected?.addRange(range)
          return
        }
        case 'scroll-bottom':
          setPinned(true)
          scrollToLatest()
      }
    }
    const icons: Record<ChatAction, MenuIcon> = {
      'open-link': 'external',
      'open-file': 'code',
      'copy-link': 'link',
      'copy-image': 'copy',
      'save-image': 'save',
      'open-image': 'image',
      'copy-code': 'copy',
      'insert-code': 'insert',
      'copy-input': tool !== null && tool.command !== null ? 'terminal' : 'copy',
      'copy-output': 'copy',
      copy: 'copy',
      'copy-plain': 'copy',
      quote: 'quote',
      'select-message': 'select',
      'scroll-bottom': 'bottom',
    }
    const target = { selection, message, code, tool, image: image === null ? null : { viewer: image.open !== null }, link, linkOpensFile: file !== null, canCompose: insert !== null }
    contextMenu.open(event, toSections(chatMenu(target), run, icons))
  }

  if (count === 0) {
    return <div className={`${pageMx} my-5 text-chat-ui text-ink-400`}>Nothing here yet.</div>
  }

  return (
    <PathLinksContext.Provider value={links}>
      <BackgroundTasksContext.Provider value={taskContext}>
      <MessageActionsContext.Provider value={actions}>
      {/* It fades in where the suggestions or the loading rows were, as the first message arrives. */}
      <div
        ref={width.ref}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && selecting) {
            event.preventDefault()
            stopSelecting()
          }
        }}
        className="motion-fade relative flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div
          ref={list}
          // Focusable by a click, so the rail's Alt+Up and Alt+Down reach it; never a tab stop.
          tabIndex={-1}
          onScroll={onScroll}
          onContextMenu={onContextMenu}
          // A right click keeps the selection it lands on, where WebKit would select the word under it.
          onMouseDown={(event) => {
            if (event.button === 2) event.preventDefault()
          }}
          className={`${rail ? `${railMargin} rail-scroll` : pageMx} ${selecting ? 'pl-8' : ''} min-h-0 flex-1 overflow-y-auto text-chat outline-none select-text`}
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = items[row.index]
              if (row.index === items.length && hasFooter) {
                return (
                  <ol key={row.key} data-index={row.index} ref={virtualizer.measureElement} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${row.start}px)` }}>
                    {footer}
                  </ol>
                )
              }
              if (item === undefined) return null
              // Each row is a one-item list, so the message components keep rendering an <li>. A hovered row
              // rises above the next, so the actions under its message stay on top.
              return (
                <ol key={row.key} data-index={row.index} ref={virtualizer.measureElement} className="absolute top-0 left-0 w-full focus-within:z-10 hover:z-10" style={{ transform: `translateY(${row.start}px)` }}>
                  <WriteBasesContext.Provider value={bases}>
                    <LatestCommandContext.Provider value={latestCommand}>
                      {divider !== null && item.type === 'message' && item.event.id === divider && <NewDivider />}
                      <Item item={item} onOpenChat={onOpenChat} />
                    </LatestCommandContext.Provider>
                  </WriteBasesContext.Provider>
                </ol>
              )
            })}
          </div>
        </div>
        {rail && <NavigatorRail turns={turns} virtualizer={virtualizer} scroller={list} marked={marked} />}
        <ConversationActionBars search={search} closeSearch={closeSearch} selecting={selecting} selection={selection} shareImage={shareImage} shareMenu={shareMenu} chosen={chosen} stopSelecting={stopSelecting} failed={failed} setFlash={setFlash} pinned={pinned} onJumpToLatest={() => { setPinned(true); scrollToLatest() }} />
        {flash !== null && (
          <p role="status" className={`absolute bottom-14 left-1/2 z-20 max-w-[80%] -translate-x-1/2 truncate rounded-full border bg-ink-900/95 px-4 py-1.5 text-chat-small shadow-lg ${flash.bad ? 'border-bad/30 text-bad' : 'border-white/15 text-ink-100'}`}>
            {flash.text}
          </p>
        )}
        <ContextMenu menu={contextMenu.menu} onClose={contextMenu.close} />
      </div>
      </MessageActionsContext.Provider>
      </BackgroundTasksContext.Provider>
    </PathLinksContext.Provider>
  )
}

/** A thin labelled line above the first message the person has not seen. */
function NewDivider() {
  return (
    <li role="separator" aria-label="New messages" className="mb-3 flex items-center gap-2 text-chat-small font-medium text-accent">
      <span aria-hidden="true" className="h-px flex-1 bg-accent/40" />
      <span aria-hidden="true">New</span>
    </li>
  )
}
