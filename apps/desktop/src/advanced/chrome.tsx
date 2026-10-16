import type { ReactNode } from 'react'

// The window chrome that used to be a top bar, now one row at the top of the sidebar: the band of
// the macOS traffic lights. The Projects header sits under it, sticky at the top of the list.
// tauri.conf.json sets trafficLightPosition { x: 18, y: 24 }. Its y is not the lights' top edge: it
// was tuned in the real window so the lights' centre line sits 22px down, the centre of row 1
// (44px tall), where both sidebar toggles sit too. Its x is the close button's left edge; macOS
// keeps its own button size and spacing, which the constants below restate. These are measured,
// not documented by macOS: confirm them in the real window after any change, and change
// tauri.conf.json and these numbers together.

/** The traffic lights' band: everything in it is vertically centred on the lights. */
export const lightsRow = 'h-[44px]'

/** tauri.conf.json trafficLightPosition.x: the close button's left edge. */
const lightsX = 18
/** A standard window button's frame width, and the step from one button's left edge to the next. */
const lightWidth = 14
const lightStep = 20
/** The clear space between the third light and the first thing beside it. */
const lightsGap = 12

/** Where the traffic lights end, plus the gap: the left inset of anything sharing their row. */
export const trafficLightsInset = lightsX + 2 * lightStep + lightWidth + lightsGap

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

/** Code mode's mark: an editor window with brackets in it. */
export function CodeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M1.5 5.5h13M6.5 7.75 4.75 9.5l1.75 1.75M9.5 7.75l1.75 1.75-1.75 1.75" />
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
    <div data-tauri-drag-region style={{ paddingLeft: trafficLightsInset }} className={`motion-fade flex ${lightsRow} shrink-0 items-center`}>
      <IconButton label="Show sidebar" title="Show sidebar (⌘B)" onClick={onExpand}>
        <SidebarToggleIcon />
      </IconButton>
    </div>
  )
}
