import type { ConversationItem } from '@/chat/conversation-model'
import { toolDetail, toolName, type DisplayItem, type SubagentItem, type ToolItem } from '@/chat/tool-groups'

// What a subagent's block shows: who it is and what it was asked, whether it still works, how many
// tools it ran and the latest thing it did, and the result it ended with.

export type { SubagentItem }
export type SubagentState = 'working' | 'completed' | 'failed' | 'stopped'

export interface SubagentSummary {
  type: string
  description: string
  state: SubagentState
  tools: number
  errors: number
  /** The latest step in one line: a tool with what it did, or the first line of a message. */
  latest: string | null
  /** What it ended with; null while it works. */
  result: string | null
  startedAt: string | null
  endedAt: string | null
}

const firstLine = (text: string) => text.split('\n')[0] ?? ''

export function subagentState(item: SubagentItem): SubagentState {
  return item.end === null ? 'working' : (item.end.subagent?.status ?? 'completed')
}

/** Its steps, without a final message the result already repeats. */
export function visibleSteps(item: SubagentItem): ConversationItem[] {
  const last = item.steps.at(-1)
  const repeated = item.end !== null && last?.type === 'message' && last.event.kind === 'assistant' && last.event.text.trim() === item.end.text.trim()
  return repeated ? item.steps.slice(0, -1) : item.steps
}

function describeStep(step: ConversationItem | undefined): string | null {
  if (step === undefined || step.type === 'subagent') return null
  if (step.type === 'tool') return `${toolName(step)} ${toolDetail(step)}`.trim()
  return firstLine(step.event.text)
}

export function subagentSummary(item: SubagentItem): SubagentSummary {
  const tools = item.steps.filter((step): step is ToolItem => step.type === 'tool')
  return {
    type: item.call.subagent?.type ?? 'Subagent',
    description: item.call.subagent?.description ?? '',
    state: subagentState(item),
    tools: tools.length,
    errors: tools.filter((step) => step.status === 'error').length,
    latest: describeStep(visibleSteps(item).at(-1)),
    result: item.end?.text ?? null,
    startedAt: item.call.at,
    endedAt: item.end?.at ?? null,
  }
}

export function subagentGroupSummary(group: Extract<DisplayItem, { type: 'subagent-group' }>): { total: number; working: number; failed: number } {
  const states = group.items.map(subagentState)
  return { total: states.length, working: states.filter((state) => state === 'working').length, failed: states.filter((state) => state === 'failed').length }
}
