import { describe, expect, test } from 'bun:test'
import type { TranscriptEvent } from '@/api/schema'
import { buildConversationItems } from '@/chat/conversation-model'
import { subagentGroupSummary, subagentSummary, visibleSteps, type SubagentItem } from '@/chat/subagent-model'
import { groupToolRuns, type DisplayItem } from '@/chat/tool-groups'
import { followState, applyLine, workingStatus } from '@/native-chat/chat-model'

// Events in the shapes megabrain chatd stores: an Agent tool call carrying `subagent` starts one, its own
// steps carry `parentId`, and a tool result carrying `subagent` with a status ends it.

function event(id: string, fields: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return { id, at: null, kind: 'assistant', text: id, ...fields }
}
const start = (id: string, type = 'general-purpose', description = `do ${id}`, at: string | null = '2026-10-16T10:00:00.000Z') =>
  event(`start-${id}`, { kind: 'tool-call', at, text: 'Agent', tool: { name: 'Agent', input: JSON.stringify({ description, subagent_type: type }) }, subagent: { id, type, description } })
const end = (id: string, status: 'completed' | 'failed' | 'stopped', text = `report ${id}`, at: string | null = '2026-10-16T10:01:05.000Z') =>
  event(`end-${id}`, { kind: 'tool-result', at, text, tool: { name: 'Agent', status: status === 'completed' ? 'ok' : 'error' }, subagent: { id, status } })
const step = (parent: string, id: string, fields: Partial<TranscriptEvent>) => event(id, { parentId: parent, ...fields })
const call = (parent: string, id: string, name: string, input: string) => step(parent, id, { kind: 'tool-call', text: name, tool: { name, input } })
const result = (parent: string, id: string, status: 'ok' | 'error' = 'ok') => step(parent, id, { kind: 'tool-result', text: 'out', tool: { name: 'x', status } })

const display = (events: TranscriptEvent[]): DisplayItem[] => groupToolRuns(buildConversationItems(events))
function only<T extends DisplayItem['type']>(items: DisplayItem[], type: T): Extract<DisplayItem, { type: T }> {
  const found = items.find((item) => item.type === type)
  if (found === undefined) throw new Error(`no ${type}`)
  return found as Extract<DisplayItem, { type: T }>
}
const subagent = (events: TranscriptEvent[]): SubagentItem => only(display(events), 'subagent')

