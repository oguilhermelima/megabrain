import type { Dispatch, Worktree } from '@/api/schema'

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

function repositoryName(chat: Dispatch, worktrees: Worktree[]): string {
  const path = chat.worktreePath ?? null
  if (path === null || path === '') return 'Other'
  return worktrees.find((worktree) => worktree.path === path)?.repository?.name ?? folder(path)
}

/** Open chats by repository and worktree, both sorted by name; ended ones apart, newest first. */
export function groupChats(chats: Dispatch[], worktrees: Worktree[]): { repositories: RepositoryGroup[]; ended: Dispatch[] } {
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

/** The chat before or after the selected one, wrapping around; the first when none is selected. */
export function neighbour(ids: string[], selected: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null
  const index = selected === null ? -1 : ids.indexOf(selected)
  if (index === -1) return ids[0] ?? null
  return ids[(index + step + ids.length) % ids.length] ?? null
}

export function pillSummary(chats: Dispatch[]): { working: number; needsYou: number; queued: number } {
  const states = chats.map(chatState)
  return {
    working: states.filter((state) => state === 'working').length,
    needsYou: states.filter((state) => state === 'needs-you').length,
    queued: states.filter((state) => state === 'queued').length,
  }
}
