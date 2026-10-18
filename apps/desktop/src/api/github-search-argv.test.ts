import { describe, expect, mock, test } from 'bun:test'
import { emptyIssueFilters, emptyPullRequestFilters, issueSearch, noAssignee, pullRequestSearch } from '@/github/github-model'

// The desktop build runs each read as `megabrain <args>` through run_cli; capture those args.
const calls: string[][] = []
const core = await import('@tauri-apps/api/core')
mock.module('@tauri-apps/api/core', () => ({
  ...core,
  invoke: async (_command: string, payload: { args: string[] }) => {
    calls.push(payload.args)
    return { code: 1, stdout: '', stderr: 'stub' }
  },
}))
const { createTauriApi } = await import('@/api/tauri')

async function argv(read: () => Promise<unknown>): Promise<string[] | undefined> {
  calls.length = 0
  await read().catch(() => undefined)
  return calls.at(-1)
}

describe('filtered list argv', () => {
  const api = createTauriApi()

  test('an issue read names each filter the way the CLI spells it', async () => {
    expect(await argv(() => api.githubIssues('/repo', 'closed', 25, null, issueSearch({ ...emptyIssueFilters, label: 'enhancement' })))).toEqual(['github', 'issues', '/repo', '--state', 'closed', '--limit', '25', '--label', 'enhancement', '--json'])
    expect(await argv(() => api.githubIssues('/repo', 'all', 25, 'c1', issueSearch({ ...emptyIssueFilters, assignee: noAssignee, query: ' tmux ' })))).toEqual(['github', 'issues', '/repo', '--state', 'all', '--limit', '25', '--after', 'c1', '--no-assignee', '--search', 'tmux', '--json'])
  })

  test('a pull request read names author and draft', async () => {
    expect(await argv(() => api.githubPullRequests('/repo', 'merged', 25, null, pullRequestSearch({ ...emptyPullRequestFilters, author: 'operator', draft: 'ready' })))).toEqual(['github', 'prs', '/repo', '--state', 'merged', '--limit', '25', '--author', 'operator', '--draft', 'false', '--json'])
  })
})
