import type { GithubProject, GithubProjectItem } from '@/api/schema'

const statusField: NonNullable<GithubProject['statusField']> = {
  id: 'PVTSSF_lADOA1',
  name: 'Status',
  options: [
    { id: 'opt_todo', name: 'Todo', color: 'GRAY' },
    { id: 'opt_progress', name: 'In Progress', color: 'BLUE' },
    { id: 'opt_review', name: 'In Review', color: 'PURPLE' },
    { id: 'opt_done', name: 'Done', color: 'GREEN' },
  ],
}

export const mockGithubProjects: GithubProject[] = [
  { id: 'PVT_kwDOBoard1', number: 7, title: 'Desktop roadmap', url: 'https://github.com/orgs/operator/projects/7', owner: 'operator', closed: false, statusField },
  { id: 'PVT_kwDOBoard2', number: 12, title: 'Research backlog', url: 'https://github.com/orgs/operator/projects/12', owner: 'operator', closed: false, statusField: null },
]

const updatedAt = '2026-10-01T12:00:00Z'
const issue = (i: number, status: string | null): GithubProjectItem => ({
  id: `PVTI_issue_${i}`, type: 'ISSUE', number: 200 + i, title: `Improve workflow ${i}`, url: `https://github.com/operator/megabrain/issues/${200 + i}`,
  state: 'OPEN', repository: 'operator/megabrain', status, assignees: [{ login: 'operator', avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4' }],
  labels: [{ name: i % 2 ? 'enhancement' : 'bug', color: i % 2 ? 'a2eeef' : 'd73a4a' }], updatedAt,
})

export const mockGithubProjectItems: Record<number, GithubProjectItem[]> = {
  7: [
    issue(1, 'opt_todo'), issue(2, 'opt_todo'),
    { ...issue(3, 'opt_progress'), id: 'PVTI_pr_3', type: 'PULL_REQUEST', number: 303, title: 'Add project board support', url: 'https://github.com/operator/megabrain/pull/303', state: 'OPEN' },
    issue(4, 'opt_progress'),
    { ...issue(5, 'opt_review'), id: 'PVTI_pr_5', type: 'PULL_REQUEST', number: 305, title: 'Polish task interactions', url: 'https://github.com/operator/megabrain/pull/305', state: 'OPEN' },
    issue(6, 'opt_review'),
    { ...issue(7, 'opt_done'), id: 'PVTI_pr_7', type: 'PULL_REQUEST', number: 307, title: 'Ship task list', url: 'https://github.com/operator/megabrain/pull/307', state: 'MERGED' },
    issue(8, 'opt_done'), issue(9, 'opt_todo'), issue(10, 'opt_progress'), issue(11, 'opt_review'),
    { id: 'PVTI_draft_12', type: 'DRAFT_ISSUE', number: null, title: 'Consider offline task editing', url: null, state: null, repository: null, status: 'opt_todo', assignees: [], labels: [], updatedAt },
  ],
  12: [issue(20, null)],
}
