import type { ProjectSession } from '@/api/schema'
import { AgentBadge } from '@/advanced/parts'
import { Conversation, type OpenChat } from '@/chat/Conversation'

export function SessionView({
  session,
  worktreePath,
  onOpenChat,
}: {
  session: ProjectSession
  worktreePath: string
  onOpenChat?: OpenChat
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-white/[0.06] px-8 pt-10 pb-5">
        <AgentBadge agent={session.agent} size="lg" />
        <div className="min-w-0">
          <h1 className="truncate text-[20px] font-semibold text-ink-100">{session.title}</h1>
          <p className="truncate text-[13px] text-ink-400">{[session.agent, worktreePath].filter(Boolean).join(' · ')}</p>
        </div>
      </header>
      <Conversation target={{ sessionId: session.sessionId }} live={session.status !== 'ended'} onOpenChat={onOpenChat} />
    </div>
  )
}
