import type { ReactNode } from 'react'
import { useShortcutBindings } from '@/lib/shortcut-store'
import { comboLabel, type ShortcutId } from '@/lib/shortcuts'

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
/** The band's height in pixels, which a panel hung from below stays under so it never covers the lights. */
export const lightsHeight = 44

/** tauri.conf.json trafficLightPosition.x: the close button's left edge. */
const lightsX = 18
/** A standard window button's frame width, and the step from one button's left edge to the next. */
const lightWidth = 14
const lightStep = 20
/** The clear space between the third light and the first thing beside it. */
const lightsGap = 12

/** Where the traffic lights end, plus the gap: the left inset of anything sharing their row. */
export const trafficLightsInset = lightsX + 2 * lightStep + lightWidth + lightsGap

/** The Settings and show-sidebar buttons (size-8 each), the gap between them and the gap after them. */
const expandWidth = 32
const buttonsGap = 4
const expandGap = 12

/** Where a pane header that joins the window row starts: past the lights, Settings and the show-sidebar button. */
export const windowRowInset = trafficLightsInset + 2 * expandWidth + buttonsGap + expandGap

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

/** The Code view's mark: an editor window with brackets in it. */
export function CodeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M1.5 5.5h13M6.5 7.75 4.75 9.5l1.75 1.75M9.5 7.75l1.75 1.75-1.75 1.75" />
    </svg>
  )
}

/** The Knowledge page's mark: topics joined into a small graph. */
export function KnowledgeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4" cy="4.5" r="2" />
      <circle cx="12" cy="6" r="2" />
      <circle cx="6.5" cy="12" r="2" />
      <path d="M5.95 4.9 10.05 5.6M10.7 7.55 7.85 10.5M4.7 6.4l1.1 3.7" />
    </svg>
  )
}

/** The Artifacts page's mark: a stack of two sheets. */
export function ArtifactsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.25" y="1.75" width="9.5" height="10" rx="1.5" />
      <path d="M2.25 4.75v8a1.5 1.5 0 0 0 1.5 1.5h7" />
    </svg>
  )
}

export function TasksIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2.25" width="12" height="11.5" rx="2" />
      <path d="M5.25 5.75 6.25 6.75 8 5M5.25 10 6.25 11 8 9.25M9.75 6h1.5M9.75 10.25h1.5" />
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

/** A button's tooltip with the first keys Settings > Shortcuts gives its shortcut, if any. */
function useShortcutTitle(label: string, id: ShortcutId): string {
  const combo = useShortcutBindings()[id][0]
  return combo === undefined ? label : `${label} (${comboLabel(combo)})`
}

/** Settings and the sidebar's toggle side by side, Settings first: the window row's two buttons. */
function WindowButtons({ sidebarOpen, onSettings, onToggle }: { sidebarOpen: boolean; onSettings: () => void; onToggle: () => void }) {
  const toggleLabel = sidebarOpen ? 'Hide sidebar' : 'Show sidebar'
  const settingsTitle = useShortcutTitle('Settings', 'settings.open')
  const toggleTitle = useShortcutTitle(toggleLabel, 'sidebar.toggle')
  return (
    <div className="flex items-center" style={{ gap: buttonsGap }}>
      <IconButton label="Settings" title={settingsTitle} compact={sidebarOpen} onClick={onSettings}>
        <SettingsIcon />
      </IconButton>
      <IconButton label={toggleLabel} title={toggleTitle} compact={sidebarOpen} onClick={onToggle}>
        <SidebarToggleIcon />
      </IconButton>
    </div>
  )
}

/** Top of the sidebar: the lights' row, with Settings and the button that hides the sidebar at its right. */
export function SidebarHeader({ onCollapse, onSettings }: { onCollapse: () => void; onSettings: () => void }) {
  return (
    <div data-tauri-drag-region className={`flex ${lightsRow} shrink-0 items-center justify-end pr-2.5`}>
      <WindowButtons sidebarOpen onSettings={onSettings} onToggle={onCollapse} />
    </div>
  )
}

/**
 * Shown in place of the sidebar when it is hidden: the lights' band with Settings and the button that
 * brings the sidebar back. With `joined` a pane header shares the band (panes/window-row), so this lies
 * over that header's inset instead of taking a row of its own.
 */
export function CollapsedChrome({ onExpand, onSettings, joined }: { onExpand: () => void; onSettings: () => void; joined: boolean }) {
  return (
    <div
      data-tauri-drag-region
      style={{ paddingLeft: trafficLightsInset, width: joined ? windowRowInset : undefined }}
      className={`motion-fade flex ${lightsRow} shrink-0 items-center ${joined ? 'absolute top-0 left-0 z-50' : ''}`}
    >
      <WindowButtons sidebarOpen={false} onSettings={onSettings} onToggle={onExpand} />
    </div>
  )
}

export function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="4" cy="3.2" r="1.6" />
      <circle cx="4" cy="12.8" r="1.6" />
      <circle cx="12" cy="7.5" r="1.6" />
      <path d="M4 4.8v6.4" />
      <path d="M4 7.5c0 2.5 2 2.5 6.4 2.5" />
    </svg>
  )
}

/** The mark a project or folded worktree shows while a chat in it works (pulsing) or waits for you. */
export function ActivityDot({ state, title }: { state: 'working' | 'waiting'; title: string }) {
  return <span title={title} className={`size-1.5 shrink-0 rounded-full ${state === 'working' ? 'bg-ok shadow-[0_0_8px_#34d399] animate-pulse' : 'bg-warn'}`} />
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition-transform duration-[180ms] ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}
