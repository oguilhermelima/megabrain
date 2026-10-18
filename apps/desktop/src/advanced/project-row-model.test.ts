import { describe, expect, test } from 'bun:test'
import type { NativeChat, Project, ProjectSession } from '@/api/schema'
import { collapseZonePx, projectActivity, projectRowClick, projectRowKey, worktreeActivity, worktreeActivityLabel } from '@/advanced/project-row-model'

const session = (sessionId: string, status: ProjectSession['status']): ProjectSession => ({
  agent: 'claude',
  sessionId,
  title: sessionId,
  status,
  startedAt: null,
  lastActivityAt: null,
  dispatchId: null,
})

const chat = (id: string, cwd: string, state: NativeChat['state']): NativeChat => ({
  id,
  agent: 'claude',
  model: null,
  cwd,
  title: id,
  state,
  mode: 'chat',
  agentSessionId: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  lastActivityAt: null,
})

const project = (sessions: ProjectSession[][]): Project => ({
  name: 'canto',
  path: '/work/canto',
  remote: 'git@github.com:acme/canto.git',
  source: 'import',
  missing: false,
  worktrees: sessions.map((list, index) => ({
    path: index === 0 ? '/work/canto' : `/work/canto-${index}`,
    branch: index === 0 ? 'main' : `feat/${index}`,
    head: null,
    primary: index === 0,
    parent: null,
    pullRequest: null,
    sessions: list,
  })),
})

describe('projectRowClick', () => {
  test('a click on the picture, or the padding before it, folds the project', () => {
    expect(projectRowClick(0, false)).toBe('collapse')
    expect(projectRowClick(12, false)).toBe('collapse')
    expect(projectRowClick(collapseZonePx - 1, false)).toBe('collapse')
  })

  test('a click anywhere past the picture opens the project page', () => {
    expect(projectRowClick(collapseZonePx, false)).toBe('open')
    expect(projectRowClick(120, false)).toBe('open')
  })

  test('a click the keyboard made has no position and opens the page', () => {
    expect(projectRowClick(0, true)).toBe('open')
  })
})

describe('projectRowKey', () => {
  const plain = { altKey: false, metaKey: false, ctrlKey: false, shiftKey: false }

  test('Enter opens the page whether the project is folded or not', () => {
    expect(projectRowKey('Enter', false, plain)).toBe('open')
    expect(projectRowKey('Enter', true, plain)).toBe('open')
  })

  test('Left folds an open project and Right unfolds a folded one', () => {
    expect(projectRowKey('ArrowLeft', false, plain)).toBe('collapse')
    expect(projectRowKey('ArrowRight', true, plain)).toBe('expand')
  })

  test('Left on a folded project and Right on an open one do nothing', () => {
    expect(projectRowKey('ArrowLeft', true, plain)).toBeNull()
    expect(projectRowKey('ArrowRight', false, plain)).toBeNull()
  })

  test('a modifier leaves the key to someone else (⌥↑ ⌥↓ reorder, ⌘ shortcuts)', () => {
    expect(projectRowKey('ArrowLeft', false, { ...plain, altKey: true })).toBeNull()
    expect(projectRowKey('Enter', false, { ...plain, metaKey: true })).toBeNull()
    expect(projectRowKey('ArrowUp', false, plain)).toBeNull()
  })
})

describe('projectActivity', () => {
  test('nothing running is no mark', () => {
    expect(projectActivity(project([[session('claude:1', 'idle')], [session('claude:2', 'ended')]]), {})).toBeNull()
  })

  test('a session working in any worktree marks the project working', () => {
    expect(projectActivity(project([[], [session('claude:2', 'working')]]), {})).toBe('working')
  })

  test('a chat waiting for approval marks it waiting', () => {
    expect(projectActivity(project([[]]), { '/work/canto': [chat('a', '/work/canto', 'waiting-approval')] })).toBe('waiting')
  })

  test('working wins over waiting', () => {
    const chats = { '/work/canto': [chat('a', '/work/canto', 'waiting-approval')], '/work/canto-1': [chat('b', '/work/canto-1', 'starting')] }
    expect(projectActivity(project([[], []]), chats)).toBe('working')
  })

  test("another project's chats do not count", () => {
    expect(projectActivity(project([[]]), { '/elsewhere': [chat('a', '/elsewhere', 'working')] })).toBeNull()
  })
})

describe('worktreeActivity', () => {
  const worktree = (sessions: ProjectSession[]) => project([sessions]).worktrees[0]!

  test('nothing working or waiting shows no mark', () => {
    expect(worktreeActivity(worktree([session('claude:1', 'idle'), session('claude:2', 'ended')]), [chat('a', '/work/canto', 'idle')])).toBeNull()
    expect(worktreeActivity(worktree([]), [])).toBeNull()
  })

  test('counts the working chats and sessions together', () => {
    expect(worktreeActivity(worktree([session('claude:1', 'working')]), [chat('a', '/work/canto', 'working'), chat('b', '/work/canto', 'starting'), chat('c', '/work/canto', 'idle')])).toEqual({ state: 'working', count: 3 })
  })

  test('working wins over waiting, and waiting counts only what waits', () => {
    expect(worktreeActivity(worktree([session('claude:1', 'waiting')]), [chat('a', '/work/canto', 'working')])).toEqual({ state: 'working', count: 1 })
    expect(worktreeActivity(worktree([session('claude:1', 'waiting')]), [chat('a', '/work/canto', 'waiting-approval'), chat('b', '/work/canto', 'idle')])).toEqual({ state: 'waiting', count: 2 })
  })

  test('the mark says how many', () => {
    expect(worktreeActivityLabel({ state: 'working', count: 1 })).toBe('1 chat working')
    expect(worktreeActivityLabel({ state: 'waiting', count: 2 })).toBe('2 chats waiting for you')
  })
})
