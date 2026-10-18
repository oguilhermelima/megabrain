import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { logOrder } from '@/native-chat/orchestration/orchestration-layout'
import { readLogFolded, writeLogFolded } from '@/native-chat/orchestration/orchestration-log-fold'
import type { OrchestrationEvent, OrchestrationNode } from '@/api/schema'

const time = (at: string): string => {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const typeLook: Record<string, string> = { ask: 'text-warn', done: 'text-ok', stalled: 'text-warn', reply: 'text-accent', change: 'text-accent' }

// Within this many pixels of the end counts as at the end, so a fractional scroll still follows.
const END_SLACK = 12

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? '' : 'rotate-180'}`}>
    <path d="m4 6 4 4 4-4" />
  </svg>
)

/**
 * The orchestration's messages, newest last, as a session log. Folded (the default, remembered per
 * viewer) it is one bar with the latest message and the count; open, it keeps to the newest line as
 * they arrive, unless the person scrolled up to read; scrolling back to the end follows again.
 */
export function OrchestrationLog({ events, nodes, onSelect }: { events: readonly OrchestrationEvent[]; nodes: readonly OrchestrationNode[]; onSelect: (nodeId: string) => void }) {
  const ordered = useMemo(() => logOrder(events), [events])
  const labels = useMemo(() => new Map(nodes.map((node) => [node.id, node.label])), [nodes])
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [folded, setFolded] = useState(() => readLogFolded(localStorage))
  const fold = (next: boolean) => {
    writeLogFolded(localStorage, next)
    following.current = true
    setFolded(next)
  }

  useLayoutEffect(() => {
    const element = scroller.current
    if (element !== null && following.current) element.scrollTop = element.scrollHeight
  }, [ordered, folded])

  const latest = ordered.at(-1)
  const count = ordered.length === 1 ? '1 message' : `${ordered.length} messages`
  if (folded)
    return (
      <section aria-label="Session log" className="border-t border-white/[0.07] bg-ink-900">
        <button type="button" aria-expanded={false} onClick={() => fold(false)} className="flex h-9 w-full min-w-0 items-center gap-3 px-5 text-left font-mono text-chat-label hover:bg-white/[0.03]">
          <span className="shrink-0 font-sans font-semibold tracking-wide text-ink-400 uppercase">Session log</span>
          {latest === undefined ? (
            <span className="min-w-0 flex-1 text-ink-500">No messages yet.</span>
          ) : (
            <>
              <span className="shrink-0 text-ink-500 tabular-nums">{time(latest.at)}</span>
              <span className="max-w-[24%] shrink-0 truncate text-ink-200">{labels.get(latest.node) ?? latest.node}</span>
              <span className={`shrink-0 ${typeLook[latest.type] ?? 'text-ink-300'}`}>{latest.type}</span>
              <span className="min-w-0 flex-1 truncate text-ink-300">{latest.text}</span>
            </>
          )}
          <span className="shrink-0 text-ink-500 tabular-nums">{count}</span>
          <Chevron open={false} />
        </button>
      </section>
    )
  return (
    <section aria-label="Session log" className="flex max-h-[34%] min-h-[112px] flex-col border-t border-white/[0.07] bg-ink-900">
      <button type="button" aria-expanded={true} onClick={() => fold(true)} className="flex w-full items-center gap-3 px-5 pt-2.5 pb-1.5 text-left hover:text-ink-200">
        <h3 className="flex-1 text-chat-label font-semibold tracking-wide text-ink-400 uppercase">Session log</h3>
        <span className="font-mono text-chat-label text-ink-500 tabular-nums">{count}</span>
        <span className="text-ink-400">
          <Chevron open={true} />
        </span>
      </button>
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= END_SLACK
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 font-mono text-chat-label leading-[1.7] select-text"
      >
        {ordered.length === 0 && <p className="text-ink-400">No messages yet.</p>}
        {ordered.map((event, index) => (
          <div key={`${event.at}-${index}`} className="flex min-w-0 gap-3">
            <span className="shrink-0 text-ink-500 tabular-nums">{time(event.at)}</span>
            <button type="button" onClick={() => onSelect(event.node)} className="max-w-[28%] shrink-0 truncate text-ink-200 hover:underline" title={labels.get(event.node) ?? event.node}>
              {labels.get(event.node) ?? event.node}
            </button>
            <span className="shrink-0 text-ink-500" aria-label={event.direction === 'to-parent' ? 'to its coordinator' : 'from its coordinator'}>
              {event.direction === 'to-parent' ? '↑' : '↓'}
            </span>
            <span className={`shrink-0 ${typeLook[event.type] ?? 'text-ink-300'}`}>{event.type}</span>
            <span className="min-w-0 flex-1 truncate text-ink-300" title={event.text}>
              {event.text}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
