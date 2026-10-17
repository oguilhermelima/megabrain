import { api } from '@/api'
import type { KnowledgeTranscript } from '@/api/schema'
import { relativeAge } from '@/advanced/projects-model'
import { MarkdownText } from '@/chat/markdown'
import { AgentIcon } from '@/components/agent-icons'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { column, useRead } from '@/advanced/knowledge-parts'

// A chat's distilled transcript, read-only inside the Knowledge page: the person's messages as the
// chat shows them, the agent's text in full, and each tool call as one compact line, runs of them
// kept together. It never opens or drives the live chat.

type Event = KnowledgeTranscript['events'][number]

/** Consecutive tool lines as one block; every other event on its own. */
function runs(events: readonly Event[]): Event[][] {
  const out: Event[][] = []
  for (const event of events) {
    const last = out.at(-1)
    if (event.role === 'tool' && last?.[0]?.role === 'tool') last.push(event)
    else out.push([event])
  }
  return out
}

function ToolLines({ events }: { events: Event[] }) {
  return (
    <li className="space-y-0.5 rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      {events.map((event) => (
        <p key={event.cursor} title={event.text} className="flex min-w-0 items-center gap-2 font-mono text-[11.5px] text-ink-400">
          <span aria-hidden="true" className="shrink-0 text-ink-500">
            ›
          </span>
          <span className="min-w-0 truncate">{event.text}</span>
        </p>
      ))}
    </li>
  )
}

export function ChatTranscript({ chatId, backLabel, onBack }: { chatId: string; backLabel: string; onBack: () => void }) {
  const load = useRead(chatId, api.knowledgeTranscript)
  const back = (
    <button type="button" onClick={onBack} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full pr-3 pl-2 text-[12.5px] font-medium text-ink-300 transition-colors hover:bg-row-hover hover:text-ink-100">
      <span aria-hidden="true">←</span>
      <span className="truncate">{backLabel}</span>
    </button>
  )
  if (load.state !== 'ready') {
    return (
      <div className={`${column} space-y-6`}>
        {back}
        {load.state === 'loading' ? <TextSkeleton lines={8} /> : <ErrorNote error={load.error} />}
      </div>
    )
  }
  const { chat, events } = load.value
  return (
    <div className={`${column} space-y-8`}>
      <header className="space-y-4">
        {back}
        <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.02em] text-ink-100">{chat.title}</h1>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-ink-400">
          <AgentIcon agent={chat.agent} size={13} className="shrink-0 text-ink-300" />
          <span>{chat.model}</span>
          <span className="text-ink-500">·</span>
          <span className="font-mono text-[11.5px]">{chat.branch}</span>
          <span className="text-ink-500">·</span>
          <span title={new Date(chat.startedAt).toLocaleString()}>Started {relativeAge(chat.startedAt, Date.now())} ago</span>
          <span className="text-ink-500">·</span>
          <span>Read only</span>
        </p>
        <p className="rounded-[16px] border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-[13.5px] leading-relaxed text-ink-300">{chat.summary}</p>
      </header>
      {events.length === 0 ? (
        <p className="text-[13.5px] text-ink-400">This chat’s conversation has not been kept yet.</p>
      ) : (
        <ol className="space-y-4" aria-label="Transcript">
          {runs(events).map((run) => {
            const first = run[0] as Event
            if (first.role === 'tool') return <ToolLines key={first.cursor} events={run} />
            if (first.role === 'person') {
              return (
                <li key={first.cursor} className="flex justify-end">
                  <div className="max-w-[80%] min-w-0 rounded-[20px] bg-accent/15 px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-ink-100">{first.text}</div>
                </li>
              )
            }
            return (
              <li key={first.cursor} className="text-ink-200">
                <MarkdownText text={first.text} className="text-[14px] leading-relaxed" />
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
