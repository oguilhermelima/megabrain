import type { Ref } from 'react'
import { AgentIcon } from '@/components/agent-icons'
import type { AgentActivity } from '@/components/agent-activity'
import { elapsed, type Relation } from '@/native-chat/orchestration/orchestration-layout'
import type { OrchestrationNode, OrchestrationState } from '@/api/schema'

const chipLook: Record<OrchestrationState, string> = {
  starting: 'text-accent bg-accent/10',
  working: 'text-accent bg-accent/10',
  asking: 'text-warn bg-warn/15',
  idle: 'text-ink-300 bg-white/[0.06]',
  done: 'text-ok bg-ok/10',
  closed: 'text-ink-400 bg-white/[0.05]',
  failed: 'text-bad-soft bg-bad/10',
  stalled: 'text-warn bg-warn/10',
}

const activityOf = (state: OrchestrationState): AgentActivity => (state === 'working' || state === 'starting' ? 'working' : state === 'asking' ? 'waiting' : 'idle')

/** A node's state as a chip; a running state carries a live dot that holds still under reduced motion. */
export function StateChip({ state }: { state: OrchestrationState }) {
  const live = state === 'working' || state === 'starting' || state === 'asking'
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-chat-label font-semibold ${chipLook[state]}`}>
      {live && <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden="true" />}
      {state}
    </span>
  )
}

/** One chat in the diagram: who runs it, its state, time, context, last word, branch and any finding. */
export function OrchestrationCard({
  node,
  relation,
  selected,
  now,
  cardRef,
  onClick,
  onDoubleClick,
}: {
  node: OrchestrationNode
  relation: Relation
  selected: boolean
  now: number
  cardRef: Ref<HTMLButtonElement>
  onClick: () => void
  onDoubleClick: () => void
}) {
  const focus = relation === 'focus'
  // Opaque, so the connectors that run behind a row of cards to the next one never show through.
  const frame = node.unanswered ? 'orchestration-ask border-warn/70 bg-ink-850' : focus ? 'border-accent/70 bg-ink-850' : selected ? 'border-white/30 bg-ink-800' : 'border-white/[0.08] bg-ink-850 hover:border-white/20'
  const dimmed = relation === 'other' && !node.unanswered ? 'opacity-80' : ''
  return (
    <button
      ref={cardRef}
      type="button"
      aria-pressed={selected}
      aria-label={`${node.label}, ${node.state}${node.unanswered ? ', waiting for an answer' : ''}${focus ? ', this chat' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`relative flex w-full max-w-[248px] flex-col gap-1.5 rounded-[18px] border px-3.5 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent ${frame} ${selected ? 'ring-2 ring-white/25' : ''} ${dimmed}`}
    >
      {focus && <span className="absolute -top-2.5 left-3 rounded-full bg-accent px-2 text-chat-label font-semibold text-accent-ink">This chat</span>}
      <span className="flex min-w-0 items-center gap-2">
        <AgentIcon agent={node.agent} activity={activityOf(node.state)} />
        <span className="min-w-0 flex-1 truncate text-chat-ui font-semibold text-ink-100" title={node.label}>
          {node.label}
        </span>
        <StateChip state={node.state} />
      </span>
      <span className="flex min-w-0 items-center gap-2 font-mono text-chat-label text-ink-400">
        <span className="min-w-0 flex-1 truncate">{[node.agent, node.model, node.effort].filter((part) => part !== null).join(' · ')}</span>
        <span className="shrink-0 tabular-nums">{elapsed(node.startedAt, node.endedAt, now)}</span>
      </span>
      {node.contextPercent !== null && (
        <span className="flex items-center gap-2" title={`Context ${Math.round(node.contextPercent)}% used`}>
          <span className="block h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
            <span className={`block h-full rounded-full ${node.contextPercent >= 85 ? 'bg-warn' : 'bg-accent/80'}`} style={{ width: `${Math.min(100, Math.max(0, node.contextPercent))}%` }} />
          </span>
          <span className="font-mono text-chat-label text-ink-400 tabular-nums">{Math.round(node.contextPercent)}%</span>
        </span>
      )}
      {node.unanswered && <span className="text-chat-small font-semibold text-warn">Waiting for an answer</span>}
      {node.last !== null && (
        <span className="line-clamp-2 text-chat-small text-ink-300" title={node.last.text}>
          <span className="text-ink-400">{node.last.type}: </span>
          {node.last.text}
        </span>
      )}
      {node.branch !== null && (
        <span className="flex min-w-0 items-center gap-2 font-mono text-chat-label text-ink-400">
          <span className="min-w-0 flex-1 truncate" title={node.branch}>
            {node.branch}
          </span>
          {node.commits !== null && <span className="shrink-0">{node.commits === 1 ? '1 commit' : `${node.commits} commits`}</span>}
        </span>
      )}
      {node.finding !== null && <span className="block text-chat-small text-warn">{node.finding}</span>}
    </button>
  )
}
