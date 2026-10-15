import { describe, expect, test } from 'bun:test'
import type { Project, ProjectSession } from '@/api/schema'
import { mockProjects } from '@/api/fixtures/mock'
import { neighbourSession, projectWorktreeRows, relativeAge, sidebarSessionOrder, sortSessions } from '@/advanced/projects-model'

const canto = mockProjects.find((project) => project.name === 'canto') as Project
const megabrain = mockProjects.find((project) => project.name === 'megabrain') as Project

describe('projectWorktreeRows', () => {
  test('puts the primary worktree first', () => {
    const rows = projectWorktreeRows(canto)
    expect(rows[0]?.worktree.primary).toBe(true)
    expect(rows[0]?.worktree.branch).toBe('main')
  })

  test('nests a stacked worktree under its parent', () => {
    const rows = projectWorktreeRows(megabrain)
    const panel = rows.find((row) => row.worktree.branch === 'feat/desktop-panel')
    const columns = rows.find((row) => row.worktree.branch === 'feat/desktop-panel-columns')
    expect(panel?.depth).toBe(1)
    expect(columns?.depth).toBe(2)
  })

  test('includes a detached worktree with no session', () => {
    const rows = projectWorktreeRows(canto)
    const detached = rows.find((row) => row.worktree.branch === null)
    expect(detached).toBeDefined()
    expect(detached?.worktree.sessions).toEqual([])
  })

  test('a project with only its primary checkout has exactly one row', () => {
    const stack = mockProjects.find((project) => project.name === 'stack') as Project
    expect(projectWorktreeRows(stack)).toHaveLength(1)
  })
})

describe('sortSessions', () => {
  const working: ProjectSession = { agent: 'claude', sessionId: 'claude:1', title: 'a', status: 'working', startedAt: null, lastActivityAt: '2026-10-15T12:00:00.000Z', dispatchId: null }
  const olderWorking: ProjectSession = { agent: 'claude', sessionId: 'claude:2', title: 'b', status: 'idle', startedAt: null, lastActivityAt: '2026-10-15T11:00:00.000Z', dispatchId: null }
  const ended: ProjectSession = { agent: 'grok', sessionId: 'grok:1', title: 'c', status: 'ended', startedAt: null, lastActivityAt: '2026-10-15T13:00:00.000Z', dispatchId: null }

  test('ended sessions sort after live ones regardless of recency', () => {
    expect(sortSessions([ended, olderWorking, working]).map((session) => session.sessionId)).toEqual(['claude:1', 'claude:2', 'grok:1'])
  })
})

describe('relativeAge', () => {
  const now = Date.parse('2026-10-15T12:00:00.000Z')

  test('under a minute reads now', () => {
    expect(relativeAge('2026-10-15T11:59:30.000Z', now)).toBe('now')
  })

  test('minutes, hours and days', () => {
    expect(relativeAge('2026-10-15T11:59:00.000Z', now)).toBe('1m')
    expect(relativeAge('2026-10-15T10:00:00.000Z', now)).toBe('2h')
    expect(relativeAge('2026-10-13T12:00:00.000Z', now)).toBe('2d')
  })

  test('no timestamp reads empty', () => {
    expect(relativeAge(null, now)).toBe('')
  })
})

describe('sidebarSessionOrder and neighbourSession', () => {
  test('skips a collapsed project', () => {
    const rows = sidebarSessionOrder(mockProjects, new Set(['canto']))
    expect(rows.some((row) => row.projectName === 'canto')).toBe(false)
    expect(rows.some((row) => row.projectName === 'megabrain')).toBe(true)
  })

  test('walks across project boundaries and wraps', () => {
    const rows = sidebarSessionOrder(mockProjects, new Set())
    const first = rows[0] as { session: ProjectSession }
    const next = neighbourSession(rows, first.session.sessionId, 1)
    expect(next).not.toBeNull()
    expect(next?.session.sessionId).not.toBe(first.session.sessionId)
    const wrapped = neighbourSession(rows, rows[rows.length - 1]?.session.sessionId ?? null, 1)
    expect(wrapped?.session.sessionId).toBe(first.session.sessionId)
  })

  test('no selection starts at the first row', () => {
    const rows = sidebarSessionOrder(mockProjects, new Set())
    expect(neighbourSession(rows, null, 1)).toEqual(rows[0] ?? null)
  })
})
