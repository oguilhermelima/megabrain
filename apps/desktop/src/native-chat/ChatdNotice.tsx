import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { chatdNotice, chatdRetryMs, onIncompatible, reconnectDecision, reconnectStep, watchesChatd, type PauseChoice, type PausePhase, type Reconnect } from '@/native-chat/chatd-reconnect'

/** How often an older or incompatible chatd is read again until it has gone. */
const WATCH_MS = 3000

/**
 * Reconnects to the chatd that outlived the last app run (see chatd-reconnect.ts): checks it on start
 * and whenever a chat call is refused as incompatible, retires an older one, and with an incompatible
 * one waits for its chats (or drains at once on Restart now). It keeps running while the window is
 * hidden, so a wait ends even with the app in the tray.
 */
function useChatdReconnect(): { decision: Reconnect; phase: PausePhase; choose: (choice: PauseChoice) => void } {
  const [decision, setDecision] = useState<Reconnect>({ kind: 'none' })
  const [phase, setPhase] = useState<PausePhase>('waiting')
  const choice = useRef<PauseChoice>('wait')
  const check = useRef<() => void>(() => {})

  useEffect(() => {
    let stopped = false
    let running = false
    let draining = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let appVersion: string | null = null
    let failures = 0

    const drain = () => {
      draining = true
      setPhase('restarting')
      // Drain returns once the old daemon has gone; the next chat call starts one of this version.
      api
        .chatDaemonDrain()
        .catch(() => {})
        .finally(() => {
          draining = false
          choice.current = 'wait'
          if (stopped) return
          setPhase('waiting')
          void read()
        })
    }

    const read = async () => {
      if (stopped || running || draining) return
      running = true
      clearTimeout(timer)
      try {
        appVersion ??= (await api.installPlan()).version
        const next = reconnectDecision(await api.chatDaemonStatus(), appVersion)
        failures = 0
        if (stopped) return
        setDecision(next)
        const step = reconnectStep(next, choice.current)
        // A CLI without retire leaves the old daemon serving; the notice still goes once it exits.
        if (step === 'retire') await api.chatDaemonRetire().catch(() => {})
        if (step === 'drain') return drain()
        if (watchesChatd(next)) timer = setTimeout(() => void read(), WATCH_MS)
      } catch {
        // No status, no notice: the read is tried again, backing off, so a slow start cannot end the watch.
        failures += 1
        if (!stopped) timer = setTimeout(() => void read(), chatdRetryMs(failures))
      } finally {
        running = false
      }
    }

    check.current = () => void read()
    void read()
    const off = onIncompatible(() => void read())
    return () => {
      stopped = true
      clearTimeout(timer)
      off()
    }
  }, [])

  const choose = (next: PauseChoice) => {
    choice.current = next
    check.current()
  }
  return { decision, phase, choose }
}

/** A line above the panes while chats still run on the previous chatd, in the composer notices' look. */
export function ChatdNotice({ className = '' }: { className?: string }) {
  const { decision, phase, choose } = useChatdReconnect()
  const [dismissed, setDismissed] = useState<Reconnect['kind'] | null>(null)
  const [chosen, setChosen] = useState<PauseChoice>('wait')
  const notice = chatdNotice(decision, phase)
  if (notice === null || (notice.dismissible && dismissed === decision.kind)) return null
  const attention = notice.tone === 'attention'
  return (
    <div className={className}>
      <div
        role="status"
        aria-live="polite"
        className={`flex min-w-0 items-center gap-2 rounded-[12px] border py-1 pr-1 pl-3 text-[12.5px] ${attention ? 'border-warn/25 bg-warn/[0.07] text-ink-200' : 'border-white/[0.08] bg-white/[0.03] text-ink-400'}`}
      >
        <svg viewBox="0 0 16 16" className={`size-3.5 shrink-0 ${attention ? 'text-warn' : 'text-ink-500'}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" />
          {attention ? <path d="M8 4.75v3.75M8 11.1v.15" /> : <path d="M5.4 8.4 7.1 10l3.5-3.6" />}
        </svg>
        <span className="min-w-0 flex-1 truncate py-1" title={notice.text}>
          {notice.text}
        </span>
        {notice.actions.map((action) => {
          const pressed = chosen === action.id
          return (
            <button
              key={action.id}
              type="button"
              aria-pressed={pressed}
              onClick={() => {
                setChosen(action.id)
                choose(action.id)
              }}
              className={`h-6 shrink-0 rounded-full px-2.5 text-[12px] font-semibold transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none ${pressed ? 'bg-white/[0.1] text-ink-100' : 'text-ink-300 hover:bg-white/[0.08] hover:text-ink-100'}`}
            >
              {action.label}
            </button>
          )
        })}
        {notice.dismissible && (
          <button
            type="button"
            onClick={() => setDismissed(decision.kind)}
            aria-label="Dismiss"
            title="Dismiss"
            className="grid size-6 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none"
          >
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
