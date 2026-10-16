import { useVirtualizer } from '@tanstack/react-virtual'
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type { Transcript, TranscriptEvent } from '@/api/schema'
import { ContextMenu, useContextMenu } from '@/components/ContextMenu'
import type { MenuIcon } from '@/components/menu-icons'
import { TranscriptSkeleton } from '@/components/Skeleton'
import { AgentIcon, ConversationAgent } from '@/components/agent-icons'
import { ErrorNote } from '@/components/ui'
import { deriveConversation, type DerivedConversation } from '@/chat/conversation-derive'
import { mergeEvents, relayedPreview, relayedTarget, type ConversationItem, type LiveRow, type ToolStatus } from '@/chat/conversation-model'
import { groupToolRuns, toolDetail, toolGroupSummary, toolName, type DisplayItem, type ToolItem as ToolRow } from '@/chat/tool-groups'
import { subagentGroupSummary, subagentSummary, visibleSteps, type SubagentItem, type SubagentState } from '@/chat/subagent-model'
import { formatElapsed } from '@/native-chat/chat-model'
import { MarkdownText } from '@/chat/markdown'
import { chatMenu, quoteText, toolCommand, type ChatAction } from '@/chat/chat-menu-model'
import { markMenu, markedParts, toSections, type ComposeChannel } from '@/chat/chat-menu'
import { imageBytes, pngBytes, saveName } from '@/lib/image-bytes'
import { NoticeCard } from '@/chat/NoticeCard'
import { collapseNotices, type NoticeDisplayItem } from '@/chat/notice-model'
import { UserMessageBody } from '@/chat/MessageImages'
import { LinkedText, PathLinksContext, type PathLinks } from '@/chat/path-links'
import { firstPath } from '@/code/chat-paths'
import { reuse } from '@/lib/reuse'
import { isMissingLog } from '@/chat/session-open-model'

const noLive: LiveRow[] = []

export type OpenChat = (target: { dispatchId: string } | { sessionId: string }) => void
/** Opens a file under a chat's worktree in Code, at a line when one was named. */
export type OpenPath = (root: string, path: string, line: number | null) => void

/** A row's right click offers its message: the markdown as sent, and the element it renders as. */
const markMessage = (text: string) => (event: ReactMouseEvent<HTMLElement>) => markMenu(event, { message: { markdown: text, element: event.currentTarget } })

function UserMessage({ event, pending = false }: { event: TranscriptEvent; pending?: boolean }) {
  return (
    <li className="flex justify-end">
      <div onContextMenu={markMessage(event.text)} title={pending ? 'Sending…' : undefined} className={`min-w-0 max-w-[75%] rounded-[20px] bg-accent/15 px-4 py-2.5 text-ink-100 transition-opacity ${pending ? 'opacity-70' : ''}`}>
        <UserMessageBody text={event.text} images={event.images} parts={event.parts} />
      </div>
    </li>
  )
}

