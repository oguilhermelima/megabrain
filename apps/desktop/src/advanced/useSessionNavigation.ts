import type { Dispatch, SetStateAction } from 'react'
import type { Dispatch as DispatchRecord, Project, ProjectSession } from '@/api/schema'
import type { Layout } from '@/panes/split-groups'
import { openLayoutItem } from '@/panes/split-groups'
import { itemKey } from '@/panes/pane-model'
import { useStableCallback } from '@/lib/useStableCallback'
import type { OpenChat } from '@/chat/Conversation'
import type { GithubPageKind } from '@/github/useGithubCounts'

type ExtraSessions = Record<string, { session: ProjectSession; worktreePath: string }>

export function useSessionNavigation({
  projects,
  status,
  extraSessions,
  setExtraSessions,
  setGithubPage,
  setLayout,
}: {
  projects: Project[]
  status: { dispatches: DispatchRecord[] } | null
  extraSessions: ExtraSessions
  setExtraSessions: Dispatch<SetStateAction<ExtraSessions>>
  setGithubPage: Dispatch<SetStateAction<{ path: string; kind: GithubPageKind; focus: number | null } | null>>
  setLayout: Dispatch<SetStateAction<Layout>>
}) {
  const findSession = (sessionId: string) => {
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        const session = worktree.sessions.find((item) => item.sessionId === sessionId)
        if (session !== undefined) return { session, worktreePath: worktree.path }
      }
    }
    return extraSessions[sessionId] ?? null
  }

  /** A chat megabrain dispatched opens as that dispatch; any other session as itself. */
  const sessionItem = (session: ProjectSession) => {
    const dispatchId = session.dispatchId
    const known = dispatchId !== null && (status?.dispatches.some((item) => item.dispatchId === dispatchId) ?? false)
    return known && dispatchId !== null ? itemKey('dispatch', dispatchId) : itemKey('session', session.sessionId)
  }

  /** Shows an item in its existing pane, or in the focused pane. */
  const showItem = (item: string) => {
    setGithubPage(null)
    setLayout((current) => openLayoutItem(current, item))
  }

  const openSession = (session: ProjectSession, worktreePath: string) => {
    if (findSession(session.sessionId) === null) setExtraSessions((current) => ({ ...current, [session.sessionId]: { session, worktreePath } }))
    showItem(sessionItem(session))
  }

  const openRelatedChat: OpenChat = useStableCallback((target) => {
    setGithubPage(null)
    if ('dispatchId' in target) {
      const dispatch = status?.dispatches.find((item) => item.dispatchId === target.dispatchId)
      if (dispatch !== undefined) {
        showItem(itemKey('dispatch', dispatch.dispatchId))
        return
      }
      const session = projects
        .flatMap((project) => project.worktrees)
        .flatMap((worktree) => worktree.sessions.map((item) => ({ session: item, worktreePath: worktree.path })))
        .find((item) => item.session.dispatchId === target.dispatchId)
      if (session !== undefined) openSession(session.session, session.worktreePath)
      return
    }

    const found = findSession(target.sessionId)
    if (found !== null) {
      openSession(found.session, found.worktreePath)
      return
    }

    const [agent] = target.sessionId.split(':', 1)
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'grok' && agent !== 'agy') return
    openSession({
      agent,
      sessionId: target.sessionId,
      title: target.sessionId,
      status: 'idle',
      startedAt: null,
      lastActivityAt: null,
      dispatchId: null,
    }, '')
  })

  return { findSession, sessionItem, showItem, openSession, openRelatedChat }
}
