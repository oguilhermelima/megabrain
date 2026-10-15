import type { Project, ProjectWorktree } from '@/api/schema'

/** A worktree or repository opened in VS Code. */
export interface CodeTarget {
  root: string
  title: string
}

/** The roots whose VS Code is open in this app session, in opening order, and the one on screen
 * (null while the person is in chats). An open root keeps its server until it is closed. */
export interface CodeModeState {
  open: CodeTarget[]
  active: string | null
}

export const emptyCodeMode: CodeModeState = { open: [], active: null }

/** Shows a root in Code mode; `start` says its server is not running yet. */
export function enterCode(state: CodeModeState, target: CodeTarget): { state: CodeModeState; start: boolean } {
  const known = state.open.some((item) => item.root === target.root)
  return { state: { open: known ? state.open : [...state.open, target], active: target.root }, start: !known }
}

/** Back to chats; every open root stays open. */
export function leaveCode(state: CodeModeState): CodeModeState {
  return { ...state, active: null }
}

/** Closes a root on purpose: its server is to be stopped (`stop`), and when it was on screen
 * another open root takes its place, or chats when none is left. */
export function closeCode(state: CodeModeState, root: string): { state: CodeModeState; stop: string | null } {
  if (!state.open.some((item) => item.root === root)) return { state, stop: null }
  const open = state.open.filter((item) => item.root !== root)
  const active = state.active === root ? (open.at(-1)?.root ?? null) : state.active
  return { state: { open, active }, stop: root }
}

/** The person names one key to go back and forth: Escape belongs to VS Code. */
export function isToggleChatsKey(event: { metaKey: boolean; shiftKey: boolean; key: string }): boolean {
  return event.metaKey && event.shiftKey && event.key.toLowerCase() === 'e'
}

const folder = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

/** A project opens under its name; a worktree under its project and branch. */
export function codeTargetFor(project: Project, worktree?: ProjectWorktree): CodeTarget {
  if (worktree === undefined || worktree.primary || worktree.path === project.path) return { root: project.path, title: project.name }
  return { root: worktree.path, title: `${project.name} · ${worktree.branch ?? folder(worktree.path)}` }
}

function projectOf(projects: Project[], root: string): Project | null {
  return projects.find((project) => project.path === root || project.worktrees.some((worktree) => worktree.path === root)) ?? null
}

/** The target for a root a chat names: the project or worktree that holds it, else its folder. */
export function codeTargetForRoot(projects: Project[], root: string): CodeTarget {
  const project = projectOf(projects, root)
  if (project === null) return { root, title: folder(root) }
  return codeTargetFor(project, project.worktrees.find((worktree) => worktree.path === root))
}

export interface RailEntry {
  root: string
  title: string
  /** The first line beside the picture: the repository's name, or the folder's when no
   * registered project holds the root. */
  name: string
  /** The line under the name: the branch, or the folder name when it has none; null for a root
   * no project holds, whose folder is already its name. */
  branch: string | null
  tooltip: string
  /** Whose picture the entry shows; null when no registered project holds the root any more. */
  project: Project | null
  /** The first letters of the branch, when another open entry shows the same picture. */
  badge: string | null
  active: boolean
}

/** "fix/player-seek" gives "PS": the initials of the words in the branch's last segment. */
function initials(label: string): string {
  const last = label.split('/').filter(Boolean).at(-1) ?? label
  return last
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join('')
}

/** The open roots, most recently opened first. Showing a root again does not move it. */
export function railEntries(state: CodeModeState, projects: Project[]): RailEntry[] {
  const entries = state.open.map((target) => {
    const project = projectOf(projects, target.root)
    const branch = project === null ? null : rootLabel(project, target.root)
    return {
      root: target.root,
      title: target.title,
      name: project?.name ?? folder(target.root),
      branch,
      tooltip: [project?.name ?? target.title, branch, target.root].filter((line) => line !== null).join('\n'),
      project,
      active: target.root === state.active,
    }
  })
  return entries
    .map((entry) => ({
      ...entry,
      badge: entry.project !== null && entries.some((other) => other !== entry && other.project === entry.project) ? initials(entry.branch ?? entry.name) : null,
    }))
    .reverse()
}

/** The branch checked out at a project's own folder, else that folder's name. */
function rootLabel(project: Project, root: string): string {
  return project.worktrees.find((worktree) => worktree.path === root)?.branch ?? folder(root)
}

export interface SwitchItem {
  target: CodeTarget
  /** The branch, or the folder name when the worktree has none. */
  label: string
  /** The root on screen. */
  current: boolean
}

export interface SwitchGroup {
  project: Project
  items: SwitchItem[]
}

/** What the switcher offers, grouped by project: what the sidebar shows, hidden ones left out,
 * each project's own folder first. Every word typed must appear in the project name, the branch
 * or the path. */
export function switchGroups(projects: Project[], active: string | null, query: string): SwitchGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return projects
    .filter((project) => !project.missing && project.hidden !== true)
    .map((project) => ({
      project,
      items: [project.path, ...project.worktrees.filter((worktree) => !worktree.primary && worktree.path !== project.path && worktree.hidden !== true).map((worktree) => worktree.path)]
        .map((root) => ({ target: codeTargetForRoot([project], root), label: rootLabel(project, root), current: root === active }))
        .filter((item) => {
          const haystack = `${project.name} ${item.label} ${item.target.root}`.toLowerCase()
          return words.every((word) => haystack.includes(word))
        }),
    }))
    .filter((group) => group.items.length > 0)
}

/** Every project and worktree the switcher offers, in its order. */
export function switchTargets(projects: Project[]): CodeTarget[] {
  return switchGroups(projects, null, '').flatMap((group) => group.items.map((item) => item.target))
}

/** How long the code frame fades in once revealed. */
export const frameFadeMs = 150

/** How long after its load event a root's VS Code stays hidden: the workbench paints white before
 * its theme, and the frame is cross-origin, so the theme cannot be watched for. A root's first
 * paint this app session is slow (extensions, theme from disk); later ones are quick. */
export function frameRevealDelay(painted: ReadonlySet<string>, root: string): number {
  return painted.has(root) ? 150 : 700
}
