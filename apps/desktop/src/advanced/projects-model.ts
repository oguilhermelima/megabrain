import type { Project, ProjectSession, ProjectWorktree, Worktree } from '@/api/schema'
import { buildStackModel, flattenStack } from '@/advanced/stack-model'

export interface ProjectWorktreeRow {
  worktree: ProjectWorktree
  depth: number
}

function toStackWorktree(worktree: ProjectWorktree, project: Project): Worktree {
  return {
    path: worktree.path,
    branch: worktree.branch ?? `detached:${worktree.path}`,
    parent: worktree.parent,
    pullRequest: worktree.pullRequest,
    repository: { name: project.name, path: project.path },
  }
}

/** Moves the primary worktree (and its stack subtree, if any) to the front, keeping the rest in place. */
function primaryFirst(rows: ProjectWorktreeRow[]): ProjectWorktreeRow[] {
  const index = rows.findIndex((row) => row.worktree.primary)
  if (index <= 0) return rows
  const baseDepth = rows[index]?.depth ?? 0
  let end = index + 1
  while (end < rows.length && (rows[end]?.depth ?? 0) > baseDepth) end++
  const block = rows.slice(index, end)
  const remainder = [...rows.slice(0, index), ...rows.slice(end)]
  return [...block, ...remainder]
}

/**
 * Worktree rows for one project, nested by stack (parent branch) as `stack-model.ts` already does
 * for dispatches, with the primary checkout first.
 */
export function projectWorktreeRows(project: Project): ProjectWorktreeRow[] {
  const byPath = new Map(project.worktrees.map((worktree) => [worktree.path, worktree]))
  const converted = project.worktrees.map((worktree) => toStackWorktree(worktree, project))
  const { stacks, standalone } = buildStackModel(converted)
  const rows: ProjectWorktreeRow[] = []
  for (const stack of stacks) {
    for (const node of flattenStack(stack.root)) {
      if (node.worktreePath === null) continue
      const worktree = byPath.get(node.worktreePath)
      if (worktree !== undefined) rows.push({ worktree, depth: node.depth })
    }
  }
  for (const converted2 of standalone) {
    const worktree = byPath.get(converted2.path)
    if (worktree !== undefined) rows.push({ worktree, depth: 0 })
  }
  return primaryFirst(rows)
}

/** Live sessions before ended ones; within each group, most recently active first. */
export function sortSessions(sessions: ProjectSession[]): ProjectSession[] {
  const rank = (session: ProjectSession) => (session.status === 'ended' ? 1 : 0)
  return [...sessions].sort((left, right) => {
    const byRank = rank(left) - rank(right)
    if (byRank !== 0) return byRank
    const leftAt = left.lastActivityAt ?? left.startedAt ?? ''
    const rightAt = right.lastActivityAt ?? right.startedAt ?? ''
    return rightAt.localeCompare(leftAt)
  })
}

/** A relative age such as "now", "1m", "14h", "2d"; empty when there is no timestamp. */
export function relativeAge(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return ''
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export interface SidebarSessionRow {
  projectName: string
  worktreePath: string
  session: ProjectSession
}

/**
 * Every session across every open (not collapsed) project, in the order the sidebar renders them —
 * the order `Cmd+[`/`Cmd+]` walk.
 */
export function sidebarSessionOrder(projects: Project[], collapsed: ReadonlySet<string>): SidebarSessionRow[] {
  const rows: SidebarSessionRow[] = []
  for (const project of projects) {
    if (collapsed.has(project.name)) continue
    for (const { worktree } of projectWorktreeRows(project)) {
      for (const session of sortSessions(worktree.sessions)) {
        rows.push({ projectName: project.name, worktreePath: worktree.path, session })
      }
    }
  }
  return rows
}

/** The session before or after the selected one, wrapping around; the first when none is selected. */
export function neighbourSession(rows: SidebarSessionRow[], selected: string | null, step: 1 | -1): SidebarSessionRow | null {
  if (rows.length === 0) return null
  const index = selected === null ? -1 : rows.findIndex((row) => row.session.sessionId === selected)
  if (index === -1) return rows[0] ?? null
  return rows[(index + step + rows.length) % rows.length] ?? null
}
