import { describe, expect, test } from 'bun:test'
import type { Project, ProjectSession } from '@/api/schema'
import { mockProjects } from '@/api/fixtures/mock'
import { activeFilterLabels, emptyFilters, filterProjects, hasFilters, parseFilters, partitionHidden, sessionTimer, type SidebarFilters } from '@/advanced/sidebar-model'

const filters = (overrides: Partial<SidebarFilters>): SidebarFilters => ({ ...emptyFilters, ...overrides })
const branches = (projects: Project[]) => projects.flatMap((project) => project.worktrees.map((worktree) => `${project.name}:${worktree.branch ?? 'detached'}`))
const { visible } = partitionHidden(mockProjects)

describe('partitionHidden', () => {
  test('moves hidden projects out of the list', () => {
    const result = partitionHidden(mockProjects)
    expect(result.visible.map((project) => project.name)).toEqual(['stack', 'canto', 'megabrain', 'old-thing'])
    expect(result.hiddenProjects.map((project) => project.name)).toEqual(['archive'])
  })

  test('moves hidden worktrees out of their project and names the project', () => {
    const result = partitionHidden(mockProjects)
    const canto = result.visible.find((project) => project.name === 'canto')
    expect(canto?.worktrees.some((worktree) => worktree.hidden === true)).toBe(false)
    expect(canto?.worktrees).toHaveLength(3)
    expect(result.hiddenWorktrees.map((item) => [item.project.name, item.worktree.path])).toEqual([['canto', '/Users/operator/Workspaces/Worktrees/canto-detached']])
  })

  test('does not list the worktrees of a hidden project separately', () => {
    const project: Project = { name: 'p', path: '/p', remote: null, source: 'import', missing: false, hidden: true, worktrees: [{ path: '/p/w', hidden: true, branch: 'w', head: null, primary: false, parent: null, pullRequest: null, sessions: [] }] }
    const result = partitionHidden([project])
    expect(result.hiddenProjects).toHaveLength(1)
    expect(result.hiddenWorktrees).toHaveLength(0)
  })
})

describe('filterProjects', () => {
  test('returns everything when no filter is set', () => {
    expect(filterProjects(visible, emptyFilters)).toEqual(visible)
  })

  test('search matches a project name and keeps all its worktrees', () => {
    expect(branches(filterProjects(visible, filters({ query: 'CANTO' })))).toEqual(['canto:main', 'canto:fix/player-seek', 'canto:feat/extension'])
  })

  test('search matches a branch', () => {
    expect(branches(filterProjects(visible, filters({ query: 'player-seek' })))).toEqual(['canto:fix/player-seek'])
  })

  test('search matches a session title', () => {
    expect(branches(filterProjects(visible, filters({ query: 'backups' })))).toEqual(['stack:main'])
  })

  test('search with no match returns nothing', () => {
    expect(filterProjects(visible, filters({ query: 'zzz-nothing' }))).toEqual([])
  })

  test('Active keeps only worktrees with a live session', () => {
    const result = branches(filterProjects(visible, filters({ active: true })))
    expect(result).toContain('stack:main')
    expect(result).toContain('canto:fix/player-seek')
    expect(result).not.toContain('megabrain:chore/old-probe')
    expect(result.some((item) => item.startsWith('old-thing'))).toBe(false)
  })

  test('Needs you keeps only worktrees with a waiting session', () => {
    expect(branches(filterProjects(visible, filters({ needsYou: true })))).toEqual(['canto:fix/player-seek'])
  })

  test('an agent filter keeps worktrees with a session of that agent', () => {
    expect(branches(filterProjects(visible, filters({ agents: ['grok'] })))).toEqual(['megabrain:chore/old-probe'])
  })

  test('several agents match any of them', () => {
    const result = branches(filterProjects(visible, filters({ agents: ['grok', 'codex'] })))
    expect(result).toEqual(['canto:fix/player-seek', 'canto:feat/extension', 'megabrain:feat/desktop-panel', 'megabrain:chore/old-probe'])
  })

  test('PR open keeps worktrees with an open pull request', () => {
    expect(branches(filterProjects(visible, filters({ pr: 'open' })))).toEqual(['canto:fix/player-seek', 'megabrain:feat/desktop-panel', 'megabrain:feat/desktop-panel-columns'])
  })

  test('PR none keeps worktrees without a pull request', () => {
    expect(branches(filterProjects(visible, filters({ pr: 'none' })))).toEqual(['stack:main', 'canto:main', 'canto:feat/extension', 'megabrain:main'])
  })

  test('filters combine with and', () => {
    expect(branches(filterProjects(visible, filters({ agents: ['claude'], pr: 'open' })))).toEqual(['megabrain:feat/desktop-panel-columns'])
    expect(branches(filterProjects(visible, filters({ active: true, agents: ['codex'], query: 'extension' })))).toEqual(['canto:feat/extension'])
  })

  test('a chip filter applies inside a project matched by name', () => {
    expect(branches(filterProjects(visible, filters({ query: 'megabrain', pr: 'open' })))).toEqual(['megabrain:feat/desktop-panel', 'megabrain:feat/desktop-panel-columns'])
  })

  test('drops projects left without worktrees, including missing ones', () => {
    const names = filterProjects(visible, filters({ needsYou: true })).map((project) => project.name)
    expect(names).toEqual(['canto'])
  })
})

