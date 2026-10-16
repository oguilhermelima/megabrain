import { useCallback, useState, type MouseEvent } from 'react'
import type { Project } from '@/api/schema'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { Logo } from '@/components/ui'
import { lightsRow } from '@/advanced/chrome'
import { CodeSwitcher } from '@/code/CodeSwitcher'
import { usePresence } from '@/lib/usePresence'
import { railEntries, type CodeModeState, type CodeTarget } from '@/code/code-mode-model'

/** A list of chats: three lines, each led by a bubble dot. */
function ChatListIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M6 4h7.5M6 8h7.5M6 12h7.5" />
      <circle cx="2.75" cy="4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.75" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.75" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** A toothed gear: the sidebar's rayed settings icon read as a sun once it stood alone here. */
function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.9 1.5h2.2l.35 1.75 1.2.5 1.5-1 1.55 1.55-1 1.5.5 1.2 1.75.35v2.2l-1.75.35-.5 1.2 1 1.5-1.55 1.55-1.5-1-1.2.5-.35 1.75H6.9l-.35-1.75-1.2-.5-1.5 1-1.55-1.55 1-1.5-.5-1.2L1.05 9.1V6.9l1.75-.35.5-1.2-1-1.5L3.85 2.3l1.5 1 1.2-.5z" />
      <circle cx="8" cy="8" r="2.1" />
    </svg>
  )
}

function OpenProjectIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5v7.5h12V5.5H7.5L6 3.5H2.5z" />
      <path d="M8 7v4M6 9h4" />
    </svg>
  )
}

const railButton = 'flex size-10 shrink-0 items-center justify-center rounded-[12px] text-ink-300 transition-colors hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-accent'

/** The picture of a root no registered project holds any more: its initial on a neutral tile. */
function Initial({ title }: { title: string }) {
  return <span aria-hidden="true" className="grid size-6 place-items-center rounded-[8px] bg-white/[0.1] text-[11px] font-bold text-ink-200">{title.slice(0, 1).toUpperCase()}</span>
}

// The sidebar folded to a rail while Code mode fills the window: wide enough for the macOS
// traffic lights above it, then the logo and the way back to chats, each open root (newest first,
// its repository and branch under its picture) and the button that opens another one.
export function CodeRail({
  state,
  projects,
  onSelect,
  onClose,
  onChats,
  onSettings,
}: {
  state: CodeModeState
  projects: Project[]
  onSelect: (target: CodeTarget) => void
  /** Closes a root's VS Code and stops its server. */
  onClose: (root: string) => void
  onChats: () => void
  onSettings: () => void
}) {
  const [switcher, setSwitcher] = useState<DOMRect | null>(null)
  const closeSwitcher = useCallback(() => setSwitcher(null), [])
  const switcherMenu = usePresence(switcher)
  const toggleSwitcher = (event: MouseEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    setSwitcher((current) => (current === null ? box : null))
  }

  return (
    <nav aria-label="Code mode" className="glass flex w-[96px] shrink-0 flex-col items-center border-r border-white/[0.06] pb-3">
      <div data-tauri-drag-region className={`${lightsRow} w-full shrink-0`} />
      <button type="button" onClick={onChats} aria-label="Back to chats" title="Back to chats (⌘⇧E)" tabIndex={-1} className="mb-2 shrink-0 rounded-full">
        <Logo className="size-6" />
      </button>
      <button type="button" onClick={onChats} aria-label="Back to chats" title="Back to chats (⌘⇧E)" className={railButton}>
        <ChatListIcon />
      </button>
      <div className="my-3 h-px w-8 shrink-0 bg-white/[0.08]" />
      <ul className="sidebar-scroll flex min-h-0 w-full flex-1 flex-col items-center gap-1">
        {railEntries(state, projects).map((entry) => (
          <li key={entry.root} className="group relative w-full px-2">
            {entry.active && <span aria-hidden="true" className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-accent" />}
            <button
              type="button"
              onClick={() => onSelect({ root: entry.root, title: entry.title })}
              aria-label={entry.tooltip.replaceAll('\n', ', ')}
              aria-current={entry.active ? 'true' : undefined}
              title={entry.tooltip}
              className={`flex w-full flex-col items-center gap-1 rounded-[12px] px-1 pt-2 pb-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-accent ${entry.active ? 'bg-white/[0.14] text-ink-100' : 'text-ink-300 hover:bg-white/[0.08] hover:text-ink-100'}`}
            >
              <span className="relative">
                {entry.project === null ? <Initial title={entry.title} /> : <ProjectPicture project={entry.project} />}
                {entry.badge !== null && (
                  <span aria-hidden="true" className="absolute -right-2 -bottom-1.5 rounded-[5px] border border-ink-900 bg-ink-700 px-[3px] text-[8.5px] leading-[12px] font-bold text-ink-100">
                    {entry.badge}
                  </span>
                )}
              </span>
              <span className="flex w-full min-w-0 flex-col items-center">
                <span className="w-full truncate text-center text-[11px] leading-[14px] font-semibold">{entry.name}</span>
                {entry.branch !== null && <span className="w-full truncate text-center text-[10px] leading-[13px] text-ink-400">{entry.branch}</span>}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onClose(entry.root)}
              aria-label={`Close ${entry.title}`}
              title={`Close ${entry.title} and stop its VS Code`}
              className="absolute -top-1 right-0.5 flex size-[18px] items-center justify-center rounded-full border border-white/[0.12] bg-ink-800 text-ink-300 opacity-0 group-hover:opacity-100 hover:text-ink-100 focus-visible:opacity-100"
            >
              <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            // Its own mousedown would close the open switcher just before this click reopens it.
            onMouseDown={(event) => event.stopPropagation()}
            onClick={toggleSwitcher}
            aria-label="Open project"
            title="Open project"
            aria-haspopup="dialog"
            aria-expanded={switcher !== null}
            className={railButton}
          >
            <OpenProjectIcon />
          </button>
        </li>
      </ul>
      <button type="button" onClick={onSettings} aria-label="Settings" title="Settings (⌘,)" className={railButton}>
        <GearIcon />
      </button>
      {switcherMenu.shown !== null && <CodeSwitcher anchor={switcherMenu.shown} projects={projects} active={state.active} leaving={switcherMenu.leaving} onSelect={onSelect} onClose={closeSwitcher} />}
    </nav>
  )
}
