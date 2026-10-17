import { describe, expect, test } from 'bun:test'
import type { SummariesList, Summary } from '@/api/schema'
import { branchCount, branchLive, foldKey, groupSummaries, neighbours, newestSummary, summariesItem, summariesItemIn, summaryOfItem } from '@/advanced/summaries-model'

const summary = (id: string, createdAt: string, extra: Partial<Summary> = {}): Summary => ({
  id,
  repo: '/work/canto',
  project: 'canto',
  worktree: '/work/canto',
  branch: 'main',
  chatId: `chat-${id}`,
  agent: 'claude',
  title: `summary ${id}`,
  text: 'what happened',
  model: 'claude-haiku-5-5',
  createdAt,
  ...extra,
})

const always = () => true

describe('groupSummaries', () => {
  test('puts each summary under its repository and branch', () => {
    const grouped = groupSummaries(
      [
        summary('a', '2026-10-16T10:00:00.000Z'),
        summary('b', '2026-10-16T11:00:00.000Z', { branch: 'feat/x', worktree: '/work/wt/feat-x' }),
        summary('c', '2026-10-16T09:00:00.000Z', { repo: '/work/juntin', project: 'juntin', worktree: '/work/juntin' }),
      ],
      always,
    )
    expect(grouped.map((project) => [project.repo, project.project, project.branches.map((branch) => [branch.branch, branch.worktree, branch.summaries.map((entry) => entry.id)])])).toEqual([
      ['/work/canto', 'canto', [['feat/x', '/work/wt/feat-x', ['b']], ['main', '/work/canto', ['a']]]],
      ['/work/juntin', 'juntin', [['main', '/work/juntin', ['c']]]],
    ])
  })

  test('orders projects and branches by their latest summary, and each branch newest first', () => {
    const grouped = groupSummaries(
      [
        summary('old-main', '2026-10-10T10:00:00.000Z'),
        summary('juntin', '2026-10-15T10:00:00.000Z', { repo: '/work/juntin', project: 'juntin' }),
        summary('new-main', '2026-10-16T10:00:00.000Z'),
        summary('feat', '2026-10-12T10:00:00.000Z', { branch: 'feat/x' }),
      ],
      always,
    )
    expect(grouped.map((project) => project.project)).toEqual(['canto', 'juntin'])
    expect(grouped[0]?.branches.map((branch) => branch.branch)).toEqual(['main', 'feat/x'])
    expect(grouped[0]?.branches[0]?.summaries.map((entry) => entry.id)).toEqual(['new-main', 'old-main'])
  })

  test('the same branch in two repositories stays two branches', () => {
    const grouped = groupSummaries([summary('a', '2026-10-16T10:00:00.000Z'), summary('b', '2026-10-16T09:00:00.000Z', { repo: '/work/juntin', project: 'juntin' })], always)
    expect(grouped.map((project) => project.branches.map((branch) => branch.summaries.map((entry) => entry.id)))).toEqual([[['a']], [['b']]])
  })

  test('a branch takes the worktree of its newest summary, and is live as the caller says', () => {
    const grouped = groupSummaries(
      [summary('new', '2026-10-16T10:00:00.000Z', { branch: 'feat/x', worktree: '/work/wt/new' }), summary('old', '2026-10-15T10:00:00.000Z', { branch: 'feat/x', worktree: '/work/wt/old' })],
      (repo, branch) => !(repo === '/work/canto' && branch === 'feat/x'),
    )
    expect(grouped[0]?.branches[0]).toMatchObject({ branch: 'feat/x', worktree: '/work/wt/new', live: false })
  })

  test('caps each branch at the limit, keeping the newest', () => {
    const entries = ['1', '2', '3', '4'].map((id) => summary(id, `2026-10-1${id}T10:00:00.000Z`))
    expect(groupSummaries(entries, always, 2)[0]?.branches[0]?.summaries.map((entry) => entry.id)).toEqual(['4', '3'])
  })

  test('nothing to group is no projects', () => {
    expect(groupSummaries([], always)).toEqual([])
  })
})

