import type { GithubCheck, GithubIssue, GithubPullRequest } from '@/api/schema'

// What the pull request and issue pages compute from `megabrain github prs|issues --json`: the
// repository behind a remote, tab counts, the colour of each state, one verdict for a set of
// checks, and the search and filters. The pages list everything once (state all) and filter here.

export interface GithubRepositoryName {
  owner: string
  name: string
  nameWithOwner: string
  url: string
}

const githubRemote = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/

/** The GitHub repository of an https, ssh or scp-style github.com remote; null for any other host. */
export function githubRepository(remote: string | null): GithubRepositoryName | null {
  if (remote === null) return null
  const match = githubRemote.exec(remote.trim())
  const owner = match?.[1]
  const name = match?.[2]
  if (owner === undefined || name === undefined) return null
  return { owner, name, nameWithOwner: `${owner}/${name}`, url: `https://github.com/${owner}/${name}` }
}

export type PullRequestTab = 'open' | 'merged' | 'closed' | 'all'
export type IssueTab = 'open' | 'closed' | 'all'

export function pullRequestTabCounts(items: GithubPullRequest[]): Record<PullRequestTab, number> {
  const count = (state: GithubPullRequest['state']) => items.filter((item) => item.state === state).length
  return { open: count('open'), merged: count('merged'), closed: count('closed'), all: items.length }
}

export function issueTabCounts(items: GithubIssue[]): Record<IssueTab, number> {
  const count = (state: GithubIssue['state']) => items.filter((item) => item.state === state).length
  return { open: count('open'), closed: count('closed'), all: items.length }
}

export type PullRequestVisualState = 'open' | 'draft' | 'merged' | 'closed'

export function pullRequestVisualState(item: GithubPullRequest): PullRequestVisualState {
  return item.state === 'open' && item.isDraft ? 'draft' : item.state
}

/** GitHub's own state colours on a dark page: open green, draft grey, merged purple, closed red. */
export const stateColors: Record<PullRequestVisualState, string> = { open: '#3fb950', draft: '#8b949e', merged: '#a371f7', closed: '#f85149' }

/**
 * The state of a worktree's pull request as `projects --json` reports it (gh's OPEN, MERGED, CLOSED),
 * drawn like the pages draw it; null when the branch has no pull request or the state is unknown.
 */
export function worktreePullRequestState(pullRequest: { state: string; isDraft?: boolean | null } | null): PullRequestVisualState | null {
  if (pullRequest === null) return null
  const state = pullRequest.state.toLowerCase()
  if (state === 'open') return pullRequest.isDraft === true ? 'draft' : 'open'
  return state === 'merged' || state === 'closed' ? state : null
}

export interface CheckSummary {
  state: 'passing' | 'failing' | 'pending' | 'none'
  passed: number
  failed: number
  pending: number
  skipped: number
  total: number
}

/** One verdict for a pull request's checks: any failure fails it, then any pending; skips alone are none. */
export function checkSummary(checks: GithubCheck[]): CheckSummary {
  const count = (...states: GithubCheck['state'][]) => checks.filter((check) => states.includes(check.state)).length
  const passed = count('success', 'neutral')
  const failed = count('failure')
  const pending = count('pending')
  const skipped = count('skipped')
  const state = failed > 0 ? 'failing' : pending > 0 ? 'pending' : passed > 0 ? 'passing' : 'none'
  return { state, passed, failed, pending, skipped, total: checks.length }
}

export interface PullRequestFilters {
  query: string
  author: string | null
  label: string | null
  draft: 'any' | 'draft' | 'ready'
  review: 'any' | 'approved' | 'changes_requested' | 'review_required' | 'none'
}

export interface IssueFilters {
  query: string
  author: string | null
  label: string | null
  assignee: string | null
}

export const emptyPullRequestFilters: PullRequestFilters = { query: '', author: null, label: null, draft: 'any', review: 'any' }
export const emptyIssueFilters: IssueFilters = { query: '', author: null, label: null, assignee: null }

const newestFirst = <T extends { updatedAt: string }>(items: T[]) => [...items].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))

