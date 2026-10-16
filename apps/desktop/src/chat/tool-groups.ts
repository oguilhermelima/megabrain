import { toolSummary, type ConversationItem } from '@/chat/conversation-model'

// Consecutive tool calls between two messages read as one row: "Working: Bash …" while the last call
// runs, "Ran 6 tools: 5 Bash, 1 Read" once all have results. Thinking between two calls stays in the
// run; any other message ends it. A subagent ends a run too, and subagents side by side read as one group.

export type ToolItem = Extract<ConversationItem, { type: 'tool' }>
type MessageItem = Extract<ConversationItem, { type: 'message' }>
export type SubagentItem = Extract<ConversationItem, { type: 'subagent' }>

export type DisplayItem = MessageItem | SubagentItem | { type: 'tool-group'; id: string; items: (ToolItem | MessageItem)[] } | { type: 'subagent-group'; id: string; items: SubagentItem[] }

const isThinking = (item: ConversationItem): item is MessageItem => item.type === 'message' && item.event.kind === 'thinking' && item.event.origin === undefined

/** A message that ends any run before it: nothing after it can change how what came before groups. */
export const closesRun = (item: ConversationItem): item is MessageItem => item.type === 'message' && !isThinking(item)

export function groupToolRuns(items: ConversationItem[]): DisplayItem[] {
  const display: DisplayItem[] = []
  let run: (ToolItem | MessageItem)[] | null = null
  // Thinking seen after the run's last call; it joins the run only if another call follows.
  let held: MessageItem[] = []
  const close = () => {
    if (run !== null) {
      const first = run[0]
      display.push({ type: 'tool-group', id: `group-${first?.type === 'tool' ? first.id : ''}`, items: run })
    }
    run = null
    display.push(...held)
    held = []
  }
  for (const item of items) {
    if (item.type === 'tool') {
      if (run === null) run = [item]
      else {
        run.push(...held, item)
        held = []
      }
      continue
    }
    if (run !== null && isThinking(item)) {
      held.push(item)
      continue
    }
    close()
    if (item.type === 'subagent') {
      const last = display.at(-1)
      if (last?.type === 'subagent') display[display.length - 1] = { type: 'subagent-group', id: `agents-${last.id}`, items: [last, item] }
      else if (last?.type === 'subagent-group') display[display.length - 1] = { ...last, items: last.items.concat(item) }
      else display.push(item)
      continue
    }
    display.push(item)
  }
  close()
  return display
}

export interface ToolGroupSummary {
  state: 'running' | 'done'
  /** The last call: what is running now, or what ran last. */
  tool: string
  detail: string
  /** Calls before the last one. */
  earlier: number
  total: number
  /** Calls per tool, most used first, then in order of first use. */
  counts: { name: string; count: number }[]
  errors: number
}

export function toolName(item: ToolItem): string {
  return item.call.tool?.name ?? 'tool'
}

export function toolDetail(item: ToolItem): string {
  const input = item.call.tool?.input
  return input === undefined ? (item.call.text.split('\n')[0] ?? '') : toolSummary(toolName(item), input)
}

export function toolGroupSummary(group: Extract<DisplayItem, { type: 'tool-group' }>): ToolGroupSummary {
  const tools = group.items.filter((item): item is ToolItem => item.type === 'tool')
  const counted = new Map<string, number>()
  for (const item of tools) counted.set(toolName(item), (counted.get(toolName(item)) ?? 0) + 1)
  const order = [...counted.keys()]
  const counts = order.map((name) => ({ name, count: counted.get(name) ?? 0 })).sort((left, right) => right.count - left.count || order.indexOf(left.name) - order.indexOf(right.name))
  const last = tools.at(-1)
  return {
    state: last?.status === 'running' ? 'running' : 'done',
    tool: last === undefined ? 'tool' : toolName(last),
    detail: last === undefined ? '' : toolDetail(last),
    earlier: Math.max(tools.length - 1, 0),
    total: tools.length,
    counts,
    errors: tools.filter((item) => item.status === 'error').length,
  }
}
