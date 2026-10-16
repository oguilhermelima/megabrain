import { useVirtualizer } from '@tanstack/react-virtual'
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { Transcript, TranscriptEvent } from '@/api/schema'
import { TranscriptSkeleton } from '@/components/Skeleton'
import { ErrorNote, Spinner } from '@/components/ui'
import { deriveConversation, type DerivedConversation } from '@/chat/conversation-derive'
import { mergeEvents, relayedPreview, relayedTarget, type ConversationItem, type ToolStatus } from '@/chat/conversation-model'
import { toolDetail, toolGroupSummary, toolName, type DisplayItem, type ToolItem as ToolRow } from '@/chat/tool-groups'
import { MarkdownText } from '@/chat/markdown'
import { NoticeCard } from '@/chat/NoticeCard'
import { collapseNotices, type NoticeDisplayItem } from '@/chat/notice-model'
import { UserMessageBody } from '@/chat/MessageImages'
import { LinkedText, PathLinksContext, type PathLinks } from '@/chat/path-links'
import { firstPath } from '@/code/chat-paths'
import { reuse } from '@/lib/reuse'

export type OpenChat = (target: { dispatchId: string } | { sessionId: string }) => void
/** Opens a file under a chat's worktree in Code mode, at a line when one was named. */
export type OpenPath = (root: string, path: string, line: number | null) => void

function UserMessage({ event }: { event: TranscriptEvent }) {
  return (
    <li className="flex justify-end">
      <div className="min-w-0 max-w-[75%] rounded-[20px] bg-accent/15 px-4 py-2.5 text-ink-100">
        <UserMessageBody text={event.text} images={event.images} />
      </div>
    </li>
  )
}

function AssistantMessage({ event }: { event: TranscriptEvent }) {
  return (
    <li className="max-w-[80%] text-ink-200">
      <MarkdownText text={event.text} />
    </li>
  )
}

/** Renders an approval event in place; a native chat provides it, other views show the event as text. */
export const ApprovalRendererContext = createContext<((event: TranscriptEvent) => ReactNode) | null>(null)

function ApprovalMessage({ event }: { event: TranscriptEvent }) {
  const render = useContext(ApprovalRendererContext)
  return render === null ? <SystemMessage event={event} /> : <li>{render(event)}</li>
}

function SystemMessage({ event }: { event: TranscriptEvent }) {
  return <li className="text-center text-[12px] text-ink-400">{event.text}</li>
}

function RelayedMessage({ event, onOpenChat }: { event: TranscriptEvent; onOpenChat: OpenChat | undefined }) {
  const origin = event.origin
  if (origin === undefined) return null
  const [open, setOpen] = useState(false)
  const target = relayedTarget(origin)
  const header = origin.kind === 'parent' ? `From parent · ${origin.label}` : `From ${origin.label}`
  return (
    <li className="max-w-[85%] rounded-2xl border border-white/[0.06] bg-white/[0.03]">
      <div className="flex items-center gap-2 px-3.5 py-2">
        <span className="shrink-0 text-[13px] text-ink-400" aria-label={origin.kind === 'parent' ? 'relayed from parent' : 'relayed from child'}>
          {origin.kind === 'parent' ? '↑' : '↓'}
        </span>
        <button type="button" onClick={() => setOpen((value) => !value)} className="min-w-0 flex-1 text-left">
          <span className="block text-[12px] font-semibold text-ink-300">{header}</span>
          {!open && <span className="block truncate text-[13px] text-ink-400">{relayedPreview(event.text)}</span>}
        </button>
        {onOpenChat !== undefined && target !== null && (
          <button
            type="button"
            onClick={() => onOpenChat(target)}
            className="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-[12px] font-semibold text-ink-300 hover:bg-white/[0.08]"
          >
            →
          </button>
        )}
      </div>
      {open && (
        <div className="px-3.5 pb-3">
          <MarkdownText text={event.text} />
        </div>
      )}
    </li>
  )
}

