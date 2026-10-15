import type { Worktree } from '@/api/schema'

export interface StackNode {
  branch: string
  worktreePath: string | null
  pullRequest: Worktree['pullRequest']
  /** True for a parent branch that has no worktree of its own, such as main. */
  isBase: boolean
  children: StackNode[]
}

export interface Stack {
  repositoryName: string
  root: StackNode
}

export interface StackModel {
  stacks: Stack[]
  /** Worktrees that are not part of any stack; render them as today. */
  standalone: Worktree[]
}

/**
 * Groups worktrees of the same repository into stacks of dependent branches, linked by
 * `parent`. A worktree whose branch is nobody's parent and has none of its own stays standalone.
 */
export function buildStackModel(worktrees: Worktree[]): StackModel {
  const byRepo = new Map<string, Worktree[]>()
  for (const worktree of worktrees) {
    const repositoryName = worktree.repository?.name
    if (repositoryName === undefined) continue
    const list = byRepo.get(repositoryName) ?? []
    list.push(worktree)
    byRepo.set(repositoryName, list)
  }

  const stacks: Stack[] = []
  const standalone: Worktree[] = []

  for (const [repositoryName, repoWorktrees] of byRepo) {
    const byBranch = new Map(repoWorktrees.map((worktree) => [worktree.branch, worktree]))
    const childrenOf = new Map<string, Worktree[]>()
    for (const worktree of repoWorktrees) {
      const parent = worktree.parent ?? null
      if (parent === null) continue
      const children = childrenOf.get(parent) ?? []
      children.push(worktree)
      childrenOf.set(parent, children)
    }

    const rootBranches = new Set<string>()
    for (const worktree of repoWorktrees) {
      if ((worktree.parent ?? null) === null && childrenOf.has(worktree.branch)) rootBranches.add(worktree.branch)
    }
    for (const parentBranch of childrenOf.keys()) {
      if (!byBranch.has(parentBranch)) rootBranches.add(parentBranch)
    }

    const visited = new Set<string>()
    const buildNode = (branch: string): StackNode => {
      visited.add(branch)
      const worktree = byBranch.get(branch) ?? null
      const children = (childrenOf.get(branch) ?? [])
        .map((child) => buildNode(child.branch))
        .sort((left, right) => left.branch.localeCompare(right.branch))
      return {
        branch,
        worktreePath: worktree?.path ?? null,
        pullRequest: worktree?.pullRequest ?? null,
        isBase: worktree === null,
        children,
      }
    }

    for (const rootBranch of [...rootBranches].sort((left, right) => left.localeCompare(right))) {
      stacks.push({ repositoryName, root: buildNode(rootBranch) })
    }

    for (const worktree of repoWorktrees) {
      if (!visited.has(worktree.branch)) standalone.push(worktree)
    }
  }

  return {
    stacks: stacks.sort((left, right) => left.repositoryName.localeCompare(right.repositoryName) || left.root.branch.localeCompare(right.root.branch)),
    standalone,
  }
}

/** Depth-first rows for rendering a stack: base first, then each branch under its parent. */
export function flattenStack(node: StackNode, depth = 0): Array<StackNode & { depth: number }> {
  return [{ ...node, depth }, ...node.children.flatMap((child) => flattenStack(child, depth + 1))]
}
