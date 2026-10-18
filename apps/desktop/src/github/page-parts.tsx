import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/ui'
import { Tooltip } from '@/components/Tooltip'
import { ActionsIcon, IssueIcon, PullRequestIcon } from '@/github/icons'
import { Avatar } from '@/github/parts'
import type { GithubKind } from '@/github/useGithubCounts'
import { pageMx } from '@/lib/page'

// The pieces the pull request, issue and Actions pages share: the header's owner picture, icon
// buttons and kind switch, the tabs, search and filter pills over a list, its empty state, rows and
// the sentinel that asks for the next page.

/** Asks for the next page when the end of the list scrolls into view. */
export function LoadMore({ onVisible, loading, loaded, total }: { onVisible: () => void; loading: boolean; loaded: number; total: number | null }) {
  const sentinel = useRef<HTMLDivElement>(null)
  const visible = useRef(onVisible)
  visible.current = onVisible
  useEffect(() => {
    const element = sentinel.current
    if (element === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) visible.current()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={sentinel} className="flex items-center gap-2 px-7 pt-3 text-[12px] text-ink-500">
      {loading && <Spinner />}
      <button type="button" onClick={onVisible} className="hover:text-ink-200">
        {loading ? 'Loading more…' : `Showing ${loaded}${total === null ? '' : ` of ${total}`}; load more`}
      </button>
    </div>
  )
}

export function OwnerPicture({ owner }: { owner: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Avatar login={null} size={44} />
  return <img src={`https://github.com/${owner}.png?size=96`} alt="" draggable={false} onError={() => setFailed(true)} className="size-11 shrink-0 rounded-[14px] bg-white/[0.06] object-cover" />
}

/** A 36px round icon button; the header's last one overhangs by its glyph's inset so the glyph ends on the page inset (lib/page). */
export function IconButton({ label, onClick, children, spinning }: { label: string; onClick: () => void; children: ReactNode; spinning?: boolean }) {
  return (
    <Tooltip text={label}>
      {(anchor) => (
        <button {...anchor} type="button" onClick={onClick} aria-label={label} className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-300 last:-mr-[11px] hover:bg-white/[0.08] hover:text-ink-100">
          <span className={spinning === true ? 'animate-spin' : ''}>{children}</span>
        </button>
      )}
    </Tooltip>
  )
}

export function KindSwitch({ kind, onKind }: { kind: GithubKind; onKind: (kind: GithubKind) => void }) {
  const option = (value: GithubKind, label: string, icon: ReactNode) => (
    <button
      type="button"
      onClick={() => onKind(value)}
      aria-pressed={kind === value}
      className={`flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${kind === value ? 'bg-white/[0.14] text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}
    >
      {icon}
      {label}
    </button>
  )
  return (
    <div className="inline-flex shrink-0 rounded-full border border-white/10 bg-white/[0.05] p-1">
      {option('prs', 'Pull requests', <PullRequestIcon size={14} />)}
      {option('issues', 'Issues', <IssueIcon size={14} />)}
      {option('actions', 'Actions', <ActionsIcon size={14} />)}
    </div>
  )
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string; count: number | null }[]; onChange: (value: T) => void }) {
  return (
    <div role="tablist" className="inline-flex shrink-0 rounded-full border border-white/10 bg-white/[0.05] p-1">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={`flex h-8 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${tab.value === value ? 'bg-white/[0.14] text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}
        >
          {tab.label}
          {tab.count !== null && <span className={`rounded-full px-1.5 text-[11px] leading-[18px] tabular-nums ${tab.value === value ? 'bg-white/[0.14] text-ink-100' : 'bg-white/[0.06] text-ink-400'}`}>{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function SearchBox({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (value: string) => void }) {
  return (
    <label className="flex h-9 min-w-[180px] flex-1 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.05] px-3.5 text-ink-400 focus-within:border-accent/60 focus-within:text-ink-200">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.4 10.4 3.1 3.1" />
      </svg>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onChange('')
        }}
        className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink-100 outline-none placeholder:text-ink-500"
      />
    </label>
  )
}

/** A filter as a pill: the native menu, so it is keyboard and screen-reader friendly for free. */
export function FilterSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  const active = value !== options[0]?.value
  return (
    <label className={`relative flex h-9 shrink-0 items-center rounded-full border text-[13px] font-semibold ${active ? 'border-accent/50 bg-accent/[0.16] text-ink-100' : 'border-white/[0.08] bg-white/[0.05] text-ink-300 hover:text-ink-100'}`}>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)} style={{ colorScheme: 'dark' }} className="h-full max-w-[200px] cursor-pointer appearance-none truncate rounded-full bg-transparent pr-8 pl-3.5 outline-none">
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="pointer-events-none absolute right-3">
        <path d="m4 6 4 4 4-4" />
      </svg>
    </label>
  )
}

export const anyValue = '\u0000any'
export const people = (label: string, values: string[]) => [{ value: anyValue, label }, ...values.map((value) => ({ value, label: value }))]
export const fromAny = (value: string) => (value === anyValue ? null : value)

export function Empty({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className={`${pageMx} my-6 rounded-[24px] border border-dashed border-white/[0.12] px-6 py-10 text-center`}>
      <p className="text-[15px] font-semibold text-ink-200">{title}</p>
      {detail !== undefined && <p className="mt-1 text-[13.5px] text-ink-400">{detail}</p>}
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  )
}

export const pillButton = 'rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]'

export function Meta({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-400">{children}</span>
}

export const dot = <span className="text-ink-600">·</span>

export function rowClass(selected: boolean) {
  return `grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3.5 px-5 py-4 text-left transition-colors duration-[var(--motion-enter)] ${selected ? 'bg-accent/[0.10]' : 'hover:bg-white/[0.03]'}`
}
