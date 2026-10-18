import { api } from '@/api'
import type { GithubIssueList, GithubPullRequestList } from '@/api/schema'
import { emptyIssueFilters, emptyPullRequestFilters, filtersSet, issueSearch, listRequestKey, pageSize, pullRequestSearch, shareInFlight, type IssueFilters, type PullRequestFilters } from '@/github/github-model'

// Every list request the app makes goes through here, so the sidebar's counts, a page's tab and a
// refresh asking for the same page at once share one gh call instead of racing several. A read with
// filters asks GitHub to filter, so its pages and total cover the whole repository.
const share = shareInFlight()

export type PullRequestState = 'open' | 'closed' | 'merged' | 'all'
export type IssueState = 'open' | 'closed' | 'all'

export function pullRequestPage(root: string, state: PullRequestState, after: string | null, filters: PullRequestFilters = emptyPullRequestFilters): Promise<GithubPullRequestList> {
  const key = listRequestKey('prs', root, state, pageSize, after, filtersSet(filters) ? filters : null)
  return share(key, () => api.githubPullRequests(root, state, pageSize, after, pullRequestSearch(filters)))
}

export function issuePage(root: string, state: IssueState, after: string | null, filters: IssueFilters = emptyIssueFilters): Promise<GithubIssueList> {
  const key = listRequestKey('issues', root, state, pageSize, after, filtersSet(filters) ? filters : null)
  return share(key, () => api.githubIssues(root, state, pageSize, after, issueSearch(filters)))
}
