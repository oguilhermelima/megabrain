import type { OwnerBar } from '@/native-chat/terminal-owner'
import { DockAction, DockRow } from '@/chat/ComposerDock'
import { TerminalIcon } from '@/terminal/TerminalIcon'

const actionLabel: Record<OwnerBar['action'], string> = { 'take-over': 'Take over', 'send-when-free': 'Send when free', cancel: 'Cancel' }

/** The terminal drives the session: a row at the top of the composer card, its action right after what it says. */
export function OwnerStrip({ bar, busy, takingOver, onAction }: { bar: OwnerBar; busy: boolean; takingOver: boolean; onAction: () => void }) {
  // The daemon refuses a take over mid-turn; Send when free waits for it instead.
  const blocked = bar.action === 'take-over' && busy
  return (
    <DockRow icon={<TerminalIcon size={13} className="text-ink-400" />} text={bar.text}>
      <DockAction
        label={bar.action === 'take-over' && takingOver ? 'Taking over…' : actionLabel[bar.action]}
        disabled={takingOver || blocked}
        reason={blocked ? 'The terminal is still answering' : undefined}
        onClick={onAction}
      />
    </DockRow>
  )
}
