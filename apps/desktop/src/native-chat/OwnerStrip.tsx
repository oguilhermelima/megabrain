import type { OwnerBar } from '@/native-chat/terminal-owner'
import { pageMx } from '@/lib/page'
import { TerminalIcon } from '@/terminal/TerminalIcon'

const actionLabel: Record<OwnerBar['action'], string> = { 'take-over': 'Take over', 'send-when-free': 'Send when free', cancel: 'Cancel' }

/** The terminal drives the session: a calm strip on the composer's top edge, its action right after what it says. */
export function OwnerStrip({ bar, busy, takingOver, onAction }: { bar: OwnerBar; busy: boolean; takingOver: boolean; onAction: () => void }) {
  // The daemon refuses a take over mid-turn; Send when free waits for it instead.
  const blocked = bar.action === 'take-over' && busy
  return (
    <div className={`${pageMx} flex min-w-0 items-center gap-2 rounded-t-[14px] border border-b-0 border-white/[0.08] bg-white/[0.03] py-1 pr-1 pl-3 text-[12.5px] text-ink-300`}>
      <TerminalIcon size={13} className="shrink-0 text-ink-400" />
      <span role="status" className="min-w-0 truncate py-1">
        {bar.text}
      </span>
      <button
        type="button"
        disabled={takingOver || blocked}
        title={blocked ? 'The terminal is still answering' : undefined}
        onClick={onAction}
        className="h-6 shrink-0 rounded-full border border-white/[0.12] px-2.5 text-[12px] font-semibold text-ink-100 transition-colors duration-100 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:opacity-50 disabled:hover:bg-transparent motion-reduce:transition-none"
      >
        {bar.action === 'take-over' && takingOver ? 'Taking over…' : actionLabel[bar.action]}
      </button>
    </div>
  )
}
