import { useEffect, useRef, useState } from 'react'
import { Chevron } from '@/advanced/chrome'
import { thinkingTail } from '@/chat/thinking-tail'
import { useClock } from '@/lib/clock'
import { formatTokens, type ThinkingProgress, type WorkingStatus } from '@/native-chat/chat-model'

/**
 * Under the newest row while a turn runs: a spinner and "Working…" (the wait for an approval instead, in its
 * own words), then what the agent reports of its progress at this instant: its output tokens, a pulse while they
 * arrive, a retry or a silent API, and the thinking text it streams. The turn's elapsed time is in its header.
 */
export function WorkingIndicator({ status, progress }: { status: WorkingStatus; progress?: (now: number) => ThinkingProgress | null }) {
  const now = useClock(1000)
  const waiting = status.label === 'Waiting for approval'
  const report = progress?.(now) ?? null
  return (
    // Only what the agent does is announced: the token count changes every second.
    <li className="motion-rise py-1 text-chat-ui">
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-600 border-t-ink-300 motion-reduce:animate-none" />
        <div className="flex min-w-0 items-center">
          <span role="status" aria-live="polite" className={`truncate ${waiting ? 'font-medium text-warn' : 'text-ink-300'}`}>
            {waiting ? status.label : 'Working…'}
            {!waiting && <span className="text-ink-400"> · {status.label}</span>}
          </span>
        </div>
        {report !== null && report.tokens !== null && (
          <span aria-live="off" className="flex items-center gap-1.5 text-ink-400 tabular-nums">
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
