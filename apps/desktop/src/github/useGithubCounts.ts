import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { Project } from '@/api/schema'
import { githubRepository } from '@/github/github-model'

export type GithubKind = 'prs' | 'issues'

/** Open pull requests and issues per project path; null until known or when gh could not answer. */
export type GithubCounts = Record<string, { prs: number | null; issues: number | null }>

// The badges on the project rows. The CLI caches each answer for 60 s, so reading again every minute
// costs one gh call per project and list at most.
const countLimit = 100
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
          const [prs, issues] = await Promise.allSettled([api.githubPullRequests(path, 'open', countLimit), api.githubIssues(path, 'open', countLimit)])
          return [path, { prs: prs.status === 'fulfilled' ? prs.value.items.length : null, issues: issues.status === 'fulfilled' ? issues.value.items.length : null }] as const
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
