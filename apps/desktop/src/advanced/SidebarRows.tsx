import { type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import type { NativeChat, ProjectSession, ProjectWorktree } from '@/api/schema'
import { useClock } from '@/lib/clock'
import { relativeAge } from '@/advanced/projects-model'
import { CodeIcon } from '@/advanced/chrome'
import type { MenuItem } from '@/components/ContextMenu'
import { sessionTimer } from '@/advanced/sidebar-model'
import { activityOf } from '@/components/agent-activity'
import { AgentIcon } from '@/components/agent-icons'
import { rowStatus } from '@/native-chat/chat-model'
import { useChatState } from '@/native-chat/live-state'
import { nativeStateLabel } from '@/native-chat/parts'
import { TerminalIcon } from '@/terminal/TerminalIcon'
import { terminalLabel, type AppTerminal } from '@/terminal/terminal-list'
import type { SidebarItemRow } from '@/advanced/item-menus'

/** A worktree's pull request number, in its state's colour; opens that pull request's page. */
export function PullRequestNumber({ pullRequest, color, title, onOpen }: { pullRequest: NonNullable<ProjectWorktree['pullRequest']>; color: string; title: string; onOpen: (() => void) | null }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.()
      }}
      disabled={onOpen === null}
      title={title}
      aria-label={title}
      style={{ color }}
      className={`shrink-0 rounded-full px-1.5 text-[11.5px] leading-6 font-semibold tabular-nums hover:bg-white/[0.08] disabled:cursor-default disabled:hover:bg-transparent ${pillAtRest}`}
    >
      #{pullRequest.number}
    </button>
  )
}

// A row's code and … buttons show on hover, while focus is inside the row, and while its menu is
// open (the row carries data-menu-open then), so they never vanish under the pointer or the keyboard.
// Hidden they take no width, so the name gets the room; a zero-width button can still take focus.
export const rowAction =
  'flex h-6 w-0 shrink-0 items-center justify-center overflow-hidden rounded-full text-ink-300 opacity-0 group-focus-within:w-6 group-focus-within:opacity-100 group-hover:w-6 group-hover:opacity-100 group-data-[menu-open]:w-6 group-data-[menu-open]:opacity-100 hover:bg-white/[0.1] hover:text-ink-100 focus-visible:w-6 focus-visible:opacity-100'

// Hidden, the actions take no width but the row's flex gap before them stays; a negative margin of
// the same size cancels it, so whatever ends the row at rest (a badge, a count, a status dot) sits on
// the row's right padding like the trailing dot of the rows under it.
// A pill button (a count, a pull request number) is padded for its hover; at the end of a row at
// rest its text, not its padding, meets the row's right padding.
export const pillAtRest = '-mr-1.5 group-focus-within:mr-0 group-hover:mr-0 group-data-[menu-open]:mr-0'

export const restingGap = {
  '0.5': '-ml-0.5 group-focus-within:ml-0 group-hover:ml-0 group-data-[menu-open]:ml-0',
  '2': '-ml-2 group-focus-within:ml-0 group-hover:ml-0 group-data-[menu-open]:ml-0',
  '2.5': '-ml-2.5 group-focus-within:ml-0 group-hover:ml-0 group-data-[menu-open]:ml-0',
}

/** The hover actions at the end of a row, kept together so hidden ones leave no gaps; `gap` is the row's. */
export function RowActions({ gap, children }: { gap: keyof typeof restingGap; children: ReactNode }) {
  return <span className={`flex shrink-0 items-center ${restingGap[gap]}`}>{children}</span>
}

/** Opens a worktree in Code; shown on hover like the … button beside it. */
export function CodeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      aria-label={label}
      title={label}
      className={rowAction}
    >
      <CodeIcon />
    </button>
  )
}

/** A chat, session or terminal row dragged toward the main area, to open it in a pane there. */
export type SidebarDrag = SidebarItemRow

