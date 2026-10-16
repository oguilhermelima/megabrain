import { useCallback, useState } from 'react'
import { api } from '@/api'
import type { Project } from '@/api/schema'
import { stackDetails, worktreeTree, type StackDetail, type WorktreeNode } from '@/advanced/stacks'
import { githubCountsPolicy, mapLimited } from '@/lib/poll-model'
import { reuse } from '@/lib/reuse'
import { usePoll } from '@/lib/usePoll'

/** Review, checks and behind counts per project path, then per branch; absent until read or when gh could not answer. */
export type StackDetails = Record<string, Record<string, StackDetail>>

// Each stack's extra state comes from `stack show --branch <tip> --json`, one call per tip (a fork has
// two), at most two at a time, on the GitHub badges' schedule. An answer is kept for as long as the
// CLI keeps its own GitHub answers (60 s) and dropped after any stack action, so the next read is fresh.
const cacheMs = 60_000
const concurrentStacks = 2
const cache = new Map<string, { at: number; details: Record<string, StackDetail> }>()

const tips = (node: WorktreeNode): string[] => (node.children.length === 0 ? (node.worktree.branch === null ? [] : [node.worktree.branch]) : node.children.flatMap(tips))

function stackTips(project: Project): string[] {
  return worktreeTree(project).flatMap((node) => (node.place === null ? [] : tips(node)))
}

export function useStackDetails(projects: Project[]): { details: StackDetails; forget: (projectPath: string) => void } {
  const [details, setDetails] = useState<StackDetails>({})
  const [generation, setGeneration] = useState(0)
  const reads = projects.filter((project) => !project.missing && project.remote !== null).flatMap((project) => stackTips(project).map((tip) => ({ path: project.path, tip })))
  const key = reads.map((read) => `${read.path}\n${read.tip}`).join('\n')

  usePoll(
    githubCountsPolicy,
    async (current) => {
      if (reads.length === 0) return
      const now = Date.now()
      const answers = await mapLimited(reads, concurrentStacks, async ({ path, tip }) => {
        const cacheKey = `${path}\n${tip}`
        const cached = cache.get(cacheKey)
        if (cached !== undefined && now - cached.at < cacheMs) return { path, details: cached.details }
        try {
          const read = Object.fromEntries(stackDetails(await api.stackShow(path, tip)))
          cache.set(cacheKey, { at: Date.now(), details: read })
          return { path, details: read }
        } catch {
          // Without gh, or on a refusal, the rows keep what the projects list says.
          return { path, details: cached?.details ?? {} }
        }
      })
      const next: StackDetails = {}
      for (const answer of answers) next[answer.path] = { ...next[answer.path], ...answer.details }
      if (current()) setDetails((previous) => reuse(previous, next))
    },
    // The joined reads are the dependency; a forget bumps the generation to read again at once.
    [key, generation],
  )

  const forget = useCallback((projectPath: string) => {
    for (const cacheKey of [...cache.keys()]) if (cacheKey.startsWith(`${projectPath}\n`)) cache.delete(cacheKey)
    setGeneration((value) => value + 1)
  }, [])

  return { details, forget }
}
