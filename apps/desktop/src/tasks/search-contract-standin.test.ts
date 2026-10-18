import { describe, expect, test } from 'bun:test'
import { emptyIssueFilters, emptyPullRequestFilters, noAssignee } from '@/github/github-model'
import { issueArgs, pullRequestArgs } from '@/tasks/search-contract-standin'

describe('filtered list argv', () => {
  test('an issue read names each filter the way the CLI contract spells it', () => {
    expect(issueArgs('/repo', 'open', { ...emptyIssueFilters, label: 'bug', assignee: 'operator', query: ' tmux line ' }, 25, 'c1')).toEqual(['github', 'issues', '/repo', '--state', 'open', '--label', 'bug', '--assignee', 'operator', '--search', 'tmux line', '--limit', '25', '--after', 'c1', '--json'])
  })

  test('the no-assignee choice asks for unassigned issues', () => {
    expect(issueArgs('/repo', 'all', { ...emptyIssueFilters, assignee: noAssignee }, 25, null)).toEqual(['github', 'issues', '/repo', '--state', 'all', '--no-assignee', '--limit', '25', '--json'])
  })

  test('a pull request read names author and draft', () => {
    expect(pullRequestArgs('/repo', 'merged', { ...emptyPullRequestFilters, author: 'operator', draft: 'ready' }, 25, null)).toEqual(['github', 'prs', '/repo', '--state', 'merged', '--author', 'operator', '--draft', 'false', '--limit', '25', '--json'])
    expect(pullRequestArgs('/repo', 'open', { ...emptyPullRequestFilters, draft: 'draft' }, 25, null)).toContain('true')
  })
})
