import { createContext, useContext, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { TranscriptEvent } from '@/api/schema'
import { Checkbox } from '@/components/Checkbox'
import { MenuIconGlyph, type MenuIcon } from '@/components/menu-icons'
import { Tooltip } from '@/components/Tooltip'

// The actions on each message of the person and of the assistant: a small group that shows on hover or
// keyboard focus in the message's bottom corner, and the checkbox each one shows while messages are
// being selected. The transcript provides them; without a provider (a shared image) nothing shows.

export interface MessageActionsValue {
  copy: (event: TranscriptEvent) => Promise<void>
  /** Opens the share menu (Copy image, Download PNG) under the button. */
  share: (event: TranscriptEvent, trigger: ReactMouseEvent<HTMLElement>) => void
  /** Enters selection with this message selected. */
  select: (event: TranscriptEvent) => void
  selecting: boolean
  selected: ReadonlySet<string>
  toggle: (id: string, range: boolean) => void
  /** The latest message of the person, which Edit takes back; disabled while a turn runs. */
  lastPerson: string | null
  editDisabled: boolean
  edit: ((event: TranscriptEvent) => void) | null
  /** The last answer of each turn, which a branch can start from. */
  turnEnds: ReadonlySet<string>
  branch: ((event: TranscriptEvent) => void) | null
}

export const MessageActionsContext = createContext<MessageActionsValue | null>(null)

const button =
  'grid size-7 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'

function Action({ label, icon, onClick, disabled = false, expanded }: { label: string; icon: MenuIcon; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void; disabled?: boolean; expanded?: boolean }) {
  return (
    <Tooltip text={label}>
      {(tip) => (
        <button type="button" {...tip} aria-label={label} aria-haspopup={expanded === undefined ? undefined : 'menu'} disabled={disabled} onClick={onClick} className={button}>
          <MenuIconGlyph icon={icon} />
        </button>
      )}
    </Tooltip>
  )
}

/** The hover group under a settled message; `side` is the corner it sits in, the message's own. */
export function MessageActions({ event, side }: { event: TranscriptEvent; side: 'left' | 'right' }) {
  const actions = useContext(MessageActionsContext)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_200)
    return () => clearTimeout(timer)
  }, [copied])
  if (actions === null || actions.selecting) return null
  const editable = actions.edit !== null && event.id === actions.lastPerson
  const branchable = actions.branch !== null && actions.turnEnds.has(event.id)
  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className={`absolute -bottom-4 z-10 flex items-center gap-0.5 rounded-full border border-white/[0.08] bg-ink-900/95 p-0.5 opacity-0 shadow-lg transition-opacity duration-100 group-hover/message:opacity-100 focus-within:opacity-100 motion-reduce:transition-none ${side === 'right' ? 'right-2' : 'left-0'}`}
    >
      <Action label={copied ? 'Copied' : event.kind === 'user' ? 'Copy text' : 'Copy markdown'} icon={copied ? 'check' : 'copy'} onClick={() => void actions.copy(event).then(() => setCopied(true), () => {})} />
      <Action label="Share as image" icon="share" expanded={false} onClick={(click) => actions.share(event, click)} />
      <Action label="Select messages" icon="select" onClick={() => actions.select(event)} />
      {editable && <Action label={actions.editDisabled ? 'Edit when the turn ends' : 'Edit (↑ in an empty composer)'} icon="rename" disabled={actions.editDisabled} onClick={() => actions.edit?.(event)} />}
      {branchable && <Action label="Branch from here" icon="branch" onClick={() => actions.branch?.(event)} />}
    </div>
  )
}

/**
 * While selecting: the message's checkbox in the gutter on its left, and the whole message a target, so
 * a click anywhere on it toggles it and a shift-click selects the run from the last one clicked.
 */
export function SelectTarget({ event }: { event: TranscriptEvent }) {
  const actions = useContext(MessageActionsContext)
  // The checkbox reports a change, not the click; the click before it says whether Shift was held.
  const shift = useRef(false)
  if (actions === null || !actions.selecting) return null
  const checked = actions.selected.has(event.id)
  return (
    <>
      <button type="button" tabIndex={-1} aria-hidden="true" onClick={(click) => actions.toggle(event.id, click.shiftKey)} className={`absolute inset-0 z-10 cursor-pointer rounded-xl transition-colors ${checked ? 'bg-accent/[0.06]' : 'hover:bg-white/[0.03]'}`} />
      <span
        onClickCapture={(click) => {
          shift.current = click.shiftKey
        }}
        className="absolute top-1.5 -left-7 z-10"
      >
        <Checkbox checked={checked} onChange={() => actions.toggle(event.id, shift.current)}>
          <span className="sr-only">Select message</span>
        </Checkbox>
      </span>
    </>
  )
}

const barButton = 'h-7 shrink-0 rounded-full px-3 text-[12.5px] font-semibold text-ink-100 transition-colors duration-100 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'

/** The bar while selecting: how many, and what can be done with them. */
export function SelectionBar({ count, onCopyImage, onDownload, onCopyText, onCancel }: { count: number; onCopyImage: () => void; onDownload: () => void; onCopyText: () => void; onCancel: () => void }) {
  return (
    <div role="toolbar" aria-label="Selected messages" className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/[0.1] bg-ink-900/95 py-1 pr-1 pl-4 shadow-lg backdrop-blur">
      <span role="status" className="mr-2 shrink-0 text-[12.5px] text-ink-300 tabular-nums">
        {count} selected
      </span>
      <button type="button" disabled={count === 0} onClick={onCopyImage} className={barButton}>
        Copy image
      </button>
      <button type="button" disabled={count === 0} onClick={onDownload} className={barButton}>
        Download PNG
      </button>
      <button type="button" disabled={count === 0} onClick={onCopyText} className={barButton}>
        Copy text
      </button>
      <button type="button" onClick={onCancel} className={`${barButton} text-ink-300`}>
        Cancel
      </button>
    </div>
  )
}
