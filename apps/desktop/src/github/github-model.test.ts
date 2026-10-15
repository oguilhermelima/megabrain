import { describe, expect, test } from 'bun:test'
import type { GithubCheck, GithubIssue, GithubPullRequest } from '@/api/schema'
import { mockGithubIssues, mockGithubPullRequests } from '@/api/fixtures/mock'
import {
  avatarUrl,
  checkSummary,
  countBadge,
  emptyIssueFilters,
  emptyPullRequestFilters,
  filterIssues,
  filterPullRequests,
  githubRepository,
  issueFilterOptions,
  issueTabCounts,
  labelStyle,
  pullRequestFilterOptions,
  pullRequestTabCounts,
  pullRequestVisualState,
  stateColors,
  worktreePullRequestState,
} from '@/github/github-model'

const prs = mockGithubPullRequests.items
const issues = mockGithubIssues.items
const pr = (number: number) => prs.find((item) => item.number === number) as GithubPullRequest
const numbers = (items: { number: number }[]) => items.map((item) => item.number)
const checks = (...states: GithubCheck['state'][]): GithubCheck[] => states.map((state, index) => ({ name: `check-${index}`, state }))

describe('githubRepository', () => {
  test.each([
    ['https://github.com/operator/megabrain', 'operator/megabrain'],
    ['https://github.com/operator/megabrain.git', 'operator/megabrain'],
    ['git@github.com:operator/my.repo.git', 'operator/my.repo'],
    ['ssh://git@github.com/operator/canto.git', 'operator/canto'],
  ])('reads %s as %s', (remote, nameWithOwner) => {
    expect(githubRepository(remote)?.nameWithOwner).toBe(nameWithOwner)
  })

  test('splits owner and name and builds the web address', () => {
    expect(githubRepository('git@github.com:operator/megabrain.git')).toEqual({ owner: 'operator', name: 'megabrain', nameWithOwner: 'operator/megabrain', url: 'https://github.com/operator/megabrain' })
  })

  test.each([[null], ['git@gitlab.com:operator/megabrain.git'], ['https://github.example.com/operator/x'], ['']])('%p has no GitHub repository', (remote) => {
    expect(githubRepository(remote)).toBeNull()
  })
})

describe('tab counts', () => {
  test('pull requests count open, merged, closed and all; drafts are open', () => {
    expect(pullRequestTabCounts(prs)).toEqual({ open: 5, merged: 3, closed: 2, all: 10 })
  })

  test('issues count open, closed and all', () => {
    expect(issueTabCounts(issues)).toEqual({ open: 4, closed: 2, all: 6 })
  })

  test('nothing listed counts zero everywhere', () => {
    expect(pullRequestTabCounts([])).toEqual({ open: 0, merged: 0, closed: 0, all: 0 })
    expect(issueTabCounts([])).toEqual({ open: 0, closed: 0, all: 0 })
  })
})

describe('pull request state colors', () => {
  test('an open draft is drawn as a draft', () => {
    expect(pullRequestVisualState(pr(109))).toBe('draft')
    expect(pullRequestVisualState(pr(112))).toBe('open')
    expect(pullRequestVisualState(pr(107))).toBe('merged')
    expect(pullRequestVisualState(pr(83))).toBe('closed')
  })

  test('open is green, draft grey, merged purple, closed red', () => {
    expect(stateColors).toEqual({ open: '#3fb950', draft: '#8b949e', merged: '#a371f7', closed: '#f85149' })
  })
})

describe('worktreePullRequestState', () => {
  test('reads the upper-case states projects reports, drafts included', () => {
    expect(worktreePullRequestState({ state: 'OPEN' })).toBe('open')
    expect(worktreePullRequestState({ state: 'OPEN', isDraft: true })).toBe('draft')
    expect(worktreePullRequestState({ state: 'MERGED' })).toBe('merged')
    expect(worktreePullRequestState({ state: 'CLOSED', isDraft: true })).toBe('closed')
  })

  test('no pull request or an unknown state keeps the neutral icon', () => {
    expect(worktreePullRequestState(null)).toBeNull()
    expect(worktreePullRequestState({ state: 'QUEUED' })).toBeNull()
  })
})

describe('checkSummary', () => {
  test('any failure fails the whole set', () => {
    expect(checkSummary(checks('success', 'failure', 'pending'))).toEqual({ state: 'failing', passed: 1, failed: 1, pending: 1, skipped: 0, total: 3 })
  })

  test('pending without a failure is pending', () => {
    expect(checkSummary(checks('success', 'pending')).state).toBe('pending')
  })

  test('successes, neutrals and skips pass', () => {
    expect(checkSummary(checks('success', 'neutral', 'skipped'))).toEqual({ state: 'passing', passed: 2, failed: 0, pending: 0, skipped: 1, total: 3 })
  })

  test('no checks at all is none', () => {
    expect(checkSummary([])).toEqual({ state: 'none', passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 })
  })

  test('only skipped checks are none, since nothing ran', () => {
    expect(checkSummary(checks('skipped', 'skipped')).state).toBe('none')
  })
})