/** Starts dragging a row; the drag begins only once the pointer moves, so a plain click still selects. */
export type RowDragger = (event: PointerEvent<HTMLElement>, row: SidebarDrag) => void

/** Opens a row's menu at the pointer (right click) or under the … button. */
export type MenuOpener = (event: MouseEvent<HTMLElement>, items: MenuItem[]) => void

export function MoreButton({ label, onClick }: { label: string; onClick: (event: MouseEvent<HTMLElement>) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      className={rowAction}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <circle cx="3.5" cy="8" r="1.3" />
        <circle cx="8" cy="8" r="1.3" />
        <circle cx="12.5" cy="8" r="1.3" />
      </svg>
    </button>
  )
}

export function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      aria-label={label}
      title={label}
      className={rowAction}
    >
      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  )
}

// On hover a row's age and status dot give their place to its … and its close, at the trailing edge.
export const hiddenOnHover = 'group-focus-within:invisible group-hover:invisible group-data-[menu-open]:invisible'

/** The … and the close of a chat, session or terminal row, over the age and dot they replace on hover. */
export function RowEnd({ label, menuItems, onMenu, onClose }: { label: string; menuItems: MenuItem[]; onMenu: MenuOpener; onClose: (() => void) | null }) {
  if (menuItems.length === 0 && onClose === null) return null
  return (
    <span className="absolute top-1/2 right-0.5 flex -translate-y-1/2 items-center">
      {menuItems.length > 0 && <MoreButton label={`Manage ${label}`} onClick={(event) => onMenu(event, menuItems)} />}
      {onClose !== null && <CloseButton label={`Close ${label}`} onClick={onClose} />}
    </span>
  )
}

export const prStateNames = { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' } as const

export function pullRequestTitle(pullRequest: NonNullable<ProjectWorktree['pullRequest']>, state: keyof typeof prStateNames): string {
  const title = pullRequest.title !== undefined && pullRequest.title !== null && pullRequest.title !== '' ? `${pullRequest.title} · ` : ''
  return `#${pullRequest.number} · ${title}${prStateNames[state]}`
}

export const sessionDot: Record<ProjectSession['status'], string> = {
  working: 'bg-ok shadow-[0_0_8px_#34d399] animate-pulse',
  waiting: 'bg-warn',
  idle: 'bg-ink-400',
  ended: 'bg-ink-600',
}

export const live = (session: ProjectSession) => session.status !== 'ended'

export const timerTone = { green: 'text-ok', yellow: 'text-warn', red: 'text-bad' }

export const timerHelp =
  'Claude keeps its prompt cache for one hour after the last activity; after that the next message re-reads the whole context at full price. ' +
  'Claude also compacts an idle session on its own after about 54 minutes when its context is over its token minimum.'

/** The current time, moved forward every interval while the window shows; the timers count down from it without refetching. */
export function useNow(intervalMs: number): number {
  return useClock(intervalMs)
}

export function TimerChip({ session, now }: { session: ProjectSession; now: number }) {
  const timer = sessionTimer(session, now)
  if (timer === null) return null
  return (
    <span role="img" aria-label={timer.label} title={`${timer.label}. ${timerHelp}`} className={`flex shrink-0 items-center gap-0.5 text-[11px] leading-4 font-medium whitespace-nowrap tabular-nums ${timerTone[timer.tone]}`}>
      <ClockIcon />
      {timer.text}
    </span>
  )
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </svg>
  )
}

/**
 * An agent session under its worktree. Its menu (right click or the … that replaces the age on hover)
 * releases one megabrain owns; one it does not run opens here or closes, which takes it out of the list.
 */