function ThinkingMessage({ event }: { event: TranscriptEvent }) {
  const [open, setOpen] = useState(false)
  const firstLine = event.text.split('\n')[0] ?? ''
  return (
    <li>
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex max-w-[80%] items-center gap-2 text-left text-[13px] text-ink-400 hover:text-ink-300">
        <span className="orb idle size-2.5 shrink-0" />
        {open ? 'Thinking' : firstLine}
      </button>
      {open && <p className="mt-1 max-w-[80%] whitespace-pre-wrap text-[13px] text-ink-400 italic">{event.text}</p>}
    </li>
  )
}

/** Indented JSON when the input is JSON, the input as given otherwise. */
function prettyInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

const toolDot: Record<ToolStatus, string> = { ok: 'bg-ok', error: 'bg-bad', running: 'bg-accent' }

function ToolItem({ item }: { item: ToolRow }) {
  const [open, setOpen] = useState(false)
  const input = item.call.tool?.input
  const summary = toolDetail(item)
  const links = useContext(PathLinksContext)
  // The row toggles open, so its path opens through a button of its own beside it.
  const target = links === null ? null : firstPath(summary, links.root)
  return (
    <li className="rounded-2xl border border-white/[0.06] bg-white/[0.03]">
      <div className="flex items-center pr-2">
        <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-2 text-left text-[13px]">
          <span className={`size-1.5 shrink-0 rounded-full ${toolDot[item.status]} ${item.status === 'running' ? 'animate-pulse' : ''}`} />
          <span className="shrink-0 font-semibold text-ink-300">{toolName(item)}</span>
          <span title={summary} className="truncate font-mono text-[12.5px] text-ink-400">{summary}</span>
        </button>
        {links !== null && target !== null && (
          <button
            type="button"
            onClick={() => links.open(target.path, target.line)}
            title={`Open in Code: ${target.text}`}
            className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold text-accent hover:bg-white/[0.08]"
          >
            Open
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-2 px-3.5 pb-3">
          {input !== undefined && (
            <pre className="max-h-48 overflow-auto rounded-xl bg-white/[0.05] px-3 py-2 font-mono text-[12px] text-ink-200">
              <LinkedText text={prettyInput(input)} />
            </pre>
          )}
          {item.result !== null && (
            <pre className="max-h-48 overflow-auto rounded-xl bg-white/[0.05] px-3 py-2 font-mono text-[12px] text-ink-200">
              <LinkedText text={item.result.text} />
            </pre>
          )}
        </div>
      )}
    </li>
  )
}

function ToolGroup({ group, onOpenChat }: { group: Extract<DisplayItem, { type: 'tool-group' }>; onOpenChat: OpenChat | undefined }) {
  const [open, setOpen] = useState(false)
  const summary = toolGroupSummary(group)
  const running = summary.state === 'running'
  return (
    <li className="max-w-[85%]">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex max-w-full items-center gap-2 rounded-full px-1 py-0.5 text-left text-[13px] text-ink-400 hover:text-ink-200">
        <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
        {running ? (
          <>
            <Spinner />
            <span className="shrink-0 font-semibold text-ink-200">Working: {summary.tool}</span>
            <span title={summary.detail} className="min-w-0 truncate font-mono text-[12.5px]">{summary.detail}</span>
            {summary.earlier > 0 && <span className="shrink-0">· {summary.earlier} earlier</span>}
          </>
        ) : (
          <>
            <span className="shrink-0 font-semibold text-ink-300">
              Ran {summary.total} {summary.total === 1 ? 'tool' : 'tools'}:
            </span>
            <span className="min-w-0 truncate">{summary.counts.map((entry) => `${entry.count} ${entry.name}`).join(', ')}</span>
            {summary.errors > 0 && <span className="shrink-0 font-semibold text-bad">· {summary.errors} failed</span>}
          </>
        )}
      </button>
      {open && (
        <ol className="mt-1.5 ml-5 space-y-1.5">
          {group.items.map((item) => (
            <Item key={item.type === 'tool' ? item.id : item.event.id} item={item} onOpenChat={onOpenChat} />
          ))}
        </ol>
      )}
    </li>
  )
}

