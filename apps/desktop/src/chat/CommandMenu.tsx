import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SlashCommand } from '@/api/schema'
import { placeMenu, type AnchorRect } from '@/advanced/menu-placement'
import { commandKey, menuKey, rememberPick, type MenuSection, type Range } from '@/chat/command-menu'

const sourceNames: Record<SlashCommand['source'], string> = { skill: 'Skill', plugin: 'Plugin', user: 'Personal command', project: 'Project command', builtin: 'Built-in' }

function SourceIcon({ source, className = 'size-4' }: { source: SlashCommand['source']; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} shrink-0`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {source === 'skill' && (
        <>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </>
      )}
      {source === 'plugin' && <path d="M10 4.5a2 2 0 1 1 4 0V6h4v4h-1.5a2 2 0 1 0 0 4H18v4h-4v-1.5a2 2 0 1 0-4 0V18H6v-4h1.5a2 2 0 1 0 0-4H6V6h4z" />}
      {(source === 'user' || source === 'project') && (
        <>
          <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
          <path d="m14 8-4 8" />
        </>
      )}
      {source === 'builtin' && <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />}
    </svg>
  )
}

/** The text with its matched stretches picked out. */
function Highlighted({ text, ranges }: { text: string; ranges: Range[] }) {
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(
      <mark key={start} className="rounded-[3px] bg-accent/[0.18] text-ink-100">
        {text.slice(start, end)}
      </mark>,
    )
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

const storageKey = (agent: string) => `megabrain.recentCommands.${agent}`

function loadRecent(agent: string): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey(agent)) ?? '[]')
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** The agent's recent picks, kept in this browser, and the function that records one. */
export function useRecentCommands(agent: string | null): [string[], (command: SlashCommand) => void] {
  const [recent, setRecent] = useState<string[]>(() => (agent === null ? [] : loadRecent(agent)))
  useEffect(() => setRecent(agent === null ? [] : loadRecent(agent)), [agent])
  const remember = useCallback(
    (command: SlashCommand) => {
      if (agent === null) return
      setRecent((current) => {
        const next = rememberPick(current, commandKey(command))
        try {
          window.localStorage.setItem(storageKey(agent), JSON.stringify(next))
        } catch {
          // Recent picks are a convenience; without storage they last until the window closes.
        }
        return next
      })
    },
    [agent],
  )
  return [recent, remember]
}

/** Arrow, Enter, Tab and Escape for a menu whose keys arrive somewhere else, such as the composer. */
export function handleMenuKey(event: KeyboardEvent, count: number, active: number, actions: { move: (index: number) => void; pick: () => void; close: () => void }): boolean {
  const action = menuKey(event.key, count, active)
  if (action === null) return false
  event.preventDefault()
  if (action.type === 'move') actions.move(action.index)
  else if (action.type === 'pick') actions.pick()
  else actions.close()
  return true
}

const detailMinWidth = 520

/**
 * The skills and slash commands in one menu: sections with counts, compact rows with an icon by
 * source and the matched letters picked out, and the highlighted item in full in a pane on the right
 * when there is room. It renders on document.body and flips inside the window like the row menus; a
 * click outside it (and outside `inside`), Escape or the window losing focus closes it.
 */
export function CommandMenu({
  anchor,
  label,
  sections,
  active,
  query,
  width,
  inside,
  search,
  onActive,
  onPick,
  onClose,
}: {
  anchor: AnchorRect
  label: string
  sections: MenuSection[]
  active: number
  query: string
  /** Preferred width; the window can make it narrower. */
  width: number
  /** An element whose clicks do not close the menu, such as the composer it belongs to. */
  inside?: RefObject<HTMLElement | null>
  /** A search box at the top, for a menu that is not typed into the composer. */
  search?: { value: string; placeholder: string; onChange: (value: string) => void; onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void }
  onActive: (index: number) => void
  onPick: (command: SlashCommand) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const items = sections.flatMap((section) => section.items)
  const highlighted = items[Math.min(active, items.length - 1)]

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return
      if (ref.current?.contains(event.target) === true || inside?.current?.contains(event.target) === true) return
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, inside])

  // Measured before paint and again when the content changes size, then flipped when it would leave the window.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const place = () => {
      const rect = element.getBoundingClientRect()
      setPosition(placeMenu(anchor, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }, 6))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    return () => observer.disconnect()
  }, [anchor])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const shownWidth = Math.min(width, window.innerWidth - 16)
  const withDetail = shownWidth >= detailMinWidth
  let index = -1
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      style={{ ...(position ?? { left: 0, top: 0, visibility: 'hidden' }), width: shownWidth }}
      className="popover fixed z-[100] flex max-h-[min(420px,calc(100vh-16px))] flex-col overflow-hidden"
    >
      {search !== undefined && (
        <div className="shrink-0 border-b border-white/[0.07] p-1.5">
          <input
            autoFocus
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={search.onKeyDown}
            placeholder={search.placeholder}
            aria-label={search.placeholder}
            className="h-8 w-full rounded-[10px] bg-white/[0.06] px-3 text-[13px] text-ink-100 outline-none placeholder:text-ink-400"
          />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div ref={list} role="listbox" aria-label={label} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-1.5">
          {items.length === 0 && (
            <div className="grid place-items-center gap-1.5 px-4 py-8 text-center">
              <SourceIcon source="skill" className="size-5 text-ink-500" />
              <p className="text-[13px] text-ink-300">{query.trim() === '' ? 'Nothing here yet.' : `Nothing matches “${query.trim()}”.`}</p>
              <p className="text-[12px] text-ink-500">Try fewer letters or another word from the description.</p>
            </div>
          )}
          {sections.map((section) => (
            <div key={section.id} role="group" aria-label={section.label} className="pb-1">
              <p className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
                {section.label}
                <span className="font-normal text-ink-500 tabular-nums">{section.count}</span>
              </p>
              {section.items.map((item) => {
                index += 1
                const position = index
                const selected = position === active
                const description = item.command.description ?? ''
                return (
                  <button
                    key={`${section.id}:${item.key}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-index={position}
                    title={withDetail || description === '' ? undefined : description}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onPick(item.command)}
                    onMouseMove={() => {
                      if (!selected) onActive(position)
                    }}
                    className={`flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left ${selected ? 'bg-white/[0.09]' : ''}`}
                  >
                    <span className={selected ? 'text-ink-200' : 'text-ink-500'}>
                      <SourceIcon source={item.command.source} />
                    </span>
                    <span className="max-w-[60%] shrink-0 truncate text-[13px] font-semibold text-ink-100">
                      <Highlighted text={item.command.name} ranges={item.match.field === 'name' ? item.match.ranges : []} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-400">
                      <Highlighted text={description} ranges={item.match.field === 'description' ? item.match.ranges : []} />
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        {withDetail && highlighted !== undefined && (
          <aside aria-label="Details" className="w-[220px] shrink-0 overflow-y-auto border-l border-white/[0.07] p-3.5">
            <div className="flex items-center gap-2 text-ink-300">
              <SourceIcon source={highlighted.command.source} />
              <span className="text-[11px] font-semibold tracking-wide uppercase">{sourceNames[highlighted.command.source]}</span>
            </div>
            <p className="mt-2 text-[14px] font-semibold break-words text-ink-100">{highlighted.command.name}</p>
            {highlighted.command.argumentHint !== undefined && highlighted.command.argumentHint !== null && highlighted.command.argumentHint !== '' && (
              <p className="mt-1 font-mono text-[11.5px] break-words text-ink-400">{highlighted.command.argumentHint}</p>
            )}
            <p className="mt-2.5 text-[12.5px] leading-[1.5] break-words whitespace-pre-wrap text-ink-300">{highlighted.command.description ?? 'No description.'}</p>
          </aside>
        )}
      </div>
      <p className="shrink-0 border-t border-white/[0.07] px-3.5 py-1.5 text-[11px] text-ink-500">↑↓ to move · Enter or Tab to use · Esc to close</p>
    </div>,
    document.body,
  )
}
