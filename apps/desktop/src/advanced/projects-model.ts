import type { Project, ProjectSession, ProjectWorktree } from '@/api/schema'
import { flattenTree, worktreeTree } from '@/advanced/stacks'

export interface ProjectWorktreeRow {
  worktree: ProjectWorktree
  depth: number
}

/** Worktree rows for one project, the primary checkout first and stacked branches under their parent (see stacks.ts). */
export function projectWorktreeRows(project: Project): ProjectWorktreeRow[] {
  return flattenTree(worktreeTree(project)).map(({ node, depth }) => ({ worktree: node.worktree, depth }))
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
