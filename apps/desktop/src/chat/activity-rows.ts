import { toolDetail, toolName, type DisplayItem, type ToolItem } from '@/chat/tool-groups'
import { toolCategory, type ToolCategory } from '@/chat/tool-sentence'

// A run of tool calls reads as one row per consecutive stretch of the same kind of work: "Read 3
// files", then "Ran 2 commands", each with its latest call beside it. Other tools group by their own
// name. Thinking between two calls stays in the row it falls in, so the row's open list keeps it.

type RunMember = Extract<DisplayItem, { type: 'tool-group' }>['items'][number]

export interface ActivityRow {
  id: string
  category: ToolCategory
  /** The tool's name; what an other row names. */
  tool: string
  /** The calls and the thinking between them, in order. */
  items: RunMember[]
  calls: ToolItem[]
  /** Running while its last call has no result; failed once settled with a failed call. */
  state: 'running' | 'done' | 'failed'
  failed: number
  /** The latest call's detail: its path, command or query. */
  detail: string
}

const rowKey = (item: ToolItem) => {
  const category = toolCategory(toolName(item))
  return category === 'other' ? `other:${toolName(item)}` : category
}

function settle(items: RunMember[]): ActivityRow {
  const calls = items.filter((item): item is ToolItem => item.type === 'tool')
  const first = calls[0]
  const last = calls.at(-1)
  const failed = calls.filter((call) => call.status === 'error').length
  const tool = first === undefined ? 'tool' : toolName(first)
  return {
    id: `activity-${first?.id ?? ''}`,
    category: toolCategory(tool),
    tool,
    items,
    calls,
    state: last?.status === 'running' ? 'running' : failed > 0 ? 'failed' : 'done',
    failed,
    detail: last === undefined ? '' : toolDetail(last),
  }
}

export function activityRows(items: RunMember[]): ActivityRow[] {
  const rows: ActivityRow[] = []
  let current: RunMember[] = []
  let key: string | null = null
  for (const item of items) {
    if (item.type === 'tool') {
      const next = rowKey(item)
      if (key !== null && next !== key) {
        rows.push(settle(current))
        current = []
      }
      key = next
    }
    current.push(item)
  }
  if (current.length > 0) rows.push(settle(current))
  return rows
}

// Running, then done; # stands for the count.
const verbs: Record<Exclude<ToolCategory, 'other'>, { running: [string, string]; done: [string, string] }> = {
  read: { running: ['Reading 1 file', 'Reading # files'], done: ['Read 1 file', 'Read # files'] },
  edit: { running: ['Editing 1 file', 'Editing # files'], done: ['Edited 1 file', 'Edited # files'] },
  write: { running: ['Writing 1 file', 'Writing # files'], done: ['Wrote 1 file', 'Wrote # files'] },
  search: { running: ['Searching 1 time', 'Searching # times'], done: ['Searched 1 time', 'Searched # times'] },
  'web-search': { running: ['Searching the web 1 time', 'Searching the web # times'], done: ['Searched the web 1 time', 'Searched the web # times'] },
  fetch: { running: ['Fetching 1 page', 'Fetching # pages'], done: ['Fetched 1 page', 'Fetched # pages'] },
  command: { running: ['Running 1 command', 'Running # commands'], done: ['Ran 1 command', 'Ran # commands'] },
  agent: { running: ['Running 1 agent', 'Running # agents'], done: ['Ran 1 agent', 'Ran # agents'] },
}

/** The row's verb and count: present tense while it runs, past once it ended. */
export function activityLabel(row: Pick<ActivityRow, 'category' | 'tool' | 'calls' | 'state'>): string {
  const count = row.calls.length
  const running = row.state === 'running'
  if (row.category === 'other') return `${running ? 'Using' : 'Used'} ${row.tool} ${count} ${count === 1 ? 'time' : 'times'}`
  const [one, many] = verbs[row.category][running ? 'running' : 'done']
  return count === 1 ? one : many.replace('#', String(count))
}