describe('branchLive', () => {
  const list: SummariesList = {
    projects: [
      {
        repo: '/work/canto',
        project: 'canto',
        branches: [
          { branch: 'main', worktree: '/work/canto', live: true, summaries: [] },
          { branch: 'feat/gone', worktree: '/work/wt/gone', live: false, summaries: [] },
        ],
      },
    ],
  }

  test('answers from the listed branches, so a search result keeps the muted look of a gone worktree', () => {
    const live = branchLive(list)
    expect(live('/work/canto', 'main')).toBe(true)
    expect(live('/work/canto', 'feat/gone')).toBe(false)
  })

  test('a branch the list does not name counts as live', () => {
    expect(branchLive(list)('/work/juntin', 'main')).toBe(true)
    expect(branchLive(null)('/work/canto', 'feat/gone')).toBe(true)
  })
})

describe('branchCount', () => {
  test('counts the summaries, and a full page reads as at least that many', () => {
    expect(branchCount(3, 5)).toBe('3')
    expect(branchCount(5, 5)).toBe('5+')
  })
})

describe('neighbours', () => {
  const branch = [summary('c', '2026-10-16T12:00:00.000Z'), summary('b', '2026-10-16T11:00:00.000Z'), summary('a', '2026-10-16T10:00:00.000Z')]

  test('the newer and older summary of the same branch', () => {
    expect(neighbours(branch, 'b')).toEqual({ newer: branch[0] ?? null, older: branch[2] ?? null })
  })

  test('the ends have no newer or no older one', () => {
    expect(neighbours(branch, 'c')).toEqual({ newer: null, older: branch[1] ?? null })
    expect(neighbours(branch, 'a')).toEqual({ newer: branch[1] ?? null, older: null })
  })

  test('a summary the branch does not list has neither', () => {
    expect(neighbours(branch, 'x')).toEqual({ newer: null, older: null })
  })
})

describe('the Summaries page item', () => {
  test('is keyed by the summary it shows', () => {
    expect(summariesItem('sum-0001')).toBe('summary:sum-0001')
    expect(summaryOfItem('sum-0001')).toBe('sum-0001')
  })

  test('with nothing picked it is the latest page, which picks no summary', () => {
    expect(summariesItem(null)).toBe('summary:latest')
    expect(summaryOfItem('latest')).toBeNull()
  })

  test('the layout holds one Summaries page: the first summary item among its items', () => {
    expect(summariesItemIn(['native:a', 'summary:sum-0002', 'terminal:t', 'summary:sum-0003'])).toBe('summary:sum-0002')
    expect(summariesItemIn(['native:a', 'project:/work/canto'])).toBeNull()
    expect(summariesItemIn([])).toBeNull()
  })
})

describe('newestSummary', () => {
  test("is the first project's first branch's first summary, the list being by latest activity", () => {
    const grouped = groupSummaries([summary('old', '2026-10-10T10:00:00.000Z'), summary('new', '2026-10-16T10:00:00.000Z', { repo: '/work/juntin', project: 'juntin' })], always)
    expect(newestSummary(grouped)?.id).toBe('new')
  })

  test('none when nothing is listed', () => {
    expect(newestSummary([])).toBeNull()
    expect(newestSummary(null)).toBeNull()
  })
})

describe('folding the page navigation', () => {
  test('a project and each of its branches fold under keys of their own', () => {
    expect(foldKey('/work/canto')).toBe('/work/canto')
    expect(foldKey('/work/canto', 'main')).not.toBe(foldKey('/work/canto'))
    expect(foldKey('/work/canto', 'main')).not.toBe(foldKey('/work/juntin', 'main'))
  })

  test('a branch whose name holds a slash stays apart from another project', () => {
    expect(foldKey('/work/a', 'b/c')).not.toBe(foldKey('/work/a/b', 'c'))
  })
})