describe('filter labels and storage', () => {
  test('hasFilters is false only for the empty filter', () => {
    expect(hasFilters(emptyFilters)).toBe(false)
    expect(hasFilters(filters({ query: '  ' }))).toBe(false)
    expect(hasFilters(filters({ pr: 'none' }))).toBe(true)
  })

  test('names each active filter for the empty message', () => {
    expect(activeFilterLabels(filters({ query: 'x', active: true, needsYou: true, agents: ['codex', 'agy'], pr: 'open' }))).toEqual(['search "x"', 'Active', 'Needs you', 'codex', 'agy', 'PR open'])
    expect(activeFilterLabels(filters({ pr: 'none' }))).toEqual(['no PR'])
  })

  test('parses stored filters and drops what it does not know', () => {
    expect(parseFilters(JSON.stringify({ query: 'a', active: true, needsYou: false, agents: ['claude', 'other'], pr: 'open' }))).toEqual(filters({ query: 'a', active: true, agents: ['claude'], pr: 'open' }))
    expect(parseFilters('not json')).toEqual(emptyFilters)
    expect(parseFilters(null)).toEqual(emptyFilters)
    expect(parseFilters(JSON.stringify({ pr: 'maybe', agents: 'claude' }))).toEqual(emptyFilters)
  })
})

describe('sessionTimer', () => {
  const now = Date.parse('2026-10-15T12:00:00.000Z')
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()
  const session = (overrides: Partial<ProjectSession>): ProjectSession => ({
    agent: 'claude',
    sessionId: 'claude:1',
    title: 't',
    status: 'idle',
    startedAt: null,
    lastActivityAt: null,
    dispatchId: null,
    ...overrides,
  })

  test('shows the compaction as a clock when it comes first', () => {
    expect(sessionTimer(session({ idleCompactAt: at(13), cacheExpiresAt: at(19) }), now)).toEqual({ kind: 'compact', text: '13m', label: 'Compacts in 13 minutes', tone: 'yellow' })
  })

  test('shows the cache when it comes first or compaction is unknown', () => {
    expect(sessionTimer(session({ idleCompactAt: at(30), cacheExpiresAt: at(19) }), now)).toEqual({ kind: 'cache', text: '19m', label: 'Prompt cache expires in 19 minutes', tone: 'yellow' })
    expect(sessionTimer(session({ cacheExpiresAt: at(19) }), now)).toEqual({ kind: 'cache', text: '19m', label: 'Prompt cache expires in 19 minutes', tone: 'yellow' })
  })

  test('moves on to the cache once compaction has passed', () => {
    expect(sessionTimer(session({ idleCompactAt: at(-1), cacheExpiresAt: at(5) }), now)).toEqual({ kind: 'cache', text: '5m', label: 'Prompt cache expires in 5 minutes', tone: 'red' })
  })

  test('is green above 30 minutes, yellow from 10 to 30, red under 10', () => {
    expect(sessionTimer(session({ idleCompactAt: at(47) }), now)?.tone).toBe('green')
    expect(sessionTimer(session({ idleCompactAt: at(30.1) }), now)?.tone).toBe('green')
    expect(sessionTimer(session({ idleCompactAt: at(30) }), now)?.tone).toBe('yellow')
    expect(sessionTimer(session({ idleCompactAt: at(10) }), now)?.tone).toBe('yellow')
    expect(sessionTimer(session({ idleCompactAt: at(9.9) }), now)?.tone).toBe('red')
    expect(sessionTimer(session({ idleCompactAt: at(0.5) }), now)?.tone).toBe('red')
  })

  test('rounds the minutes up so the last minute still reads 1m, in the singular', () => {
    expect(sessionTimer(session({ cacheExpiresAt: at(0.5) }), now)).toMatchObject({ text: '1m', label: 'Prompt cache expires in 1 minute' })
    expect(sessionTimer(session({ idleCompactAt: at(12.2) }), now)).toMatchObject({ text: '13m', label: 'Compacts in 13 minutes' })
  })

  test('shows nothing once both times have passed', () => {
    expect(sessionTimer(session({ idleCompactAt: at(-5), cacheExpiresAt: at(0) }), now)).toBeNull()
  })

  test('shows nothing while working, for other agents, or without times', () => {
    expect(sessionTimer(session({ status: 'working', cacheExpiresAt: at(19) }), now)).toBeNull()
    expect(sessionTimer(session({ agent: 'codex', cacheExpiresAt: at(19) }), now)).toBeNull()
    expect(sessionTimer(session({ cacheExpiresAt: null, idleCompactAt: null }), now)).toBeNull()
    expect(sessionTimer(session({}), now)).toBeNull()
  })
})
