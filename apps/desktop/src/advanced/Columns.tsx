import { useState } from 'react'
import type { Dispatch, Worktree } from '@/api/schema'
import { buildColumns, type ChildNode, type ColumnModel } from '@/advanced/columns-model'
import { chatState } from '@/advanced/model'
import { AgentBadge, StateChip, StateDot, chatName } from '@/advanced/parts'
import { Conversation } from '@/chat/Conversation'

function columnSummary(column: ColumnModel): { working: number; needsYou: number } {
  let working = 0
  let needsYou = 0
  const walk = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      const state = chatState(node.chat)
      if (state === 'working') working += 1
      if (state === 'needs-you') needsYou += 1
      walk(node.children)
    }
  }
  walk(column.children)
  return { working, needsYou }
}

function ChildCard({ node, onSelect }: { node: ChildNode; onSelect: (dispatchId: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const state = chatState(node.chat)
  const finding = node.chat.supervision.finding
  return (
    <div className="rounded-[18px] border border-white/[0.06] bg-white/[0.03]">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <AgentBadge agent={node.chat.agent ?? 'unknown'} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink-100">{chatName(node.chat)}</span>
        <StateDot state={state} />
      </button>
      {finding !== null && <p className="px-4 pb-3 text-[12.5px] text-warn">{finding.errorText ?? finding.cause}</p>}
      {expanded && (
        <div className="border-t border-white/[0.06] px-4 pt-3 pb-4">
          <div className="max-h-[260px] overflow-y-auto rounded-[14px] bg-black/20">
            <Conversation target={{ dispatchId: node.chat.dispatchId }} live={state !== 'ended'} />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <button type="button" onClick={() => onSelect(node.chat.dispatchId)} className="rounded-full bg-white/[0.08] px-4 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
              Open
            </button>
            {node.children.length > 0 && <span className="text-[12px] text-ink-500">{node.children.length} nested</span>}
          </div>
          {node.children.length > 0 && (
            <div className="mt-3 space-y-2 border-l border-white/[0.06] pl-3">
              {node.children.map((child) => (
                <ChildCard key={child.chat.dispatchId} node={child} onSelect={onSelect} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Column({ column, onSelect }: { column: ColumnModel; onSelect: (dispatchId: string) => void }) {
  const summary = columnSummary(column)
  return (
    <div className="flex h-full w-[440px] shrink-0 flex-col border-r border-white/[0.06]">
      <div className="flex items-center justify-between px-5 py-4">
        <span className="text-[15px] font-semibold text-ink-100">{column.label}</span>
        <span className="flex items-center gap-2">
          {summary.needsYou > 0 && <StateChip state="needs-you" />}
          {summary.working > 0 && <span className="text-[12.5px] text-ink-400">{summary.working} working</span>}
        </span>
      </div>
      <div className="max-h-[45%] shrink-0 space-y-2 overflow-y-auto px-4 pb-3">
        {column.children.map((node) => (
          <ChildCard key={node.chat.dispatchId} node={node} onSelect={onSelect} />
        ))}
      </div>
      <div className="min-h-0 flex-1 border-t border-white/[0.06]">
        <Conversation target={{ sessionId: column.parentSessionId }} live />
      </div>
      {column.endedCount > 0 && <div className="px-5 py-2 text-[12px] text-ink-500">{column.endedCount} ended</div>}
    </div>
  )
}

// One column per parent session, its children collapsed inside it, the parent's own conversation
// filling the rest. Receives every open chat and the worktrees, and reports the chat the person opens.
export function Columns({ chats, onSelect }: { chats: Dispatch[]; worktrees: Worktree[]; selected: string | null; onSelect: (dispatchId: string) => void }) {
  const columns = buildColumns(chats)
  if (columns.length === 0) return <div className="flex h-full items-center justify-center text-[14px] text-ink-500">No open chats.</div>
  return (
    <div className="flex h-full overflow-x-auto">
      {columns.map((column) => (
        <Column key={column.parentSessionId} column={column} onSelect={onSelect} />
      ))}
    </div>
  )
}
