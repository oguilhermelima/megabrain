import type { ToolStatus } from '@/chat/conversation-model'

// Which glyph a tool row shows. The agent's mark stays with the agent's own state (thinking, writing,
// its messages); a tool call shows what kind of tool it is, in the muted text colour, pulsing while
// it runs and in the error colour once it failed. Names cover Claude's tools and Codex's.

export type ToolKind = 'terminal' | 'file' | 'edit' | 'search' | 'web' | 'subagent' | 'mcp' | 'tool'

const kinds: Record<string, ToolKind> = {
  bash: 'terminal',
  bashoutput: 'terminal',
  killshell: 'terminal',
  command: 'terminal',
  shell: 'terminal',
  local_shell: 'terminal',
  exec_command: 'terminal',
  read: 'file',
  read_file: 'file',
  ls: 'file',
  notebookread: 'file',
  edit: 'edit',
  multiedit: 'edit',
  write: 'edit',
  notebookedit: 'edit',
  apply_patch: 'edit',
  grep: 'search',
  glob: 'search',
  toolsearch: 'search',
  webfetch: 'web',
  websearch: 'web',
  web_search: 'web',
  task: 'subagent',
  agent: 'subagent',
}

/** The kind of a tool by its name; an MCP server's tools (mcp__server__tool) are all one kind. */
export function toolKind(name: string): ToolKind {
  const key = name.toLowerCase()
  if (key.startsWith('mcp__')) return 'mcp'
  return kinds[key] ?? 'tool'
}

export interface ToolIconLook {
  kind: ToolKind
  tone: 'muted' | 'error'
  pulse: boolean
}

export function toolIconLook(name: string, status: ToolStatus): ToolIconLook {
  return { kind: toolKind(name), tone: status === 'error' ? 'error' : 'muted', pulse: status === 'running' }
}
