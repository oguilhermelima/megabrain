import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { trapFocus } from '@/chat/composer-look'
import { ResizeHandle } from '@/components/ResizeHandle'
import { focusBack, readSheetMemory, sheetInset, sheetLimits, sheetTop, writeSheetMemory, type SheetMemory } from '@/components/sheet-model'
import { clampWidth } from '@/lib/panel-width'

// The app's one side sheet: a rounded panel inset from the edges of the page it serves, on its right
// or left. Floating, it lies over the page on a light backdrop that closes it, like a dialog: Escape
// closes it, Tab stays inside, and focus goes back to what opened it. Pinned, it docks to its side and
// the page narrows to make room; it stays open until closed, comes back open on the page's next
// visit, and its inner edge resizes it. What it remembers is in sheet-model.ts.
//
// A page puts <Sheet> in a `relative` flex row beside its content: floating it is positioned over
// that row, pinned it takes its place in it.

const browserStorage = () => localStorage

const controls = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'

/** One sheet's state, from its trigger to its panel; `id` names what it remembers. */
export function useSheet(id: string) {
  const [memory, setMemory] = useState(() => readSheetMemory(browserStorage, id))
  const [floating, setFloating] = useState(false)
  const [dragged, setDragged] = useState<number | null>(null)
  const remember = (patch: Partial<SheetMemory>) => setMemory((current) => writeSheetMemory(browserStorage, id, { ...current, ...patch }))
  const open = memory.pinned ? memory.open : floating
  const show = () => (memory.pinned ? remember({ open: true }) : setFloating(true))
  const close = () => (memory.pinned ? remember({ open: false }) : setFloating(false))
  return {
    open,
    pinned: memory.pinned,
    toggle: () => (open ? close() : show()),
    close,
    /** Unpinning leaves it open, floating. */
    setPinned: (pinned: boolean) => {
      remember({ pinned, open: true })
      setFloating(!pinned)
    },
    /** The panel width, in the shape the resize handle drives. */
    width: {
      width: dragged ?? memory.width,
      preview: (next: number) => setDragged(clampWidth(next, sheetLimits)),
      commit: (next: number) => {
        setDragged(null)
        remember({ width: next })
      },
      reset: () => remember({ width: sheetLimits.initial }),
    },
  }
}

export type SheetState = ReturnType<typeof useSheet>

const cross = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
)

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M6 2.5h4l-.5 4 2 2v1h-7v-1l2-2z" />
      <path d="M8 9.5v4" fill="none" />
    </svg>
  )
}

const headerButton = 'grid size-8 place-items-center rounded-full text-ink-400 hover:bg-white/[0.06] hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-accent'

export function Sheet({
  sheet,
  title,
  side = 'right',
  note,
  footer,
  children,
}: {
  sheet: SheetState
  title: string
  side?: 'left' | 'right'
  /** A short line beside the title, such as how many filters are set. */
  note?: ReactNode
  /** Under the body, outside its scroll: Clear, or Apply when changes wait for it. */
  footer?: ReactNode
  children: ReactNode
}) {
  const panel = useRef<HTMLElement>(null)
  const titleId = useId()
  const latest = useRef(sheet)
  latest.current = sheet
  const modal = sheet.open && !sheet.pinned

  // Floating it behaves as a dialog; pinning it ends that without moving focus, closing it hands focus back.
  useEffect(() => {
    if (!modal) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (panel.current?.contains(document.activeElement) !== true) panel.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent) => {
      const element = panel.current
      if (element === null) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        latest.current.close()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        const reachable = [...element.querySelectorAll<HTMLElement>(controls)]
        const focused = document.activeElement
        const next = trapFocus(focused instanceof HTMLElement ? reachable.indexOf(focused) : -1, reachable.length, event.shiftKey)
        if (next !== null) reachable[next]?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (!latest.current.pinned) focusBack(before)?.focus({ preventScroll: true })
    }
  }, [modal])

  if (!sheet.open) return null
  const width = sheet.width.width
  const edge = side === 'right' ? { right: sheetInset } : { left: sheetInset }
  const place: CSSProperties = sheet.pinned ? { width } : { position: 'absolute', top: sheetTop, bottom: sheetInset, ...edge, width, maxWidth: `calc(100% - ${2 * sheetInset}px)` }
  const pinLabel = sheet.pinned ? `Unpin ${title.toLowerCase()}` : `Pin ${title.toLowerCase()}`
  return (
    // Pinned, the wrapper is the column it docks in, painted like the page; floating, it has no box of its own.
    <div style={sheet.pinned ? { maxWidth: '60%', paddingTop: sheetTop, paddingBottom: sheetInset, [side === 'right' ? 'paddingRight' : 'paddingLeft']: sheetInset } : undefined} className={sheet.pinned ? `flex shrink-0 bg-ink-950 ${side === 'left' ? 'order-first' : ''}` : 'contents'}>
      {modal && <button type="button" tabIndex={-1} aria-label={`Close ${title.toLowerCase()}`} onClick={sheet.close} className="motion-fade absolute inset-0 z-30 cursor-default bg-black/20" />}
      <aside
        ref={panel}
        tabIndex={-1}
        role={modal ? 'dialog' : undefined}
        aria-modal={modal || undefined}
        aria-labelledby={titleId}
        style={place}
        className={`relative z-30 flex min-h-0 min-w-0 flex-col rounded-card border border-white/[0.1] bg-ink-900 shadow-[0_25px_50px_-12px_rgb(0_0_0/0.5)] outline-none ${modal ? 'dialog-card' : ''}`}
      >
        <header className="flex h-14 shrink-0 items-center gap-1 border-b border-white/[0.08] pr-3 pl-5">
          <h2 id={titleId} className="text-[14px] font-semibold text-ink-100">
            {title}
          </h2>
          {note !== undefined && <span className="ml-1 text-[12px] text-ink-400 tabular-nums">{note}</span>}
          <span className="ml-auto" />
          <button type="button" onClick={() => sheet.setPinned(!sheet.pinned)} aria-pressed={sheet.pinned} aria-label={pinLabel} title={pinLabel} className={`${headerButton} ${sheet.pinned ? 'text-ink-100' : ''}`}>
            <PinIcon pinned={sheet.pinned} />
          </button>
          <button type="button" onClick={sheet.close} aria-label={`Close ${title.toLowerCase()}`} title="Close" className={headerButton}>
            {cross}
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer !== undefined && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-white/[0.08] px-4 py-3">{footer}</footer>}
        {sheet.pinned && <ResizeHandle edge={side === 'right' ? 'left' : 'right'} label={`Resize ${title.toLowerCase()}`} panel={sheet.width} grip />}
      </aside>
    </div>
  )
}
