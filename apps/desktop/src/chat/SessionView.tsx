import { lazy, Suspense, useState } from 'react'
import { api } from '@/api'
import type { MessagePart, ProjectSession } from '@/api/schema'
import { ChatHeader } from '@/chat/ChatHeader'
import { Conversation, type OpenChat, type OpenPath } from '@/chat/Conversation'
import { Composer, type Notice } from '@/chat/Composer'
import { messagePartsToText } from '@/chat/composer-parts'
import { ownership, ownedTerminalTarget, sessionView, type SessionViewMode } from '@/chat/session-ownership'
import { ViewSwitch } from '@/chat/ViewSwitch'
import { TerminalSkeleton } from '@/terminal/TerminalSkeleton'

const TerminalView = lazy(() => import('@/terminal/TerminalView').then((module) => ({ default: module.TerminalView })))

const folder = (path: string) => path.split('/').at(-1) ?? path

export function SessionView({
  session,
  worktreePath,
  onOpenChat,
  onOpenPath,
}: {
  session: ProjectSession
  worktreePath: string
  onOpenChat?: OpenChat
  onOpenPath?: OpenPath
}) {
  const [chosenView, setChosenView] = useState<SessionViewMode>('chat')
  const view = sessionView(session, chosenView)
  const [exited, setExited] = useState<number | null | undefined>(undefined)

  const ended = session.status === 'ended'
  const started = session.startedAt === null ? null : `started ${new Date(session.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`

  const send = async (parts: MessagePart[]): Promise<Notice> => {
    const result = await api.sendToSession(session.sessionId, messagePartsToText(parts))
    return result.delivered ? { tone: 'ok', text: `Delivered through ${result.channel}.` } : { tone: 'bad', text: result.detail ?? `Not delivered (${result.channel}).` }
  }

  const terminalTarget = ownedTerminalTarget(session)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        agent={session.agent}
        title={session.title}
        meta={[session.agent, folder(worktreePath), started].filter(Boolean).join(' · ')}
        metaTitle={worktreePath}
        actions={
          // Chat and terminal are both there only for a session megabrain owns.
          ownership(session).owned ? (
            <ViewSwitch
              view={view}
              onView={(next) => {
                setExited(undefined)
                setChosenView(next)
              }}
            />
          ) : null
        }
      />
      {view === 'terminal' && terminalTarget !== null ? (
        <>
          {exited !== undefined && (
            <p className="mx-8 mt-3 text-[13px] text-ink-400">
              The terminal exited{exited === null ? '' : ` with code ${exited}`}. Switch to Chat and back to attach again.
            </p>
          )}
          <Suspense fallback={<TerminalSkeleton label={`Attaching to ${session.title}`} />}>
            <TerminalView
              key={terminalTarget}
              startingLabel={`Attaching to ${session.title}`}
              connect={(cols, rows) => api.openTerminal({ engine: 'tmux', cwd: worktreePath === '' ? '/' : worktreePath, tmuxSession: terminalTarget, cols, rows })}
              onExit={(code) => setExited(code)}
            />
          </Suspense>
        </>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col">
            <Conversation target={{ sessionId: session.sessionId }} live={!ended} onOpenChat={onOpenChat} root={worktreePath} onOpenPath={onOpenPath} />
          </div>
          <Composer
            placeholder={ended ? 'This session has ended' : `Reply to ${session.title}…`}
            disabled={ended}
            agent={session.agent}
            cwd={worktreePath}
            context={{ tokens: session.contextTokens, window: session.contextWindow }}
            model={session.model ?? null}
            onSend={send}
          />
        </>
      )}
    </div>
  )
}

