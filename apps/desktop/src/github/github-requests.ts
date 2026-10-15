import { api } from '@/api'
import type { GithubIssueList, GithubPullRequestList } from '@/api/schema'
import { listRequestKey, pageSize, shareInFlight } from '@/github/github-model'

// Every list request the app makes goes through here, so the sidebar's counts, a page's tab and a
// refresh asking for the same page at once share one gh call instead of racing several.
const share = shareInFlight()

export type PullRequestState = 'open' | 'closed' | 'merged' | 'all'
export type IssueState = 'open' | 'closed' | 'all'

export function pullRequestPage(root: string, state: PullRequestState, after: string | null): Promise<GithubPullRequestList> {
  return share(listRequestKey('prs', root, state, pageSize, after), () => api.githubPullRequests(root, state, pageSize, after))
}

export function issuePage(root: string, state: IssueState, after: string | null): Promise<GithubIssueList> {
  return share(listRequestKey('issues', root, state, pageSize, after), () => api.githubIssues(root, state, pageSize, after))
}
