import type { ReactNode } from 'react'

// The window chrome that used to be a top bar, now one row at the top of the sidebar: the band of
// the macOS traffic lights. The Projects header sits under it, sticky at the top of the list.
// tauri.conf.json sets trafficLightPosition { x: 18, y: 19 }, and its y is not the lights' top edge:
// in a real window the lights' centres measured about 22pt from the window top (centre = y + 3).
// Row 1 is 44px tall so its centre line is 22px, the lights' own; the collapse button sits on it at
// the right. x 18 puts the three 12pt lights at about 18-70pt with 8pt between them, and the 72px
// inset leaves that same 8pt before the expand button's icon when the sidebar is hidden. These are
// measured, not documented by macOS: confirm them in the real window after any change, and change
// these numbers together.

/** The traffic lights' band: everything in it is vertically centred on the lights. */
export const lightsRow = 'h-[44px]'

/** Room for the macOS traffic lights, which the Overlay title bar draws over the web view. */
export const trafficLightsInset = 'pl-[72px]'

export function SidebarToggleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M6 2.5v11" />
    </svg>
  )
}

export function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.76 6.84L14.33 7.04L14.33 8.96L12.76 9.16L12.19 10.54L13.15 11.8L11.8 13.15L10.54 12.19L9.16 12.76L8.96 14.33L7.04 14.33L6.84 12.76L5.46 12.19L4.2 13.15L2.85 11.8L3.81 10.54L3.24 9.16L1.67 8.96L1.67 7.04L3.24 6.84L3.81 5.46L2.85 4.2L4.2 2.85L5.46 3.81L6.84 3.24L7.04 1.67L8.96 1.67L9.16 3.24L10.54 3.81L11.8 2.85L13.15 4.2L12.19 5.46Z" />
      <circle cx="8" cy="8" r="2.1" />
    </svg>
  )
}

export function CodeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

export function IconButton({ label, title, onClick, pressed, compact, children }: { label: string; title?: string; onClick: () => void; pressed?: boolean; compact?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      className={`flex ${compact === true ? 'size-7' : 'size-8'} shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
        pressed === true ? 'bg-white/[0.14] text-ink-100' : 'text-ink-300 hover:bg-white/[0.08] hover:text-ink-100'
      }`}
    >
      {children}
    </button>
  )
}

/** Top of the sidebar: the lights' row, with the button that hides the sidebar at its right. */
export function SidebarHeader({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div data-tauri-drag-region className={`flex ${lightsRow} shrink-0 items-center justify-end pr-2.5`}>
      <IconButton label="Hide sidebar" title="Hide sidebar (⌘B)" compact onClick={onCollapse}>
        <SidebarToggleIcon />
      </IconButton>
    </div>
  )
}

/** Shown in place of the sidebar when it is hidden: the lights' row with one button to bring it back. */
export function CollapsedChrome({ onExpand }: { onExpand: () => void }) {
  return (
    <div data-tauri-drag-region className={`motion-fade flex ${lightsRow} shrink-0 items-center ${trafficLightsInset}`}>
      <IconButton label="Show sidebar" title="Show sidebar (⌘B)" compact onClick={onExpand}>
        <SidebarToggleIcon />
      </IconButton>
    </div>
  )
}
