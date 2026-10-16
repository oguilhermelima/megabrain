import type { HistorySession, NativeChat, Project, ProjectSession } from '@/api/schema'
import type { LaunchPlan, LaunchTileId } from '@/launcher/launch-model'

// Resume on the launcher: the past sessions of a worktree, which ones the selected tile shows, and
// whether resuming one opens what megabrain already shows or starts its TUI again.

export const resumePageSize = 8

const activity = (session: HistorySession) => session.lastActivityAt ?? session.startedAt ?? ''

/** Which sessions Resume lists: one agent's, or every agent's under All agents (and under the terminal, when no agent is installed). */
export type ResumeFilter = LaunchTileId | 'all'

/** The filter's sessions whose title or id start matches the search, newest first. */
export function resumeRows(sessions: readonly HistorySession[], filter: ResumeFilter, query: string): HistorySession[] {
  const needle = query.trim().toLowerCase()
  return sessions
    .filter((session) => filter === 'all' || filter === 'terminal' || session.agent === filter)
    .filter((session) => needle === '' || session.title.toLowerCase().includes(needle) || session.id.toLowerCase().startsWith(needle))
    .sort((left, right) => activity(right).localeCompare(activity(left)))
}

/** The rows of the first `pages` pages and how many are still behind Show more. */
export function resumePage<T>(rows: readonly T[], pages: number): { rows: T[]; hidden: number } {
  const shown = rows.slice(0, pages * resumePageSize)
  return { rows: shown, hidden: rows.length - shown.length }
}

export type OpenResumed = { kind: 'session'; session: ProjectSession; worktreePath: string } | { kind: 'native'; chat: NativeChat }

/** What megabrain already shows for this agent session, so resuming it opens that instead of a second copy; null when nothing does. */
export function alreadyOpen(session: HistorySession, projects: readonly Project[], chats: readonly NativeChat[]): OpenResumed | null {
  const chat = chats.find((item) => item.agent === session.agent && item.agentSessionId === session.id)
  if (chat !== undefined) return { kind: 'native', chat }
  const sessionId = `${session.agent}:${session.id}`
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      const found = worktree.sessions.find((item) => item.sessionId === sessionId)
      if (found !== undefined) return { kind: 'session', session: found, worktreePath: worktree.path }
    }
  }
  return null
}

export type ResumeLaunch = Extract<LaunchPlan, { kind: 'agent-terminal' }> & { resume: string }

/**
 * The agent's own TUI resuming the session on tmux, so megabrain owns it. The model picked in the
 * composer belongs to the selected tile, so it goes along only when that tile is this agent.
 */
export function resumeLaunch(session: HistorySession, { cwd, tile, model, effort }: { cwd: string; tile: LaunchTileId; model: string | null; effort: string | null }): ResumeLaunch {
  const own = tile === session.agent
  return { kind: 'agent-terminal', agent: session.agent, engine: 'tmux', cwd, model: own ? model : null, effort: own ? effort : null, firstInput: null, resume: session.id }
}
