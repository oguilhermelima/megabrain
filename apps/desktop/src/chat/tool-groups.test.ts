import { describe, expect, test } from 'bun:test'
import type { TranscriptEvent } from '@/api/schema'
import { buildConversationItems } from '@/chat/conversation-model'
import { groupToolRuns, toolGroupSummary, type DisplayItem } from '@/chat/tool-groups'

function event(id: string, fields: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return { id, at: null, kind: 'assistant', text: '', ...fields }
}

function call(id: string, name: string, input = '{}'): TranscriptEvent {
  return event(id, { kind: 'tool-call', text: name, tool: { name, input } })
}

function result(id: string, status: 'ok' | 'error' = 'ok'): TranscriptEvent {
  return event(id, { kind: 'tool-result', text: 'out', tool: { name: 'x', status } })
}

const display = (events: TranscriptEvent[]): DisplayItem[] => groupToolRuns(buildConversationItems(events))

function shape(items: DisplayItem[]): string[] {
  return items.map((item) => (item.type === 'tool-group' ? `group:${item.items.map((member) => (member.type === 'tool' ? member.id : member.event.id)).join(',')}` : item.type === 'message' ? item.event.id : item.id))
}

function onlyGroup(items: DisplayItem[]): Extract<DisplayItem, { type: 'tool-group' }> {
  const group = items.find((item) => item.type === 'tool-group')
  if (group === undefined || group.type !== 'tool-group') throw new Error('no group')
  return group
}

describe('groupToolRuns', () => {
  test('consecutive tool calls between two messages become one group', () => {
    const items = display([event('m1'), call('c1', 'Bash'), result('r1'), call('c2', 'Read'), result('r2'), event('m2')])
    expect(shape(items)).toEqual(['m1', 'group:c1,c2', 'm2'])
  })

  test('a thinking event inside a run stays inside the group', () => {
    const items = display([call('c1', 'Bash'), result('r1'), event('t1', { kind: 'thinking', text: 'hmm' }), call('c2', 'Bash'), result('r2')])
    expect(shape(items)).toEqual(['group:c1,t1,c2'])
  })

  test('thinking before the first call or after the last stays outside the group', () => {
    const items = display([event('t0', { kind: 'thinking', text: 'hmm' }), call('c1', 'Bash'), result('r1'), event('t1', { kind: 'thinking', text: 'ok' }), event('m1')])
    expect(shape(items)).toEqual(['t0', 'group:c1', 't1', 'm1'])
  })

  test('thinking with no visible text is no row, inside a run or out of it', () => {
    const items = display([event('t0', { kind: 'thinking' }), call('c1', 'Bash'), result('r1'), event('t1', { kind: 'thinking', text: ' ' }), call('c2', 'Bash'), result('r2'), event('t2', { kind: 'thinking' }), event('m1')])
    expect(shape(items)).toEqual(['group:c1,c2', 'm1'])
  })

  test('a message breaks the run into two groups', () => {
    const items = display([call('c1', 'Bash'), result('r1'), event('m1'), call('c2', 'Bash'), result('r2')])
    expect(shape(items)).toEqual(['group:c1', 'm1', 'group:c2'])
  })

  test('a relayed message breaks the run too', () => {
    const relayed = event('m1', { kind: 'user', origin: { kind: 'parent', label: 'brief', dispatchId: null, sessionId: null } })
    const items = display([call('c1', 'Bash'), result('r1'), relayed, call('c2', 'Bash')])
    expect(shape(items)).toEqual(['group:c1', 'm1', 'group:c2'])
  })

  test('the group id is the id of its first call, stable as the run grows', () => {
    expect(onlyGroup(display([call('c1', 'Bash')])).id).toBe('group-c1')
    expect(onlyGroup(display([call('c1', 'Bash'), result('r1'), call('c2', 'Bash')])).id).toBe('group-c1')
  })
})

describe('toolGroupSummary', () => {
  test('while the last call has no result it says what is running and how many came before', () => {
    const group = onlyGroup(
      display([
        call('c1', 'Bash'),
        result('r1'),
        call('c2', 'Read'),
        result('r2'),
        call('c3', 'Bash'),
        result('r3'),
        call('c4', 'Grep'),
        result('r4'),
        call('c5', 'Bash', JSON.stringify({ command: 'bun test src' })),
      ]),
    )
    expect(toolGroupSummary(group)).toEqual({ state: 'running', tool: 'Bash', detail: 'bun test src', earlier: 4, total: 5, counts: [{ name: 'Bash', count: 3 }, { name: 'Read', count: 1 }, { name: 'Grep', count: 1 }], errors: 0 })
  })

  test('a single running call has no earlier calls', () => {
    const summary = toolGroupSummary(onlyGroup(display([call('c1', 'Bash', JSON.stringify({ command: 'ls' }))])))
    expect(summary.state).toBe('running')
    expect(summary.earlier).toBe(0)
  })

  test('when every call has a result it counts the tools, most used first', () => {
    const events = [...['Bash', 'Read', 'Bash', 'Bash', 'Bash', 'Bash'].flatMap((name, index) => [call(`c${index}`, name), result(`r${index}`)])]
    const summary = toolGroupSummary(onlyGroup(display(events)))
    expect(summary.state).toBe('done')
    expect(summary.total).toBe(6)
    expect(summary.counts).toEqual([
      { name: 'Bash', count: 5 },
      { name: 'Read', count: 1 },
    ])
  })

  test('failed calls are counted as errors', () => {
    const summary = toolGroupSummary(onlyGroup(display([call('c1', 'Bash'), result('r1', 'error'), call('c2', 'Bash'), result('r2'), call('c3', 'Edit'), result('r3', 'error')])))
    expect(summary.errors).toBe(2)
    expect(summary.state).toBe('done')
  })

  test('thinking inside the group is not counted as a tool', () => {
    const summary = toolGroupSummary(onlyGroup(display([call('c1', 'Bash'), result('r1'), event('t1', { kind: 'thinking', text: 'hmm' }), call('c2', 'Read'), result('r2')])))
    expect(summary.total).toBe(2)
  })
})
