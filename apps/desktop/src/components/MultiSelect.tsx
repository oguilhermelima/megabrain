import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { placeMenu, type AnchorRect } from '@/advanced/menu-placement'
import { Checkbox } from '@/components/Checkbox'
import { chosenLabels, filterGroups, optionCount, selectionSummary, toggledValue, withUnknown, type PickGroup } from '@/components/multi-select-model'
import { usePresence } from '@/lib/usePresence'

// A dropdown of checkboxes: the closed button says what is chosen in a few words, the open list has
// a search once it is long, headed groups, and each group's older options folded away.

const heading = 'px-2 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-ink-500 uppercase'
/** Lists this long get a search field. */
const searchFrom = 8

function Chevron({ open = false, className = 'size-3.5' }: { open?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''} ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 4 4 4-4 4" />
    </svg>
  )
}

function Group({ group, chosen, onToggle, searching }: { group: PickGroup; chosen: string[]; onToggle: (value: string) => void; searching: boolean }) {
  const older = group.older ?? []
  // Opened when a chosen option sits in the fold, so it shows.
  const [showOlder, setShowOlder] = useState(() => older.some((option) => chosen.includes(option.value)))
  const row = (option: PickGroup['options'][number]) => (
    <Checkbox key={option.value} checked={chosen.includes(option.value)} onChange={() => onToggle(option.value)} className="rounded-[8px] px-2 py-1.5 hover:bg-white/[0.06]">
      <span className="block truncate text-[13px] leading-4 text-ink-100">{option.label}</span>
      {option.detail !== undefined && option.detail !== option.label && <span className="mt-0.5 block truncate font-mono text-[11px] leading-4 text-ink-500">{option.detail}</span>}
    </Checkbox>
  )
  return (
    <div role="group" aria-label={group.label}>
      {group.label !== undefined && <p className={heading}>{group.label}</p>}
      {group.options.map(row)}
      {!searching && older.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showOlder}
            onClick={() => setShowOlder((open) => !open)}
            className="flex h-7 w-full items-center gap-1.5 rounded-[8px] px-2 text-left text-[12px] text-ink-500 transition-colors duration-100 hover:bg-white/[0.04] hover:text-ink-300 focus-visible:bg-white/[0.06] focus-visible:text-ink-300 focus-visible:outline-none motion-reduce:transition-none"
          >
            <Chevron open={showOlder} className="size-3" />
            {`Older (${older.length})`}
          </button>
          {showOlder && older.map(row)}
        </>
      )}
    </div>
  )
}

function Panel({
  anchor,
  label,
  groups,
  chosen,
  onChange,
  empty,
  leaving,
  trigger,
  onClose,
}: {
  anchor: AnchorRect
  label: string
  groups: PickGroup[]
  chosen: string[]
  onChange: (next: string[]) => void
  empty: string
  leaving: boolean
  trigger: HTMLButtonElement | null
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const searchable = optionCount(groups) >= searchFrom
  const shown = filterGroups(groups, query)

  useEffect(() => {
    if (leaving) return
    const outside = (event: Event) => !(event.target instanceof Node) || (ref.current?.contains(event.target) !== true && trigger?.contains(event.target) !== true)
    const onDown = (event: MouseEvent) => {
      if (outside(event)) onClose()
    }
    // The settings page scrolls under it, which moves the button it hangs from.
    const onScroll = (event: Event) => {
      if (outside(event)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      trigger?.focus({ preventScroll: true })
      onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    ref.current?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true })
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, leaving, trigger])

  // Measured before paint and again when the list changes size, then flipped when it would leave the window.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const place = () => {
      const rect = element.getBoundingClientRect()
      setPosition(placeMenu(anchor, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }, 4))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    return () => observer.disconnect()
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-leaving={leaving || undefined}
      inert={leaving}
      style={position === null ? { left: 0, top: 0, visibility: 'hidden' } : position}
      className="popover fixed z-[100] flex max-h-[min(420px,calc(100vh-16px))] w-[288px] max-w-[calc(100vw-16px)] flex-col overflow-hidden p-1.5"
    >
      {searchable && (
        <input
          aria-label={`Search ${label.toLowerCase()}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          spellCheck={false}
          className="mb-1 h-8 shrink-0 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-2.5 text-[13px] text-ink-100 placeholder:text-ink-500 focus:border-accent/60 focus:outline-none"
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && <p className="px-2 py-3 text-[12.5px] text-ink-500">{query.trim() === '' ? empty : 'Nothing matches.'}</p>}
        {shown.map((group, index) => (
          <Group key={group.label ?? index} group={group} chosen={chosen} searching={query.trim() !== ''} onToggle={(value) => onChange(toggledValue(chosen, value))} />
        ))}
      </div>
      {chosen.length > 0 && (
        <div className="mt-1 flex shrink-0 justify-end border-t border-white/[0.08] pt-1">
          <button type="button" onClick={() => onChange([])} className="h-7 rounded-full px-3 text-[12px] font-semibold text-ink-400 hover:bg-white/[0.07] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25">
            Clear
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}

/** A button that names the chosen options, opening a list of checkboxes under it. */
export function MultiSelect({
  label,
  groups,
  chosen,
  onChange,
  plural,
  any = 'Any',
  empty = 'Nothing to choose.',
  className = '',
}: {
  /** Names the button and the list for screen readers. */
  label: string
  groups: PickGroup[]
  chosen: string[]
  onChange: (next: string[]) => void
  /** The chosen options when there are three or more: "3 models". */
  plural: string
  /** What the button says with nothing chosen. */
  any?: string
  /** What the list says when it has no options. */
  empty?: string
  /** The button's look: the owner's field style and width. */
  className?: string
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const { shown, leaving } = usePresence(anchor)
  const all = withUnknown(groups, chosen)
  const summary = selectionSummary(chosen, all, plural, any)
  const close = useCallback(() => setAnchor(null), [])
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`${label}: ${summary}`}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        title={chosen.length > 2 ? chosenLabels(chosen, all).join(', ') : undefined}
        onClick={() => {
          if (anchor !== null) return close()
          const { left, top, right, bottom } = button.current?.getBoundingClientRect() ?? { left: 0, top: 0, right: 0, bottom: 0 }
          setAnchor({ left, top, right, bottom })
        }}
        className={`inline-flex items-center gap-1.5 text-left ${className}`}
      >
        <span className={`min-w-0 flex-1 truncate ${chosen.length === 0 ? 'text-ink-400' : ''}`}>{summary}</span>
        <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-ink-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
        </svg>
      </button>
      {shown !== null && <Panel anchor={shown} label={label} groups={all} chosen={chosen} onChange={onChange} empty={empty} leaving={leaving} trigger={button.current} onClose={close} />}
    </>
  )
}
