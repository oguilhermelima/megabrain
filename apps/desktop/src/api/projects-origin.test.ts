import { describe, expect, test } from 'bun:test'
import { createMockApi } from '@/api/mock'
import { projectsArgs, sessionsOfOrigin } from '@/api/projects-origin'
import type { Project, ProjectSession } from '@/api/schema'

const session = (sessionId: string, origin?: 'megabrain' | 'external'): ProjectSession => ({
  agent: 'claude',
  sessionId,
  title: sessionId,
  status: 'idle',
  startedAt: null,
  lastActivityAt: null,
  dispatchId: null,
  ...(origin === undefined ? {} : { origin }),
})

const project = (sessions: ProjectSession[]): Project =>
  ({
    name: 'canto',
    path: '/repo/canto',
    worktrees: [{ path: '/repo/canto', branch: 'main', head: null, primary: true, parent: null, pullRequest: null, sessions }],
  }) as unknown as Project

const ids = (projects: Project[]) => projects.flatMap((item) => item.worktrees.flatMap((worktree) => worktree.sessions.map((entry) => entry.sessionId)))

describe('projectsArgs', () => {
  test('the app asks the CLI for megabrain sessions only', () => {
    expect(projectsArgs('megabrain')).toEqual(['projects', '--origin', 'megabrain', '--json'])
  })

  test('all is the CLI default, so it sends no filter', () => {
    expect(projectsArgs('all')).toEqual(['projects', '--json'])
  })
})

describe('sessionsOfOrigin', () => {
  const listed = [project([session('claude:mine', 'megabrain'), session('claude:orca', 'external'), session('claude:old')])]

  test('megabrain keeps only sessions megabrain started', () => {
    expect(ids(sessionsOfOrigin(listed, 'megabrain'))).toEqual(['claude:mine'])
  })

  test('a session without an origin, from an older CLI, is not shown as megabrain', () => {
    expect(ids(sessionsOfOrigin([project([session('claude:old')])], 'megabrain'))).toEqual([])
  })

  test('the worktree stays when its sessions are all external', () => {
    const [kept] = sessionsOfOrigin([project([session('claude:orca', 'external')])], 'megabrain')
    expect(kept?.worktrees).toHaveLength(1)
    expect(kept?.worktrees[0]?.sessions).toEqual([])
  })

  test('all leaves every session', () => {
    expect(ids(sessionsOfOrigin(listed, 'all'))).toEqual(['claude:mine', 'claude:orca', 'claude:old'])
  })
})

describe('mock projects', () => {
  test('the fixture has external sessions and the megabrain filter drops them', async () => {
    const api = createMockApi()
    const every = await api.projects('all')
    const own = await api.projects('megabrain')
    const all = every.flatMap((item) => item.worktrees.flatMap((worktree) => worktree.sessions))
    expect(all.some((entry) => entry.origin === 'external')).toBe(true)
    const mine = own.flatMap((item) => item.worktrees.flatMap((worktree) => worktree.sessions))
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((entry) => entry.origin === 'megabrain')).toBe(true)
  })
})
