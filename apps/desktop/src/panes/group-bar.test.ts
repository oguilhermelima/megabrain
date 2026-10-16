import { describe, expect, test } from 'bun:test'
import type { Project } from '@/api/schema'
import { groupIdentity, limitAgents, limitsPlace, sharedWorktree, splitCodeShown, type SplitMember } from '@/panes/group-bar'

const member = (item: string, worktree: string | null, agent: string | null = 'claude'): SplitMember => {
  const kind = item.split(':', 1)[0]
  return { item, kind: kind === 'dispatch' || kind === 'session' || kind === 'native' || kind === 'terminal' || kind === 'launcher' || kind === 'github' || kind === 'code' ? kind : null, worktree, agent }
}

describe('sharedWorktree', () => {
  test('four chats on one worktree share its bar', () => {
    const members = ['native:a', 'native:b', 'session:c', 'dispatch:d'].map((item) => member(item, '/w/juntin'))
    expect(sharedWorktree(members)).toBe('/w/juntin')
  })

  test('terminals and a launcher on the same worktree count as members', () => {
    expect(sharedWorktree([member('terminal:t', '/w/a', null), member('launcher:l', '/w/a', null), member('native:n', '/w/a')])).toBe('/w/a')
  })

  test('one pane alone has no shared bar: its own header is the bar', () => {
    expect(sharedWorktree([member('native:a', '/w/a')])).toBeNull()
    expect(sharedWorktree([])).toBeNull()
  })

  test('two worktrees in one split keep their own headers', () => {
    expect(sharedWorktree([member('native:a', '/w/a'), member('native:b', '/w/b')])).toBeNull()
  })

  test('a member with no worktree yet keeps the split on per-pane headers', () => {
    expect(sharedWorktree([member('native:a', '/w/a'), member('launcher:l', null, null)])).toBeNull()
    expect(sharedWorktree([member('native:a', '/w/a'), member('native:b', '')])).toBeNull()
  })

  test('a GitHub item or a Code item in the split keeps per-pane headers', () => {
    expect(sharedWorktree([member('native:a', '/w/a'), member('github:pr', '/w/a', null)])).toBeNull()
    expect(sharedWorktree([member('native:a', '/w/a'), member('code:/w/a', '/w/a', null)])).toBeNull()
  })

  test('an item that does not parse keeps per-pane headers', () => {
    expect(sharedWorktree([member('native:a', '/w/a'), { item: 'nonsense', kind: null, worktree: '/w/a', agent: null }])).toBeNull()
  })
})

describe('limitsPlace', () => {
  test('one pane keeps the limits under its composer', () => {
    expect(limitsPlace({ panes: 1, shared: false })).toBe('composer')
  })

  test('a split on one worktree shows them once, in its bar', () => {
    expect(limitsPlace({ panes: 4, shared: true })).toBe('group-bar')
  })

  test('a split across worktrees shows them once, under the split', () => {
    expect(limitsPlace({ panes: 2, shared: false })).toBe('under-split')
  })
})

describe('limitAgents', () => {
  test('each agent once, in pane order, skipping members with no agent', () => {
    const members = [member('native:a', '/w/a', 'claude'), member('terminal:t', '/w/a', null), member('native:b', '/w/a', 'codex'), member('session:c', '/w/a', 'claude')]
    expect(limitAgents(members)).toEqual(['claude', 'codex'])
  })

  test('a split with no agent shows no limits', () => {
    expect(limitAgents([member('terminal:t', '/w/a', null), member('launcher:l', '/w/a', null)])).toEqual([])
  })
})

describe('splitCodeShown', () => {
  test('Code on the bar asks for the worktree\'s one Code server, held by the split', () => {
    expect(splitCodeShown({ groupId: 'g1', root: '/w/a', view: 'code' })).toEqual({ item: 'split:g1', root: '/w/a' })
  })

  test('Agent, PR and Diff need no Code server', () => {
    for (const view of ['agent', 'pr', 'diff'] as const) expect(splitCodeShown({ groupId: 'g1', root: '/w/a', view })).toBeNull()
  })
})

describe('groupIdentity', () => {
  const project = {
    name: 'juntin',
    path: '/r/juntin',
    worktrees: [{ path: '/w/juntin-feat', branch: 'feat/x', parent: 'main', pullRequest: { number: 12 } }],
  } as unknown as Project

  test('names the project, the branch and its pull request', () => {
    const identity = groupIdentity([project], '/w/juntin-feat')
    expect(identity.project).toBe(project)
    expect(identity.name).toBe('juntin')
    expect(identity.branch).toBe('feat/x')
    expect(identity.pullRequest).toBe(12)
  })

  test('the name the person gave the project wins over its folder', () => {
    const renamed = { ...project, appearance: { name: 'Juntin app' } } as unknown as Project
    expect(groupIdentity([renamed], '/w/juntin-feat').name).toBe('Juntin app')
  })

  test('an unknown worktree is named by its folder', () => {
    expect(groupIdentity([project], '/w/elsewhere')).toEqual({ project: null, name: 'elsewhere', branch: null, pullRequest: null })
  })
})
