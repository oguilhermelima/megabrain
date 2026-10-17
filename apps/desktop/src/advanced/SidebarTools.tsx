import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { agents, emptyFilters, type SidebarFilters } from '@/advanced/sidebar-model'
import { AgentIcon } from '@/components/agent-icons'
import { usePresence } from '@/lib/usePresence'

// The search and filter controls of the Projects header: two icons beside +, a search field that
// opens under the header, and a menu of filters anchored to the funnel.

export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.4 10.4 3.1 3.1" />
    </svg>
  )
}

export function FilterIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3h11l-4.3 5.2V13l-2.4-1.2V8.2L2.5 3Z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  )
}

/** A round icon button the size of the header's +; `on` marks a control whose filter is in effect. */
export function HeaderButton({ label, on, expanded, keepFocus, onClick, children }: { label: string; on?: boolean; expanded?: boolean; keepFocus?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Keeps focus where it is, so pressing the button does not first blur the search field it toggles.
      onMouseDown={keepFocus === true ? (event) => event.preventDefault() : undefined}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      className={`relative flex size-7 items-center justify-center rounded-full transition-colors ${on === true ? 'bg-accent/[0.18] text-ink-100' : 'text-ink-400 hover:bg-white/[0.08] hover:text-ink-100'}`}
    >
      {children}
    </button>
  )
}

/** The search field under the header; Escape clears and closes it, leaving it empty closes it. */
export function SearchField({
  inputRef,
  query,
  onQuery,
  onClose,
  placeholder = 'Search projects, branches, chats',
  label = 'Search projects, branches and chats',
}: {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  onQuery: (query: string) => void
  onClose: () => void
  placeholder?: string
  label?: string
}) {
  return (
    <div className="px-1">
      <input
        ref={inputRef}
        type="search"
        autoFocus
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          onQuery('')
          onClose()
        }}
        onBlur={() => {
          if (query === '') onClose()
        }}
        placeholder={placeholder}
        aria-label={label}
        className="h-8 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 text-[13px] text-ink-100 placeholder:text-ink-400 focus:border-accent/60 focus:outline-none"
      />
    </div>
  )
}

function FilterRow({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      onClick={onClick}
      title={title}
      className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] text-ink-200 hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:outline-none"
    >
      <span className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] border ${on ? 'border-accent bg-accent/80 text-ink-100' : 'border-white/[0.2]'}`}>{on && <CheckIcon />}</span>
      {children}
    </button>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="py-1">
      <p className="px-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-ink-400 uppercase">{label}</p>
      {children}
    </div>
  )
}

/** The funnel and its menu of filters, closed by a click elsewhere or Escape; the badge counts filters in effect. */
export function FilterMenu({ filters, onFilters }: { filters: SidebarFilters; onFilters: (filters: SidebarFilters) => void }) {
  const [open, setOpen] = useState(false)
  const menu = usePresence(open || null)
  const ref = useRef<HTMLDivElement>(null)
  const set = (patch: Partial<SidebarFilters>) => onFilters({ ...filters, ...patch })
  const count = (filters.active ? 1 : 0) + (filters.needsYou ? 1 : 0) + filters.agents.length + (filters.pr === null ? 0 : 1)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || ref.current?.contains(event.target) !== true) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <HeaderButton label={count > 0 ? `Filters (${count} on)` : 'Filters'} on={count > 0} expanded={open} onClick={() => setOpen((current) => !current)}>
        <FilterIcon />
        {count > 0 && <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9.5px] leading-none font-bold text-ink-100 tabular-nums">{count}</span>}
      </HeaderButton>
      {menu.shown !== null && (
        <div role="menu" aria-label="Filters" data-leaving={menu.leaving || undefined} inert={menu.leaving} className="popover absolute top-full right-0 z-50 mt-1.5 w-[220px] p-1.5">
          <Group label="Status">
            <FilterRow on={filters.active} onClick={() => set({ active: !filters.active })} title="Only worktrees with a live session">
              Active
            </FilterRow>
            <FilterRow on={filters.needsYou} onClick={() => set({ needsYou: !filters.needsYou })} title="Only worktrees with a session waiting for you">
              Needs you
            </FilterRow>
          </Group>
          <Group label="Agent">
            {agents.map((agent) => {
              const on = filters.agents.includes(agent)
              return (
                <FilterRow key={agent} on={on} onClick={() => set({ agents: on ? filters.agents.filter((item) => item !== agent) : [...filters.agents, agent] })} title={`Only worktrees with a ${agent} session`}>
                  <AgentIcon agent={agent} size={12} />
                  {agent}
                </FilterRow>
              )
            })}
          </Group>
          <Group label="Pull request">
            <FilterRow on={filters.pr === 'open'} onClick={() => set({ pr: filters.pr === 'open' ? null : 'open' })} title="Only worktrees with an open pull request">
              PR open
            </FilterRow>
            <FilterRow on={filters.pr === 'none'} onClick={() => set({ pr: filters.pr === 'none' ? null : 'none' })} title="Only worktrees without a pull request">
              No PR
            </FilterRow>
          </Group>
          <div className="mt-1 border-t border-white/[0.08] pt-1.5">
            <button
              type="button"
              role="menuitem"
              disabled={count === 0}
              onClick={() => onFilters({ ...emptyFilters, query: filters.query })}
              className="w-full rounded-[10px] px-2.5 py-1.5 text-left text-[13px] font-semibold text-ink-200 hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:outline-none disabled:text-ink-400 disabled:hover:bg-transparent"
            >
              Clear all
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
