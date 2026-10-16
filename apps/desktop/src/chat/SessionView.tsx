import { lazy, Suspense, useState } from 'react'
import { activityOf } from '@/components/agent-activity'
import { ConversationAgent } from '@/components/agent-icons'
import { api } from '@/api'
import type { MessagePart, ProjectSession } from '@/api/schema'
import { ChatHeader } from '@/chat/ChatHeader'
import { Conversation, type OpenChat, type OpenPath } from '@/chat/Conversation'
import { Composer, type Notice } from '@/chat/Composer'
import { useComposeChannel } from '@/chat/chat-menu'
import { messagePartsToText } from '@/chat/composer-parts'
import { closable, ownership, ownedTerminalTarget, sessionView, type SessionViewMode } from '@/chat/session-ownership'
import { noLogState } from '@/chat/session-open-model'
import { ViewSwitch } from '@/chat/ViewSwitch'
import { TerminalSkeleton } from '@/terminal/TerminalSkeleton'
import { Button, ErrorNote } from '@/components/ui'

const TerminalView = lazy(() => import('@/terminal/TerminalView').then((module) => ({ default: module.TerminalView })))

export function SessionView({
  session,
  worktreePath,
  onOpenChat,
  onOpenPath,
  onShowTerminal,
}: {
  session: ProjectSession
  worktreePath: string
  onOpenChat?: OpenChat
  onOpenPath?: OpenPath
  /** Shows the app terminal item that runs this session, when one does. */
  onShowTerminal?: () => void
}) {
  const [chosenView, setChosenView] = useState<SessionViewMode>('chat')
  const compose = useComposeChannel()
  const view = sessionView(session, chosenView)
  const [exited, setExited] = useState<number | null | undefined>(undefined)

  const ended = session.status === 'ended'

  const send = async (parts: MessagePart[]): Promise<Notice> => {
    const result = await api.sendToSession(session.sessionId, messagePartsToText(parts))
    return result.delivered ? { tone: 'ok', text: `Delivered through ${result.channel}.` } : { tone: 'bad', text: result.detail ?? `Not delivered (${result.channel}).` }
  }

  const terminalTarget = ownedTerminalTarget(session)
  const missingLog = <NoLogNote session={session} onShowTerminal={onShowTerminal ?? (terminalTarget === null ? undefined : () => setChosenView('terminal'))} onOpened={() => setChosenView('terminal')} />
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        agent={session.agent}
        activity={activityOf(session.status)}
        title={session.title}
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
            <ConversationAgent.Provider value={session.agent}>
              <Conversation target={{ sessionId: session.sessionId }} live={!ended} onOpenChat={onOpenChat} root={worktreePath} onOpenPath={onOpenPath} channel={compose} missingLog={missingLog} />
            </ConversationAgent.Provider>
          </div>
          {ended && closable(session) ? (
            <ResumeBar session={session} onResumed={() => setChosenView('terminal')} />
          ) : (
            <Composer
              placeholder={ended ? 'This session has ended' : `Reply to ${session.title}…`}
              disabled={ended}
              agent={session.agent}
              cwd={worktreePath}
              context={{ tokens: session.contextTokens, window: session.contextWindow }}
              model={session.model ?? null}
              onSend={send}
              channel={compose}
            />
          )}
        </>
      )}
    </div>
  )
}


// A session with no log yet: its live state and where it runs, in place of a conversation.
function NoLogNote({ session, onShowTerminal, onOpened }: { session: ProjectSession; onShowTerminal?: () => void; onOpened: () => void }) {
  const [error, setError] = useState<unknown>(null)
  const [opening, setOpening] = useState(false)
  const state = noLogState(session, onShowTerminal !== undefined)
  const openHere = () => {
    setOpening(true)
    setError(null)
    api.ownSession(session.sessionId).then(onOpened, (caught: unknown) => {
      setOpening(false)
      setError(caught)
    })
  }
  return (
    <div className="flex flex-col items-start gap-2 text-[13px] text-ink-300">
      <p>
        <span className="text-ink-100">{state.activity}</span> · {state.note}
      </p>
      {state.action === 'terminal' && onShowTerminal !== undefined && (
        <Button onClick={onShowTerminal}>Show its terminal</Button>
      )}
      {state.action === 'open-here' && (
        <Button disabled={opening} onClick={openHere}>
          {opening ? 'Resuming…' : 'Resume here'}
        </Button>
      )}
      {error !== null && <ErrorNote error={error} />}
    </div>
  )
}

// An ended conversation of ours stays resumable: its agent starts again on demand, in megabrain's own
// tmux session (`session own`), and the view moves to that terminal once it runs.
function ResumeBar({ session, onResumed }: { session: ProjectSession; onResumed: () => void }) {
  const [error, setError] = useState<unknown>(null)
  const [resuming, setResuming] = useState(false)
  const resume = () => {
    setResuming(true)
    setError(null)
    api.ownSession(session.sessionId).then(onResumed, (caught: unknown) => {
      setResuming(false)
      setError(caught)
    })
  }
  return (
    <div className="mx-8 mb-4 flex flex-col items-start gap-2 text-[13px] text-ink-300">
      <div className="flex items-center gap-3">
        <span>This conversation ended.</span>
        <Button disabled={resuming} onClick={resume}>
          {resuming ? 'Resuming…' : 'Resume'}
        </Button>
      </div>
      {error !== null && <ErrorNote error={error} />}
    </div>
  )
}
