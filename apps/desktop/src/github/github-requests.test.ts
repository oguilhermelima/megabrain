import { describe, expect, test, spyOn } from 'bun:test'
import { api } from '@/api'
import type { GithubDetail, GithubPullRequestList } from '@/api/schema'
import { issueDetail, pullRequestDetail, pullRequestPage } from '@/github/github-requests'

describe('shared GitHub surface reads', () => {
  test('overview, page and counts consume one list read and keep the same rows and totals', async () => {
    const path = '/shared-counting-fake/repository-a'
    const visiblePage = { counts: { open: 3, merged: 4, closed: 2, all: 9 }, totalCount: 3, nextCursor: null, items: [{ number: 45, title: 'Visible row' }] } as GithubPullRequestList
    const read = spyOn(api, 'githubPullRequests').mockResolvedValue(visiblePage)
    const [overview, page, counts] = await Promise.all([
      pullRequestPage(path, 'open', null),
      pullRequestPage(path, 'open', null),
      pullRequestPage(path, 'open', null),
    ])

    expect(read).toHaveBeenCalledTimes(1)
    expect(overview.items).toEqual([{ number: 45, title: 'Visible row' }])
    expect(page.items).toEqual(overview.items)
    expect(counts.counts.open).toBe(3)
    read.mockRestore()
  })

  test('an opened PR page and knowledge reference share the same detail read', async () => {
    const path = '/shared-counting-fake/repository-b'
    const visibleDetail = { number: 45, title: 'Visible detail', state: 'open', isDraft: false, reviewDecision: null, checks: [] } as GithubDetail
    const read = spyOn(api, 'githubPullRequest').mockResolvedValue(visibleDetail)
    const [page, reference] = await Promise.all([
      pullRequestDetail(path, 45),
      pullRequestDetail(path, 45),
    ])

    expect(read).toHaveBeenCalledTimes(1)
    expect(page).toEqual(visibleDetail)
    expect(reference).toEqual(visibleDetail)
    read.mockRestore()
  })

  test('issue details remain keyed separately from pull request details', async () => {
    const path = '/shared-counting-fake/repository-c'
    const visibleDetail = { number: 45, title: 'Visible issue', state: 'open' } as GithubDetail
    const read = spyOn(api, 'githubIssue').mockResolvedValue(visibleDetail)
    expect(await issueDetail(path, 45)).toEqual(visibleDetail)
    expect(read).toHaveBeenCalledTimes(1)
    read.mockRestore()
  })
})