export function SessionRow({ session, selected, now, onSelect, menuItems, onMenu, onClose, onDrag }: { session: ProjectSession; selected: boolean; now: number; onSelect: () => void; menuItems: MenuItem[]; onMenu: MenuOpener; onClose: (() => void) | null; onDrag: RowDragger }) {
  const age = relativeAge(session.lastActivityAt, now)
  const hasMenu = menuItems.length > 0
  const hasEnd = hasMenu || onClose !== null
  return (
    <div className="group relative" onContextMenu={hasMenu ? (event) => onMenu(event, menuItems) : undefined}>
      <button
        type="button"
        onClick={onSelect}
        onPointerDown={(event) => onDrag(event, { kind: 'session', session })}
        aria-current={selected ? 'true' : undefined}
        title={`${session.title} · ${session.agent} · ${session.status}\nDrag into the main area to split it`}
        // The title takes what is left; the time sits in a fixed right-aligned column before the dot, so
        // every row lines up at the right edge, under the Projects header's buttons, timer or not.
        className={`flex h-8 w-full items-center gap-2 rounded-[12px] pr-1.5 pl-[29px] text-left text-[13px] transition-colors ${
          selected ? 'bg-row-selected text-ink-100' : live(session) ? 'text-ink-300 hover:bg-row-hover hover:text-ink-100' : 'text-ink-400 hover:bg-row-hover hover:text-ink-200'
        }`}
      >
        <AgentIcon agent={session.agent} activity={activityOf(session.status)} className="shrink-0 text-ink-300" />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        <TimerChip session={session} now={now} />
        <span className={`w-[30px] shrink-0 text-right text-[11px] whitespace-nowrap text-ink-400 tabular-nums ${hasEnd ? hiddenOnHover : ''}`}>{age}</span>
        <span className={`size-1.5 shrink-0 rounded-full ${sessionDot[session.status]} ${hasEnd ? hiddenOnHover : ''}`} aria-label={session.status} />
      </button>
      <RowEnd label={session.title} menuItems={menuItems} onMenu={onMenu} onClose={onClose} />
    </div>
  )
}

export const noChats: NativeChat[] = []

/**
 * A native chat under its worktree: the same row as a session, with a badge while an approval
 * waits. Its menu (right click or the … that replaces the age on hover) holds Stop.
 */
export function NativeChatRow({ chat: listed, session, selected, now, onSelect, menuItems, onMenu, onClose, onDrag }: { chat: NativeChat; session: ProjectSession | null; selected: boolean; now: number; onSelect: () => void; menuItems: MenuItem[]; onMenu: MenuOpener; onClose: (chat: NativeChat) => void; onDrag: RowDragger }) {
  // An open view's follow knows a turn started before the next poll of the list does.
  const state = useChatState(listed)
  const chat = state === listed.state ? listed : { ...listed, state }
  const status = rowStatus(chat.state)
  const title = chat.title ?? 'New chat'
  return (
    <div className="group relative" onContextMenu={(event) => onMenu(event, menuItems)}>
      <button
        type="button"
        onClick={onSelect}
        onPointerDown={(event) => onDrag(event, { kind: 'native', chat })}
        aria-current={selected ? 'true' : undefined}
        title={`${title} · ${chat.agent} · ${nativeStateLabel[chat.state]}\nDrag into the main area to split it`}
        className={`flex h-8 w-full items-center gap-2 rounded-[12px] pr-1.5 pl-[29px] text-left text-[13px] transition-colors ${
          selected ? 'bg-row-selected text-ink-100' : status !== 'ended' ? 'text-ink-300 hover:bg-row-hover hover:text-ink-100' : 'text-ink-400 hover:bg-row-hover hover:text-ink-200'
        }`}
      >
        <AgentIcon agent={chat.agent} activity={activityOf(chat.state)} className="shrink-0 text-ink-300" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {session !== null && <TimerChip session={session} now={now} />}
        {chat.state === 'waiting-approval' && <span className="shrink-0 rounded-full bg-warn/[0.12] px-1.5 text-[10.5px] leading-4 font-medium text-warn">waiting</span>}
        <span className={`w-[30px] shrink-0 text-right text-[11px] whitespace-nowrap text-ink-400 tabular-nums ${hiddenOnHover}`}>{relativeAge(chat.lastActivityAt ?? chat.createdAt, now)}</span>
        <span className={`size-1.5 shrink-0 rounded-full ${sessionDot[status]} ${hiddenOnHover}`} aria-label={nativeStateLabel[chat.state]} />
      </button>
      <RowEnd label={title} menuItems={menuItems} onMenu={onMenu} onClose={() => onClose(chat)} />
    </div>
  )
}

