import type { Project } from '@/api/schema'
import { displayName } from '@/advanced/appearance-model'
import type { PaneView } from '@/chat/action-bar-model'
import type { CodeShown } from '@/code/code-pane-model'
import type { ItemKind } from '@/panes/pane-model'

// A split whose panes all work in one worktree gets one bar over the whole area (GroupBar): the
// worktree's identity, Agent, Code, PR and Diff for the whole split, and Run. Its panes keep a slim
// header each. A split across worktrees keeps each pane's own top bar. Either way the usage limits
// show once for the split, never under every composer.

export interface SplitMember {
  item: string
  kind: ItemKind | null
  /** The worktree the member's action bar would name; null or empty while it has none. */
  worktree: string | null
  /** The agent whose limits the member's composer would show; null for terminals and launchers. */
  agent: string | null
}

/** The items a shared bar can stand in for: everything whose own top bar carries the action bar, but a Code item, whose bar is its view. */
const sharedKinds: ReadonlySet<ItemKind> = new Set<ItemKind>(['dispatch', 'session', 'native', 'terminal', 'launcher'])

/** The worktree a split shares one bar for, or null when it keeps per-pane headers: one pane alone, two worktrees, or a member without one. */
export function sharedWorktree(members: readonly SplitMember[]): string | null {
  if (members.length < 2) return null
  const first = members[0]?.worktree ?? null
  if (first === null || first === '') return null
  return members.every((member) => member.kind !== null && sharedKinds.has(member.kind) && member.worktree === first) ? first : null
}

/** Where the usage limits show: under the one composer, in the shared bar, or once under a split across worktrees. */
export type LimitsPlace = 'composer' | 'group-bar' | 'under-split'

export function limitsPlace({ panes, shared }: { panes: number; shared: boolean }): LimitsPlace {
  if (panes < 2) return 'composer'
  return shared ? 'group-bar' : 'under-split'
}

/** The agents whose limits a split shows, each once, in pane order. */
export function limitAgents(members: readonly SplitMember[]): string[] {
  return [...new Set(members.flatMap((member) => (member.agent === null || member.agent === '' ? [] : [member.agent])))]
}

/** The split's own Code slot, named like an item so the code layer can hold a frame over it. */
export const splitCodeItem = (groupId: string) => `split:${groupId}`

/** The Code a shared bar asks for: the worktree's one server, its frame laid over the split's own slot. */
export function splitCodeShown({ groupId, root, view }: { groupId: string; root: string; view: PaneView }): CodeShown | null {
  return view === 'code' ? { item: splitCodeItem(groupId), root } : null
}

export interface GroupIdentity {
  project: Project | null
  name: string
  branch: string | null
  pullRequest: number | null
}

/** What the shared bar names at its left: the project (its display name), the branch and its pull request; an unknown worktree by its folder. */
export function groupIdentity(projects: readonly Project[], root: string): GroupIdentity {
  for (const project of projects) {
    const worktree = project.worktrees.find((candidate) => candidate.path === root)
    if (worktree !== undefined) return { project, name: displayName(project), branch: worktree.branch, pullRequest: worktree.pullRequest?.number ?? null }
  }
  return { project: null, name: root.split('/').filter((part) => part !== '').at(-1) ?? root, branch: null, pullRequest: null }
}
