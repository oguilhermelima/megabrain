import type { Project } from '@/api/schema'
import { pendingError } from '@/lib/pending-model'

// The project row's + creates a worktree: a branch name, a base ref, and the creation shown in the
// sidebar at once as pending, then real once megabrain's projects list shows it.

// git check-ref-format, for the cases a person types: no control or special characters, no "..",
// no "@{", no empty or dot-led component, no trailing "/", "." or ".lock", not "@" alone.
function validRef(name: string): boolean {
  if (name === '@' || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false
  return name.split('/').every((part) => part !== '' && !part.startsWith('.'))
}

/** Why a new branch name cannot be used; null when it can. */
export function branchNameError(name: string, existing: readonly string[]): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'Name the branch.'
  if (/\s/.test(trimmed)) return 'A branch name has no spaces.'
  if (!validRef(trimmed)) return `${trimmed} is not a valid branch name.`
  if (existing.includes(trimmed)) return `A branch named ${trimmed} already exists.`
  return null
}

/**
 * The bases the field suggests: the branches the project's worktrees have checked out, the primary
 * checkout's first and chosen by default. Any other ref can be typed; megabrain refuses one that does not exist.
 */
export function baseSuggestions(project: Pick<Project, 'worktrees'>): { initial: string; suggestions: string[] } {
  const ordered = [...project.worktrees].sort((a, b) => Number(b.primary) - Number(a.primary))
  const suggestions = [...new Set(ordered.flatMap((worktree) => (worktree.branch === null ? [] : [worktree.branch])))]
  const primary = project.worktrees.find((worktree) => worktree.primary)
  return { initial: primary?.branch ?? '', suggestions }
}

/** True when the base is the branch of another worktree of the project: the new one stacks on it. */
export function stacksOn(project: Pick<Project, 'worktrees'>, base: string): boolean {
  const name = base.trim()
  return name !== '' && project.worktrees.some((worktree) => !worktree.primary && worktree.branch === name)
}

/** `stacked` records the base as the new branch's parent, so megabrain's stack commands find it. */
export function createWorktreeArgs(repo: string, branch: string, base: string, stacked = false): string[] {
  return ['worktree', 'create', '--repo', repo, '--branch', branch, '--from', base, ...(stacked ? ['--parent', `branch:${base}`] : []), '--json']
}

export interface PendingWorktree {
  id: string
  /** The project's path. */
  repo: string
  branch: string
  base: string
  /** The base is another worktree's branch, recorded as the new branch's parent. */
  stacked?: boolean
  /** creating: megabrain runs; created: it answered with the path, the projects list does not show it yet. */
  status: 'creating' | 'created' | 'failed'
  path: string | null
  error: string | null
}

const update = (list: PendingWorktree[], id: string, change: (item: PendingWorktree) => PendingWorktree) => list.map((item) => (item.id === id ? change(item) : item))

/** null while the same branch is still being created in that project. A failed one is replaced. */
export function startCreation(list: PendingWorktree[], input: { id: string; repo: string; branch: string; base: string; stacked?: boolean }): PendingWorktree[] | null {
  const same = (item: PendingWorktree) => item.repo === input.repo && item.branch === input.branch
  if (list.some((item) => same(item) && item.status !== 'failed')) return null
  return [...list.filter((item) => !same(item)), { ...input, status: 'creating', path: null, error: null }]
}

export function creationSucceeded(list: PendingWorktree[], id: string, path: string): PendingWorktree[] {
  return update(list, id, (item) => ({ ...item, status: 'created', path, error: null }))
}

export function creationFailed(list: PendingWorktree[], id: string, error: unknown): PendingWorktree[] {
  return update(list, id, (item) => ({ ...item, status: 'failed', error: pendingError(error) }))
}

export function retryCreation(list: PendingWorktree[], id: string): PendingWorktree[] {
  return update(list, id, (item) => (item.status === 'failed' ? { ...item, status: 'creating', error: null } : item))
}

export function dismissCreation(list: PendingWorktree[], id: string): PendingWorktree[] {
  return list.filter((item) => item.id !== id)
}

export function creationsIn(list: readonly PendingWorktree[], repo: string): PendingWorktree[] {
  return list.filter((item) => item.repo === repo)
}

/** The created worktrees the projects list now shows, and the ones still pending. */
export function arrivedCreations(list: PendingWorktree[], projects: readonly Project[]): { arrived: PendingWorktree[]; rest: PendingWorktree[] } {
  const listed = new Set(projects.flatMap((project) => project.worktrees.map((worktree) => worktree.path)))
  const arrived = list.filter((item) => item.status === 'created' && item.path !== null && listed.has(item.path))
  return { arrived, rest: list.filter((item) => !arrived.includes(item)) }
}
