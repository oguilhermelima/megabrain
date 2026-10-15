import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { Transcript, TranscriptEvent } from '@/api/schema'
import { ErrorNote, Spinner } from '@/components/ui'
import { buildConversationItems, formatText, mergeEvents, type ConversationItem, type ToolStatus } from '@/chat/conversation-model'

function FormattedText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <p className={`whitespace-pre-wrap ${className}`}>
      {formatText(text).map((segment, index) =>
        segment.type === 'code' ? (
          <pre key={index} className="my-1.5 overflow-x-auto rounded-xl bg-white/[0.06] px-3 py-2 font-mono text-[12.5px] text-ink-100">
            {segment.value}
          </pre>
        ) : segment.type === 'inline-code' ? (
          <code key={index} className="rounded-md bg-white/[0.08] px-1 py-0.5 font-mono text-[13px] text-ink-100">
            {segment.value}
          </code>
        ) : (
          <span key={index}>{segment.value}</span>
        ),
      )}
    </p>
  )
}

function UserMessage({ event }: { event: TranscriptEvent }) {
  return (
    <li className="flex justify-end">
      <div className="max-w-[75%] rounded-[20px] bg-accent/15 px-4 py-2.5 text-[14px] text-ink-100">
        <FormattedText text={event.text} />
      </div>
    </li>
  )
}

function AssistantMessage({ event }: { event: TranscriptEvent }) {
  return (
    <li className="max-w-[80%] text-[14px] text-ink-200">
      <FormattedText text={event.text} />
    </li>
  )
}

function SystemMessage({ event }: { event: TranscriptEvent }) {
  return <li className="text-center text-[12px] text-ink-500">{event.text}</li>
}

function ThinkingMessage({ event }: { event: TranscriptEvent }) {
  const [open, setOpen] = useState(false)
  const firstLine = event.text.split('\n')[0] ?? ''
  return (
    <li>
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex max-w-[80%] items-center gap-2 text-left text-[13px] text-ink-500 hover:text-ink-400">
        <span className="orb idle size-2.5 shrink-0" />
        {open ? 'Thinking' : firstLine}
      </button>
      {open && <p className="mt-1 max-w-[80%] whitespace-pre-wrap text-[13px] text-ink-500 italic">{event.text}</p>}
    </li>
  )
}

const toolDot: Record<ToolStatus, string> = { ok: 'bg-ok', error: 'bg-bad', running: 'bg-accent' }

function ToolItem({ item }: { item: Extract<ConversationItem, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const inputLine = item.call.tool?.input?.split('\n')[0] ?? item.call.text.split('\n')[0] ?? ''
  return (
    <li className="max-w-[85%] rounded-2xl border border-white/[0.06] bg-white/[0.03]">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[13px]">
        <span className={`size-1.5 shrink-0 rounded-full ${toolDot[item.status]} ${item.status === 'running' ? 'animate-pulse' : ''}`} />
        <span className="shrink-0 font-semibold text-ink-300">{item.call.tool?.name ?? 'tool'}</span>
        <span className="truncate text-ink-500">{inputLine}</span>
      </button>
      {open && (
        <div className="space-y-2 px-3.5 pb-3">
          {item.call.tool?.input !== undefined && (
            <pre className="max-h-48 overflow-auto rounded-xl bg-white/[0.05] px-3 py-2 font-mono text-[12px] text-ink-200">{item.call.tool.input}</pre>
          )}
          {item.result !== null && (
            <pre className="max-h-48 overflow-auto rounded-xl bg-white/[0.05] px-3 py-2 font-mono text-[12px] text-ink-200">{item.result.text}</pre>
          )}
        </div>
      )}
    </li>
  )
}

function Item({ item }: { item: ConversationItem }) {
  if (item.type === 'tool') return <ToolItem item={item} />
  const event = item.event
  if (event.kind === 'user') return <UserMessage event={event} />
  if (event.kind === 'assistant') return <AssistantMessage event={event} />
  if (event.kind === 'thinking') return <ThinkingMessage event={event} />
  return <SystemMessage event={event} />
}

export function Conversation({ target, live }: { target: { dispatchId: string } | { sessionId: string }; live: boolean }) {
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [pinned, setPinned] = useState(true)
  const key = 'dispatchId' in target ? target.dispatchId : target.sessionId
  const list = useRef<HTMLOListElement>(null)
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
        setTranscript((previous) => (previous === null ? next : { ...next, events: mergeEvents(previous.events, next.events) }))
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

  useEffect(() => {
    const element = list.current
    if (element !== null && pinned) element.scrollTop = element.scrollHeight
  }, [transcript, pinned])

  const onScroll = () => {
    const element = list.current
    if (element === null) return
    setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 40)
  }

  if (error !== null) return <div className="mx-8 my-5"><ErrorNote error={error} /></div>
  if (transcript === null) {
    return (
      <div className="mx-8 my-5 flex items-center gap-2 text-[13px] text-ink-500">
        <Spinner />
        Reading…
      </div>
    )
  }
  if (transcript.events.length === 0) {
    return <div className="mx-8 my-5 text-[13px] text-ink-500">Nothing here yet.</div>
  }

  const items = buildConversationItems(transcript.events)
  return (
    <div className="relative min-h-0 flex-1">
      <ol ref={list} onScroll={onScroll} className="mx-8 my-5 h-full space-y-3 overflow-y-auto pb-2 select-text">
        {items.map((item) => (
          <Item key={item.type === 'tool' ? item.id : item.event.id} item={item} />
        ))}
      </ol>
      {!pinned && (
        <button
          type="button"
          onClick={() => {
            setPinned(true)
            const element = list.current
            if (element !== null) element.scrollTop = element.scrollHeight
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-ink-900/90 px-4 py-1.5 text-[12.5px] font-semibold text-ink-100 shadow-lg"
        >
          Jump to latest
        </button>
      )}
    </div>
  )
}
