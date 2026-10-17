import type { DisplayItem, ToolItem } from '@/chat/tool-groups'

// A run of tool calls reads as one sentence, one clause per kind of work in the order the run first
// did it: "Read 3 files, edited 2 files, and ran 4 commands". Each call reads as a short label taken
// from its main argument: the file name, the command's first line, the query. Names cover Claude's
// tools and Codex's (a live Codex chat names every command `command`).

export type ToolCategory = 'read' | 'edit' | 'write' | 'search' | 'web-search' | 'fetch' | 'command' | 'agent' | 'other'

const categories: Record<string, ToolCategory> = {
  read: 'read',
  read_file: 'read',
  ls: 'read',
  notebookread: 'read',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  apply_patch: 'edit',
  write: 'write',
  grep: 'search',
  glob: 'search',
  websearch: 'web-search',
  web_search: 'web-search',
  webfetch: 'fetch',
  bash: 'command',
  bashoutput: 'command',
  killshell: 'command',
  command: 'command',
  shell: 'command',
  local_shell: 'command',
  exec_command: 'command',
  task: 'agent',
  agent: 'agent',
}

/** The kind of work a tool does, by its name; MCP tools and unknown names are other tools. */
export function toolCategory(name: string): ToolCategory {
  return categories[name.toLowerCase()] ?? 'other'
}

// One call, then many; # stands for the count.
const clauses: Record<ToolCategory, [string, string]> = {
  read: ['Read 1 file', 'Read # files'],
  edit: ['Edited 1 file', 'Edited # files'],
  write: ['Wrote 1 file', 'Wrote # files'],
  search: ['Searched 1 time', 'Searched # times'],
  'web-search': ['Searched the web 1 time', 'Searched the web # times'],
  fetch: ['Fetched 1 page', 'Fetched # pages'],
  command: ['Ran 1 command', 'Ran # commands'],
  agent: ['Ran 1 agent', 'Ran # agents'],
  other: ['Used 1 tool', 'Used # tools'],
}

/** The sentence a run of calls reads as, from the names of its tools in the order they were called. */
export function toolRunSentence(names: string[]): string {
  const counts = new Map<ToolCategory, number>()
  for (const name of names) counts.set(toolCategory(name), (counts.get(toolCategory(name)) ?? 0) + 1)
  const parts = [...counts].map(([category, count], index) => {
    const [one, many] = clauses[category]
    const clause = count === 1 ? one : many.replace('#', String(count))
    // Only the first clause starts the sentence; the others continue it.
    return index === 0 ? clause : `${clause.charAt(0).toLowerCase()}${clause.slice(1)}`
  })
  if (parts.length <= 2) return parts.join(' and ')
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1) ?? ''}`
}

export interface ToolRunLine {
  sentence: string
  /** Running while any call has no result; failed once settled with a failed call; done otherwise. */
  state: 'running' | 'done' | 'failed'
  failed: number
}

export function toolRunLine(group: Extract<DisplayItem, { type: 'tool-group' }>): ToolRunLine {
  const tools = group.items.filter((item): item is ToolItem => item.type === 'tool')
  const failed = tools.filter((item) => item.status === 'error').length
  const running = tools.some((item) => item.status === 'running')
  return { sentence: toolRunSentence(tools.map((item) => item.call.tool?.name ?? 'tool')), state: running ? 'running' : failed > 0 ? 'failed' : 'done', failed }
}

const firstLine = (text: string) => text.trim().split('\n')[0]?.trim() ?? ''
const fileName = (path: string) => path.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? path

// A shell call given as argv through a login shell (Codex's ["bash", "-lc", "…"]) reads as the command it runs.
function commandText(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === 'string')) return null
  const [shell, flag, script] = value as string[]
  if (value.length === 3 && /(^|\/)(ba|z)?sh$/.test(shell ?? '') && /^-l?c$/.test(flag ?? '') && script !== undefined) return script
  return value.join(' ')
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

/** The short label of one call: what it worked on, without its raw input. */
export function toolLabel(name: string, input: string | undefined): string {
  if (input === undefined || input.trim() === '') return ''
  const patched = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(input)
  if (patched?.[1] !== undefined) return fileName(patched[1].trim())
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return firstLine(input)
  }
  if (typeof parsed === 'string') return firstLine(parsed)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
  const fields = parsed as Record<string, unknown>
  const category = toolCategory(name)
  // A search's path is the folder it scanned, not what it worked on.
  const path = text(fields.file_path) ?? text(fields.notebook_path) ?? (category === 'search' ? null : text(fields.path))
  if (path !== null) return fileName(path)
  const primary = text(fields.query) ?? text(fields.pattern) ?? commandText(fields.command) ?? commandText(fields.cmd) ?? text(fields.url)
  return firstLine(primary ?? Object.values(fields).map(text).find((value) => value !== null) ?? '')
}

/** A call's input or output cut to a readable length; `clipped` says whether anything was left out. */
export function clipText(value: string, maxLines = 14, maxChars = 1600): { shown: string; clipped: boolean } {
  const lines = value.split('\n')
  let shown = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : value
  if (shown.length > maxChars) shown = shown.slice(0, maxChars)
  return { shown, clipped: shown.length < value.length }
}
