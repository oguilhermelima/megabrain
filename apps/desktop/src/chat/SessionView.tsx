import { api } from '@/api'
import type { ProjectSession } from '@/api/schema'
import { ChatHeader } from '@/chat/ChatHeader'
import { Conversation, type OpenChat, type OpenPath } from '@/chat/Conversation'
import { Composer, type Notice } from '@/chat/Composer'

const folder = (path: string) => path.split('/').at(-1) ?? path

const statusTone: Record<ProjectSession['status'], string> = {
  working: 'text-ok bg-ok/[0.12]',
  waiting: 'text-warn bg-warn/[0.12]',
  idle: 'text-ink-300 bg-white/[0.06]',
  ended: 'text-ink-400 bg-white/[0.06]',
}

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
  const ended = session.status === 'ended'
  const started = session.startedAt === null ? null : `started ${new Date(session.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`

  const send = async (text: string): Promise<Notice> => {
    const result = await api.sendToSession(session.sessionId, text)
    return result.delivered ? { tone: 'ok', text: `Delivered through ${result.channel}.` } : { tone: 'bad', text: result.detail ?? `Not delivered (${result.channel}).` }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        agent={session.agent}
        title={session.title}
        meta={[session.agent, folder(worktreePath), started].filter(Boolean).join(' · ')}
        metaTitle={worktreePath}
        status={<span className={`rounded-full px-3 py-1 text-[12px] font-semibold whitespace-nowrap ${statusTone[session.status]}`}>{session.status}</span>}
        session={session}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <Conversation target={{ sessionId: session.sessionId }} live={!ended} onOpenChat={onOpenChat} root={worktreePath} onOpenPath={onOpenPath} />
      </div>
      <Composer placeholder={ended ? 'This session has ended' : `Reply to ${session.title}…`} disabled={ended} agent={session.agent} cwd={worktreePath} onSend={send} />
    </div>
  )
}
