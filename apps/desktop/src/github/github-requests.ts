import { api } from '@/api'
import type { GithubIssueList, GithubPullRequestList } from '@/api/schema'
import { emptyIssueFilters, emptyPullRequestFilters, issueSearch, pageSize, pullRequestSearch, type IssueFilters, type PullRequestFilters } from '@/github/github-model'
import { createRequestCache } from '@/github/request-cache'

// Counts, overview rows and GitHub pages share the exact CLI query, as do opened details and
// knowledge references. Expiry follows the CLI's 60 s GitHub read cache and visible list cadence.
const requests = createRequestCache()
const requestAgeMs = 60_000

export type PullRequestState = 'open' | 'closed' | 'merged' | 'all'
export type IssueState = 'open' | 'closed' | 'all'

export function pullRequestPage(root: string, state: PullRequestState, after: string | null, filters: PullRequestFilters = emptyPullRequestFilters): Promise<GithubPullRequestList> {
  const query = pullRequestSearch(filters)
  const key = JSON.stringify(['githubPullRequests', root, state, pageSize, after, query])
  return requests.request(key, requestAgeMs, () => api.githubPullRequests(root, state, pageSize, after, query))
}

export function issuePage(root: string, state: IssueState, after: string | null, filters: IssueFilters = emptyIssueFilters): Promise<GithubIssueList> {
  const query = issueSearch(filters)
  const key = JSON.stringify(['githubIssues', root, state, pageSize, after, query])
  return requests.request(key, requestAgeMs, () => api.githubIssues(root, state, pageSize, after, query))
}

export function pullRequestDetail(root: string, number: number) {
  return requests.request(JSON.stringify(['githubPullRequest', root, number]), requestAgeMs, () => api.githubPullRequest(root, number))
}

export function issueDetail(root: string, number: number) {
  return requests.request(JSON.stringify(['githubIssue', root, number]), requestAgeMs, () => api.githubIssue(root, number))
}

/** Forget reads after a successful repository mutation so the next view sees GitHub's new state. */
export function invalidateGithubRequests(root: string, number?: number): void {
  requests.invalidate((key) => {
    const [kind, requestRoot, requestNumber] = JSON.parse(key) as [string, string, number?]
    return requestRoot === root && (kind === 'githubPullRequests' || kind === 'githubIssues' || number === undefined || requestNumber === number)
  })
}
