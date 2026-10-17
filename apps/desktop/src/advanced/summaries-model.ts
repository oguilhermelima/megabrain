import type { SummariesList, Summary } from '@/api/schema'

// The sidebar's Summaries section: chat summaries by project and branch, as `summaries list` returns
// them, or regrouped from `summaries search` results while the section's search has text. The section
// folds under its own key in the sidebar state; its projects start folded, so their key in the same
// list marks one the person opened.

export type SummaryProject = SummariesList['projects'][number]

const newestFirst = (left: Summary, right: Summary) => right.createdAt.localeCompare(left.createdAt)

/** Summaries by repository and branch, each ordered by its newest summary; a branch keeps at most `limit`, the newest. */
export function groupSummaries(entries: readonly Summary[], live: (repo: string, branch: string) => boolean, limit: number = Number.POSITIVE_INFINITY): SummaryProject[] {
  const projects = new Map<string, { project: string; branches: Map<string, Summary[]> }>()
  for (const entry of [...entries].sort(newestFirst)) {
    const project = projects.get(entry.repo) ?? { project: entry.project, branches: new Map<string, Summary[]>() }
    const branch = project.branches.get(entry.branch) ?? []
    branch.push(entry)
    project.branches.set(entry.branch, branch)
    projects.set(entry.repo, project)
  }
  // Maps keep insertion order, and entries went in newest first, so both levels already sit by latest activity.
  return [...projects].map(([repo, { project, branches }]) => ({
    repo,
    project,
    branches: [...branches].map(([branch, summaries]) => ({ branch, worktree: summaries[0]?.worktree ?? '', live: live(repo, branch), summaries: summaries.slice(0, limit) })),
  }))
}

/** Whether a branch's worktree still exists, as the list says; a branch it does not name counts as live. */
export function branchLive(list: SummariesList | null): (repo: string, branch: string) => boolean {
  const gone = new Set(list?.projects.flatMap((project) => project.branches.filter((branch) => !branch.live).map((branch) => `${project.repo}\n${branch.branch}`)) ?? [])
  return (repo, branch) => !gone.has(`${repo}\n${branch}`)
}

/** A branch's count; a full page means there may be more. */
export const branchCount = (count: number, limit: number): string => (count >= limit ? `${count}+` : String(count))

/** The newer and older summary beside one in its branch's list (newest first). */
export function neighbours(branch: readonly Summary[], id: string): { newer: Summary | null; older: Summary | null } {
  const index = branch.findIndex((entry) => entry.id === id)
  if (index === -1) return { newer: null, older: null }
  return { newer: branch[index - 1] ?? null, older: branch[index + 1] ?? null }
}

export const summariesSectionKey = 'summaries'

export const summaryProjectKey = (repo: string): string => `${summariesSectionKey}:${repo}`

export const summaryProjectOpen = (collapsed: ReadonlySet<string>, repo: string): boolean => collapsed.has(summaryProjectKey(repo))
