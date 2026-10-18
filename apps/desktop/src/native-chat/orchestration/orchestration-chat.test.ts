import { describe, expect, test } from 'bun:test'
import { laneEvents, nodeChat } from '@/native-chat/orchestration/orchestration-chat'
import type { OrchestrationNode } from '@/api/schema'

const node = (patch: Partial<OrchestrationNode>): OrchestrationNode => ({
  id: 'dispatch-1', kind: 'lane', parent: 'root', label: 'lane', agent: 'codex', model: null, effort: null, state: 'working',
  startedAt: '2026-10-18T10:00:00Z', endedAt: null, contextPercent: null, last: null, finding: null, unanswered: false, worktree: null, branch: null, commits: null, chatId: null, session: null,
  ...patch,
})

describe('nodeChat', () => {
  test('an app chat wins over its dispatch', () => {
    expect(nodeChat(node({ chatId: 'chat-1' }))).toEqual({ kind: 'app', chatId: 'chat-1' })
  })
  test('a lane shows its messages with the coordinator', () => {
    expect(nodeChat(node({ session: 'codex:abc' }))).toEqual({ kind: 'lane', dispatch: 'dispatch-1' })
  })
  test('a coordinator that is only a session shows its transcript', () => {
    expect(nodeChat(node({ id: 'session:claude:abc', kind: 'coordinator', session: 'claude:abc' }))).toEqual({ kind: 'session', session: 'claude:abc' })
  })
  test('a session node with no session has nothing to show', () => {
    expect(nodeChat(node({ id: 'session:claude:abc', session: null }))).toEqual({ kind: 'none' })
  })
})

describe('laneEvents', () => {
  test('the coordinator speaks as the person and the lane as the agent', () => {
    const events = laneEvents([
      { from: 'parent', type: 'prompt', text: 'Do it.', createdAt: '2026-10-18T10:00:00Z' },
      { from: 'child', type: 'received', text: 'received', createdAt: '2026-10-18T10:00:05Z' },
      { from: 'child', type: 'ask', text: 'Which one?' },
      { from: 'parent', type: 'reply', text: 'The first.' },
      { from: 'child', type: 'stalled', text: 'no brief' },
      { from: 'child', type: 'done', text: 'Done.' },
    ])
    expect(events.map((event) => [event.kind, event.text])).toEqual([
      ['user', 'Do it.'],
      ['system', 'Received the brief.'],
      ['assistant', 'Which one?'],
      ['user', 'The first.'],
      ['system', 'stalled: no brief'],
      ['assistant', 'Done.'],
    ])
    expect(events[0]?.at).toBe('2026-10-18T10:00:00Z')
    expect(events[2]?.at).toBeNull()
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length)
  })
  test('a notice with nothing beyond its type says only the type', () => {
    expect(laneEvents([{ from: 'parent', type: 'supervise', text: '' }])[0]?.text).toBe('supervise')
  })
})
