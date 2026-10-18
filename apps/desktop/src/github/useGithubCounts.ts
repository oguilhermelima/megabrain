import { useState } from 'react'
import type { Project } from '@/api/schema'
import { githubRepository } from '@/github/github-model'
import { issuePage, pullRequestPage } from '@/github/github-requests'
import { githubCountsPolicy, mapLimited } from '@/lib/poll-model'
import { reuse } from '@/lib/reuse'
import { usePoll } from '@/lib/usePoll'

export type GithubKind = 'prs' | 'issues' | 'actions'

/** The kinds the GitHub page lists; a project's issues are the Tasks page's. */
export type GithubPageKind = Exclude<GithubKind, 'issues'>

/** Open pull requests and issues per project path; null until known or when gh could not answer. */
export type GithubCounts = Record<string, { prs: number | null; issues: number | null }>

// The badges on the project rows: the open total of the first open page, the same request the open
// tab of a page makes, so the two share one gh call. At most three projects are read at once, every
// two minutes while the window shows (githubCountsPolicy).
const concurrentProjects = 3

export function useGithubCounts(projects: Project[]): GithubCounts {
  const [counts, setCounts] = useState<GithubCounts>({})
  const paths = projects.filter((project) => !project.missing && githubRepository(project.remote) !== null).map((project) => project.path)
  const key = paths.join('\n')

  usePoll(
    githubCountsPolicy,
    async (current) => {
      if (paths.length === 0) return
      const entries = await mapLimited(paths, concurrentProjects, async (path) => {
        const [prs, issues] = await Promise.allSettled([pullRequestPage(path, 'open', null), issuePage(path, 'open', null)])
        return [path, { prs: prs.status === 'fulfilled' ? (prs.value.counts.open ?? null) : null, issues: issues.status === 'fulfilled' ? (issues.value.counts.open ?? null) : null }] as const
      })
      if (current()) setCounts((previous) => reuse(previous, Object.fromEntries(entries)))
    },
    // The joined paths are the dependency; the array is rebuilt on every render.
    [key],
  )

  return counts
}
