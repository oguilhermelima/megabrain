import { useEffect, useState } from 'react'
import type { Project } from '@/api/schema'
import { githubRepository } from '@/github/github-model'
import { issuePage, pullRequestPage } from '@/github/github-requests'

export type GithubKind = 'prs' | 'issues'

/** Open pull requests and issues per project path; null until known or when gh could not answer. */
export type GithubCounts = Record<string, { prs: number | null; issues: number | null }>

// The badges on the project rows: the open total of the first open page, the same request the open
// tab of a page makes, so the two share one gh call. The CLI caches each answer for 60 s.
const refreshMs = 60_000

export function useGithubCounts(projects: Project[]): GithubCounts {
  const [counts, setCounts] = useState<GithubCounts>({})
  const paths = projects.filter((project) => !project.missing && githubRepository(project.remote) !== null).map((project) => project.path)
  const key = paths.join('\n')

  useEffect(() => {
    if (paths.length === 0) return
    let stopped = false
    const load = async () => {
      const entries = await Promise.all(
        paths.map(async (path) => {
          const [prs, issues] = await Promise.allSettled([pullRequestPage(path, 'open', null), issuePage(path, 'open', null)])
          return [path, { prs: prs.status === 'fulfilled' ? (prs.value.counts.open ?? null) : null, issues: issues.status === 'fulfilled' ? (issues.value.counts.open ?? null) : null }] as const
        }),
      )
      if (!stopped) setCounts(Object.fromEntries(entries))
    }
    void load()
    const timer = setInterval(() => void load(), refreshMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
    // The joined paths are the dependency; the array is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return counts
}
