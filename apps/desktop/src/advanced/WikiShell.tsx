import { useState, type ReactNode } from 'react'
import { SearchIcon } from '@/advanced/SidebarTools'
import { readPanelOpen, wikiPanelLimits, writePanelOpen, type WikiPanel } from '@/advanced/wiki-shell-model'
import { ResizeHandle, usePanelWidth } from '@/components/ResizeHandle'
import { SlidePanel } from '@/components/SlidePanel'

// The shell the Knowledge and Artifacts pages share: a top bar across the whole pane, sized like a
// chat's (chat/ChatHeader: 12px above a 36px row, 30px pill controls), and the page's navigation in a
// panel on the right that opens, closes and resizes like the run panel, styled like the left sidebar.
// What the page reads takes the room left between them. See wiki-shell-model.ts for what it remembers.

const browserStorage = () => localStorage

function usePanelOpen(key: string) {
  const [open, setOpen] = useState(() => readPanelOpen(browserStorage, key))
  return { open, setOpen: (next: boolean) => setOpen(writePanelOpen(browserStorage, key, next)) }
}

function PanelIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.75" width="12" height="10.5" rx="2" />
      <path d="M10 2.75v10.5" />
    </svg>
  )
}

/** A 30px pill of the bar, pressed or not, as the run panel's toggle. */
export const barToggle = (pressed: boolean) => `bar-control gap-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 ${pressed ? 'bg-white/[0.14] text-ink-100' : 'text-ink-300 hover:bg-white/[0.08] hover:text-ink-100'}`

/** The bar's search: a 30px pill that narrows with the pane; Escape clears it. */
export function BarSearch({ value, onChange, label, disabled = false }: { value: string; onChange: (value: string) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`bar-control w-40 gap-1.5 px-2.5 text-ink-400 focus-within:border-accent/60 @min-[720px]/header:w-56 @min-[960px]/header:w-64 ${disabled ? 'opacity-50' : ''}`}>
      <SearchIcon />
      <input
        type="search"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || value === '') return
          event.preventDefault()
          onChange('')
        }}
        placeholder={label}
        aria-label={label}
        className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-ink-100 placeholder:text-ink-400 focus:outline-none"
      />
    </label>
  )
}

export function WikiShell({
  keys,
  crumb,
  title,
  tools,
  panelLabel,
  panelCount,
  panel,
  children,
}: {
  /** Where this page remembers its panel. */
  keys: WikiPanel
  /** What the bar starts with: the page, or the project it shows. */
  crumb: ReactNode
  /** What is read, after the crumb; none shows the crumb alone. */
  title: string | null
  /** The bar's controls before the panel's toggle. */
  tools?: ReactNode
  /** The panel's name, in its header and on its toggle; null leaves the page without one. */
  panelLabel: string | null
  panelCount?: number | null
  panel: ReactNode
  children: ReactNode
}) {
  const width = usePanelWidth(keys.width, wikiPanelLimits)
  const { open, setOpen } = usePanelOpen(keys.open)
  const shown = panelLabel !== null && open
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header data-tauri-drag-region className="@container/header flex shrink-0 items-center gap-2 border-b border-white/[0.06] pt-3 pr-6 pb-2.5 pl-6">
        <div data-tauri-drag-region className="flex h-9 min-w-0 flex-1 items-center gap-2">
          {crumb}
          {title !== null && (
            <>
              <span aria-hidden="true" className="shrink-0 text-[13px] text-ink-500">
                /
              </span>
              <h1 title={title} className="min-w-0 flex-1 truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink-100">
                {title}
              </h1>
            </>
          )}
        </div>
        <div data-tauri-drag-region className="flex shrink-0 items-center justify-end gap-2">
          {tools}
          {panelLabel !== null && (
            <button type="button" onClick={() => setOpen(!open)} aria-pressed={open} aria-label={`${open ? 'Hide' : 'Show'} ${panelLabel.toLowerCase()}`} title={`${open ? 'Hide' : 'Show'} ${panelLabel.toLowerCase()}`} className={`${barToggle(open)} px-[6px]`}>
              <PanelIcon />
            </button>
          )}
        </div>
      </header>
      {/* A container, so the panel's 50% cap reads the same for its frame and its body. */}
      <div className="@container flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">{children}</div>
        {panelLabel !== null && (
          <SlidePanel open={shown} side="right" width={width.width} maxWidth="50cqw" className="glass border-l border-white/[0.06]" handle={<ResizeHandle edge="left" label={`Resize ${panelLabel.toLowerCase()}`} panel={width} grip />}>
            <nav aria-label={panelLabel} className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 pt-3 pr-3 pb-1 pl-5">
                <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-ink-300">{panelLabel}</h2>
                {panelCount !== null && panelCount !== undefined && <span className="shrink-0 text-[11px] font-medium text-ink-400 tabular-nums">{panelCount}</span>}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={`Hide ${panelLabel.toLowerCase()}`}
                  title={`Hide ${panelLabel.toLowerCase()}`}
                  className="grid size-7 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.07] hover:text-ink-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none motion-reduce:transition-none"
                >
                  <PanelIcon />
                </button>
              </div>
              {/* Padded like the left sidebar's list: 10px at the left, 4px and the scrollbar's gutter at the right. */}
              <div style={{ scrollbarGutter: 'stable' }} className="sidebar-scroll min-h-0 flex-1 space-y-1 overflow-y-auto pt-1 pr-1 pb-3 pl-2.5">
                {panel}
              </div>
            </nav>
          </SlidePanel>
        )}
      </div>
    </div>
  )
}