// Memoised: a settled row keeps its item object across polls (see conversation-derive.ts).
const Item = memo(function Item({ item, onOpenChat }: { item: ConversationItem | NoticeDisplayItem; onOpenChat: OpenChat | undefined }) {
  if (item.type === 'notice') return <NoticeCard card={item} onOpenChat={onOpenChat} />
  if (item.type === 'tool-group') return <ToolGroup group={item} onOpenChat={onOpenChat} />
  if (item.type === 'tool') return <ToolItem item={item} />
  const event = item.event
  if (event.origin !== undefined) return <RelayedMessage event={event} onOpenChat={onOpenChat} />
  if (event.kind === 'user') return <UserMessage event={event} />
  if (event.kind === 'assistant') return <AssistantMessage event={event} />
  if (event.kind === 'thinking') return <ThinkingMessage event={event} />
  if (event.kind === 'approval') return <ApprovalMessage event={event} />
  return <SystemMessage event={event} />
})

const itemKey = (item: NoticeDisplayItem | undefined) => (item === undefined ? '' : item.type === 'message' ? item.event.id : item.id)
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
}: {
  target: { dispatchId: string } | { sessionId: string }
  live: boolean
  onOpenChat?: OpenChat
  /** The chat's worktree: only paths under it become links. */
  root?: string | null
  onOpenPath?: OpenPath
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

  if (error !== null) return <div className="mx-8 my-5"><ErrorNote error={error} /></div>
  if (transcript === null) {
    return <TranscriptSkeleton />
  }
  return <ConversationList events={transcript.events} onOpenChat={onOpenChat} root={root} onOpenPath={onOpenPath} />
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
}: {
  events: TranscriptEvent[]
  onOpenChat?: OpenChat
  root?: string | null
  onOpenPath?: OpenPath
}) {
  const [pinned, setPinned] = useState(true)
  const list = useRef<HTMLDivElement>(null)
  const links = useMemo<PathLinks | null>(
    () => (root === null || root === '' || onOpenPath === undefined ? null : { root, open: (path, line) => onOpenPath(root, path, line) }),
    [root, onOpenPath],
  )

  // Only the new events are derived on each poll; the settled rows are kept.
  const derived = useRef<DerivedConversation | null>(null)
  const collapsed = useRef<NoticeDisplayItem[]>([])
  const items = useMemo(() => {
    const next = deriveConversation(derived.current, events)
    derived.current = next
    collapsed.current = collapseNotices(next.display, collapsed.current)
    return collapsed.current
  }, [events])

  // Only the rows near the viewport are in the DOM; each is measured as it renders.
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => list.current,
    estimateSize: () => estimatedRowHeight,
    getItemKey: (index) => itemKey(items[index]),
    gap: rowGap,
    paddingStart: listPadding,
    paddingEnd: listPadding,
    overscan: 6,
  })

  const scrollToLatest = () => {
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: 'end' })
  }

  useEffect(() => {
    if (pinned) scrollToLatest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, pinned])

  const onScroll = () => {
    const element = list.current
    if (element === null) return
    setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 40)
  }

  if (events.length === 0) {
    return <div className="mx-8 my-5 text-[13px] text-ink-400">Nothing here yet.</div>
  }

  return (
    <PathLinksContext.Provider value={links}>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div ref={list} onScroll={onScroll} className="mx-8 min-h-0 flex-1 overflow-y-auto select-text">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = items[row.index]
              if (item === undefined) return null
              // Each row is a one-item list, so the message components keep rendering an <li>.
              return (
                <ol key={row.key} data-index={row.index} ref={virtualizer.measureElement} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${row.start}px)` }}>
                  <Item item={item} onOpenChat={onOpenChat} />
                </ol>
              )
            })}
          </div>
        </div>
        {!pinned && (
          <button
            type="button"
            onClick={() => {
              setPinned(true)
              scrollToLatest()
            }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-ink-900/90 px-4 py-1.5 text-[12.5px] font-semibold text-ink-100 shadow-lg"
          >
            Jump to latest
          </button>
        )}
      </div>
    </PathLinksContext.Provider>
  )
}
