import { useEffect, useRef, useState } from 'react'
import { Chevron } from '@/advanced/chrome'
import { ToolIcon } from '@/chat/ToolIcon'
import { thinkingTail } from '@/chat/thinking-tail'
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
    // Only what the agent does is announced: the elapsed time and token count change every second.
    <li className="motion-rise py-1 text-chat-ui">
      <div className="flex items-center gap-2.5">
        {status.tool === undefined ? (
          <span aria-hidden="true" className="contents text-ink-400">
            <AgentIcon agent={agent} size={14} activity={waiting ? 'waiting' : 'working'} />
          </span>
        ) : (
          <ToolIcon name={status.tool} status="running" size={14} />
        )}
        <span role="status" aria-live="polite" className={`font-medium ${waiting ? 'text-warn' : 'shimmer'}`}>
          {status.label}
        </span>
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

/**
 * The thinking streaming now: folded, its last lines from a sentence start; opened, the whole text in a box that
 * follows the newest words unless the person scrolled up to read.
 */
function ThinkingTail({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const tail = thinkingTail(text)
  useEffect(() => {
    if (open && following.current && box.current !== null) box.current.scrollTop = box.current.scrollHeight
  }, [open, text])
  const toggle = () => {
    following.current = true
    setOpen((value) => !value)
  }
  const look = 'whitespace-pre-wrap text-chat-ui text-ink-400 italic'
  if (!tail.hidden) return <p className={`mt-1 ml-6 max-w-[80%] ${look}`}>{tail.text}</p>
  return (
    <div className="group/thinking mt-1 ml-6 max-w-[80%]">
      {open ? (
        <div
          ref={box}
          onScroll={(event) => {
            const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
            following.current = scrollHeight - scrollTop - clientHeight < 8
          }}
          className={`max-h-60 overflow-y-auto ${look}`}
        >
          {text.trim()}
        </div>
      ) : (
        // A light fade says more lies above without dimming the first line past reading.
        <button type="button" tabIndex={-1} onClick={toggle} aria-expanded={false} className={`block w-full text-left hover:text-ink-300 [mask-image:linear-gradient(to_bottom,rgb(0_0_0/0.6),black_1.5em)] ${look}`}>
          {tail.text}
        </button>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`mt-0.5 flex items-center gap-1 text-[12px] text-ink-400 transition-opacity hover:text-ink-300 focus-visible:opacity-100 group-hover/thinking:opacity-100 motion-reduce:transition-none ${open ? '' : 'opacity-0'}`}
      >
        <Chevron open={open} />
        {open ? 'Show less' : 'Show all'}
      </button>
    </div>
  )
}
