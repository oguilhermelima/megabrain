import { describe, expect, test } from 'bun:test'
import type { TranscriptEvent } from '@/api/schema'
import { activityLabel, activityRows, type ActivityRow } from '@/chat/activity-rows'
import { buildConversationItems } from '@/chat/conversation-model'
import { groupToolRuns, type DisplayItem } from '@/chat/tool-groups'

function event(id: string, fields: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return { id, at: null, kind: 'assistant', text: '', ...fields }
}

function call(id: string, name: string, input: Record<string, unknown> = {}): TranscriptEvent {
  return event(id, { kind: 'tool-call', text: name, tool: { name, input: JSON.stringify(input) } })
}

function result(id: string, status: 'ok' | 'error' = 'ok'): TranscriptEvent {
  return event(id, { kind: 'tool-result', text: 'out', tool: { name: 'x', status } })
}

function rowsOf(events: TranscriptEvent[]): ActivityRow[] {
  const group = groupToolRuns(buildConversationItems(events)).find((item): item is Extract<DisplayItem, { type: 'tool-group' }> => item.type === 'tool-group')
  if (group === undefined) throw new Error('no group')
  return activityRows(group.items)
}

const ids = (row: ActivityRow) => row.items.map((item) => (item.type === 'tool' ? item.id : item.event.id))

describe('activityRows', () => {
  test('one row per consecutive run of the same kind of work', () => {
    const rows = rowsOf([
      call('r1', 'Read', { file_path: '/a/one.ts' }),
      result('r1o'),
      call('r2', 'Read', { file_path: '/a/two.ts' }),
      result('r2o'),
      call('b1', 'Bash', { command: 'bun test' }),
      result('b1o'),
      call('r3', 'Read', { file_path: '/a/three.ts' }),
      result('r3o'),
    ])
    expect(rows.map((row) => [row.category, row.calls.length])).toEqual([
      ['read', 2],
      ['command', 1],
      ['read', 1],
    ])
  })

  test('Claude and Codex names of the same kind of work share a row', () => {
    const rows = rowsOf([call('b1', 'Bash', { command: 'ls' }), result('b1o'), call('c1', 'exec_command', { cmd: 'pwd' }), result('c1o')])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.calls).toHaveLength(2)
  })

  test('other tools group by their own name', () => {
    const rows = rowsOf([call('m1', 'mcp__x__find', { q: 'a' }), result('m1o'), call('m2', 'mcp__x__find', { q: 'b' }), result('m2o'), call('m3', 'TodoWrite', {}), result('m3o')])
    expect(rows.map((row) => [row.tool, row.calls.length])).toEqual([
      ['mcp__x__find', 2],
      ['TodoWrite', 1],
    ])
  })

  test('the detail is the latest call of the row', () => {
    const rows = rowsOf([call('r1', 'Read', { file_path: '/a/one.ts' }), result('r1o'), call('r2', 'Read', { file_path: '/a/two.ts' }), result('r2o')])
    expect(rows[0]?.detail).toContain('two.ts')
  })

  test('thinking between calls stays in the row it falls in, so nothing shown today is lost', () => {
    const rows = rowsOf([call('r1', 'Read', { file_path: '/a' }), result('r1o'), event('t1', { kind: 'thinking', text: 'hmm' }), call('r2', 'Read', { file_path: '/b' }), result('r2o')])
    expect(rows).toHaveLength(1)
    expect(ids(rows[0] as ActivityRow)).toEqual(['r1', 't1', 'r2'])
  })

  test('thinking before a new kind of work closes the row before it', () => {
    const rows = rowsOf([call('r1', 'Read', { file_path: '/a' }), result('r1o'), event('t1', { kind: 'thinking', text: 'hmm' }), call('b1', 'Bash', { command: 'ls' }), result('b1o')])
    expect(rows.map(ids)).toEqual([['r1', 't1'], ['b1']])
  })

  test('a row runs while its last call has no result, fails once settled with a failed call', () => {
    const running = rowsOf([call('b1', 'Bash', { command: 'ls' }), result('b1o'), call('b2', 'Bash', { command: 'sleep 9' })])
    expect(running[0]?.state).toBe('running')
    const failed = rowsOf([call('b1', 'Bash', { command: 'ls' }), result('b1o', 'error'), call('b2', 'Bash', { command: 'pwd' }), result('b2o')])
    expect(failed[0]?.state).toBe('failed')
    expect(failed[0]?.failed).toBe(1)
    const done = rowsOf([call('b1', 'Bash', { command: 'ls' }), result('b1o')])
    expect(done[0]?.state).toBe('done')
  })

  test('row ids are stable: the id of the first call', () => {
    const rows = rowsOf([call('r1', 'Read', { file_path: '/a' }), result('r1o'), call('b1', 'Bash', { command: 'ls' })])
    expect(rows.map((row) => row.id)).toEqual(['activity-r1', 'activity-b1'])
  })
})

const row = (category: ActivityRow['category'], count: number, state: ActivityRow['state'], tool = 'x'): Pick<ActivityRow, 'category' | 'tool' | 'calls' | 'state'> => ({
  category,
  tool,
  calls: Array.from({ length: count }) as ActivityRow['calls'],
  state,
})

describe('activityLabel', () => {
  test('present tense while running', () => {
    expect(activityLabel(row('web-search', 1, 'running'))).toBe('Searching the web 1 time')
    expect(activityLabel(row('read', 3, 'running'))).toBe('Reading 3 files')
    expect(activityLabel(row('command', 2, 'running'))).toBe('Running 2 commands')
    expect(activityLabel(row('edit', 4, 'running'))).toBe('Editing 4 files')
    expect(activityLabel(row('other', 2, 'running', 'TodoWrite'))).toBe('Using TodoWrite 2 times')
  })

  test('past tense once done or failed', () => {
    expect(activityLabel(row('web-search', 1, 'done'))).toBe('Searched the web 1 time')
    expect(activityLabel(row('read', 1, 'done'))).toBe('Read 1 file')
    expect(activityLabel(row('read', 3, 'done'))).toBe('Read 3 files')
    expect(activityLabel(row('command', 2, 'failed'))).toBe('Ran 2 commands')
    expect(activityLabel(row('edit', 4, 'done'))).toBe('Edited 4 files')
    expect(activityLabel(row('write', 1, 'done'))).toBe('Wrote 1 file')
    expect(activityLabel(row('search', 2, 'done'))).toBe('Searched 2 times')
    expect(activityLabel(row('fetch', 1, 'done'))).toBe('Fetched 1 page')
    expect(activityLabel(row('agent', 2, 'done'))).toBe('Ran 2 agents')
    expect(activityLabel(row('other', 1, 'done', 'TodoWrite'))).toBe('Used TodoWrite 1 time')
  })
})
