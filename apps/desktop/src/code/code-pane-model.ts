import type { Project, ProjectWorktree } from '@/api/schema'

/** A worktree or repository opened in VS Code. */
export interface CodeTarget {
  root: string
  title: string
}

const folder = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

/** A project opens under its name; a worktree under its project and branch. */
export function codeTargetFor(project: Project, worktree?: ProjectWorktree): CodeTarget {
  if (worktree === undefined || worktree.primary || worktree.path === project.path) return { root: project.path, title: project.name }
  return { root: worktree.path, title: `${project.name} · ${worktree.branch ?? folder(worktree.path)}` }
}

/** The target for a root a chat names: the project or worktree that holds it, else its folder. */
export function codeTargetForRoot(projects: Project[], root: string): CodeTarget {
  const project = projects.find((candidate) => candidate.path === root || candidate.worktrees.some((worktree) => worktree.path === root)) ?? null
  if (project === null) return { root, title: folder(root) }
  return codeTargetFor(project, project.worktrees.find((worktree) => worktree.path === root))
}

/** A pane showing a root in Code. */
export interface CodeShown {
  item: string
  root: string
}

/**
 * Which pane's item holds each root's VS Code. A root has one frame, so when two panes show it in
 * Code the one that held it keeps it, else the first in reading order takes it; the other pane
 * points to it. An unchanged assignment is returned as is.
 */
export function frameHolders(previous: Readonly<Record<string, string>>, shown: readonly CodeShown[]): Readonly<Record<string, string>> {
  const next: Record<string, string> = {}
  for (const { item, root } of shown) {
    const holder = previous[root]
    if (holder !== undefined && shown.some((entry) => entry.item === holder && entry.root === root)) next[root] = holder
    else next[root] ??= item
  }
  const roots = Object.keys(next)
  return roots.length === Object.keys(previous).length && roots.every((root) => previous[root] === next[root]) ? previous : next
}

/** How long a server keeps running after nothing in the panes uses its root: coming back within it is instant. */
export const serverGraceMs = 10 * 60_000

/**
 * When each running root went unused: a root that no pane item works in starts its grace now, one
 * already idle keeps its time, and one used again or no longer running leaves. An unchanged list
 * is returned as is.
 */
export function idleServers(previous: Readonly<Record<string, number>>, running: readonly string[], used: ReadonlySet<string>, now: number): Readonly<Record<string, number>> {
  const next: Record<string, number> = {}
  for (const root of running) if (!used.has(root)) next[root] = previous[root] ?? now
  const roots = Object.keys(next)
  return roots.length === Object.keys(previous).length && roots.every((root) => previous[root] === next[root]) ? previous : next
}

/** The idle roots whose grace has passed: their servers stop. */
export function expiredServers(idle: Readonly<Record<string, number>>, now: number): string[] {
  return Object.entries(idle)
    .filter(([, since]) => now - since >= serverGraceMs)
    .map(([root]) => root)
}

/** How long the code frame fades in once revealed. */
export const frameFadeMs = 150

/** How long after its load event a root's VS Code stays hidden: the workbench paints white before
 * its theme, and the frame is cross-origin, so the theme cannot be watched for. A root's first
 * paint this app session is slow (extensions, theme from disk); later ones are quick. */
export function frameRevealDelay(painted: ReadonlySet<string>, root: string): number {
  return painted.has(root) ? 150 : 700
}
