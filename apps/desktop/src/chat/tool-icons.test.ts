import { describe, expect, test } from 'bun:test'
import { toolIconLook, toolKind } from '@/chat/tool-icons'

describe('toolKind', () => {
  test('names each kind of tool', () => {
    expect(toolKind('Bash')).toBe('terminal')
    expect(toolKind('Read')).toBe('file')
    expect(toolKind('Edit')).toBe('edit')
    expect(toolKind('Write')).toBe('edit')
    expect(toolKind('MultiEdit')).toBe('edit')
    expect(toolKind('Grep')).toBe('search')
    expect(toolKind('Glob')).toBe('search')
    expect(toolKind('WebFetch')).toBe('web')
    expect(toolKind('WebSearch')).toBe('web')
    expect(toolKind('Task')).toBe('subagent')
    expect(toolKind('Agent')).toBe('subagent')
  })

  test("covers Codex's tool names", () => {
    expect(toolKind('shell')).toBe('terminal')
    expect(toolKind('exec_command')).toBe('terminal')
    expect(toolKind('apply_patch')).toBe('edit')
    expect(toolKind('web_search')).toBe('web')
  })

  test('every MCP tool is a plug, whatever its server and name', () => {
    expect(toolKind('mcp__playwright__browser_click')).toBe('mcp')
    expect(toolKind('mcp__claude_ai_Notion__notion-search')).toBe('mcp')
    // A server named after a built-in tool is still MCP.
    expect(toolKind('mcp__bash__run')).toBe('mcp')
  })

  test('an unknown or empty name is a generic tool', () => {
    expect(toolKind('TodoWrite')).toBe('tool')
    expect(toolKind('tool')).toBe('tool')
    expect(toolKind('')).toBe('tool')
    expect(toolKind('mcp_single_underscore')).toBe('tool')
  })
})

describe('toolIconLook', () => {
  test('a running tool pulses in the muted colour', () => {
    expect(toolIconLook('Bash', 'running')).toEqual({ kind: 'terminal', tone: 'muted', pulse: true })
  })

  test('a finished tool holds still', () => {
    expect(toolIconLook('Read', 'ok')).toEqual({ kind: 'file', tone: 'muted', pulse: false })
  })

  test('a failed tool shows in the error colour and holds still', () => {
    expect(toolIconLook('mcp__github__create_pr', 'error')).toEqual({ kind: 'mcp', tone: 'error', pulse: false })
  })
})
