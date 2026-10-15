import { useEffect, useState, type ReactNode } from 'react'
import type { ProjectSession } from '@/api/schema'
import { AgentBadge } from '@/advanced/parts'
import { sessionTimer, type SessionTimer } from '@/chat/header-model'

const timerTone: Record<SessionTimer['tone'], string> = {
  neutral: 'text-ink-300 bg-white/[0.06]',
  warn: 'text-warn bg-warn/[0.12]',
  bad: 'text-bad bg-bad/[0.12]',
}

function TimerChip({ session }: { session: Pick<ProjectSession, 'cacheExpiresAt' | 'idleCompactAt'> }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const timer = sessionTimer(session, now)
  if (timer === null) return null
  return (
    <span title="When this idle session loses its cached context" className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold whitespace-nowrap tabular-nums ${timerTone[timer.tone]}`}>
      {timer.text}
    </span>
  )
}

/**
 * The compact header both chat views share: agent icon and one-line title, one small metadata line,
 * the status chip and, for a session that records them, the cache or compaction timer. It sits about
 * 12px below the window top; when the sidebar is hidden the window's own drag strip above it clears
 * the traffic lights.
 */
export function ChatHeader({
  agent,
  title,
  meta,
  metaTitle,
  status,
  session,
}: {
  agent: string
  title: string
  meta: string
  metaTitle?: string
  status: ReactNode
  session?: Pick<ProjectSession, 'cacheExpiresAt' | 'idleCompactAt'>
}) {
  return (
    <header data-tauri-drag-region className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-6 pt-3 pb-2.5">
      <AgentBadge agent={agent} size="md" />
      <div className="min-w-0 flex-1">
        <h1 title={title} className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em] text-ink-100">{title}</h1>
        <p title={metaTitle ?? meta} className="truncate text-[12px] leading-4 text-ink-400">{meta}</p>
      </div>
      {session !== undefined && <TimerChip session={session} />}
      {status}
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-400" title="Previous and next chat">
        <kbd className="rounded-md border border-white/10 px-1 font-mono">⌘[</kbd>
        <kbd className="rounded-md border border-white/10 px-1 font-mono">⌘]</kbd>
      </span>
    </header>
  )
}
