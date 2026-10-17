import { describe, expect, test } from 'bun:test'
import type { TranscriptEvent } from '@/api/schema'
import { buildConversationItems } from '@/chat/conversation-model'
import { groupToolRuns, type DisplayItem } from '@/chat/tool-groups'
import { toolCategory, toolLabel, toolRunLine, toolRunSentence } from '@/chat/tool-sentence'

function event(id: string, fields: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return { id, at: null, kind: 'assistant', text: '', ...fields }
}

function call(id: string, name: string, input = '{}'): TranscriptEvent {
  return event(id, { kind: 'tool-call', text: name, tool: { name, input } })
}

function result(id: string, status: 'ok' | 'error' = 'ok'): TranscriptEvent {
  return event(id, { kind: 'tool-result', text: 'out', tool: { name: 'x', status } })
}

function onlyGroup(events: TranscriptEvent[]): Extract<DisplayItem, { type: 'tool-group' }> {
  const group = groupToolRuns(buildConversationItems(events)).find((item) => item.type === 'tool-group')
  if (group === undefined || group.type !== 'tool-group') throw new Error('no group')
  return group
}

describe('toolCategory', () => {
  test("names the category of each of Claude's tools", () => {
    expect(toolCategory('Read')).toBe('read')
    expect(toolCategory('LS')).toBe('read')
    expect(toolCategory('Edit')).toBe('edit')
    expect(toolCategory('MultiEdit')).toBe('edit')
    expect(toolCategory('NotebookEdit')).toBe('edit')
    expect(toolCategory('Write')).toBe('write')
    expect(toolCategory('Grep')).toBe('search')
    expect(toolCategory('Glob')).toBe('search')
    expect(toolCategory('WebSearch')).toBe('web-search')
    expect(toolCategory('WebFetch')).toBe('fetch')
    expect(toolCategory('Bash')).toBe('command')
    expect(toolCategory('BashOutput')).toBe('command')
    expect(toolCategory('Task')).toBe('agent')
    expect(toolCategory('Agent')).toBe('agent')
  })

  test("names the category of each of Codex's tools", () => {
    expect(toolCategory('command')).toBe('command')
    expect(toolCategory('shell')).toBe('command')
    expect(toolCategory('local_shell')).toBe('command')
    expect(toolCategory('exec_command')).toBe('command')
    expect(toolCategory('apply_patch')).toBe('edit')
    expect(toolCategory('read_file')).toBe('read')
    expect(toolCategory('web_search')).toBe('web-search')
  })

  test('MCP tools and anything unknown are other tools', () => {
    expect(toolCategory('mcp__playwright__browser_click')).toBe('other')
    expect(toolCategory('mcp__bash__run')).toBe('other')
    expect(toolCategory('TodoWrite')).toBe('other')
    expect(toolCategory('update_plan')).toBe('other')
    expect(toolCategory('')).toBe('other')
  })
})

describe('toolRunSentence', () => {
  test('one clause per category, with its count, in the order the run first used it', () => {
    expect(toolRunSentence(['Read', 'Read', 'Edit', 'Read', 'MultiEdit', 'Bash', 'Bash', 'Bash', 'Bash'])).toBe('Read 3 files, edited 2 files, and ran 4 commands')
  })

  test('two clauses join with and', () => {
    expect(toolRunSentence(['WebSearch', 'mcp__a__one', 'WebSearch', 'mcp__b__two'])).toBe('Searched the web 2 times and used 2 tools')
  })

  test('a single call reads in the singular', () => {
    expect(toolRunSentence(['Read'])).toBe('Read 1 file')
    expect(toolRunSentence(['Edit'])).toBe('Edited 1 file')
    expect(toolRunSentence(['Write'])).toBe('Wrote 1 file')
    expect(toolRunSentence(['Grep'])).toBe('Searched 1 time')
    expect(toolRunSentence(['WebSearch'])).toBe('Searched the web 1 time')
    expect(toolRunSentence(['WebFetch'])).toBe('Fetched 1 page')
    expect(toolRunSentence(['Bash'])).toBe('Ran 1 command')
    expect(toolRunSentence(['Task'])).toBe('Ran 1 agent')
    expect(toolRunSentence(['TodoWrite'])).toBe('Used 1 tool')
  })

  test('many calls read in the plural', () => {
    expect(toolRunSentence(['Write', 'Write'])).toBe('Wrote 2 files')
    expect(toolRunSentence(['Glob', 'Grep', 'Glob'])).toBe('Searched 3 times')
    expect(toolRunSentence(['WebFetch', 'WebFetch'])).toBe('Fetched 2 pages')
    expect(toolRunSentence(['Agent', 'Task'])).toBe('Ran 2 agents')
  })

  test("Codex's names count in the same categories as Claude's", () => {
    expect(toolRunSentence(['command', 'shell', 'apply_patch', 'exec_command', 'web_search', 'apply_patch'])).toBe('Ran 3 commands, edited 2 files, and searched the web 1 time')
  })

  test('no calls is no sentence', () => {
    expect(toolRunSentence([])).toBe('')
  })
})