describe('filterPullRequests', () => {
  test('each tab keeps its own state, newest update first', () => {
    expect(numbers(filterPullRequests(prs, emptyPullRequestFilters, 'open'))).toEqual([112, 111, 110, 109, 108])
    expect(numbers(filterPullRequests(prs, emptyPullRequestFilters, 'merged'))).toEqual([107, 105, 104])
    expect(numbers(filterPullRequests(prs, emptyPullRequestFilters, 'closed'))).toEqual([84, 83])
    expect(filterPullRequests(prs, emptyPullRequestFilters, 'all')).toHaveLength(10)
  })

  test('search matches the title, number, branch, author and labels, ignoring case', () => {
    const search = (query: string) => numbers(filterPullRequests(prs, { ...emptyPullRequestFilters, query }, 'all'))
    expect(search('LAUNCH LINE')).toEqual([111])
    expect(search('launch line')).toEqual([111])
    expect(search('#105')).toEqual([105])
    expect(search('105')).toEqual([105])
    expect(search('feat/native-capture')).toEqual([109])
    expect(search('dependabot')).toEqual([107])
    expect(search('documentation')).toEqual([108])
    expect(search('   ')).toHaveLength(10)
  })

  test('author, label, draft and review filters combine', () => {
    const filter = (filters: Partial<typeof emptyPullRequestFilters>) => numbers(filterPullRequests(prs, { ...emptyPullRequestFilters, ...filters }, 'all'))
    expect(filter({ author: 'fake-contributor' })).toEqual([110])
    expect(filter({ label: 'desktop' })).toEqual([112, 110, 105])
    expect(filter({ draft: 'draft' })).toEqual([109, 84, 83])
    expect(filter({ draft: 'ready' })).not.toContain(109)
    expect(filter({ review: 'approved' })).toEqual([110, 107, 105, 104])
    expect(filter({ review: 'changes_requested' })).toEqual([111])
    expect(filter({ review: 'none' })).toEqual([109, 108, 84, 83])
    expect(filter({ label: 'desktop', review: 'approved' })).toEqual([110, 105])
  })

  test('filter options list each author and label once, sorted', () => {
    expect(pullRequestFilterOptions(prs)).toEqual({
      authors: ['app/dependabot', 'fake-contributor', 'operator'],
      labels: ['bug', 'dependencies', 'desktop', 'documentation', 'enhancement'],
    })
  })
})

describe('filterIssues', () => {
  test('tabs, search and filters', () => {
    expect(numbers(filterIssues(issues, emptyIssueFilters, 'open'))).toEqual([118, 117, 116, 115])
    expect(numbers(filterIssues(issues, emptyIssueFilters, 'closed'))).toEqual([102, 99])
    expect(numbers(filterIssues(issues, { ...emptyIssueFilters, query: 'tmux' }, 'all'))).toEqual([118])
    expect(numbers(filterIssues(issues, { ...emptyIssueFilters, label: 'bug' }, 'all'))).toEqual([118, 116, 102])
    expect(numbers(filterIssues(issues, { ...emptyIssueFilters, assignee: 'operator' }, 'all'))).toEqual([118, 102])
    expect(numbers(filterIssues(issues, { ...emptyIssueFilters, author: 'fake-contributor' }, 'open'))).toEqual([116])
    expect(numbers(filterIssues(issues, { ...emptyIssueFilters, query: 'v0.3.0' }, 'all'))).toEqual([118, 115])
  })

  test('filter options include assignees', () => {
    expect(issueFilterOptions(issues)).toEqual({ authors: ['fake-contributor', 'operator'], labels: ['bug', 'desktop', 'documentation', 'enhancement', 'good first issue', 'needs-triage'], assignees: ['operator'] })
  })

  test('an issue without labels or author still filters', () => {
    const bare: GithubIssue = { ...(issues[0] as GithubIssue), number: 1, author: null, labels: [], assignees: [] }
    expect(numbers(filterIssues([bare], { ...emptyIssueFilters, label: 'bug' }, 'all'))).toEqual([])
    expect(numbers(filterIssues([bare], emptyIssueFilters, 'all'))).toEqual([1])
  })
})

describe('labelStyle', () => {
  test('tints the chip with the label color and keeps its text readable', () => {
    const style = labelStyle('d73a4a')
    expect(style.backgroundColor).toBe('rgba(215, 58, 74, 0.18)')
    expect(style.borderColor).toBe('rgba(215, 58, 74, 0.45)')
    expect(style.color.startsWith('rgb(')).toBe(true)
  })

  test('a dark label color gets lighter text than its own color', () => {
    const channels = (rgb: string) => (rgb.match(/\d+/g) ?? []).slice(0, 3).map(Number)
    const [red, green, blue] = channels(labelStyle('0e1a5c').color)
    expect((red ?? 0) + (green ?? 0) + (blue ?? 0)).toBeGreaterThan(14 + 26 + 92)
  })

  test('accepts a leading # and falls back to grey on anything else', () => {
    expect(labelStyle('#d73a4a').backgroundColor).toBe('rgba(215, 58, 74, 0.18)')
    expect(labelStyle('nope').backgroundColor).toBe('rgba(139, 148, 158, 0.18)')
  })
})

describe('small helpers', () => {
  test('countBadge hides zero and caps at 99+', () => {
    expect(countBadge(0)).toBeNull()
    expect(countBadge(7)).toBe('7')
    expect(countBadge(99)).toBe('99')
    expect(countBadge(100)).toBe('99+')
  })

  test('avatarUrl uses the GitHub profile picture and has none for apps', () => {
    expect(avatarUrl('operator')).toBe('https://github.com/operator.png?size=64')
    expect(avatarUrl('app/dependabot')).toBeNull()
  })
})
