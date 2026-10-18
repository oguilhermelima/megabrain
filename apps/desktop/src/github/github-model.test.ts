import { describe, expect, test } from 'bun:test'
import type { GithubCheck, GithubIssue, GithubPullRequest } from '@/api/schema'
import { mockGithubIssues, mockGithubPullRequests } from '@/api/fixtures/mock'
import {
  filtersSet,
  noAssignee,
  avatarUrl,
  checkSummary,
  countBadge,
  emptyIssueFilters,
  emptyPullRequestFilters,
  filterIssues,
  filterPullRequests,
  githubRepository,
  includesAuthor,
  isRepositoryFileLink,
  issueFilterOptions,
  labelStyle,
  otherPeople,
  listRequestKey,
  mergeItems,
  nextPage,
  refreshedPage,
  shareInFlight,
  type GithubPage,
  pullRequestFilterOptions,
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

  test('author, label and draft filters combine', () => {
    const filter = (filters: Partial<typeof emptyPullRequestFilters>) => numbers(filterPullRequests(prs, { ...emptyPullRequestFilters, ...filters }, 'all'))
    expect(filter({ author: 'fake-contributor' })).toEqual([110])
    expect(filter({ label: 'desktop' })).toEqual([112, 110, 105])
    expect(filter({ draft: 'draft' })).toEqual([109, 84, 83])
    expect(filter({ draft: 'ready' })).not.toContain(109)
    expect(filter({ label: 'desktop', draft: 'ready' })).toEqual([112, 110, 105])
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

describe('shareInFlight', () => {
  const deferred = () => {
    let resolve: (value: number) => void = () => {}
    let reject: (cause: unknown) => void = () => {}
    const promise = new Promise<number>((done, fail) => {
      resolve = done
      reject = fail
    })
    return { promise, resolve, reject }
  }

  test('callers asking for the same key while it runs share one request', async () => {
    const share = shareInFlight()
    const pending = deferred()
    let runs = 0
    const run = () => {
      runs += 1
      return pending.promise
    }
    const first = share('prs open', run)
    const second = share('prs open', run)
    const third = share('prs open', run)
    expect(runs).toBe(1)
    pending.resolve(7)
    expect(await Promise.all([first, second, third])).toEqual([7, 7, 7])
  })

  test('another key runs on its own', async () => {
    const share = shareInFlight()
    let runs = 0
    const run = async () => ++runs
    expect(await Promise.all([share('prs open', run), share('prs merged', run), share('issues open', run)])).toEqual([1, 2, 3])
  })

  test('a settled request is asked again the next time', async () => {
    const share = shareInFlight()
    let runs = 0
    const run = async () => ++runs
    expect(await share('prs open', run)).toBe(1)
    expect(await share('prs open', run)).toBe(2)
  })

  test('a failure reaches every caller and is not kept', async () => {
    const share = shareInFlight()
    const pending = deferred()
    const first = share('prs all', () => pending.promise)
    const second = share('prs all', () => pending.promise)
    pending.reject(new Error('gh api graphql failed: GitHub timed out, try again'))
    await expect(first).rejects.toThrow('GitHub timed out')
    await expect(second).rejects.toThrow('GitHub timed out')
    expect(await share('prs all', async () => 3)).toBe(3)
  })

  test('the sidebar count and the first page of the open tab are one request', () => {
    expect(listRequestKey('prs', '/repo', 'open', 30, null)).toBe(listRequestKey('prs', '/repo', 'open', 30, null))
    const keys = [
      listRequestKey('prs', '/repo', 'open', 30, null),
      listRequestKey('issues', '/repo', 'open', 30, null),
      listRequestKey('prs', '/repo', 'merged', 30, null),
      listRequestKey('prs', '/repo', 'open', 30, 'Y3Vyc29yOjE='),
      listRequestKey('prs', '/other', 'open', 30, null),
      listRequestKey('prs', '/repo', 'open', 31, null),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('paging', () => {
  const item = (number: number, title = `#${number}`) => ({ number, title })
  const page = (numbers: number[], nextCursor: string | null, counts: Record<string, number> = { open: 40 }): GithubPage<{ number: number; title: string }> => ({
    items: numbers.map((number) => item(number)),
    nextCursor,
    counts,
    fetchedAt: '2026-10-15T19:00:00Z',
  })

  test('the next page appends only what is not listed yet and moves the cursor', () => {
    const first = page([5, 4, 3], 'c1')
    const next = nextPage(first, page([3, 2, 1], 'c2', { open: 41 }))
    expect(next.items.map((entry) => entry.number)).toEqual([5, 4, 3, 2, 1])
    expect(next.nextCursor).toBe('c2')
    expect(next.counts).toEqual({ open: 41 })
  })

  test('the last page leaves no cursor', () => {
    expect(nextPage(page([2], 'c1'), page([1], null)).nextCursor).toBeNull()
  })

  test('a refreshed first page puts its items on top and keeps the pages loaded below it', () => {
    const loaded = nextPage(page([5, 4, 3], 'c1'), page([2, 1], 'c2'))
    const fresh: GithubPage<{ number: number; title: string }> = { ...page([6, 2, 5], 'f1', { open: 42 }), fetchedAt: '2026-10-15T19:01:00Z' }
    fresh.items[1] = item(2, 'renamed')
    const refreshed = refreshedPage(loaded, fresh)
    expect(refreshed.items.map((entry) => entry.number)).toEqual([6, 2, 5, 4, 3, 1])
    expect(refreshed.items[1]?.title).toBe('renamed')
    expect(refreshed.nextCursor).toBe('c2')
    expect(refreshed.counts).toEqual({ open: 42 })
    expect(refreshed.fetchedAt).toBe('2026-10-15T19:01:00Z')
  })

  test('with nothing loaded yet the first page is the listing', () => {
    expect(refreshedPage(null, page([1], 'c1'))).toEqual(page([1], 'c1'))
  })

  test('mergeItems keeps the front copy of an item listed twice', () => {
    expect(mergeItems([item(1, 'front')], [item(1, 'back'), item(2)])).toEqual([item(1, 'front'), item(2)])
  })
})

describe('isRepositoryFileLink', () => {
  test('blob and raw links to a repository file go through the CLI', () => {
    expect(isRepositoryFileLink('https://github.com/cantospace/canto-space/blob/2a5bb4e5/pr-513/01-meta.png?raw=true')).toBe(true)
    expect(isRepositoryFileLink('https://github.com/operator/sample/raw/main/docs/a.png')).toBe(true)
    expect(isRepositoryFileLink('https://raw.githubusercontent.com/operator/sample/main/docs/a.png')).toBe(true)
  })

  test('any other picture loads as it is', () => {
    expect(isRepositoryFileLink('https://avatars.githubusercontent.com/u/1')).toBe(false)
    expect(isRepositoryFileLink('https://github.com/operator/sample/pull/7')).toBe(false)
    expect(isRepositoryFileLink('https://github.com/operator/sample/blob/main')).toBe(false)
    expect(isRepositoryFileLink('https://github.com/user-attachments/assets/1234')).toBe(false)
    expect(isRepositoryFileLink('http://github.com/operator/sample/blob/main/a.png')).toBe(false)
    expect(isRepositoryFileLink('https://example.com/a.png')).toBe(false)
    expect(isRepositoryFileLink('docs/a.png')).toBe(false)
  })
})

describe('people beside the author', () => {
  const person = (login: string) => ({ login, name: null })

  test('the author assigned to their own issue is left out and still known as assigned', () => {
    expect(otherPeople('thiagoadsix', [person('thiagoadsix')])).toEqual([])
    expect(includesAuthor('thiagoadsix', [person('thiagoadsix')])).toBe(true)
  })

  test('someone else stays, in order, with the author removed from among them', () => {
    expect(otherPeople('octo', [person('ana'), person('octo'), person('bo')]).map((p) => p.login)).toEqual(['ana', 'bo'])
    expect(includesAuthor('octo', [person('ana'), person('bo')])).toBe(false)
  })

  test('logins match without regard to case, and each appears once', () => {
    expect(otherPeople('Octo', [person('octo'), person('Ana'), person('ana')]).map((p) => p.login)).toEqual(['Ana'])
    expect(includesAuthor('Octo', [person('OCTO')])).toBe(true)
  })

  test('with no author (a deleted account) nobody is removed and nobody is the author', () => {
    expect(otherPeople(null, [person('ana'), person('ana')]).map((p) => p.login)).toEqual(['ana'])
    expect(includesAuthor(null, [person('ana')])).toBe(false)
    expect(otherPeople('ana', [])).toEqual([])
  })
})

describe('filtersSet', () => {
  test('a plain read asks GitHub for nothing', () => {
    expect(filtersSet(emptyIssueFilters)).toBe(false)
    expect(filtersSet(emptyPullRequestFilters)).toBe(false)
    expect(filtersSet({ ...emptyIssueFilters, query: '   ' })).toBe(false)
  })

  test('any filter, the no-assignee choice included, makes the read a search', () => {
    expect(filtersSet({ ...emptyIssueFilters, query: 'tmux' })).toBe(true)
    expect(filtersSet({ ...emptyIssueFilters, label: 'bug' })).toBe(true)
    expect(filtersSet({ ...emptyIssueFilters, assignee: noAssignee })).toBe(true)
    expect(filtersSet({ ...emptyPullRequestFilters, author: 'operator' })).toBe(true)
    expect(filtersSet({ ...emptyPullRequestFilters, draft: 'draft' })).toBe(true)
  })

  test('filters are part of the request key, so a filtered page never answers for the plain one', () => {
    expect(listRequestKey('issues', '/repo', 'open', 25, null, { ...emptyIssueFilters, label: 'bug' })).not.toBe(listRequestKey('issues', '/repo', 'open', 25, null))
  })
})
