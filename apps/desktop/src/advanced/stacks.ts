import type { Project, ProjectWorktree, StackShow } from '@/api/schema'

// Stacked branches in the sidebar: a worktree whose recorded parent is another (non-primary)
// worktree's branch nests under it. The primary checkout is the base every stack starts from, never
// a member, so a worktree made from main with no children stays an independent row.

export interface StackPlace {
  /** The path of the stack's first branch; the same for every member. */
  root: string
  /** 1 for the root, then one more per level. */
  position: number
  /** The length of the longest line through this branch, root to tip. */
  total: number
  /** Some branch of the stack has two or more children. */
  forked: boolean
}

export interface WorktreeNode {
  worktree: ProjectWorktree
  /** Null outside a stack. */
  place: StackPlace | null
  children: WorktreeNode[]
}

type Bare = { worktree: ProjectWorktree; children: Bare[] }

/** The project's worktrees as rows: the primary first, then each independent row or stack in listed order. */
export function worktreeTree(project: Pick<Project, 'worktrees'>): WorktreeNode[] {
  const members = project.worktrees.filter((worktree) => !worktree.primary)
  const byBranch = new Map(members.flatMap((worktree) => (worktree.branch === null ? [] : [[worktree.branch, worktree] as const])))
  const parentOf = (worktree: ProjectWorktree) => (worktree.branch === null || worktree.parent === null || worktree.parent === worktree.branch ? undefined : byBranch.get(worktree.parent))
  const childrenOf = new Map<string, ProjectWorktree[]>()
  for (const worktree of members) {
    const parent = parentOf(worktree)
    if (parent === undefined) continue
    childrenOf.set(parent.path, [...(childrenOf.get(parent.path) ?? []), worktree])
  }
  const placed = new Set<string>()
  const build = (worktree: ProjectWorktree): Bare => {
    placed.add(worktree.path)
    const children = (childrenOf.get(worktree.path) ?? []).filter((child) => !placed.has(child.path)).sort((left, right) => (left.branch ?? '').localeCompare(right.branch ?? ''))
    return { worktree, children: children.map(build) }
  }
  // A worktree in a parent cycle has a parent but no root above it; it shows on its own.
  const roots = members.filter((worktree) => parentOf(worktree) === undefined).map(build)
  const loose = members.filter((worktree) => !placed.has(worktree.path)).map((worktree): Bare => ({ worktree, children: [] }))
  const ordered = [...roots, ...loose].sort((left, right) => members.indexOf(left.worktree) - members.indexOf(right.worktree))
  const primary = project.worktrees.filter((worktree) => worktree.primary).map((worktree): Bare => ({ worktree, children: [] }))
  return [...primary, ...ordered].map((node) => (node.children.length === 0 ? { worktree: node.worktree, place: null, children: [] } : placeStack(node)))
}

function placeStack(root: Bare): WorktreeNode {
  const height = (node: Bare): number => 1 + Math.max(0, ...node.children.map(height))
  const forks = (node: Bare): boolean => node.children.length > 1 || node.children.some(forks)
  const forked = forks(root)
  const place = (node: Bare, position: number): WorktreeNode => ({
    worktree: node.worktree,
    place: { root: root.worktree.path, position, total: position - 1 + height(node), forked },
    children: node.children.map((child) => place(child, position + 1)),
  })
  return place(root, 1)
}

/** The rows that show: a dropped member's children take its place and keep their positions. */
export function visibleTree(nodes: WorktreeNode[], shown: (worktree: ProjectWorktree) => boolean): WorktreeNode[] {
  return nodes.flatMap((node) => (shown(node.worktree) ? [{ ...node, children: visibleTree(node.children, shown) }] : visibleTree(node.children, shown)))
}

/** Depth-first, as the sidebar renders them. */
export function flattenTree(nodes: WorktreeNode[], depth = 0): Array<{ node: WorktreeNode; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)])
}

export type ChecksState = 'failing' | 'passing' | 'pending' | 'none'

/** What `stack show --json` adds to the projects list for one branch. */
export interface StackDetail {
  reviewDecision: string | null
  checks: ChecksState
  /** Commits the parent has that the branch lacks; null when git could not tell. */
  behindParent: number | null
}

// The same reading as the CLI's own table (src/cli/commands/stack.ts githubChecks).
function checksOf(rollup: unknown[] | null | undefined): ChecksState {
  if (rollup === null || rollup === undefined || rollup.length === 0) return 'none'
  const states = rollup.map((item) => {
    const check = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    const value = [check.conclusion, check.state, check.status].find((field) => typeof field === 'string' && field !== '')
    return typeof value === 'string' ? value.toUpperCase() : ''
  })
  if (states.some((state) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].includes(state))) return 'failing'
  if (states.every((state) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state))) return 'passing'
  return 'pending'
}

