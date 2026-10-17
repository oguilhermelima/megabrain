import { useEffect, useState } from 'react'
import { ToolIcon } from '@/chat/ToolIcon'
import { AgentIcon } from '@/components/agent-icons'
import { formatElapsed, formatTokens, type ThinkingProgress, type WorkingStatus } from '@/native-chat/chat-model'

/**
 * Under the newest message while a turn runs: the agent's mark at work (a running tool's icon), what it does and for
 * how long, then what the agent reports of its progress at this instant: its output tokens, a pulse while they
 * arrive, a retry or a silent API, and the thinking text it streams.
 */
export function WorkingIndicator({ agent, status, progress }: { agent: string; status: WorkingStatus; progress?: (now: number) => ThinkingProgress | null }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const since = status.since === null ? Number.NaN : Date.parse(status.since)
  const waiting = status.label === 'Waiting for approval'
  const report = progress?.(now) ?? null
  return (
    <li role="status" aria-live="polite" className="motion-rise py-1 text-[13px]">
      <div className="flex items-center gap-2.5">
        {status.tool === undefined ? (
          <span aria-hidden="true" className="contents text-ink-400">
            <AgentIcon agent={agent} size={14} activity={waiting ? 'waiting' : 'working'} />
          </span>
        ) : (
          <ToolIcon name={status.tool} status="running" size={14} />
        )}
        <span className={`font-medium ${waiting ? 'text-warn' : 'shimmer'}`}>{status.label}</span>
        {!Number.isNaN(since) && <span className="text-ink-400 tabular-nums">{formatElapsed(now - since)}</span>}
        {report !== null && report.tokens !== null && (
          <span className="flex items-center gap-1.5 text-ink-400 tabular-nums">
            · {formatTokens(report.tokens)}
            <span aria-hidden="true" className={`size-1.5 rounded-full bg-current transition-opacity duration-500 ${report.receiving ? 'animate-pulse opacity-100' : 'opacity-0'}`} />
          </span>
        )}
        {report?.notice != null ? <span className="text-warn">· {report.notice}</span> : report?.waiting === true && <span className="text-ink-400">· waiting for the API</span>}
      </div>
      {report?.thinking != null && <ThinkingTail text={report.thinking} />}
    </li>
  )
}

/** The thinking streaming now: its last lines, muted, opening to the whole text on a click. */
function ThinkingTail({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  // Only a tail cut at the top fades in; a short thought shows whole.
  const cut = text.length > 240 || text.split('\n').length > 3
  return (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      aria-label={open ? 'Show less of the thinking' : 'Show all of the thinking'}
      className={`mt-1 ml-6 flex max-w-[80%] flex-col text-left text-[13px] whitespace-pre-wrap text-ink-400 italic hover:text-ink-300 ${open ? 'max-h-60 overflow-y-auto' : `max-h-[4.5em] justify-end overflow-hidden ${cut ? '[mask-image:linear-gradient(to_bottom,transparent,black_1.5em)]' : ''}`}`}
    >
      <span>{text.trim()}</span>
    </button>
  )
}
