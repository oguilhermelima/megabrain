import type { Dispatch, Project } from '@/api/schema'

export type ChatState = 'needs-you' | 'working' | 'queued' | 'ended'

const ended = new Set(['done', 'failed', 'cancelled', 'exited', 'closed'])

export function chatState(chat: Dispatch): ChatState {
  if (chat.supervision.finding !== null) return 'needs-you'
  if (ended.has(chat.state)) return 'ended'
  if (chat.state === 'queued') return 'queued'
  // Everything else is in flight: running, spawning, and states such as orphaned that still hold a child.
  return 'working'
}

export interface WorktreeGroup {
  path: string | null
  branch: string | null
  chats: Dispatch[]
}

export interface RepositoryGroup {
  name: string
  worktrees: WorktreeGroup[]
}

const folder = (path: string): string => path.replace(/\/+$/, '').split('/').at(-1) ?? path

/** Which repository a worktree belongs to: what `groupChats` needs from `worktree list`. */
export interface WorktreeRepository {
  path: string
  repository?: { name: string }
}

/** Every listed worktree with its repository named after the main checkout's folder, as `worktree list` names it. */
export function worktreeRepositories(projects: Project[]): WorktreeRepository[] {
  return projects.flatMap((project) => project.worktrees.map((worktree) => ({ path: worktree.path, repository: { name: folder(project.path) } })))
}

function repositoryName(chat: Dispatch, worktrees: WorktreeRepository[]): string {
  const path = chat.worktreePath ?? null
  if (path === null || path === '') return 'Other'
  return worktrees.find((worktree) => worktree.path === path)?.repository?.name ?? folder(path)
}

/** Open chats by repository and worktree, both sorted by name; ended ones apart, newest first. */
export function groupChats(chats: Dispatch[], worktrees: WorktreeRepository[]): { repositories: RepositoryGroup[]; ended: Dispatch[] } {
  const repositories = new Map<string, Map<string, WorktreeGroup>>()
  const endedChats: Dispatch[] = []
  for (const chat of [...chats].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    if (chatState(chat) === 'ended') {
      endedChats.push(chat)
      continue
    }
    const name = repositoryName(chat, worktrees)
    const groups = repositories.get(name) ?? new Map<string, WorktreeGroup>()
    const key = chat.worktreePath ?? ''
    const group = groups.get(key) ?? { path: chat.worktreePath ?? null, branch: chat.branch ?? null, chats: [] }
    group.chats.push(chat)
    groups.set(key, group)
    repositories.set(name, groups)
  }
  return {
    repositories: [...repositories]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, groups]) => ({ name, worktrees: [...groups.values()].sort((left, right) => (left.path ?? '').localeCompare(right.path ?? '')) })),
    ended: endedChats.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  }
}

export function pillSummary(chats: Dispatch[]): { working: number; needsYou: number; queued: number } {
  const states = chats.map(chatState)
  return {
    working: states.filter((state) => state === 'working').length,
    needsYou: states.filter((state) => state === 'needs-you').length,
    queued: states.filter((state) => state === 'queued').length,
  }
}