export const noTerminals: AppTerminal[] = []

const terminalDot: Record<AppTerminal['status'], string> = { starting: 'bg-accent animate-pulse motion-reduce:animate-none', live: 'bg-ok', exited: 'bg-ink-600', failed: 'bg-bad' }
const terminalStatus: Record<AppTerminal['status'], string> = { starting: 'starting', live: 'running', exited: 'exited', failed: 'did not start' }

/**
 * A terminal the app opened, under its worktree: the program or the name given to it, and a dot that
 * is green while it runs. Its menu renames or closes it; renaming turns the row into a field.
 */
export function TerminalRow({
  terminal,
  session,
  now,
  selected,
  renaming,
  onSelect,
  onRename,
  menuItems,
  onMenu,
  onClose,
  onDrag,
}: {
  onClose: () => void
  terminal: AppTerminal
  /** The agent session a terminal resumed from Resume runs, when the projects list reports it. */
  session: ProjectSession | null
  now: number
  onDrag: RowDragger
  selected: boolean
  renaming: boolean
  onSelect: () => void
  /** The new name, or null to stop renaming without one. */
  onRename: (name: string | null) => void
  menuItems: MenuItem[]
  onMenu: MenuOpener
}) {
  const label = terminalLabel(terminal)
  const exitNote = terminal.status === 'exited' && terminal.exitCode !== null ? ` with code ${terminal.exitCode}` : ''
  if (renaming) {
    return (
      <div className="flex h-8 items-center gap-2 rounded-[12px] bg-row-selected pr-1.5 pl-[29px]">
        <TerminalIcon className="shrink-0 text-ink-300" />
        <input
          aria-label={`Rename ${label}`}
          defaultValue={terminal.name ?? ''}
          placeholder={terminal.program}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onRename(event.currentTarget.value)
            if (event.key === 'Escape') onRename(null)
          }}
          onBlur={(event) => onRename(event.currentTarget.value)}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-100 outline-none placeholder:text-ink-400"
        />
      </div>
    )
  }
  return (
    <div className="group relative" onContextMenu={(event) => onMenu(event, menuItems)}>
      <button
        type="button"
        onClick={onSelect}
        onPointerDown={(event) => onDrag(event, { kind: 'terminal', terminal })}
        aria-current={selected ? 'true' : undefined}
        title={`${[label, terminal.engine, terminalStatus[terminal.status]].filter((part) => part !== null).join(' · ')}${exitNote}\n${terminal.cwd}\nDrag into the main area to split it`}
        className={`flex h-8 w-full items-center gap-2 rounded-[12px] pr-1.5 pl-[29px] text-left text-[13px] transition-colors ${
          selected ? 'bg-row-selected text-ink-100' : terminal.status === 'starting' || terminal.status === 'live' ? 'text-ink-300 hover:bg-row-hover hover:text-ink-100' : 'text-ink-400 hover:bg-row-hover hover:text-ink-200'
        }`}
      >
        <TerminalIcon className="shrink-0 text-ink-300" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {session !== null && <TimerChip session={session} now={now} />}
        <span className={`w-[30px] shrink-0 ${hiddenOnHover}`} />
        <span className={`size-1.5 shrink-0 rounded-full ${terminalDot[terminal.status]} ${hiddenOnHover}`} aria-label={terminalStatus[terminal.status]} />
      </button>
      <RowEnd label={label} menuItems={menuItems} onMenu={onMenu} onClose={onClose} />
    </div>
  )
}

