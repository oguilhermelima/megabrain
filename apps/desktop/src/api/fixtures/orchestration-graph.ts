import type { OrchestrationGraph } from '@/api/schema'

export const mockOrchestrationGraph: OrchestrationGraph = {
  version: 1,
  focus: 'session:claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d',
  root: 'session:claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d',
  nodes: [
    { id: 'session:claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d', kind: 'coordinator', parent: null, label: 'Orchestration graph', agent: 'claude', model: 'claude-sonnet-4-5', effort: 'high', state: 'working', startedAt: '2026-10-18T15:00:00.000Z', endedAt: null, contextPercent: 58, last: { type: 'received', text: 'Implement graph command and shared API contract.', at: '2026-10-18T15:02:00.000Z' }, finding: null, unanswered: false, worktree: null, branch: null, commits: null, chatId: 'chat-orchestrate-graph', session: 'claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d' },
    { id: 'dispatch-20261018a1', kind: 'lane', parent: 'session:claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d', label: 'Build graph command', agent: 'codex', model: 'gpt-6-sol', effort: 'high', state: 'working', startedAt: '2026-10-18T15:05:00.000Z', endedAt: null, contextPercent: 42, last: { type: 'received', text: 'Implement orchestration graph data command.', at: '2026-10-18T15:05:10.000Z' }, finding: null, unanswered: false, worktree: '/Users/operator/graph', branch: 'feat/graph', commits: 0, chatId: null, session: 'codex:thread-graph' },
    { id: 'dispatch-20261018a2', kind: 'lane', parent: 'session:claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d', label: 'Clarify event shape', agent: 'grok', model: 'grok-3', effort: null, state: 'asking', startedAt: '2026-10-18T15:08:00.000Z', endedAt: null, contextPercent: null, last: { type: 'ask', text: 'Should snapshots include archived lanes?', at: '2026-10-18T15:10:00.000Z' }, finding: null, unanswered: true, worktree: null, branch: null, commits: null, chatId: null, session: 'grok:session-graph' },
    { id: 'dispatch-20261018a3', kind: 'lane', parent: 'session:claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d', label: 'Add API fixture', agent: 'agy', model: 'gemini-2.5-pro', effort: null, state: 'done', startedAt: '2026-10-18T14:45:00.000Z', endedAt: '2026-10-18T15:00:00.000Z', contextPercent: null, last: { type: 'done', text: 'Fixture and API types are ready.', at: '2026-10-18T15:00:00.000Z' }, finding: null, unanswered: false, worktree: '/Users/operator/api', branch: 'feat/api', commits: 3, chatId: null, session: 'agy:session-api' },
    { id: 'dispatch-20261018a4', kind: 'lane', parent: 'session:claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d', label: 'Review usage limits', agent: 'claude', model: 'claude-sonnet-4-5', effort: 'medium', state: 'failed', startedAt: '2026-10-18T14:30:00.000Z', endedAt: '2026-10-18T14:40:00.000Z', contextPercent: null, last: { type: 'supervise', text: 'Provider usage limit reached.', at: '2026-10-18T14:40:00.000Z' }, finding: 'usage-limit; resets at 3:41 AM', unanswered: false, worktree: null, branch: null, commits: null, chatId: null, session: null },
    { id: 'dispatch-20261018a5', kind: 'lane', parent: 'session:claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d', label: 'Inspect old flow', agent: 'codex', model: 'gpt-6-luna', effort: null, state: 'closed', startedAt: '2026-10-18T14:00:00.000Z', endedAt: '2026-10-18T14:15:00.000Z', contextPercent: null, last: null, finding: null, unanswered: false, worktree: null, branch: null, commits: null, chatId: null, session: null },
  ],
  events: [
    { at: '2026-10-18T15:10:00.000Z', node: 'dispatch-20261018a2', direction: 'to-parent', type: 'ask', text: 'Should snapshots include archived lanes?' },
    { at: '2026-10-18T15:00:00.000Z', node: 'dispatch-20261018a3', direction: 'to-parent', type: 'done', text: 'Fixture and API types are ready.' },
  ],
}
