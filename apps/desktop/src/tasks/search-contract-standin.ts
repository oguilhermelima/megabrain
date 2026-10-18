import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import { CliError } from '@/api/adapter'
import { mockGithubIssues, mockGithubPullRequests, mockPage } from '@/api/fixtures/mock'
import { githubIssueListSchema, githubPullRequestListSchema, type GithubIssueList, type GithubPullRequestList } from '@/api/schema'
import { filterIssues, filterPullRequests, noAssignee, type IssueFilters, type PullRequestFilters } from '@/github/github-model'
import { native } from '@/lib/surface'

// STAND-IN until the CLI's filtered list reads join api/adapter.ts: github issues and github prs with
// --label, --assignee or --no-assignee, --author, --draft and --search (GitHub search, so the filter
// covers the whole repository and "total" is that query's count), and github labels for every label
// of a repository. The app calls these through github/github-requests only; at merge they become
// adapter methods (tauri.ts runs the same argv, mock.ts keeps the mock branch below).

const real = native || Boolean(import.meta.env.VITE_MEGABRAIN_BRIDGE)

export type IssueState = 'open' | 'closed' | 'all'
export type PullRequestState = 'open' | 'closed' | 'merged' | 'all'

const labelSchema = z.looseObject({ name: z.string(), color: z.string(), description: z.string().nullable().optional() })
export type GithubRepositoryLabel = z.infer<typeof labelSchema>
const labelsSchema = z.looseObject({ labels: z.array(labelSchema) })

// A filtered read answers "total" (the search's count); a plain one "totalCount". Either is the query's total.
const totals = { totalCount: z.number().optional(), total: z.number().optional() }
const filteredIssueListSchema = githubIssueListSchema.extend(totals)
const filteredPullRequestListSchema = githubPullRequestListSchema.extend(totals)

async function cliJson<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
  const output = await invoke<{ code: number | null; stdout: string; stderr: string }>('run_cli', { args })
  if (output.stdout.trim() === '') throw new CliError(output.stderr.trim().split('\n').at(-1) || `megabrain ${args[0]} exited ${output.code}`, output.code)
  const body: unknown = JSON.parse(output.stdout)
  const refusal = z.looseObject({ refusal: z.looseObject({ code: z.string(), message: z.string() }) }).safeParse(body)
  if (refusal.success) throw new CliError(refusal.data.refusal.message, output.code, refusal.data.refusal.code)
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new CliError(`megabrain ${args.join(' ')} answered in an unexpected shape: ${parsed.error.message}`, output.code)
  return parsed.data
}

const paging = (limit: number, after: string | null) => ['--limit', String(limit), ...(after === null ? [] : ['--after', after]), '--json']
const searched = (query: string) => (query.trim() === '' ? [] : ['--search', query.trim()])
const labelled = (label: string | null) => (label === null ? [] : ['--label', label])

/** The argv of a filtered issue read. */
export function issueArgs(root: string, state: IssueState, filters: IssueFilters, limit: number, after: string | null): string[] {
  const assignee = filters.assignee === null ? [] : filters.assignee === noAssignee ? ['--no-assignee'] : ['--assignee', filters.assignee]
  return ['github', 'issues', root, '--state', state, ...labelled(filters.label), ...assignee, ...searched(filters.query), ...paging(limit, after)]
}

/** The argv of a filtered pull request read. */
export function pullRequestArgs(root: string, state: PullRequestState, filters: PullRequestFilters, limit: number, after: string | null): string[] {
  const author = filters.author === null ? [] : ['--author', filters.author]
  const draft = filters.draft === 'any' ? [] : ['--draft', filters.draft === 'draft' ? 'true' : 'false']
  return ['github', 'prs', root, '--state', state, ...labelled(filters.label), ...author, ...draft, ...searched(filters.query), ...paging(limit, after)]
}

export async function githubIssuesFiltered(root: string, state: IssueState, filters: IssueFilters, limit: number, after: string | null): Promise<GithubIssueList> {
  if (!real) {
    const items = filterIssues(mockGithubIssues.items, { ...filters, assignee: filters.assignee === noAssignee ? null : filters.assignee }, state).filter((item) => filters.assignee !== noAssignee || item.assignees.length === 0)
    return { ...mockGithubIssues, ...mockPage(items, state, limit, after) }
  }
  const { total, totalCount, ...list } = await cliJson(issueArgs(root, state, filters, limit, after), filteredIssueListSchema)
  return { ...list, totalCount: total ?? totalCount ?? list.counts[state] ?? list.items.length }
}

export async function githubPullRequestsFiltered(root: string, state: PullRequestState, filters: PullRequestFilters, limit: number, after: string | null): Promise<GithubPullRequestList> {
  if (!real) return { ...mockGithubPullRequests, ...mockPage(filterPullRequests(mockGithubPullRequests.items, filters, state), state, limit, after) }
  const { total, totalCount, ...list } = await cliJson(pullRequestArgs(root, state, filters, limit, after), filteredPullRequestListSchema)
  return { ...list, totalCount: total ?? totalCount ?? list.counts[state] ?? list.items.length }
}

/** Every label of the repository (github labels), not only those on a loaded page. */
export async function githubLabels(root: string): Promise<GithubRepositoryLabel[]> {
  if (!real) return [...new Map([...mockGithubIssues.items, ...mockGithubPullRequests.items].flatMap((item) => item.labels).map((label) => [label.name, label])).values()]
  return (await cliJson(['github', 'labels', root, '--json'], labelsSchema)).labels
}