describe('toolLabel', () => {
  test('a file tool shows the file name', () => {
    expect(toolLabel('Read', JSON.stringify({ file_path: '/repo/apps/desktop/src/App.tsx' }))).toBe('App.tsx')
    expect(toolLabel('Edit', JSON.stringify({ file_path: 'src/chat/markdown.tsx', old_string: 'a', new_string: 'b' }))).toBe('markdown.tsx')
    expect(toolLabel('NotebookEdit', JSON.stringify({ notebook_path: '/n/analysis.ipynb' }))).toBe('analysis.ipynb')
  })

  test('a command shows its first line', () => {
    expect(toolLabel('Bash', JSON.stringify({ command: 'bun test src\necho done', description: 'Run tests' }))).toBe('bun test src')
    expect(toolLabel('exec_command', JSON.stringify({ cmd: 'rg -n foo src' }))).toBe('rg -n foo src')
    expect(toolLabel('command', 'git status --short')).toBe('git status --short')
  })

  test("a Codex shell call shows the command without its login shell", () => {
    expect(toolLabel('shell', JSON.stringify({ command: ['bash', '-lc', 'git log --oneline -3'] }))).toBe('git log --oneline -3')
    expect(toolLabel('shell', JSON.stringify({ command: ['zsh', '-lc', 'ls'] }))).toBe('ls')
    expect(toolLabel('shell', JSON.stringify({ command: ['ls', '-la'] }))).toBe('ls -la')
  })

  test('a Codex patch shows the file it changes', () => {
    expect(toolLabel('apply_patch', '*** Begin Patch\n*** Update File: src/chat/markdown.tsx\n@@\n-a\n+b\n*** End Patch')).toBe('markdown.tsx')
    expect(toolLabel('apply_patch', '*** Begin Patch\n*** Add File: docs/new.md\n+hello\n*** End Patch')).toBe('new.md')
  })

  test('a search shows its query or pattern', () => {
    expect(toolLabel('WebSearch', JSON.stringify({ query: 'react markdown streaming' }))).toBe('react markdown streaming')
    expect(toolLabel('web_search', JSON.stringify({ query: 'orca chat' }))).toBe('orca chat')
    expect(toolLabel('Grep', JSON.stringify({ pattern: 'toolSummary', path: 'src' }))).toBe('toolSummary')
    expect(toolLabel('Glob', JSON.stringify({ pattern: '**/*.tsx' }))).toBe('**/*.tsx')
  })

  test('a fetch shows its address', () => {
    expect(toolLabel('WebFetch', JSON.stringify({ url: 'https://example.com/docs', prompt: 'summarize' }))).toBe('https://example.com/docs')
  })

  test('any other tool shows its first text field, and no input shows nothing', () => {
    expect(toolLabel('mcp__playwright__browser_click', JSON.stringify({ element: 'Submit button', ref: 'e12' }))).toBe('Submit button')
    expect(toolLabel('TodoWrite', '{}')).toBe('')
    expect(toolLabel('Read', undefined)).toBe('')
  })
})

describe('toolRunLine', () => {
  test('a run whose calls all finished reads as its sentence, done', () => {
    const line = toolRunLine(onlyGroup([call('c1', 'Read'), result('r1'), call('c2', 'Edit'), result('r2'), call('c3', 'Bash'), result('r3'), event('m1')]))
    expect(line).toEqual({ sentence: 'Read 1 file, edited 1 file, and ran 1 command', state: 'done', failed: 0 })
  })

  test('a run with a call still running is running, and counts that call', () => {
    const line = toolRunLine(onlyGroup([call('c1', 'Read'), result('r1'), call('c2', 'Bash', JSON.stringify({ command: 'bun test' }))]))
    expect(line).toEqual({ sentence: 'Read 1 file and ran 1 command', state: 'running', failed: 0 })
  })

  test('a settled run with a failed call is failed, with how many failed', () => {
    const line = toolRunLine(onlyGroup([call('c1', 'Bash'), result('r1', 'error'), call('c2', 'Bash'), result('r2'), call('c3', 'Edit'), result('r3', 'error'), event('m1')]))
    expect(line).toEqual({ sentence: 'Ran 2 commands and edited 1 file', state: 'failed', failed: 2 })
  })

  test('a run still running stays running even after an earlier call failed', () => {
    const line = toolRunLine(onlyGroup([call('c1', 'Bash'), result('r1', 'error'), call('c2', 'Bash')]))
    expect(line.state).toBe('running')
    expect(line.failed).toBe(1)
  })

  test('thinking inside the run is not a call', () => {
    const line = toolRunLine(onlyGroup([call('c1', 'Grep'), result('r1'), event('t1', { kind: 'thinking', text: 'hmm' }), call('c2', 'Grep'), result('r2'), event('m1')]))
    expect(line.sentence).toBe('Searched 2 times')
  })

  test("a Codex run of commands pairs each command with its result", () => {
    const codexResult = (id: string, status: 'ok' | 'error') => event(id, { kind: 'tool-result', text: 'out', tool: { name: 'command', status } })
    const line = toolRunLine(onlyGroup([call('c1', 'command', 'ls'), codexResult('r1', 'ok'), call('c2', 'command', 'false'), codexResult('r2', 'error'), event('m1')]))
    expect(line).toEqual({ sentence: 'Ran 2 commands', state: 'failed', failed: 1 })
  })
})
