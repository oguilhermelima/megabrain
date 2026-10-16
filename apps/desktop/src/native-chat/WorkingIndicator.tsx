import { useEffect, useState } from 'react'
import { AgentIcon } from '@/components/agent-icons'
import { formatElapsed, type WorkingStatus } from '@/native-chat/chat-model'

/** Under the newest message while a turn runs: the agent's mark at work, what it does and for how long. */
export function WorkingIndicator({ agent, status }: { agent: string; status: WorkingStatus }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const since = status.since === null ? Number.NaN : Date.parse(status.since)
  const waiting = status.label === 'Waiting for approval'
  return (
    <li role="status" aria-live="polite" className="motion-rise flex items-center gap-2.5 py-1 text-[13px]">
      <span aria-hidden="true" className="contents text-ink-400">
        <AgentIcon agent={agent} size={14} activity={waiting ? 'waiting' : 'working'} />
      </span>
      <span className={`font-medium ${waiting ? 'text-warn' : 'shimmer'}`}>{status.label}</span>
      {!Number.isNaN(since) && <span className="text-ink-400 tabular-nums">{formatElapsed(now - since)}</span>}
    </li>
  )
}
