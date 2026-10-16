import type { Project } from '@/api/schema'

/**
 * Which sessions `projects` lists: megabrain is only the ones megabrain started (native chats, its
 * tmux server, terminals the app opened, owned sessions, its dispatches); all adds the ones opened
 * in Orca, Superset or a plain terminal.
 */
export type ProjectsOrigin = 'megabrain' | 'all'

/** `megabrain projects --json`; all is the CLI's default, so it sends no filter. */
export function projectsArgs(origin: ProjectsOrigin): string[] {
  return origin === 'all' ? ['projects', '--json'] : ['projects', '--origin', origin, '--json']
}

/** The filter the CLI applies, for the mock and as the app's guard; a session without an origin is not megabrain's. */
export function sessionsOfOrigin(projects: Project[], origin: ProjectsOrigin): Project[] {
  if (origin === 'all') return projects
  return projects.map((project) => ({
    ...project,
    worktrees: project.worktrees.map((worktree) => ({ ...worktree, sessions: worktree.sessions.filter((session) => session.origin === origin) })),
  }))
}