/** True when every word of the query appears in one of the haystack strings; `#12` matches number 12. */
function matches(query: string, number: number, haystack: (string | null | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return true
  const text = haystack.filter((value): value is string => typeof value === 'string').join('\n').toLowerCase()
  return words.every((word) => word.replace(/^#/, '') === String(number) || text.includes(word))
}

export function filterPullRequests(items: GithubPullRequest[], filters: PullRequestFilters, tab: PullRequestTab): GithubPullRequest[] {
  return newestFirst(
    items.filter((item) => {
      if (tab !== 'all' && item.state !== tab) return false
      if (filters.author !== null && item.author?.login !== filters.author) return false
      if (filters.label !== null && !item.labels.some((label) => label.name === filters.label)) return false
      if (filters.draft === 'draft' && !item.isDraft) return false
      if (filters.draft === 'ready' && item.isDraft) return false
      if (filters.review === 'none' && item.reviewDecision !== null) return false
      if (filters.review !== 'any' && filters.review !== 'none' && item.reviewDecision !== filters.review) return false
      return matches(filters.query, item.number, [item.title, item.headRefName, item.baseRefName, item.author?.login, item.author?.name, ...item.labels.map((label) => label.name)])
    }),
  )
}

export function filterIssues(items: GithubIssue[], filters: IssueFilters, tab: IssueTab): GithubIssue[] {
  return newestFirst(
    items.filter((item) => {
      if (tab !== 'all' && item.state !== tab) return false
      if (filters.author !== null && item.author?.login !== filters.author) return false
      if (filters.label !== null && !item.labels.some((label) => label.name === filters.label)) return false
      if (filters.assignee !== null && !item.assignees.some((assignee) => assignee.login === filters.assignee)) return false
      return matches(filters.query, item.number, [item.title, item.author?.login, item.author?.name, item.milestone?.title, ...item.labels.map((label) => label.name), ...item.assignees.map((assignee) => assignee.login)])
    }),
  )
}

const sortedUnique = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => value !== undefined))].sort((left, right) => left.localeCompare(right))

export function pullRequestFilterOptions(items: GithubPullRequest[]): { authors: string[]; labels: string[] } {
  return { authors: sortedUnique(items.map((item) => item.author?.login)), labels: sortedUnique(items.flatMap((item) => item.labels.map((label) => label.name))) }
}

export function issueFilterOptions(items: GithubIssue[]): { authors: string[]; labels: string[]; assignees: string[] } {
  return {
    authors: sortedUnique(items.map((item) => item.author?.login)),
    labels: sortedUnique(items.flatMap((item) => item.labels.map((label) => label.name))),
    assignees: sortedUnique(items.flatMap((item) => item.assignees.map((assignee) => assignee.login))),
  }
}

export interface LabelStyle {
  backgroundColor: string
  borderColor: string
  color: string
}

const fallbackLabel: [number, number, number] = [139, 148, 158]

function rgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (match?.[1] === undefined) return fallbackLabel
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/**
 * A label chip in the label's own colour on a black page, the way GitHub's dark theme draws it: a
 * translucent fill and border, and text lifted toward white until it reads on that fill.
 */
export function labelStyle(color: string): LabelStyle {
  const [red, green, blue] = rgb(color)
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
  const lift = Math.max(0, 0.72 - luminance)
  const text = [red, green, blue].map((channel) => Math.round(channel + (255 - channel) * lift))
  return {
    backgroundColor: `rgba(${red}, ${green}, ${blue}, 0.18)`,
    borderColor: `rgba(${red}, ${green}, ${blue}, 0.45)`,
    color: `rgb(${text.join(', ')})`,
  }
}

/** A row's count badge: hidden at zero, capped at 99+. */
export function countBadge(count: number): string | null {
  if (count <= 0) return null
  return count > 99 ? '99+' : String(count)
}

/** A person's GitHub picture; GitHub apps (app/…) have none at a guessable address. */
export function avatarUrl(login: string): string | null {
  return login.startsWith('app/') ? null : `https://github.com/${login}.png?size=64`
}
