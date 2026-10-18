import { useState } from 'react'
import type { OrchestrationNode } from '@/api/schema'
import { AgentIcon } from '@/components/agent-icons'
import { pageMx } from '@/lib/page'
import { elapsed } from '@/native-chat/orchestration/orchestration-layout'
import type { ClosedGroup } from '@/native-chat/orchestration/orchestration-visible'

// Whether the closed lanes are shown, kept in this viewer's storage for every orchestration.
const shownKey = 'megabrain.orchestration.closed-shown'

function readShown(): boolean {
  try {
    return localStorage.getItem(shownKey) === 'true'
  } catch {
    return false
  }
}

function writeShown(shown: boolean): void {
  try {
    localStorage.setItem(shownKey, String(shown))
  } catch {
    // Only the choice is lost; the toggle still works for this run.
  }
}

/**
 * The closed lanes the tree leaves out, behind a "Show N closed" toggle: grouped by the lane or
 * coordinator that started them, each group folded until opened. A row selects its lane.
 */
export function OrchestrationClosed({ groups, count, selected, now, onSelect }: { groups: readonly ClosedGroup[]; count: number; selected: string | null; now: number; onSelect: (nodeId: string) => void }) {
  const [shown, setShown] = useState(readShown)
  if (count === 0) return null
  const toggle = () => {
    setShown(!shown)
    writeShown(!shown)
  }
  return (
    <section aria-label="Closed lanes" className={`flex flex-col border-t border-white/[0.07] ${shown ? 'max-h-[40%] min-h-0' : ''}`}>
      <button type="button" aria-expanded={shown} onClick={toggle} className={`${pageMx} self-start py-2 text-chat-small text-ink-300 hover:text-ink-100`}>
        {shown ? `Hide ${count} closed` : `Show ${count} closed`}
      </button>
      {shown && (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3">
          {groups.map((group) => (
            <details key={group.parent?.id ?? ''} className="group/closed">
              <summary className="flex cursor-default list-none items-baseline gap-2 rounded-lg px-1 py-0.5 text-chat-ui text-ink-200 hover:bg-row-hover [&::-webkit-details-marker]:hidden">
                <span className="text-ink-500 transition-transform group-open/closed:rotate-90" aria-hidden="true">
                  ›
                </span>
                <span className="min-w-0 truncate">{group.parent?.label ?? 'Unknown parent'}</span>
                <span className="shrink-0 text-chat-label text-ink-400">{group.nodes.length} closed</span>
              </summary>
              <ul className="mb-1 ml-5">
                {group.nodes.map((node) => (
                  <ClosedRow key={node.id} node={node} selected={selected === node.id} now={now} onSelect={onSelect} />
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </section>
  )
}

function ClosedRow({ node, selected, now, onSelect }: { node: OrchestrationNode; selected: boolean; now: number; onSelect: (nodeId: string) => void }) {
  return (
    <li>
      <button type="button" onClick={() => onSelect(node.id)} className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 text-left text-chat-small hover:bg-row-hover ${selected ? 'bg-white/[0.06]' : ''}`}>
        <AgentIcon agent={node.agent} activity="idle" />
        <span className="min-w-0 flex-1 truncate text-ink-200" title={node.label}>
          {node.label}
        </span>
        <span className="shrink-0 font-mono text-chat-label text-ink-400 tabular-nums">{elapsed(node.startedAt, node.endedAt, now)}</span>
      </button>
    </li>
  )
}
