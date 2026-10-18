import { api } from '@/api'
import type { GithubIssueList, GithubPullRequestList } from '@/api/schema'
import { emptyIssueFilters, emptyPullRequestFilters, filtersSet, listRequestKey, pageSize, shareInFlight, type IssueFilters, type PullRequestFilters } from '@/github/github-model'
import { githubIssuesFiltered, githubPullRequestsFiltered } from '@/tasks/search-contract-standin'

// Every list request the app makes goes through here, so the sidebar's counts, a page's tab and a
// refresh asking for the same page at once share one gh call instead of racing several. A read with
// filters asks GitHub to filter, so its pages and total cover the whole repository.
const share = shareInFlight()

export type PullRequestState = 'open' | 'closed' | 'merged' | 'all'
export type IssueState = 'open' | 'closed' | 'all'

export function pullRequestPage(root: string, state: PullRequestState, after: string | null, filters: PullRequestFilters = emptyPullRequestFilters): Promise<GithubPullRequestList> {
  if (!filtersSet(filters)) return share(listRequestKey('prs', root, state, pageSize, after), () => api.githubPullRequests(root, state, pageSize, after))
  return share(listRequestKey('prs', root, state, pageSize, after, filters), () => githubPullRequestsFiltered(root, state, filters, pageSize, after))
}

export function issuePage(root: string, state: IssueState, after: string | null, filters: IssueFilters = emptyIssueFilters): Promise<GithubIssueList> {
  if (!filtersSet(filters)) return share(listRequestKey('issues', root, state, pageSize, after), () => api.githubIssues(root, state, pageSize, after))
  return share(listRequestKey('issues', root, state, pageSize, after, filters), () => githubIssuesFiltered(root, state, filters, pageSize, after))
}