export function stackDetails(show: StackShow): Map<string, StackDetail> {
  return new Map(
    show.branches.map((entry) => {
      const review = entry.pullRequest?.reviewDecision
      return [entry.branch, { reviewDecision: typeof review === 'string' && review !== '' ? review : null, checks: checksOf(entry.pullRequest?.statusCheckRollup), behindParent: typeof entry.behindParent === 'number' ? entry.behindParent : null }]
    }),
  )
}

export type MemberStatus = 'draft' | 'open' | 'approved' | 'changes-requested' | 'merged' | 'closed' | 'checks-failing'

export const memberStatusLabel: Record<MemberStatus, string> = {
  draft: 'draft',
  open: 'open',
  approved: 'approved',
  'changes-requested': 'changes requested',
  merged: 'merged',
  closed: 'closed',
  'checks-failing': 'checks failing',
}

/** One word for a member's pull request, and whether its parent moved on since it branched. */
export function memberStatus(pullRequest: ProjectWorktree['pullRequest'], detail?: StackDetail): { status: MemberStatus | null; needsSync: boolean } {
  const needsSync = detail?.behindParent !== null && detail?.behindParent !== undefined && detail.behindParent > 0
  if (pullRequest === null) return { status: null, needsSync }
  const state = pullRequest.state.toUpperCase()
  if (state === 'MERGED') return { status: 'merged', needsSync }
  if (state === 'CLOSED') return { status: 'closed', needsSync }
  if (pullRequest.isDraft === true) return { status: 'draft', needsSync }
  if (detail?.checks === 'failing') return { status: 'checks-failing', needsSync }
  if (detail?.reviewDecision === 'APPROVED') return { status: 'approved', needsSync }
  if (detail?.reviewDecision === 'CHANGES_REQUESTED') return { status: 'changes-requested', needsSync }
  return { status: 'open', needsSync }
}

export interface StackChain {
  /** Root to tip through the member, the order the CLI's `--branch` selects. */
  members: ProjectWorktree[]
  forked: boolean
}

/**
 * The line `megabrain stack … --branch <member>` acts on: the path from the root to the member, then
 * on while each branch has a single child. Null outside a stack.
 */
export function stackChain(nodes: WorktreeNode[], path: string): StackChain | null {
  const trail = (list: WorktreeNode[]): WorktreeNode[] | null => {
    for (const node of list) {
      if (node.worktree.path === path) return [node]
      const below = trail(node.children)
      if (below !== null) return [node, ...below]
    }
    return null
  }
  const found = trail(nodes)
  const member = found?.at(-1)
  if (found === null || member === undefined || member.place === null) return null
  const line = [...found]
  for (let last = member; last.children.length === 1 && last.children[0] !== undefined; last = last.children[0]) line.push(last.children[0])
  return { members: line.map((node) => node.worktree), forked: member.place.forked }
}

export type PullRequest = NonNullable<ProjectWorktree['pullRequest']>

export type StackAction =
  | { kind: 'new-stacked' }
  | { kind: 'sync' }
  | { kind: 'pr'; draft: boolean }
  | { kind: 'merge'; pullRequests: Array<PullRequest & { branch: string }> }
  | { kind: 'show-github'; url: string }

/**
 * What a worktree row's menu offers for stacks. Any branch can start a stack on itself; sync, open
 * and merge act on the member's chain and need a remote and a stack with no fork (the CLI refuses
 * one); merge also needs every member's pull request open.
 */
export function stackActions(project: Pick<Project, 'remote'>, nodes: WorktreeNode[], node: WorktreeNode): StackAction[] {
  const { worktree } = node
  if (worktree.primary || worktree.branch === null) return []
  const actions: StackAction[] = [{ kind: 'new-stacked' }]
  const chain = stackChain(nodes, worktree.path)
  if (chain === null) return actions
  if (project.remote !== null && !chain.forked) {
    actions.push({ kind: 'sync' }, { kind: 'pr', draft: false }, { kind: 'pr', draft: true })
    const pullRequests = chain.members.flatMap((member) => (member.pullRequest !== null && member.pullRequest.state.toUpperCase() === 'OPEN' && member.branch !== null ? [{ ...member.pullRequest, branch: member.branch }] : []))
    if (pullRequests.length === chain.members.length) actions.push({ kind: 'merge', pullRequests })
  }
  if (worktree.pullRequest !== null) actions.push({ kind: 'show-github', url: worktree.pullRequest.url })
  return actions
}