describe('subagents in the conversation', () => {
  test('a subagent sits where its Agent call was, its steps inside it and never in the main flow', () => {
    const items = display([
      event('u1', { kind: 'user' }),
      start('a'),
      call('a', 'c1', 'Bash', '{"command":"ls"}'),
      result('a', 'r1'),
      event('m1'),
      step('a', 't1', { kind: 'assistant', text: 'half way' }),
      end('a', 'completed'),
    ])
    expect(items.map((item) => item.type)).toEqual(['message', 'subagent', 'message'])
    const item = only(items, 'subagent')
    expect(item.id).toBe('a')
    expect(item.steps.map((entry) => (entry.type === 'tool' ? `tool:${entry.id}` : entry.type === 'message' ? entry.event.id : entry.type))).toEqual(['tool:c1', 't1'])
    expect(item.end?.id).toBe('end-a')
  })

  test('steps or an end whose subagent is not in view are dropped, not shown as stray rows', () => {
    expect(display([call('gone', 'c1', 'Bash', '{}'), end('gone', 'completed'), event('m1')]).map((item) => item.type)).toEqual(['message'])
  })

  test('parallel subagents read as one group; a single one stands alone', () => {
    const parallel = display([start('a'), start('b'), call('a', 'c1', 'Bash', '{}'), call('b', 'c2', 'Read', '{}'), event('m1')])
    expect(parallel.map((item) => item.type)).toEqual(['subagent-group', 'message'])
    expect(only(parallel, 'subagent-group').items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(display([start('a'), event('m1'), start('b')]).map((item) => item.type)).toEqual(['subagent', 'message', 'subagent'])
  })

  test('a subagent ends a run of tool calls, which go on as a new run after it', () => {
    const items = display([event('c1', { kind: 'tool-call', text: 'Bash', tool: { name: 'Bash' } }), event('r1', { kind: 'tool-result', text: '', tool: { name: 'Bash', status: 'ok' } }), start('a'), event('c2', { kind: 'tool-call', text: 'Read', tool: { name: 'Read' } })])
    expect(items.map((item) => item.type)).toEqual(['tool-group', 'subagent', 'tool-group'])
  })
})

describe('subagentSummary', () => {
  test('while working: its type and description, the tool count and the latest step', () => {
    const summary = subagentSummary(subagent([start('a', 'Explore', 'Map the repo'), call('a', 'c1', 'Read', '{"file_path":"/x/a.ts"}'), result('a', 'r1'), call('a', 'c2', 'Bash', '{"command":"ls -la"}')]))
    expect(summary).toMatchObject({ type: 'Explore', description: 'Map the repo', state: 'working', tools: 2, errors: 0, latest: 'Bash ls -la', result: null, startedAt: '2026-10-16T10:00:00.000Z', endedAt: null })
  })

  test('the latest step is a message when the subagent last wrote', () => {
    expect(subagentSummary(subagent([start('a'), call('a', 'c1', 'Bash', '{"command":"ls"}'), result('a', 'r1'), step('a', 't1', { kind: 'assistant', text: 'Found it.\nMore detail' })])).latest).toBe('Found it.')
  })

  test('a finished subagent shows its state, failures and result, and when it ended', () => {
    const done = subagentSummary(subagent([start('a'), call('a', 'c1', 'Bash', '{}'), result('a', 'r1', 'error'), end('a', 'completed', 'All good')]))
    expect(done).toMatchObject({ state: 'completed', tools: 1, errors: 1, result: 'All good', endedAt: '2026-10-16T10:01:05.000Z' })
    expect(subagentSummary(subagent([start('a'), end('a', 'failed', 'boom')])).state).toBe('failed')
    expect(subagentSummary(subagent([start('a'), end('a', 'stopped', '')])).state).toBe('stopped')
  })

  test('a subagent with no type or description still has something to show', () => {
    const bare = event('start-x', { kind: 'tool-call', text: 'spawnAgent', tool: { name: 'spawnAgent' }, subagent: { id: 'x' } })
    expect(subagentSummary(subagent([bare]))).toMatchObject({ type: 'Subagent', description: '' })
  })

  test('its final message is not repeated above the result it became', () => {
    const item = subagent([start('a'), call('a', 'c1', 'Bash', '{}'), result('a', 'r1'), step('a', 't1', { kind: 'assistant', text: 'Done.' }), end('a', 'completed', 'Done.')])
    expect(visibleSteps(item).map((entry) => entry.type)).toEqual(['tool'])
    const other = subagent([start('a'), step('a', 't1', { kind: 'assistant', text: 'Working on it' }), end('a', 'completed', 'Done.')])
    expect(visibleSteps(other)).toHaveLength(1)
  })

  test('a group counts how many still work and how many failed', () => {
    const group = only(display([start('a'), start('b'), start('c'), end('b', 'completed'), end('c', 'failed')]), 'subagent-group')
    expect(subagentGroupSummary(group)).toEqual({ total: 3, working: 1, failed: 1 })
  })
})

describe('the working indicator with subagents', () => {
  test('names the Agent call, not the latest step of a subagent', () => {
    let state = followState({ id: 'chat', agent: 'claude', model: null, cwd: '/w', title: null, state: 'working', mode: 'chat', agentSessionId: 's', createdAt: '2026-10-16T09:59:00.000Z', lastActivityAt: null })
    for (const [index, item] of [start('a'), call('a', 'c1', 'Bash', '{}')].entries()) state = applyLine(state, { cursor: String(index + 1), event: item })
    expect(workingStatus(state)?.label).toBe('Running Agent')
  })
})
