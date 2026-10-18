import { api } from '@/api'
import type { GithubActionRun } from '@/api/schema'
import { shareInFlight } from '@/github/github-model'
import { isLive, latestRunsByBranch, type RunsPage } from '@/github/actions-model'

// Every runs request goes through here, so the project page's section, its worktree rows and the
// Actions page asking for the same page at once share one gh call.
const share = shareInFlight()

export interface RunFilters {
  workflow: string | null
  branch: string | null
}

export const noRunFilters: RunFilters = { workflow: null, branch: null }

export function runsPage(root: string, filters: RunFilters, limit: number, after: string | null): Promise<RunsPage> {
  const key = JSON.stringify(['runs', root, filters.workflow, filters.branch, limit, after])
  return share(key, async () => {
    const page = await api.githubActionRuns(root, { ...(filters.workflow === null ? {} : { workflow: filters.workflow }), ...(filters.branch === null ? {} : { branch: filters.branch }), limit, after })
    return { runs: page.runs, workflows: page.workflows, next: page.next, fetchedAt: new Date().toISOString() }
  })
}

/** The newest run of one branch (a pull request's head, a worktree's branch); null when it has none. */
export async function latestRun(root: string, branch: string): Promise<GithubActionRun | null> {
  const page = await runsPage(root, { workflow: null, branch }, 10, null)
  return latestRunsByBranch(page.runs).get(branch) ?? null
}

export const anyLive = (runs: { status: string }[]) => runs.some(isLive)
