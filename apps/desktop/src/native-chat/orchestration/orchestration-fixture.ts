import type { OrchestrationEvent, OrchestrationGraph, OrchestrationNode } from '@/native-chat/orchestration/orchestration-schema'

// LOCAL FIXTURE for `megabrain orchestrate graph --json` until the CLI lane merges: one coordinator
// (the mock's first app chat) and five lanes, one per state the view must draw — working, asking with
// no reply, done with commits, failed on a usage limit, closed. The working lane is also an app chat.

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

const coordinatorId = 'session:claude:0b1c2d3e-0000-4000-8000-0000000000aa'
const working = 'dispatch-20261018164634000-41001-1a2b3c4d'
const asking = 'dispatch-20261018164700000-41002-2b3c4d5e'
const done = 'dispatch-20261018163900000-41003-3c4d5e6f'
const failed = 'dispatch-20261018164000000-41004-4d5e6f70'
const closed = 'dispatch-20261018163000000-41005-5e6f7081'

const lane = (fields: Partial<OrchestrationNode> & Pick<OrchestrationNode, 'id' | 'label' | 'agent' | 'state'>): OrchestrationNode => ({
  kind: 'lane',
  parent: coordinatorId,
  model: null,
  effort: null,
  startedAt: minutesAgo(40),
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
})

export const fixtureNodes: OrchestrationNode[] = [
  {
    id: coordinatorId,
    kind: 'coordinator',
    parent: null,
    label: 'Tidy the onboarding steps',
    agent: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    state: 'working',
    startedAt: minutesAgo(55),
    endedAt: null,
    contextPercent: 61,
    last: { type: 'reply', text: 'Option B: a click on an app-chat card opens that chat already in its Orchestration view.', at: minutesAgo(3) },
    finding: null,
    unanswered: false,
    worktree: '/Users/operator/Workspaces/canto',
    branch: 'main',
    commits: null,
    chatId: 'chat-0001',
    session: 'claude:0b1c2d3e-0000-4000-8000-0000000000aa',
  },
  lane({
    id: working,
    label: 'feat/orchestration-graph',
    agent: 'codex',
    model: 'gpt-6-luna',
    effort: 'high',
    state: 'working',
    startedAt: minutesAgo(32),
    contextPercent: 38,
    last: { type: 'received', text: 'Brief received; building the graph command.', at: minutesAgo(31) },
    worktree: '/Users/operator/Workspaces/Worktrees/feat-orchestration-graph',
    branch: 'feat/orchestration-graph',
    commits: 1,
    chatId: 'chat-0004',
    session: 'codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b',
  }),
  lane({
    id: asking,
    label: 'feat/desktop-panel-columns',
    agent: 'claude',
    model: 'claude-opus-5-5',
    effort: 'medium',
    state: 'asking',
    startedAt: minutesAgo(28),
    contextPercent: 24,
    last: { type: 'ask', text: 'Keep the third column when the pane is narrower than 900px, or fold it into a tab?', at: minutesAgo(6) },
    unanswered: true,
    worktree: '/Users/operator/Workspaces/Worktrees/feat-desktop-panel-columns',
    branch: 'feat/desktop-panel-columns',
    commits: 0,
  }),
  lane({
    id: done,
    label: 'docs/status-command',
    agent: 'codex',
    model: 'gpt-6-luna',
    effort: 'high',
    state: 'done',
    startedAt: minutesAgo(50),
    endedAt: minutesAgo(12),
    contextPercent: 71,
    last: { type: 'done', text: 'The status page is documented; typecheck 0 errors, 412 tests pass.', at: minutesAgo(12) },
    worktree: '/Users/operator/Workspaces/Worktrees/docs-status-command',
    branch: 'docs/status-command',
    commits: 3,
  }),
  lane({
    id: failed,
    label: 'fix/queue-cancel-owner',
    agent: 'codex',
    model: 'gpt-6-luna',
    effort: 'medium',
    state: 'failed',
    startedAt: minutesAgo(45),
    endedAt: minutesAgo(20),
    contextPercent: 55,
    last: { type: 'stalled', text: 'You have hit your usage limit.', at: minutesAgo(20) },
    finding: 'usage-limit; resets at 3:41 AM',
    worktree: '/Users/operator/Workspaces/Worktrees/fix-queue-cancel-owner',
    branch: 'fix/queue-cancel-owner',
    commits: 1,
  }),
  lane({
    id: closed,
    label: 'chore/agy-trust-probe',
    agent: 'agy',
    model: null,
    state: 'closed',
    startedAt: minutesAgo(54),
    endedAt: minutesAgo(35),
    last: { type: 'done', text: 'The trust prompt is one-shot; nothing persisted.', at: minutesAgo(36) },
    branch: 'chore/agy-trust-probe',
    commits: 0,
  }),
]

const event = (minutes: number, node: string, direction: OrchestrationEvent['direction'], type: string, text: string): OrchestrationEvent => ({ at: minutesAgo(minutes), node, direction, type, text })

export const fixtureEvents: OrchestrationEvent[] = [
  event(54, closed, 'to-child', 'brief', 'Probe whether agy persists a trust choice.'),
  event(50, done, 'to-child', 'brief', 'Document the status command.'),
  event(45, failed, 'to-child', 'brief', 'Fix cancel ownership in the queue.'),
  event(36, closed, 'to-parent', 'done', 'The trust prompt is one-shot; nothing persisted.'),
  event(32, working, 'to-child', 'brief', 'Build megabrain orchestrate graph.'),
  event(31, working, 'to-parent', 'received', 'Brief received; building the graph command.'),
  event(28, asking, 'to-child', 'brief', 'Split the desktop panel into columns.'),
  event(20, failed, 'to-parent', 'stalled', 'You have hit your usage limit.'),
  event(12, done, 'to-parent', 'done', 'The status page is documented; typecheck 0 errors, 412 tests pass.'),
  event(6, asking, 'to-parent', 'ask', 'Keep the third column when the pane is narrower than 900px, or fold it into a tab?'),
]

/** The fixture graph seen from `focus`: a node id, or the coordinator when the asked chat is not in it. */
export function fixtureGraph(focus: string | null): OrchestrationGraph {
  const known = fixtureNodes.some((node) => node.id === focus)
  return { version: 1, focus: known && focus !== null ? focus : coordinatorId, root: coordinatorId, nodes: fixtureNodes, events: fixtureEvents }
}

/** Events the dev stub appends one at a time, cycling, so the live path has something to animate. */
export const fixtureLiveEvents: { node: string; direction: OrchestrationEvent['direction']; type: string; text: string }[] = [
  { node: working, direction: 'to-parent', type: 'ask', text: 'Should --follow print a full snapshot per change?' },
  { node: working, direction: 'to-child', type: 'reply', text: 'Yes, a full snapshot each time is fine.' },
  { node: asking, direction: 'to-child', type: 'change', text: 'Fold it into a tab below 900px.' },
  { node: working, direction: 'to-parent', type: 'done', text: 'The graph command is in; 38 tests pass.' },
]
