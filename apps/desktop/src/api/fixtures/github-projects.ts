import type { GithubProject, GithubProjectItem } from '@/api/schema'

// GitHub Projects for the mock API and the Tasks board's tests: one project with a Status field
// (Todo, In Progress, In Review, Done) and 12 mixed items, among them drafts, pull requests, another
// repository's issue, items with no status and one whose option was deleted, and one project
// without a Status field.

export const fixtureRoadmap: GithubProject = {
  id: 'PVT_roadmap',
  number: 3,
  title: 'Roadmap',
  url: 'https://github.com/users/oguilhermelima/projects/3',
  owner: 'oguilhermelima',
  closed: false,
  statusField: {
    id: 'PVTSSF_status',
    name: 'Status',
    options: [
      { id: 'opt_todo', name: 'Todo', color: 'GRAY' },
      { id: 'opt_progress', name: 'In Progress', color: 'YELLOW' },
      { id: 'opt_review', name: 'In Review', color: 'BLUE' },
      { id: 'opt_done', name: 'Done', color: 'GREEN' },
    ],
  },
}

export const fixtureBacklog: GithubProject = {
  id: 'PVT_backlog',
  number: 5,
  title: 'Ideas backlog',
  url: 'https://github.com/users/oguilhermelima/projects/5',
  owner: 'oguilhermelima',
  closed: false,
  statusField: null,
}

const repo = 'oguilhermelima/megabrain'
const person = (login: string) => ({ login, avatarUrl: `https://avatars.githubusercontent.com/${login}` })
const label = (name: string, color: string) => ({ name, color })

function item(id: string, fields: Partial<GithubProjectItem> & Pick<GithubProjectItem, 'title'>): GithubProjectItem {
  return { id, type: 'ISSUE', number: null, url: null, state: 'OPEN', repository: repo, status: null, assignees: [], labels: [], updatedAt: '2026-10-17T12:00:00.000Z', ...fields }
}

const issue = (number: number) => ({ number, url: `https://github.com/${repo}/issues/${number}` })
const pull = (number: number) => ({ type: 'PULL_REQUEST' as const, number, url: `https://github.com/${repo}/pull/${number}` })

export const fixtureRoadmapItems: GithubProjectItem[] = [
  item('PVTI_01', { ...issue(141), title: 'Tasks page in the desktop app', status: 'opt_progress', assignees: [person('oguilhermelima')], labels: [label('desktop', '1d76db'), label('feature', 'a2eeef')] }),
  item('PVTI_02', { ...pull(142), title: 'github projects verbs', status: 'opt_review', assignees: [person('oguilhermelima')], labels: [label('cli', 'fbca04')] }),
  item('PVTI_03', { ...issue(118), title: 'Knowledge map zoom resets on refresh', status: 'opt_todo', labels: [label('bug', 'd73a4a')] }),
  item('PVTI_04', { type: 'DRAFT_ISSUE', state: null, title: 'Sketch: board swimlanes by assignee', status: 'opt_todo' }),
  item('PVTI_05', { ...pull(139), title: 'Fold the orchestration log by default', state: 'MERGED', status: 'opt_done', assignees: [person('oguilhermelima')] }),
  item('PVTI_06', { ...issue(120), title: 'Artifacts revision picker loses its place', state: 'CLOSED', status: 'opt_done', labels: [label('bug', 'd73a4a')] }),
  item('PVTI_07', { ...issue(131), title: 'Run panel remembers its width per worktree', status: 'opt_progress', assignees: [person('octocat'), person('oguilhermelima')] }),
  item('PVTI_08', { ...issue(12), title: 'Shared icons for the docs site', repository: 'oguilhermelima/megabrain-docs', url: 'https://github.com/oguilhermelima/megabrain-docs/issues/12', status: 'opt_todo', labels: [label('docs', '0075ca')] }),
  item('PVTI_09', { ...pull(143), title: 'Draft: drag cards between columns', status: null, assignees: [person('octocat')] }),
  item('PVTI_10', { ...issue(144), title: 'Board keyboard navigation', status: null, labels: [label('a11y', 'c5def5')] }),
  item('PVTI_11', { type: 'DRAFT_ISSUE', state: null, title: 'Decide on a board for the CLI lane', status: 'opt_review' }),
  item('PVTI_12', { ...issue(137), title: 'Item whose option was deleted', status: 'opt_removed', labels: [label('question', 'd876e3')] }),
]

export const fixtureBacklogItems: GithubProjectItem[] = [
  item('PVTI_21', { ...issue(150), title: 'Grok leader socket per worktree' }),
  item('PVTI_22', { type: 'DRAFT_ISSUE', state: null, title: 'A themes gallery' }),
  item('PVTI_23', { ...pull(151), title: 'Probe tmux 3.6 pane ids', assignees: [person('octocat')] }),
]

export const mockGithubProjects: GithubProject[] = [fixtureRoadmap, fixtureBacklog]

export const mockGithubProjectStatusUpdates = {
  [fixtureRoadmap.number]: [{ id: 'PVT_status_roadmap', status: 'ON_TRACK' as const, body: 'Work is progressing as planned', startDate: '2026-10-01', targetDate: '2026-10-31', createdAt: '2026-10-02T12:00:00.000Z', creator: 'operator' }],
}

export const mockGithubProjectWorkflows = {
  [fixtureRoadmap.number]: [{ id: 'PWF_auto_close', name: 'Auto-close issue', number: 9, enabled: true }],
}

export const mockGithubProjectItems: Record<number, GithubProjectItem[]> = {
  [fixtureRoadmap.number]: fixtureRoadmapItems,
  [fixtureBacklog.number]: fixtureBacklogItems,
}
