import { createContext, useContext, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import type { TranscriptEvent } from '@/api/schema'
import { Checkbox } from '@/components/Checkbox'
import type { MenuRow } from '@/components/ContextMenu'
import { MenuIconGlyph, type MenuIcon } from '@/components/menu-icons'
import { Tooltip } from '@/components/Tooltip'

// The actions under each message, as an icon row like a chat app's: under the last answer of each
// turn the row keeps its place and shows on hover or keyboard focus, always for the latest answer;
// under the person's messages and an answer in the middle of a turn a lighter row floats in on hover,
// so a turn keeps one row and the person's messages keep their spacing. While messages are being selected each one shows its checkbox
// instead. The transcript provides them; without a provider (a shared image) nothing shows.

export interface MessageActionsValue {
  copy: (event: TranscriptEvent) => Promise<void>
  /** Copies text the row worked out itself (the message as it reads, without markdown). */
  copyText: (text: string) => Promise<void>
  /** Opens the share menu (Copy image, Download PNG) under the button. */
  share: (event: TranscriptEvent, trigger: ReactMouseEvent<HTMLElement>) => void
  /** Opens a menu of these rows under the button. */
  menu: (trigger: ReactMouseEvent<HTMLElement>, sections: MenuRow[][]) => void
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
  /** The latest answer once no turn runs: its row always shows. */
  lastAnswer: string | null
  branch: ((event: TranscriptEvent) => void) | null
}

export const MessageActionsContext = createContext<MessageActionsValue | null>(null)

const button =
  'grid size-8 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.07] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:pointer-events-none disabled:opacity-40 aria-expanded:bg-white/[0.08] aria-expanded:text-ink-100 motion-reduce:transition-none'

function Action({ label, icon, onClick, disabled = false, menu = false }: { label: string; icon: MenuIcon | 'more'; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void; disabled?: boolean; menu?: boolean }) {
  return (
    <Tooltip text={label}>
      {(tip) => (
        <button type="button" {...tip} aria-label={label} aria-haspopup={menu ? 'menu' : undefined} disabled={disabled} onClick={onClick} className={button}>
          {icon === 'more' ? (
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.25" />
              <circle cx="8" cy="8" r="1.25" />
              <circle cx="12.5" cy="8" r="1.25" />
            </svg>
          ) : (
            <MenuIconGlyph icon={icon} />
          )}
        </button>
      )}
    </Tooltip>
  )
}

/**
 * The row under a settled message, on the message's own side. `raw` and `onRaw` are set where the
 * message renders markdown, to show its source instead; `body` is the rendered message, whose text
 * Copy as plain text takes.
 */
export function MessageActions({ event, side, raw, onRaw, body }: { event: TranscriptEvent; side: 'left' | 'right'; raw?: boolean; onRaw?: () => void; body?: RefObject<HTMLElement | null> }) {
  const actions = useContext(MessageActionsContext)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_200)
    return () => clearTimeout(timer)
  }, [copied])
  if (actions === null || actions.selecting) return null
  const person = event.kind === 'user'
  const editable = actions.edit !== null && event.id === actions.lastPerson
  const branchable = actions.branch !== null && actions.turnEnds.has(event.id)
  const latest = event.id === actions.lastAnswer
  // The person's messages and an answer in the middle of a turn float their row in on hover instead of keeping a place under it.
  const kept = !person && actions.turnEnds.has(event.id)
  const more: MenuRow[][] = [
    [
      { label: 'Select messages', icon: 'select', onSelect: () => actions.select(event) },
      ...(onRaw === undefined ? [] : [{ label: raw === true ? 'Show formatted' : 'Show raw', icon: 'code' as const, onSelect: onRaw }]),
      ...(person || body === undefined ? [] : [{ label: 'Copy as plain text', icon: 'copy' as const, onSelect: () => void actions.copyText(body.current?.innerText ?? '').catch(() => {}) }]),
    ],
  ]
  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className={`flex items-center gap-0.5 transition-opacity duration-100 focus-within:opacity-100 group-hover/message:opacity-100 motion-reduce:transition-none ${latest ? '' : 'opacity-0'} ${
        kept ? '-ml-2 mt-1' : `absolute top-full z-10 mt-0.5 rounded-full border border-white/[0.08] bg-ink-900/95 p-0.5 shadow-lg ${side === 'right' ? 'right-0' : 'left-0'}`
      }`}
    >
      <Action label={copied ? 'Copied' : person ? 'Copy text' : 'Copy markdown'} icon={copied ? 'check' : 'copy'} onClick={() => void actions.copy(event).then(() => setCopied(true), () => {})} />
      <Action label="Share as image" icon="share" menu onClick={(click) => actions.share(event, click)} />
      {branchable && <Action label="Branch from here" icon="branch" onClick={() => actions.branch?.(event)} />}
      {editable && <Action label={actions.editDisabled ? 'Edit when the turn ends' : 'Edit (↑ in an empty composer)'} icon="rename" disabled={actions.editDisabled} onClick={() => actions.edit?.(event)} />}
      <Action label="More" icon="more" menu onClick={(click) => actions.menu(click, more)} />
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

/**
 * The surface of a bar floating over the transcript: an opaque fill, so no message reads through it
 * whether or not the webview applies a backdrop blur, above the rows (a hovered or focused row rises to z-10).
 */
export const floatingBar = 'z-20 rounded-full border border-white/15 bg-ink-850 shadow-lg shadow-black/50'

// The bar's buttons take the message row's height and glyphs, with their labels beside them.
const barButton = 'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold text-ink-100 transition-colors duration-100 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'

/** The bar while selecting: how many, and what can be done with them. */
export function SelectionBar({ count, onCopyImage, onShare, onCopyText, onCancel }: { count: number; onCopyImage: () => void; onShare: (trigger: ReactMouseEvent<HTMLElement>) => void; onCopyText: () => void; onCancel: () => void }) {
  return (
    <div role="toolbar" aria-label="Selected messages" className={`absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 py-1 pr-1 pl-4 ${floatingBar}`}>
      <span role="status" className="mr-2 shrink-0 text-[12.5px] text-ink-300 tabular-nums">
        {count} selected
      </span>
      <button type="button" disabled={count === 0} onClick={onCopyImage} className={barButton}>
        <MenuIconGlyph icon="image" />
        Copy image
      </button>
      <button type="button" aria-haspopup="menu" disabled={count === 0} onClick={onShare} className={`${barButton} aria-expanded:bg-white/[0.08]`}>
        <MenuIconGlyph icon="share" />
        Share as image
      </button>
      <button type="button" disabled={count === 0} onClick={onCopyText} className={barButton}>
        <MenuIconGlyph icon="copy" />
        Copy text
      </button>
      <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-white/[0.1]" />
      <button type="button" onClick={onCancel} className={`${barButton} font-medium text-ink-400 hover:text-ink-100`}>
        Cancel
      </button>
    </div>
  )
}
