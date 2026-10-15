import type { ReactNode } from 'react'

// The window chrome that used to be a top bar: it lives at the top of the sidebar now, with the
// macOS traffic lights kept clear on its left.

export type Mode = 'sidebar' | 'columns'

/** Room for the macOS traffic lights, which the Overlay title bar draws over the web view. */
export const trafficLightsInset = 'pl-[84px]'

export function SidebarToggleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M6 2.5v11" />
    </svg>
  )
}

export function ColumnsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M6 2.5v11M10 2.5v11" />
    </svg>
  )
}

export function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

export function IconButton({ label, title, onClick, pressed, children }: { label: string; title?: string; onClick: () => void; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
        pressed === true ? 'bg-white/[0.14] text-ink-100' : 'text-ink-300 hover:bg-white/[0.08] hover:text-ink-100'
      }`}
    >
      {children}
    </button>
  )
}

function ViewSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div className="flex gap-0.5 rounded-full border border-white/10 bg-white/[0.05] p-0.5" role="group" aria-label="View">
      <IconButton label="Sidebar view" pressed={mode === 'sidebar'} onClick={() => onChange('sidebar')}>
        <SidebarToggleIcon />
      </IconButton>
      <IconButton label="Columns view" pressed={mode === 'columns'} onClick={() => onChange('columns')}>
        <ColumnsIcon />
      </IconButton>
    </div>
  )
}

/** Top of the sidebar: a drag strip beside the traffic lights, then the logo and the window's controls. */
export function SidebarHeader({ mode, onMode, onHome, onCollapse, onSettings }: { mode: Mode; onMode: (mode: Mode) => void; onHome: () => void; onCollapse: () => void; onSettings: () => void }) {
  return (
    <div className="shrink-0">
      <div data-tauri-drag-region className={`flex h-[46px] items-center justify-end pr-3 ${trafficLightsInset}`}>
        <IconButton label="Hide sidebar" title="Hide sidebar (⌘B)" onClick={onCollapse}>
          <SidebarToggleIcon />
        </IconButton>
      </div>
      <div data-tauri-drag-region className="flex items-center justify-between gap-2 pr-3 pb-3 pl-4">
        <button type="button" onClick={onHome} title="Overview" className="flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-2 pl-1 hover:bg-white/[0.06]">
          <span className="orb size-5 shrink-0" />
          <span className="truncate text-[16px] font-semibold tracking-[-0.01em] text-ink-100">megabrain</span>
        </button>
        <span className="flex items-center gap-1">
          <ViewSwitch mode={mode} onChange={onMode} />
          <IconButton label="Settings" title="Settings (⌘,)" onClick={onSettings}>
            <SettingsIcon />
          </IconButton>
        </span>
      </div>
    </div>
  )
}

/** Shown in place of the sidebar when it is hidden: a drag strip with one button to bring it back. */
export function CollapsedChrome({ onExpand }: { onExpand: () => void }) {
  return (
    <div data-tauri-drag-region className={`flex h-[46px] shrink-0 items-center ${trafficLightsInset}`}>
      <IconButton label="Show sidebar" title="Show sidebar (⌘B)" onClick={onExpand}>
        <SidebarToggleIcon />
      </IconButton>
    </div>
  )
}
