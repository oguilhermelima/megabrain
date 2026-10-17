import { useState, type ReactNode } from 'react'
import { SearchIcon } from '@/advanced/SidebarTools'
import { readPanelOpen, wikiPanelLimits, wikiShellLayout, writePanelOpen, type WikiPanel } from '@/advanced/wiki-shell-model'
import { ResizeHandle, usePanelWidth } from '@/components/ResizeHandle'
import { SlidePanel } from '@/components/SlidePanel'

// The shell the Knowledge and Artifacts pages share: the page's navigation in a panel on the right that
// runs the pane's full height and opens, closes and resizes like the run panel, drawn like the left
// sidebar; and beside it, over what the page reads, a top bar sized like a chat's (chat/ChatHeader:
// 12px above a 36px row, 30px pill controls). The panel's header lines up with the bar. See
// wiki-shell-model.ts for what it remembers.

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

/** The bar's search: a 30px pill that narrows with the pane, and gives way before the bar's other controls; Escape clears it. */
export function BarSearch({ value, onChange, label, disabled = false }: { value: string; onChange: (value: string) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`bar-control w-40 min-w-[88px] shrink gap-1.5 px-2.5 text-ink-400 focus-within:border-accent/60 @min-[720px]/header:w-56 @min-[960px]/header:w-64 ${disabled ? 'opacity-50' : ''}`}>
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
  const layout = wikiShellLayout(panelLabel !== null, open)
  const toggleTitle = (shown: boolean) => `${shown ? 'Hide' : 'Show'} ${(panelLabel ?? '').toLowerCase()}`
  return (
    // A container, so the panel's 50% cap reads the same for its frame and its body.
    <div className="@container flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region className="@container/header flex shrink-0 items-center gap-2 border-b border-white/[0.06] pt-3 pr-6 pb-2.5 pl-6">
          <div data-tauri-drag-region className="flex h-9 min-w-0 flex-1 items-center gap-2">
            {crumb}
          </div>
          <div data-tauri-drag-region className="flex min-w-0 items-center justify-end gap-2">
            {tools}
            {layout.barToggle && (
              <button type="button" onClick={() => setOpen(true)} aria-pressed={false} aria-label={toggleTitle(false)} title={toggleTitle(false)} className={`${barToggle(false)} px-[6px]`}>
                <PanelIcon />
              </button>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
      {panelLabel !== null && (
        // No fill of its own, like the left sidebar: the pane shows through, a hairline at its edge.
        <SlidePanel open={layout.panel} side="right" width={width.width} maxWidth="50cqw" className="border-l border-white/[0.06]" handle={<ResizeHandle edge="left" label={`Resize ${panelLabel.toLowerCase()}`} panel={width} grip />}>
          <nav aria-label={panelLabel} className="flex min-h-0 flex-1 flex-col">
            {/* The bar's height (12px above a 36px row, 10px below), padded and laid out like the left
                sidebar's Projects header (the list's 4px plus its 6px gutter at the right): the title on the rows' text column, the toggle overhanging by
                its inset so its glyph ends where the counts below end. */}
            <div data-tauri-drag-region className="flex shrink-0 pt-3 pr-2.5 pb-2.5 pl-2.5">
              <div data-tauri-drag-region className="flex h-9 min-w-0 flex-1 items-center gap-2 pr-1.5 pl-2.5">
                <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-ink-300">{panelLabel}</h2>
                {panelCount !== null && panelCount !== undefined && <span className="shrink-0 text-[11px] font-medium text-ink-400 tabular-nums">{panelCount}</span>}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={toggleTitle(true)}
                  title={toggleTitle(true)}
                  className="-mr-[6px] grid size-7 shrink-0 place-items-center rounded-full text-ink-400 transition-colors hover:bg-white/[0.08] hover:text-ink-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none"
                >
                  <PanelIcon />
                </button>
              </div>
            </div>
            {/* Padded like the left sidebar's list: 10px at the left, 4px and the scrollbar's gutter at the right. */}
            <div style={{ scrollbarGutter: 'stable' }} className="sidebar-scroll min-h-0 flex-1 space-y-1 overflow-y-auto pt-1 pr-1 pb-3 pl-2.5">
              {panel}
            </div>
          </nav>
        </SlidePanel>
      )}
    </div>
  )
}
