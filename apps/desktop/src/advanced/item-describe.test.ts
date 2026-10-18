import { describe, expect, test } from 'bun:test'
import { mockProjects, mockStatus } from '@/api/fixtures/mock'
import { describeItem, itemRoot, type ItemSources } from '@/advanced/item-describe'
import { groupRows } from '@/advanced/split-rows'
import { githubItemId } from '@/github/review-model'
import { dropItem, itemKey, singlePane } from '@/panes/pane-model'
import { changeShown, layoutOf, type Layout } from '@/panes/split-groups'

const session = mockProjects[0]?.worktrees[0]?.sessions[0]
const sessionRoot = mockProjects[0]?.worktrees[0]?.path ?? ''
const dispatch = mockStatus.dispatches[0]

const sources: ItemSources = {
  status: mockStatus,
  sessionRows: [],
  findSession: (id) => (session !== undefined && id === session.sessionId ? { session, worktreePath: sessionRoot } : null),
  nativeChats: [],
  startedChat: null,
  terminals: [],
  launcherRoots: { 'launcher:new': '/wt/picked' },
  projects: mockProjects,
  chatsInWorktrees: {},
  terminalsInWorktrees: {},
}

/** One item, then each of the others split to its right: what Split right builds from the focused pane. */
function splitOf(items: string[]): Layout {
  const [first, ...rest] = items
  let layout = layoutOf(singlePane(first ?? '', 'p0'), 'g0')
  rest.forEach((item, index) => {
    layout = changeShown(layout, (panes) => dropItem(panes, item, `p${index}`, 'right', `p${index + 1}`), 'g1')
  })
  return layout
}

describe('a split describes every member', () => {
  // Split right puts a launcher beside the focused item; describing it once read the window's rootOf
  // before it was declared, which threw and blanked the window (Cmd+D).
  test('a launcher split beside a chat describes both, with their worktrees', () => {
    const items = [itemKey('session', session?.sessionId ?? ''), 'launcher:new']
    const rows = groupRows(splitOf(items), (item) => describeItem(sources, item))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.members.map((member) => [member.title, member.worktree])).toEqual([
      [session?.title ?? '', sessionRoot],
      ['New chat', null],
    ])
  })

  test('every kind whose worktree comes from its root is described in a split', () => {
    const github = itemKey('github', githubItemId('pr', 83, '/wt/github'))
    const items = [itemKey('dispatch', dispatch?.dispatchId ?? ''), github, itemKey('code', sessionRoot), 'launcher:new']
    const rows = groupRows(splitOf(items), (item) => describeItem(sources, item))
    expect(rows[0]?.members.map((member) => member.worktree)).toEqual([dispatch?.worktreePath ?? null, '/wt/github', sessionRoot, null])
    expect(rows[0]?.members.map((member) => member.mark.kind)).toEqual(['agent', 'github', 'code', 'launcher'])
  })

  test('the root of an item is where its commands run', () => {
    expect(itemRoot(sources, 'launcher:new')).toBe('/wt/picked')
    expect(itemRoot(sources, 'launcher:other')).toBeNull()
    expect(itemRoot(sources, itemKey('session', 'claude:unknown'))).toBeNull()
    expect(itemRoot(sources, itemKey('tasks', 'tasks'))).toBeNull()
  })
})
