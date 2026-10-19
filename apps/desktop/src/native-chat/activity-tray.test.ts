import { describe, expect, test } from 'bun:test'
import type { ChatQueueItem, OrchestrationGraph, OrchestrationNode, TranscriptEvent } from '@/api/schema'
import type { BackgroundTask } from '@/chat/background-tasks'
import { chatLanes, pillLabel, runningSubagents, trayEntries, trayPills, type TrayEntry } from '@/native-chat/activity-tray'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 19, 12, 0, seconds)).toISOString()
const ms = (seconds: number) => Date.parse(at(seconds))

const task = (id: string, fields: Partial<BackgroundTask> = {}): BackgroundTask => ({ id, kind: 'shell', label: 'bun test --watch', state: 'running', startedAt: at(0), ...fields })

function node(id: string, fields: Partial<OrchestrationNode> = {}): OrchestrationNode {
  return {
    id,
    kind: 'lane',
    parent: 'me',
    label: id,
    agent: 'codex',
    model: null,
    effort: null,
    state: 'working',
    startedAt: at(0),
    endedAt: null,
    contextPercent: null,
    last: null,
    finding: null,
    unanswered: false,
    worktree: null,
    branch: null,
    commits: null,
    chatId: null,
    session: null,
    ...fields,
  }
}

const graph = (nodes: OrchestrationNode[]): OrchestrationGraph => ({ version: 1, focus: 'me', root: 'me', nodes: [node('me', { kind: 'coordinator', parent: null }), ...nodes], events: [] })

const queued = (id: string, seconds: number): ChatQueueItem => ({ id, parts: [{ type: 'text', text: `message ${id}` }] as ChatQueueItem['parts'], createdAt: at(seconds), updatedAt: at(seconds) })

function subagentCall(id: string, seconds: number, description = 'Look around'): TranscriptEvent {
  return { id: `call-${id}`, at: at(seconds), kind: 'tool-call', text: 'Task', tool: { name: 'Task' }, subagent: { id, type: 'Explore', description } }
}

function subagentEnd(id: string, seconds: number): TranscriptEvent {
  return { id: `end-${id}`, at: at(seconds), kind: 'tool-result', text: 'done', tool: { name: 'Task', status: 'ok' }, subagent: { id, status: 'completed' } }
}

describe('runningSubagents', () => {
  test('a subagent runs from its call until the result that ends it', () => {
    const entries = runningSubagents([subagentCall('a', 1), subagentCall('b', 2, 'Read the docs'), subagentEnd('a', 5)])
    expect(entries).toEqual([{ id: 'subagent-b', kind: 'subagent', label: 'Explore · Read the docs', startedAt: at(2), status: 'working' }])
  })
})

describe('chatLanes', () => {
  test('the live lanes this chat started, not finished ones or lanes of its lanes', () => {
    const lanes = chatLanes(graph([node('l1'), node('l2', { state: 'done', endedAt: at(9) }), node('l3', { parent: 'l1' }), node('l4', { state: 'asking' })]))
    expect(lanes.map((lane) => lane.id)).toEqual(['l1', 'l4'])
  })

  test('no graph, no lanes', () => {
    expect(chatLanes(null)).toEqual([])
  })
})

describe('trayEntries', () => {
  test('sorts running work into its kind; finished tasks are left out', () => {
    const entries = trayEntries({
      tasks: [task('s1'), task('m1', { kind: 'monitor', label: 'tail log' }), task('a1', { kind: 'agent', label: 'reviewer' }), task('o1', { kind: 'other', label: 'job' }), task('s2', { state: 'completed' })],
      events: [subagentCall('x', 3)],
      lanes: [node('l1', { label: 'chat rows', state: 'asking' })],
      queue: [queued('q1', 4)],
    })
    expect(entries.map((entry) => [entry.kind, entry.id, entry.status])).toEqual([
      ['shell', 's1', 'running'],
      ['monitor', 'm1', 'running'],
      ['subagent', 'a1', 'running'],
      ['task', 'o1', 'running'],
      ['subagent', 'subagent-x', 'working'],
      ['lane', 'l1', 'asking'],
      ['queue', 'q1', 'queued'],
    ])
    expect(entries.find((entry) => entry.id === 'q1')?.label).toBe('message q1')
  })
})

const entry = (kind: TrayEntry['kind'], id: string, seconds: number | null): TrayEntry => ({ id, kind, label: id, startedAt: seconds === null ? null : at(seconds), status: 'running' })

describe('trayPills', () => {
  test('one pill per kind with its count and longest elapsed time, kinds with nothing hidden', () => {
    const pills = trayPills([entry('shell', 's1', 10), entry('shell', 's2', 0), entry('queue', 'q1', 70)], ms(80))
    expect(pills).toEqual([
      { kind: 'shell', count: 2, longestMs: 80_000, label: '2 shell commands — 1m 20s' },
      { kind: 'queue', count: 1, longestMs: 10_000, label: '1 queued message — 10s' },
    ])
  })

  test('a pill keeps a fixed order of kinds', () => {
    const pills = trayPills([entry('queue', 'q', 0), entry('lane', 'l', 0), entry('subagent', 'a', 0), entry('monitor', 'm', 0), entry('shell', 's', 0), entry('task', 't', 0)], ms(1))
    expect(pills.map((pill) => pill.kind)).toEqual(['shell', 'monitor', 'task', 'subagent', 'lane', 'queue'])
  })

  test('a pill without any start time shows no time', () => {
    expect(trayPills([entry('lane', 'l', null)], ms(1))[0]?.label).toBe('1 lane')
  })

  test('nothing running, no pills', () => {
    expect(trayPills([], ms(1))).toEqual([])
  })
})

describe('pillLabel', () => {
  test('singular and plural per kind', () => {
    expect(pillLabel('shell', 1)).toBe('1 shell command')
    expect(pillLabel('monitor', 2)).toBe('2 monitors')
    expect(pillLabel('task', 1)).toBe('1 background task')
    expect(pillLabel('subagent', 3)).toBe('3 subagents')
    expect(pillLabel('lane', 1)).toBe('1 lane')
    expect(pillLabel('queue', 3)).toBe('3 queued messages')
  })
})
