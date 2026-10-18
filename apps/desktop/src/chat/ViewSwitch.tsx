import type { SessionViewMode } from '@/chat/session-ownership'
import { Spinner } from '@/components/ui'

function ChatIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.2v-2.2h0a1.5 1.5 0 0 1-1.5-1.5Z" />
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="m4.5 6 2 2-2 2M8.5 10.5h3" />
    </svg>
  )
}

function OrchestrationIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.5" y="1.5" width="5" height="3.5" rx="1" />
      <rect x="1.5" y="11" width="4.5" height="3.5" rx="1" />
      <rect x="10" y="11" width="4.5" height="3.5" rx="1" />
      <path d="M8 5v3M3.75 11V8h8.5v3" />
    </svg>
  )
}

/** The ways a chat shows: its conversation, its agent's terminal, or the orchestration tree it belongs to. */
export type ChatViewMode = SessionViewMode | 'orchestration'

const views = { chat: { label: 'Chat', Icon: ChatIcon }, terminal: { label: 'Terminal', Icon: TerminalIcon }, orchestration: { label: 'Orchestration', Icon: OrchestrationIcon } } as const

/**
 * The chat's views as icon buttons in a segmented control; the names are in their tooltips and
 * labels. `enabled` and `reason` concern moving the session between chat and terminal, so they never
 * hold back Orchestration, which only shows; `switching` spins on the chat or terminal being opened.
 */
export function ViewSwitch({ view, onView, views: shown = ['chat', 'terminal'], enabled = true, reason, switching = false }: { view: ChatViewMode; onView: (view: ChatViewMode) => void; views?: readonly ChatViewMode[]; enabled?: boolean; reason?: string | null; switching?: boolean }) {
  return (
    <div role="group" aria-label="Chat view" title={reason ?? undefined} className="bar-control bar-group">
      {shown.map((value) => {
        const { label, Icon } = views[value]
        const current = view === value
        const moves = value !== 'orchestration'
        return (
          <button key={value} type="button" aria-label={label} title={moves ? (reason ?? label) : label} aria-pressed={current} disabled={current || (moves && !enabled)} onClick={() => onView(value)} className="bar-segment">
            {switching && moves && !current ? <Spinner /> : <Icon />}
          </button>
        )
      })}
    </div>
  )
}
