import type { SessionViewMode } from '@/chat/session-ownership'
import { Spinner } from '@/components/ui'

function ChatIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.2v-2.2h0a1.5 1.5 0 0 1-1.5-1.5Z" />
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="m4.5 6 2 2-2 2M8.5 10.5h3" />
    </svg>
  )
}

const views = { chat: { label: 'Chat', Icon: ChatIcon }, terminal: { label: 'Terminal', Icon: TerminalIcon } } as const

/**
 * Chat or terminal, as two icon buttons in a segmented control; the names are in their tooltips
 * and labels. `reason` explains a disabled switch, and `switching` spins on the view being opened.
 */
export function ViewSwitch({ view, onView, enabled = true, reason, switching = false }: { view: SessionViewMode; onView: (view: SessionViewMode) => void; enabled?: boolean; reason?: string | null; switching?: boolean }) {
  return (
    <div role="group" aria-label="Chat or terminal" title={reason ?? undefined} className="flex shrink-0 gap-0.5 rounded-full border border-white/10 bg-white/[0.05] p-0.5">
      {(['chat', 'terminal'] as const).map((value) => {
        const { label, Icon } = views[value]
        const current = view === value
        return (
          <button
            key={value}
            type="button"
            aria-label={label}
            title={reason ?? label}
            aria-pressed={current}
            disabled={current || !enabled}
            onClick={() => onView(value)}
            className={`flex size-7 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default ${
              current ? 'bg-white/[0.14] text-ink-100' : enabled ? 'text-ink-400 hover:text-ink-200' : 'text-ink-600'
            }`}
          >
            {switching && !current ? <Spinner /> : <Icon />}
          </button>
        )
      })}
    </div>
  )
}
