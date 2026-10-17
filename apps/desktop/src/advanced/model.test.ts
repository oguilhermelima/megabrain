import { describe, expect, test } from 'bun:test'
import { mockStatus, mockWorktrees } from '@/api/fixtures/mock'
import type { Dispatch, Project } from '@/api/schema'
import { chatState, groupChats, worktreeRepositories } from '@/advanced/model'

function chat(id: string, fields: Partial<Dispatch> = {}): Dispatch {
  return {
    dispatchId: `dispatch-20261015000000000-1-${id}`,
    state: 'running',
    owner: 'foreign',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
    supervision: { lastCheck: null, finding: null },
    ...fields,
  }
}

const worktrees = [
  { path: '/w/fix-seek', branch: 'fix/seek', repository: { name: 'canto', path: '/r/canto' } },
  { path: '/w/feat-tv', branch: 'feat/tv', repository: { name: 'canto', path: '/r/canto' } },
  { path: '/w/docs', branch: 'docs/readme', repository: { name: 'juntin', path: '/r/juntin' } },
]

describe('chatState', () => {
  test('a supervisor finding means the chat needs you, whatever its state', () => {
    expect(chatState(chat('a', { state: 'running', supervision: { lastCheck: null, finding: { cause: 'usage-limit' } } }))).toBe('needs-you')
  })
  test('running and spawning work, queued waits, done and failed have ended', () => {
    expect(chatState(chat('a', { state: 'running' }))).toBe('working')
    expect(chatState(chat('a', { state: 'spawning' }))).toBe('working')
    expect(chatState(chat('a', { state: 'queued' }))).toBe('queued')
    expect(chatState(chat('a', { state: 'done' }))).toBe('ended')
    expect(chatState(chat('a', { state: 'failed' }))).toBe('ended')
  })
})

describe('groupChats', () => {
  test('groups active chats by repository, then worktree, in a stable order', () => {
    const grouped = groupChats(
      [
        chat('a', { worktreePath: '/w/docs', branch: 'docs/readme' }),
        chat('b', { worktreePath: '/w/fix-seek', branch: 'fix/seek' }),
        chat('c', { worktreePath: '/w/feat-tv', branch: 'feat/tv' }),
        chat('d', { worktreePath: '/w/fix-seek', branch: 'fix/seek', createdAt: '2026-10-15T11:00:00.000Z' }),
      ],
      worktrees,
    )
    expect(grouped.repositories.map((repository) => repository.name)).toEqual(['canto', 'juntin'])
    const canto = grouped.repositories[0]
    expect(canto?.worktrees.map((worktree) => worktree.path)).toEqual(['/w/feat-tv', '/w/fix-seek'])
    expect(canto?.worktrees[1]?.chats.map((item) => item.dispatchId.slice(-1))).toEqual(['b', 'd'])
  })
  test('puts ended chats apart, newest first', () => {
    const grouped = groupChats(
      [
        chat('a', { state: 'failed', updatedAt: '2026-09-23T00:00:00.000Z' }),
        chat('b', { state: 'running', worktreePath: '/w/docs' }),
        chat('c', { state: 'done', updatedAt: '2026-10-14T00:00:00.000Z' }),
      ],
      worktrees,
    )
    expect(grouped.ended.map((item) => item.dispatchId.slice(-1))).toEqual(['c', 'a'])
    expect(grouped.repositories.flatMap((repository) => repository.worktrees.flatMap((worktree) => worktree.chats)).map((item) => item.dispatchId.slice(-1))).toEqual(['b'])
  })
  test('a chat whose worktree megabrain does not list is grouped by its folder name', () => {
    const grouped = groupChats([chat('a', { worktreePath: '/Users/operator/Workspaces/megabrain' })], worktrees)
    expect(grouped.repositories.map((repository) => repository.name)).toEqual(['megabrain'])
  })
  test('a chat with no worktree at all goes under Other', () => {
    const grouped = groupChats([chat('a', { worktreePath: null })], worktrees)
    expect(grouped.repositories.map((repository) => repository.name)).toEqual(['Other'])
  })
  test('the mock groups into more than one repository', () => {
    expect(groupChats(mockStatus.dispatches, mockWorktrees).repositories.length).toBeGreaterThan(1)
  })
})

describe('worktreeRepositories', () => {
  const project = (name: string, path: string, worktrees: string[]): Project => ({
    name,
    path,
    remote: null,
    source: 'megabrain',
    missing: false,
    worktrees: worktrees.map((worktree, index) => ({ path: worktree, branch: `b${index}`, head: null, primary: index === 0, parent: null, pullRequest: null, sessions: [] })),
  })

  test('names every worktree of a project after its main checkout folder, as worktree list does', () => {
    const listed = worktreeRepositories([project('Canto', '/Users/o/canto-space', ['/Users/o/canto-space', '/w/fix-seek']), project('juntin', '/Users/o/juntin', ['/Users/o/juntin'])])
    expect(listed).toEqual([
      { path: '/Users/o/canto-space', repository: { name: 'canto-space' } },
      { path: '/w/fix-seek', repository: { name: 'canto-space' } },
      { path: '/Users/o/juntin', repository: { name: 'juntin' } },
    ])
  })

  test('groups chats the same way the worktree list did', () => {
    const fromProjects = worktreeRepositories([project('c', '/Users/o/canto', ['/Users/o/canto', '/w/docs', '/w/fix-seek', '/w/feat-tv'])])
    const grouped = groupChats([chat('a', { worktreePath: '/w/docs' }), chat('b', { worktreePath: '/w/feat-tv' })], fromProjects)
    expect(grouped.repositories.map((repository) => repository.name)).toEqual(['canto'])
  })
})
