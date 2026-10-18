import type { ReactNode } from 'react'
import { Tooltip } from '@/components/Tooltip'

// The composer is one card: what states the chat is in (the terminal drives it, the last message is
// being edited, a notice, an approval waiting) are slim rows at the card's top, above the message
// box, each an icon, a sentence and at most a quiet action, and a hairline sets them apart.

export type DockTone = 'neutral' | 'accent' | 'warn' | 'bad'

const toneText: Record<DockTone, string> = {
  neutral: 'text-ink-300',
  accent: 'text-ink-200',
  warn: 'text-warn',
  bad: 'text-bad',
}

const toneFill: Record<DockTone, string> = {
  neutral: '',
  accent: 'bg-accent/[0.06]',
  warn: 'bg-warn/[0.05]',
  bad: 'bg-bad/[0.07]',
}

/** A state row at the top of the composer card; `title` is the whole sentence when it may be cut. `children` are its actions. */
export function DockRow({ icon, tone = 'neutral', role = 'status', text, title, children }: { icon: ReactNode; tone?: DockTone; role?: 'status' | 'alert'; text: ReactNode; title?: string; children?: ReactNode }) {
  return (
    <div className={`flex min-h-9 min-w-0 items-center gap-2.5 border-b border-white/[0.06] py-1 pr-2 pl-4 text-chat-small ${toneText[tone]} ${toneFill[tone]}`}>
      <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center">
        {icon}
      </span>
      {title === undefined ? (
        <span role={role} className="min-w-0 truncate select-text">
          {text}
        </span>
      ) : (
        <Tooltip text={title}>
          {(tip) => (
            <span {...tip} role={role} className="min-w-0 truncate select-text">
              {text}
            </span>
          )}
        </Tooltip>
      )}
      {children}
    </div>
  )
}

const action =
  'h-7 shrink-0 rounded-full px-3 text-chat-small font-semibold text-ink-100 transition-colors duration-100 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:opacity-50 disabled:hover:bg-transparent motion-reduce:transition-none'

/** A row's quiet inline action; `reason` explains a disabled one in the app's tooltip. */
export function DockAction({ label, onClick, disabled = false, reason }: { label: string; onClick: () => void; disabled?: boolean; reason?: string }) {
  const button = () => (
    <button type="button" disabled={disabled} onClick={onClick} className={action}>
      {label}
    </button>
  )
  if (reason === undefined) return button()
  // A disabled button gets no pointer events, so the tooltip hangs on a wrapper.
  return <Tooltip text={reason}>{(tip) => <span {...tip} className="shrink-0">{button()}</span>}</Tooltip>
}

/** A row's dismiss cross. */
export function DockDismiss({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip text="Dismiss">
      {(tip) => (
        <button
          type="button"
          {...tip}
          onClick={onClick}
          aria-label="Dismiss"
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none"
        >
          <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="m4.5 4.5 7 7m0-7-7 7" />
          </svg>
        </button>
      )}
    </Tooltip>
  )
}