function AssistantMessage({ event }: { event: TranscriptEvent }) {
  return (
    <li onContextMenu={markMessage(event.text)} className="max-w-[80%] text-ink-200">
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
  return (
    <li onContextMenu={markMessage(event.text)} className="text-center text-[12px] text-ink-400">
      {event.text}
    </li>
  )
}

function RelayedMessage({ event, onOpenChat }: { event: TranscriptEvent; onOpenChat: OpenChat | undefined }) {
  const origin = event.origin
  if (origin === undefined) return null
  const [open, setOpen] = useState(false)
  const target = relayedTarget(origin)
  const header = origin.kind === 'parent' ? `From parent · ${origin.label}` : `From ${origin.label}`
  return (
    <li onContextMenu={markMessage(event.text)} className="max-w-[85%] rounded-2xl border border-white/[0.06] bg-white/[0.03]">
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

/**
 * What marks a row still at work: the conversation's agent mark when the view names one (see
 * ConversationAgent), megabrain's orb otherwise; settled, the same mark held still and grey.
 */
function WorkMark({ size, working }: { size: number; working: boolean }) {
  const agent = useContext(ConversationAgent)
  if (agent === null) return <span aria-hidden="true" style={{ width: size, height: size }} className={`orb shrink-0 ${working ? '' : 'idle'}`} />
  return (
    <span aria-hidden="true" className="contents text-ink-400">
      <AgentIcon agent={agent} size={size} activity={working ? 'working' : 'idle'} />
    </span>
  )
}

/** Collapsed to its first line; while it streams the header reads Thinking… with a shimmer. */
function ThinkingMessage({ event, streaming = false }: { event: TranscriptEvent; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  const firstLine = event.text.split('\n')[0] ?? ''
  return (
    <li>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex max-w-[80%] items-center gap-2 text-left text-[13px] text-ink-400 hover:text-ink-300">
        <WorkMark size={10} working={streaming} />
        {streaming ? <span className="shimmer">Thinking…</span> : open ? 'Thinking' : firstLine}
      </button>
      {open && (
        <p onContextMenu={markMessage(event.text)} className="mt-1 max-w-[80%] whitespace-pre-wrap text-[13px] text-ink-400 italic">
          {event.text}
        </p>
      )}
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
  const onContextMenu = (event: ReactMouseEvent) =>
    markMenu(event, { tool: { command: toolCommand(input), input: input === undefined ? null : prettyInput(input), output: item.result?.text ?? null } })
  return (
    <li onContextMenu={onContextMenu} className="rounded-2xl border border-white/[0.06] bg-white/[0.03]">
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
            <WorkMark size={12} working />
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

/** Time from `since` to `until`, counting each second while `until` is null. */
function Elapsed({ since, until }: { since: string | null; until: string | null }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (until !== null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [until])
  const start = since === null ? Number.NaN : Date.parse(since)
  if (Number.isNaN(start)) return null
  return <>{formatElapsed((until === null ? now : Date.parse(until)) - start)}</>
}

const subagentOutcome: Record<Exclude<SubagentState, 'working'>, { label: string; tone: string }> = {
  completed: { label: 'Done', tone: 'text-ok' },
  failed: { label: 'Failed', tone: 'text-bad' },
  stopped: { label: 'Stopped', tone: 'text-ink-400' },
}

/**
 * A subagent where the call that started it was: its type and task, whether it still works, its tool count
 * and time, and in one line its latest step (its result once it ended). Open, it lists its own steps with the
 * rows the main chat uses, then its result.
 */
function SubagentBlock({ item, onOpenChat }: { item: SubagentItem; onOpenChat: OpenChat | undefined }) {
  const [open, setOpen] = useState(false)
  const summary = subagentSummary(item)
  const working = summary.state === 'working'
  const outcome = summary.state === 'working' ? null : subagentOutcome[summary.state]
  // Collapsed, the result shows as one plain line: its first, without bold and code marks.
  const line = working || summary.result === null || summary.result === '' ? summary.latest : (summary.result.split('\n')[0] ?? '').replace(/\*\*|`/g, '')
  const steps = open ? groupToolRuns(visibleSteps(item)) : []
  return (
    <li className="max-w-[85%] rounded-2xl border border-white/[0.06] bg-white/[0.03]">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full min-w-0 flex-col gap-0.5 px-3.5 py-2 text-left text-[13px]">
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="w-3 shrink-0 text-[10px] text-ink-400">{open ? '▾' : '▸'}</span>
          <WorkMark size={12} working={working} />
          <span className="shrink-0 font-semibold text-ink-200">{summary.type}</span>
          <span title={summary.description} className="min-w-0 flex-1 truncate text-ink-300">{summary.description}</span>
          <span className="shrink-0 text-[12px] text-ink-400 tabular-nums">
            {summary.tools} {summary.tools === 1 ? 'tool' : 'tools'}
            {summary.errors > 0 && <span className="font-semibold text-bad"> · {summary.errors} failed</span>}
            {' · '}
            <Elapsed since={summary.startedAt} until={summary.endedAt} />
          </span>
          {outcome !== null && <span className={`shrink-0 text-[12px] font-semibold ${outcome.tone}`}>{outcome.label}</span>}
        </span>
        {!open && line !== null && line !== '' && (
          <span title={line} className={`truncate pl-[2.6rem] text-[12.5px] text-ink-400 ${working ? 'font-mono' : ''}`}>{line}</span>
        )}
      </button>
      {open && (
        <div className="space-y-2 px-3.5 pb-3 pl-[2.6rem]">
          {steps.length > 0 && (
            <ol className="space-y-1.5">
              {steps.map((step) => (
                <Item key={step.type === 'message' ? step.event.id : step.id} item={step} onOpenChat={onOpenChat} />
              ))}
            </ol>
          )}
          {summary.result !== null && summary.result !== '' && (
            <div onContextMenu={markMessage(summary.result)} className="rounded-xl bg-white/[0.05] px-3 py-2 text-ink-200">
              <span className="mb-1 block text-[11px] font-semibold tracking-wide text-ink-400 uppercase">Result</span>
              <MarkdownText text={summary.result} />
            </div>
          )}
          {working && steps.length === 0 && <p className="text-[12.5px] text-ink-400">No steps yet.</p>}
        </div>
      )}
    </li>
  )
}

/** Subagents started side by side: how many still work, then each one's block. */
function SubagentGroup({ group, onOpenChat }: { group: Extract<DisplayItem, { type: 'subagent-group' }>; onOpenChat: OpenChat | undefined }) {
  const summary = subagentGroupSummary(group)
  return (
    <li className="max-w-[85%] space-y-1.5">
      <p className="flex items-center gap-2 px-1 text-[13px] text-ink-400">
        <WorkMark size={12} working={summary.working > 0} />
        <span className="font-semibold text-ink-300">{summary.total} subagents</span>
        <span>· {summary.working > 0 ? `${summary.working} working` : 'all finished'}</span>
        {summary.failed > 0 && <span className="font-semibold text-bad">· {summary.failed} failed</span>}
      </p>
      <ol className="space-y-1.5">
        {group.items.map((item) => (
          <SubagentBlock key={item.id} item={item} onOpenChat={onOpenChat} />
        ))}
      </ol>
    </li>
  )
}

// Memoised: a settled row keeps its item object across polls (see conversation-derive.ts).
const Item = memo(function Item({ item, onOpenChat }: { item: ConversationItem | NoticeDisplayItem; onOpenChat: OpenChat | undefined }) {
  if (item.type === 'notice') return <NoticeCard card={item} onOpenChat={onOpenChat} />
  if (item.type === 'tool-group') return <ToolGroup group={item} onOpenChat={onOpenChat} />
  if (item.type === 'subagent-group') return <SubagentGroup group={item} onOpenChat={onOpenChat} />
  if (item.type === 'subagent') return <SubagentBlock item={item} onOpenChat={onOpenChat} />
  if (item.type === 'tool') return <ToolItem item={item} />
  const event = item.event
  if (event.origin !== undefined) return <RelayedMessage event={event} onOpenChat={onOpenChat} />
  if (event.kind === 'user') return <UserMessage event={event} pending={item.pending} />
  if (event.kind === 'assistant') return <AssistantMessage event={event} />
  if (event.kind === 'thinking') return <ThinkingMessage event={event} streaming={item.streaming} />
  if (event.kind === 'approval') return <ApprovalMessage event={event} />
  return <SystemMessage event={event} />
})

// A streamed message keys by its messageId, so the row its chunks grew is the row the complete
// event fills, measured once and never remounted.
const itemKey = (item: NoticeDisplayItem | undefined) => {
  if (item === undefined) return ''
  if (item.type !== 'message') return item.id
  const messageId = item.event.messageId
  return messageId === undefined ? item.event.id : `${item.event.kind}:${messageId}`
}
const footerKey = 'footer'
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

  if (error !== null && missingLog !== undefined && isMissingLog(error)) return <div className="mx-8 my-5">{missingLog}</div>
  if (error !== null) return <div className="mx-8 my-5"><ErrorNote error={error} /></div>
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
  const settled = useMemo(() => {
    const next = deriveConversation(derived.current, events)
    derived.current = next
    collapsed.current = collapseNotices(next.display, collapsed.current)
    return collapsed.current
  }, [events])
  // The live rows change with every chunk; the settled ones above keep their identity.
  const items = useMemo<NoticeDisplayItem[]>(
    () => (live.length === 0 ? settled : settled.concat(live.map((row) => ({ type: 'message', event: row.event, streaming: row.streaming, pending: row.pending })))),
    [settled, live],
  )
  const hasFooter = footer !== null
  const count = items.length + (hasFooter ? 1 : 0)

  // Only the rows near the viewport are in the DOM; each is measured as it renders.
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => list.current,
    estimateSize: () => estimatedRowHeight,
    getItemKey: (index) => (index === items.length ? footerKey : itemKey(items[index])),
    gap: rowGap,
    paddingStart: listPadding,
    paddingEnd: listPadding,
    overscan: 6,
  })

  const scrollToLatest = () => {
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: 'end' })
  }

  useEffect(() => {
    if (pinned) scrollToLatest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, hasFooter, pinned])

  const onScroll = () => {
    const element = list.current
    if (element === null) return
    setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 40)
  }

  const contextMenu = useContextMenu()
  // What a menu action could not do (a clipboard or a save refused), shown for a few seconds.
  const [menuError, setMenuError] = useState<string | null>(null)
  useEffect(() => {
    if (menuError === null) return
    const timer = setTimeout(() => setMenuError(null), 4_000)
    return () => clearTimeout(timer)
  }, [menuError])

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const marked = markedParts(event)
    const element = event.target instanceof Element ? event.target : null
    const selected = window.getSelection()
    const selection = selected !== null && !selected.isCollapsed && list.current?.contains(selected.anchorNode) === true ? selected.toString() : ''
    const link = element?.closest<HTMLElement>('[data-link]')?.dataset.link ?? null
    const image = marked.image ?? (element instanceof HTMLImageElement ? { src: element.currentSrc || element.src, name: element.alt || 'Image', open: null } : null)
    // A tool's input and output are <pre> too; the tool's own actions cover them.
    const code = marked.tool === undefined ? (element?.closest('pre')?.textContent ?? null) : null
    const message = marked.message ?? null
    const tool = marked.tool ?? null
    const insert = channel?.current ?? null
    const failed = (caught: unknown) => setMenuError(caught instanceof Error ? caught.message : String(caught))
    const copy = (text: string) => void api.copyText(text).catch(failed)
    const run = (action: ChatAction) => {
      switch (action) {
        case 'open-link':
          if (link !== null) void api.openUrl(link).catch(failed)
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
    const target = { selection, message, code, tool, image: image === null ? null : { viewer: image.open !== null }, link, canCompose: insert !== null }
    contextMenu.open(event, toSections(chatMenu(target), run, icons))
  }

  if (count === 0) {
    return <div className="mx-8 my-5 text-[13px] text-ink-400">Nothing here yet.</div>
  }

  return (
    <PathLinksContext.Provider value={links}>
      {/* It fades in where the suggestions or the loading rows were, as the first message arrives. */}
      <div className="motion-fade relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={list}
          onScroll={onScroll}
          onContextMenu={onContextMenu}
          // A right click keeps the selection it lands on, where WebKit would select the word under it.
          onMouseDown={(event) => {
            if (event.button === 2) event.preventDefault()
          }}
          className="mx-8 min-h-0 flex-1 overflow-y-auto select-text"
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
        {menuError !== null && (
          <p role="status" className="absolute bottom-14 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-full border border-bad/30 bg-ink-900/95 px-4 py-1.5 text-[12.5px] text-bad shadow-lg">
            {menuError}
          </p>
        )}
        <ContextMenu menu={contextMenu.menu} onClose={contextMenu.close} />
      </div>
    </PathLinksContext.Provider>
  )
}
