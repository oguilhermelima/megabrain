import type { Project, ProjectSession, ProjectWorktree } from '@/api/schema'

export interface HiddenWorktree {
  project: Project
  worktree: ProjectWorktree
}

export interface HiddenPartition {
  /** Projects the sidebar lists, without their hidden worktrees. */
  visible: Project[]
  hiddenProjects: Project[]
  /** Hidden worktrees of visible projects; a hidden project's worktrees go with it. */
  hiddenWorktrees: HiddenWorktree[]
}

/** Splits what the person hid from what the sidebar lists. */
export function partitionHidden(projects: Project[]): HiddenPartition {
  const visible: Project[] = []
  const hiddenProjects: Project[] = []
  const hiddenWorktrees: HiddenWorktree[] = []
  for (const project of projects) {
    if (project.hidden === true) {
      hiddenProjects.push(project)
      continue
    }
    const shown = project.worktrees.filter((worktree) => worktree.hidden !== true)
    for (const worktree of project.worktrees) if (worktree.hidden === true) hiddenWorktrees.push({ project, worktree })
    visible.push(shown.length === project.worktrees.length ? project : { ...project, worktrees: shown })
  }
  return { visible, hiddenProjects, hiddenWorktrees }
}

export const agents = ['claude', 'codex', 'grok', 'agy'] as const
export type Agent = (typeof agents)[number]
export type PrFilter = 'open' | 'none'

export interface SidebarFilters {
  query: string
  /** Only worktrees with a session that has not ended. */
  active: boolean
  /** Only worktrees with a session waiting for the person. */
  needsYou: boolean
  /** Only worktrees with a session of one of these agents; empty means any. */
  agents: Agent[]
  pr: PrFilter | null
}

export const emptyFilters: SidebarFilters = { query: '', active: false, needsYou: false, agents: [], pr: null }

export function hasFilters(filters: SidebarFilters): boolean {
  return filters.query.trim() !== '' || filters.active || filters.needsYou || filters.agents.length > 0 || filters.pr !== null
}

function worktreePasses(worktree: ProjectWorktree, filters: SidebarFilters): boolean {
  const { sessions } = worktree
  if (filters.active && !sessions.some((session) => session.status !== 'ended')) return false
  if (filters.needsYou && !sessions.some((session) => session.status === 'waiting')) return false
  if (filters.agents.length > 0 && !sessions.some((session) => filters.agents.includes(session.agent))) return false
  if (filters.pr === 'open' && worktree.pullRequest?.state !== 'OPEN') return false
  if (filters.pr === 'none' && worktree.pullRequest !== null) return false
  return true
}

const worktreeMatches = (worktree: ProjectWorktree, query: string) =>
  (worktree.branch ?? '').toLowerCase().includes(query) || worktree.sessions.some((session) => session.title.toLowerCase().includes(query))

/**
 * The projects and worktrees that pass every filter. Search matches a project name (keeping all its
 * worktrees), a branch or a session title; the chips narrow worktrees; a project left with no
 * worktree drops out.
 */
export function filterProjects(projects: Project[], filters: SidebarFilters): Project[] {
  if (!hasFilters(filters)) return projects
  const query = filters.query.trim().toLowerCase()
  const result: Project[] = []
  for (const project of projects) {
    const nameMatches = query === '' || project.name.toLowerCase().includes(query)
    const worktrees = project.worktrees.filter((worktree) => worktreePasses(worktree, filters) && (nameMatches || worktreeMatches(worktree, query)))
    if (worktrees.length > 0) result.push(worktrees.length === project.worktrees.length ? project : { ...project, worktrees })
  }
  return result
}

/** Each active filter in words, for the message shown when nothing passes. */
export function activeFilterLabels(filters: SidebarFilters): string[] {
  const labels: string[] = []
  const query = filters.query.trim()
  if (query !== '') labels.push(`search "${query}"`)
  if (filters.active) labels.push('Active')
  if (filters.needsYou) labels.push('Needs you')
  labels.push(...filters.agents)
  if (filters.pr === 'open') labels.push('PR open')
  if (filters.pr === 'none') labels.push('no PR')
  return labels
}

const isAgent = (value: unknown): value is Agent => agents.some((agent) => agent === value)

/** Filters as stored by this viewer; anything unknown or malformed falls back to no filter. */
export function parseFilters(raw: string | null): SidebarFilters {
  if (raw === null) return emptyFilters
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return emptyFilters
  }
  if (typeof value !== 'object' || value === null) return emptyFilters
  const record = value as Record<string, unknown>
  return {
    query: typeof record.query === 'string' ? record.query : '',
    active: record.active === true,
    needsYou: record.needsYou === true,
    agents: Array.isArray(record.agents) ? record.agents.filter(isAgent) : [],
    pr: record.pr === 'open' || record.pr === 'none' ? record.pr : null,
  }
}

export interface SessionTimer {
  /** compact: Claude compacts the idle session on its own; cache: the prompt cache expires. */
  kind: 'compact' | 'cache'
  /** The time left, short: "47m". */
  text: string
  /** The same in words, for screen readers and the tooltip. */
  label: string
  /** green above 30 minutes left, yellow from 10 to 30, red under 10. */
  tone: 'green' | 'yellow' | 'red'
}

/**
 * The next thing that happens to an idle Claude session if nobody writes to it: its own compaction
 * or the end of its one-hour prompt cache, whichever comes first. Null while it works, once both
 * have passed, or when the agent records neither.
 */
export function sessionTimer(session: ProjectSession, now: number): SessionTimer | null {
  if (session.agent !== 'claude' || session.status === 'working') return null
  const future = (iso: string | null | undefined) => {
    if (iso === null || iso === undefined) return null
    const at = Date.parse(iso)
    return Number.isNaN(at) || at <= now ? null : at
  }
  const compactAt = future(session.idleCompactAt)
  const cacheAt = future(session.cacheExpiresAt)
  const compactFirst = compactAt !== null && (cacheAt === null || compactAt <= cacheAt)
  const at = compactFirst ? compactAt : cacheAt
  if (at === null) return null
  const left = at - now
  const minutes = Math.ceil(left / 60_000)
  const tone = left > 30 * 60_000 ? 'green' : left >= 10 * 60_000 ? 'yellow' : 'red'
  const inWords = `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  return { kind: compactFirst ? 'compact' : 'cache', text: `${minutes}m`, label: compactFirst ? `Compacts ${inWords}` : `Prompt cache expires ${inWords}`, tone }
}
