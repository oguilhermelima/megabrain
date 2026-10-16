import type { GithubCheck, GithubIssue, GithubPullRequest } from '@/api/schema'

// What the pull request and issue pages compute from `megabrain github prs|issues --json`: the
// repository behind a remote, the colour of each state, one verdict for a set of checks, the search
// and filters over the pages loaded so far, how those pages join, and one shared request per key.

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
}

export interface IssueFilters {
  query: string
  author: string | null
  label: string | null
  assignee: string | null
}

export const emptyPullRequestFilters: PullRequestFilters = { query: '', author: null, label: null, draft: 'any' }
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

/** Items per request: light enough for GitHub to answer quickly; the page asks for more on scroll. */
export const pageSize = 30

/**
 * Shares one request per key while it runs: callers asking for the same thing at once (the sidebar
 * count and the open tab, a refresh during a load) get the same promise. A settled key runs again.
 */
export function shareInFlight(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const running = new Map<string, Promise<unknown>>()
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const current = running.get(key)
    if (current !== undefined) return current as Promise<T>
    const started = run().finally(() => running.delete(key))
    running.set(key, started)
    return started
  }
}

export function listRequestKey(kind: 'prs' | 'issues', root: string, state: string, limit: number, after: string | null): string {
  return JSON.stringify([kind, root, state, limit, after])
}

/** The loaded part of one tab: its items, the cursor of the page after them, and every state's total. */
export interface GithubPage<T> {
  items: T[]
  nextCursor: string | null
  counts: Record<string, number>
  fetchedAt: string
}

/** Front items first, then the back ones not already in front; a number is one item. */
export function mergeItems<T extends { number: number }>(front: T[], back: T[]): T[] {
  const listed = new Set(front.map((item) => item.number))
  return [...front, ...back.filter((item) => !listed.has(item.number))]
}

/** The page after the loaded ones joins below them and carries the cursor on. */
export function nextPage<T extends { number: number }>(loaded: GithubPage<T>, page: GithubPage<T>): GithubPage<T> {
  return { items: mergeItems(loaded.items, page.items), nextCursor: page.nextCursor, counts: page.counts, fetchedAt: loaded.fetchedAt }
}

/**
 * A refresh reads the first page again: its items go on top, replacing their old copies, and the pages
 * loaded below stay with their cursor, so a refresh never scrolls the list back to the start.
 */
export function refreshedPage<T extends { number: number }>(loaded: GithubPage<T> | null, first: GithubPage<T>): GithubPage<T> {
  if (loaded === null) return first
  return { items: mergeItems(first.items, loaded.items), nextCursor: loaded.nextCursor, counts: first.counts, fetchedAt: first.fetchedAt }
}

/**
 * Whether a picture's link names a file in a GitHub repository (a github.com blob or raw link, or
 * raw.githubusercontent.com), which a private repository only serves with a token, so the desktop
 * reads it through `github image`. Pictures anywhere else load as they are.
 */
export function isRepositoryFileLink(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  if (parsed.hostname === 'github.com') return (segments[2] === 'blob' || segments[2] === 'raw') && segments.length >= 5
  return parsed.hostname === 'raw.githubusercontent.com' && segments.length >= 4
}
