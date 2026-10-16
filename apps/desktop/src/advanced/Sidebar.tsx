import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type { NativeChat, Project, ProjectSession, ProjectWorktree } from '@/api/schema'
import { projectWorktreeRows, relativeAge, sortSessions } from '@/advanced/projects-model'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { dropTarget, moveProject, reconcileOrder, stepProject, type Placement } from '@/advanced/project-order'
import { CodeIcon, PlusIcon } from '@/advanced/chrome'
import { creationsIn, type PendingWorktree } from '@/advanced/new-worktree-model'
import { NewWorktreeDialog } from '@/advanced/NewWorktreeDialog'
import { RowMenu, type MenuItem, type OpenMenu } from '@/advanced/RowMenu'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { FilterMenu, HeaderButton, SearchField, SearchIcon } from '@/advanced/SidebarTools'
import { activeFilterLabels, emptyFilters, filterProjects, hasFilters, parseFilters, partitionHidden, sessionTimer, type HiddenPartition, type SidebarFilters } from '@/advanced/sidebar-model'
import { SidebarSkeleton } from '@/components/Skeleton'
import { ErrorNote, Spinner } from '@/components/ui'
import { AgentIcon } from '@/components/agent-icons'
import { codeTargetFor, type CodeTarget } from '@/code/code-mode-model'
import { countBadge, githubRepository, stateColors, worktreePullRequestState } from '@/github/github-model'
import { IssueIcon, PullRequestIcon } from '@/github/icons'
import { useGithubCounts, type GithubCounts, type GithubKind } from '@/github/useGithubCounts'
import { announceAction } from '@/lib/app-events'
import { useStableCallback } from '@/lib/useStableCallback'
import { ownership } from '@/chat/session-ownership'
import { rowStatus } from '@/native-chat/chat-model'
import { useChatState } from '@/native-chat/live-state'
import { nativeStateLabel } from '@/native-chat/parts'
import { TerminalIcon } from '@/terminal/TerminalIcon'
import { closeNeedsConfirm, terminalLabel, type AppTerminal } from '@/terminal/terminal-list'

const filtersKey = 'megabrain.sidebar.filters'

export function readFilters(): SidebarFilters {
  try {
    return parseFilters(localStorage.getItem(filtersKey))
  } catch {
    return emptyFilters
  }
}

export function writeFilters(filters: SidebarFilters) {
  try {
    localStorage.setItem(filtersKey, JSON.stringify(filters))
  } catch {
    // Remembered filters are a convenience; starting unfiltered is fine.
  }
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem('megabrain.sidebar.collapsed')
    return raw === null ? new Set() : new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

function writeCollapsed(collapsed: Set<string>) {
  try {
    localStorage.setItem('megabrain.sidebar.collapsed', JSON.stringify([...collapsed]))
  } catch {
    // A remembered collapse state is a convenience; starting expanded is fine.
  }
}

/** A worktree's pull request number, in its state's colour; opens that pull request's page. */
function PullRequestNumber({ pullRequest, color, title, onOpen }: { pullRequest: NonNullable<ProjectWorktree['pullRequest']>; color: string; title: string; onOpen: (() => void) | null }) {
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

function BranchIcon() {
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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition-transform ${open ? 'rotate-90' : ''}`}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

// A row's code and … buttons show on hover, while focus is inside the row, and while its menu is
// open (the row carries data-menu-open then), so they never vanish under the pointer or the keyboard.
// Hidden they take no width, so the name gets the room; a zero-width button can still take focus.
const rowAction =
  'flex h-6 w-0 shrink-0 items-center justify-center overflow-hidden rounded-full text-ink-300 opacity-0 group-focus-within:w-6 group-focus-within:opacity-100 group-hover:w-6 group-hover:opacity-100 group-data-[menu-open]:w-6 group-data-[menu-open]:opacity-100 hover:bg-white/[0.1] hover:text-ink-100 focus-visible:w-6 focus-visible:opacity-100'

// Hidden, the actions take no width but the row's flex gap before them stays; a negative margin of
// the same size cancels it, so whatever ends the row at rest (a badge, a count, a status dot) sits on
// the row's right padding like the trailing dot of the rows under it.
// A pill button (a count, a pull request number) is padded for its hover; at the end of a row at
// rest its text, not its padding, meets the row's right padding.
const pillAtRest = '-mr-1.5 group-focus-within:mr-0 group-hover:mr-0 group-data-[menu-open]:mr-0'

const restingGap = {
  '0.5': '-ml-0.5 group-focus-within:ml-0 group-hover:ml-0 group-data-[menu-open]:ml-0',
  '2': '-ml-2 group-focus-within:ml-0 group-hover:ml-0 group-data-[menu-open]:ml-0',
  '2.5': '-ml-2.5 group-focus-within:ml-0 group-hover:ml-0 group-data-[menu-open]:ml-0',
}

/** The hover actions at the end of a row, kept together so hidden ones leave no gaps; `gap` is the row's. */
function RowActions({ gap, children }: { gap: keyof typeof restingGap; children: ReactNode }) {
  return <span className={`flex shrink-0 items-center ${restingGap[gap]}`}>{children}</span>
}

/** Opens a worktree in Code mode; shown on hover like the … button beside it. */
function CodeButton({ label, onClick }: { label: string; onClick: () => void }) {
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
export type SidebarDrag = { kind: 'session'; session: ProjectSession } | { kind: 'native'; chat: NativeChat } | { kind: 'terminal'; terminal: AppTerminal }

/** Starts dragging a row; the drag begins only once the pointer moves, so a plain click still selects. */
export type RowDragger = (event: PointerEvent<HTMLElement>, row: SidebarDrag) => void

/** Opens a row's menu at the pointer (right click) or under the … button. */
type MenuOpener = (event: MouseEvent<HTMLElement>, items: MenuItem[]) => void

function MoreButton({ label, onClick }: { label: string; onClick: (event: MouseEvent<HTMLElement>) => void }) {
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

/** Opens the project's pull request or issue page; the badge is the open count. */
function GithubButton({ kind, label, count, active, last, onClick }: { kind: GithubKind; label: string; count: number | null; active: boolean; last: boolean; onClick: () => void }) {
  const badge = count === null ? null : countBadge(count)
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      aria-label={badge === null ? label : `${label}, ${count} open`}
      title={badge === null ? label : `${label} · ${count} open`}
      aria-pressed={active}
      className={`flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-semibold tabular-nums transition-colors ${active ? 'bg-row-selected text-ink-100' : `text-ink-400 hover:bg-white/[0.08] hover:text-ink-100 ${last ? pillAtRest : ''}`}`}
    >
      {kind === 'prs' ? <PullRequestIcon size={14} /> : <IssueIcon size={14} />}
      {badge !== null && <span className={active ? 'text-ink-200' : 'text-ink-400'}>{badge}</span>}
    </button>
  )
}

const prStateNames = { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' } as const

function pullRequestTitle(pullRequest: NonNullable<ProjectWorktree['pullRequest']>, state: keyof typeof prStateNames): string {
  const title = pullRequest.title !== undefined && pullRequest.title !== null && pullRequest.title !== '' ? `${pullRequest.title} · ` : ''
  return `#${pullRequest.number} · ${title}${prStateNames[state]}`
}

const sessionDot: Record<ProjectSession['status'], string> = {
  working: 'bg-ok shadow-[0_0_8px_#34d399] animate-pulse',
  waiting: 'bg-warn',
  idle: 'bg-ink-400',
  ended: 'bg-ink-600',
}

const live = (session: ProjectSession) => session.status !== 'ended'

const timerTone = { green: 'text-ok', yellow: 'text-warn', red: 'text-bad' }

const timerHelp =
  'Claude keeps its prompt cache for one hour after the last activity; after that the next message re-reads the whole context at full price. ' +
  'Claude also compacts an idle session on its own after about 54 minutes when its context is over its token minimum.'

/** The current time, moved forward every interval; the timers count down from it without refetching. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function TimerChip({ session, now }: { session: ProjectSession; now: number }) {
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
 * An agent session under its worktree. One megabrain owns has a menu (right click or the … that
 * replaces the age on hover) that holds Release; other sessions have none.
 */
function SessionRow({ session, selected, now, onSelect, menuItems, onMenu, onDrag }: { session: ProjectSession; selected: boolean; now: number; onSelect: () => void; menuItems: MenuItem[]; onMenu: MenuOpener; onDrag: RowDragger }) {
  const age = relativeAge(session.lastActivityAt, now)
  const hasMenu = menuItems.length > 0
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
        <AgentIcon agent={session.agent} className="shrink-0 text-ink-300" />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        <TimerChip session={session} now={now} />
        <span className={`w-[30px] shrink-0 text-right text-[11px] whitespace-nowrap text-ink-400 tabular-nums ${hasMenu ? 'group-focus-within:invisible group-hover:invisible group-data-[menu-open]:invisible' : ''}`}>{age}</span>
        <span className={`size-1.5 shrink-0 rounded-full ${sessionDot[session.status]}`} aria-label={session.status} />
      </button>
      {hasMenu && (
        <span className="absolute top-1/2 right-[23px] -translate-y-1/2">
          <MoreButton label={`Manage ${session.title}`} onClick={(event) => onMenu(event, menuItems)} />
        </span>
      )}
    </div>
  )
}

const noChats: NativeChat[] = []

/**
 * A native chat under its worktree: the same row as a session, with a badge while an approval
 * waits. Its menu (right click or the … that replaces the age on hover) holds Stop.
 */
function NativeChatRow({ chat: listed, selected, now, onSelect, menuItems, onMenu, onDrag }: { chat: NativeChat; selected: boolean; now: number; onSelect: () => void; menuItems: MenuItem[]; onMenu: MenuOpener; onDrag: RowDragger }) {
  // An open view's follow knows a turn started before the next poll of the list does.
  const state = useChatState(listed)
  const chat = state === listed.state ? listed : { ...listed, state }
  const status = rowStatus(chat.state)
  const title = chat.title ?? 'New chat'
  const hasMenu = menuItems.length > 0
  return (
    <div className="group relative" onContextMenu={hasMenu ? (event) => onMenu(event, menuItems) : undefined}>
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
        <AgentIcon agent={chat.agent} className="shrink-0 text-ink-300" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {chat.state === 'waiting-approval' && <span className="shrink-0 rounded-full bg-warn/[0.12] px-1.5 text-[10.5px] leading-4 font-medium text-warn">waiting</span>}
        <span className={`w-[30px] shrink-0 text-right text-[11px] whitespace-nowrap text-ink-400 tabular-nums ${hasMenu ? 'group-focus-within:invisible group-hover:invisible group-data-[menu-open]:invisible' : ''}`}>
          {relativeAge(chat.lastActivityAt ?? chat.createdAt, now)}
        </span>
        <span className={`size-1.5 shrink-0 rounded-full ${sessionDot[status]}`} aria-label={nativeStateLabel[chat.state]} />
      </button>
      {hasMenu && (
        <span className="absolute top-1/2 right-[23px] -translate-y-1/2">
          <MoreButton label={`Manage ${title}`} onClick={(event) => onMenu(event, menuItems)} />
        </span>
      )}
    </div>
  )
}

const noTerminals: AppTerminal[] = []

const terminalDot: Record<AppTerminal['status'], string> = { starting: 'bg-accent animate-pulse motion-reduce:animate-none', live: 'bg-ok', exited: 'bg-ink-600', failed: 'bg-bad' }
const terminalStatus: Record<AppTerminal['status'], string> = { starting: 'starting', live: 'running', exited: 'exited', failed: 'did not start' }

/**
 * A terminal the app opened, under its worktree: the program or the name given to it, and a dot that
 * is green while it runs. Its menu renames or closes it; renaming turns the row into a field.
 */
function TerminalRow({
  terminal,
  selected,
  renaming,
  onSelect,
  onRename,
  menuItems,
  onMenu,
  onDrag,
}: {
  terminal: AppTerminal
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
        <span className="w-[30px] shrink-0 group-focus-within:invisible group-hover:invisible group-data-[menu-open]:invisible" />
        <span className={`size-1.5 shrink-0 rounded-full ${terminalDot[terminal.status]}`} aria-label={terminalStatus[terminal.status]} />
      </button>
      <span className="absolute top-1/2 right-[23px] -translate-y-1/2">
        <MoreButton label={`Manage ${label}`} onClick={(event) => onMenu(event, menuItems)} />
      </span>
    </div>
  )
}

/** Starts a native chat in this worktree; shown on hover like the code button beside it. */
function NewChatButton({ label, onClick }: { label: string; onClick: () => void }) {
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
      <PlusIcon />
    </button>
  )
}

function WorktreeRow({
  worktree,
  depth,
  selectedSessionId,
  onSelectSession,
  menuItems,
  chatItems,
  sessionItems,
  onMenu,
  onCode,
  onPullRequest,
  now,
  chats,
  selectedChatId,
  onSelectChat,
  onNewChat,
  terminals,
  terminalRows,
  onDrag,
}: {
  onDrag: RowDragger
  worktree: ProjectWorktree
  depth: number
  /** Terminals the app opened in this worktree. */
  terminals: AppTerminal[]
  terminalRows: TerminalRows
  now: number
  /** Native chats whose folder is in this worktree. */
  chats: NativeChat[]
  selectedChatId: string | null
  onSelectChat: (chat: NativeChat) => void
  onNewChat: (worktreePath: string) => void
  /** Opens the worktree's pull request on the project's pull request page; null without GitHub. */
  onPullRequest: (() => void) | null
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  menuItems: MenuItem[]
  chatItems: (chat: NativeChat) => MenuItem[]
  sessionItems: (session: ProjectSession) => MenuItem[]
  onMenu: MenuOpener
  onCode: () => void
}) {
  const running = worktree.sessions.some(live)
  const name = worktree.branch === null ? `Detached HEAD at ${worktree.head ?? ''}` : worktree.branch
  const prState = worktreePullRequestState(worktree.pullRequest)
  const prColor = prState === null ? null : stateColors[prState]
  return (
    <div style={{ paddingLeft: `${depth * 10}px` }} className="space-y-0.5">
      <div onContextMenu={(event) => onMenu(event, menuItems)} className="group flex h-8 items-center gap-2 rounded-[12px] pr-1.5 pl-[15px] transition-colors hover:bg-row-hover">
        <span style={prColor === null ? undefined : { color: prColor }} className={`shrink-0 ${running ? 'text-ink-300' : 'text-ink-400'}`}>
          <BranchIcon />
        </span>
        <span title={`${name}\n${worktree.path}`} className={`min-w-0 flex-1 truncate text-[13.5px] ${running ? 'font-medium text-ink-100' : 'text-ink-300'}`}>
          {name}
        </span>
        {worktree.primary && <span className="shrink-0 rounded-[6px] bg-white/[0.06] px-1.5 text-[10.5px] leading-4 font-medium text-ink-400">primary</span>}
        {worktree.pullRequest !== null && prState !== null && prColor !== null && (
          <PullRequestNumber pullRequest={worktree.pullRequest} color={prColor} title={pullRequestTitle(worktree.pullRequest, prState)} onOpen={onPullRequest} />
        )}
        <RowActions gap="2">
          <NewChatButton label={`New chat in ${name}`} onClick={() => onNewChat(worktree.path)} />
          <CodeButton label={`Open ${name} in Code`} onClick={onCode} />
          <MoreButton label={`Manage ${name}`} onClick={(event) => onMenu(event, menuItems)} />
        </RowActions>
      </div>
      {chats.map((chat) => (
        <NativeChatRow key={chat.id} chat={chat} selected={chat.id === selectedChatId} now={now} onSelect={() => onSelectChat(chat)} menuItems={chatItems(chat)} onMenu={onMenu} onDrag={onDrag} />
      ))}
      {terminals.map((terminal) => (
        <TerminalRow
          key={terminal.id}
          terminal={terminal}
          selected={terminal.id === terminalRows.selectedId}
          renaming={terminal.id === terminalRows.renamingId}
          onSelect={() => terminalRows.select(terminal)}
          onRename={(name) => terminalRows.rename(terminal, name)}
          menuItems={terminalRows.items(terminal)}
          onMenu={onMenu}
          onDrag={onDrag}
        />
      ))}
      {sortSessions(worktree.sessions).map((session) => (
        <SessionRow key={session.sessionId} session={session} selected={session.sessionId === selectedSessionId} now={now} onSelect={() => onSelectSession(session)} menuItems={sessionItems(session)} onMenu={onMenu} onDrag={onDrag} />
      ))}
    </div>
  )
}

const noCreations: PendingWorktree[] = []

/** What every pending worktree row needs; the same object every render. */
interface CreationRows {
  retry: (id: string) => void
  dismiss: (id: string) => void
}

/**
 * A worktree being created, shown where it will appear: creating while megabrain runs, opening once
 * it answered and the list catches up, and its error with a retry when it failed.
 */
function PendingWorktreeRow({ creation, rows }: { creation: PendingWorktree; rows: CreationRows }) {
  const failed = creation.status === 'failed'
  return (
    <div className="space-y-1">
      <div role="status" aria-busy={!failed} title={`${creation.branch} from ${creation.base}${creation.error === null ? '' : `\n${creation.error}`}`} className="group flex h-8 items-center gap-2 rounded-[12px] pr-1.5 pl-[15px]">
        <span className={`shrink-0 ${failed ? 'text-bad' : 'text-ink-400'}`}>
          <BranchIcon />
        </span>
        <span className={`min-w-0 flex-1 truncate text-[13.5px] ${failed ? 'text-ink-300' : 'text-ink-400'}`}>{creation.branch}</span>
        {failed ? (
          <span className="flex shrink-0 items-center gap-0.5">
            <button type="button" onClick={() => rows.retry(creation.id)} className="rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-ink-200 hover:bg-white/[0.1] hover:text-ink-100">
              Retry
            </button>
            <button type="button" onClick={() => rows.dismiss(creation.id)} aria-label={`Dismiss ${creation.branch}`} title="Dismiss" className="grid size-6 place-items-center rounded-full text-ink-400 hover:bg-white/[0.1] hover:text-ink-100">
              <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-400">
            {creation.status === 'creating' ? 'creating' : 'opening'}
            <Spinner />
          </span>
        )}
      </div>
      {failed && creation.error !== null && <p className="truncate pl-[37px] pr-1.5 text-[11.5px] text-bad select-text">{creation.error}</p>}
    </div>
  )
}

// Memoised with stable callbacks: a status poll or another project's change leaves this row alone.
const ProjectSection = memo(function ProjectSection({
  project,
  collapsed,
  onToggle,
  selectedSessionId,
  onSelectSession,
  actions,
  onMenu,
  now,
  drag,
  dragging,
  edge,
  githubCounts,
  githubActive,
  onGithub,
  chats,
  selectedChatId,
  onSelectChat,
  onNewChat,
  terminals,
  terminalRows,
  onDragRow,
  creations,
  creationRows,
  onNewWorktree,
}: {
  onDragRow: RowDragger
  /** Worktrees being created in this project. */
  creations: PendingWorktree[]
  creationRows: CreationRows
  /** Opens the new worktree dialog for this project. */
  onNewWorktree: (project: Project) => void
  project: Project
  now: number
  /** Terminals by worktree path. */
  terminals: Record<string, AppTerminal[]>
  terminalRows: TerminalRows
  /** Native chats by worktree path. */
  chats: Record<string, NativeChat[]>
  selectedChatId: string | null
  onSelectChat: (chat: NativeChat) => void
  onNewChat: (worktreePath: string) => void
  drag: ProjectDrag
  /** This row is the one being dragged. */
  dragging: boolean
  /** Where a dragged project would land against this row. */
  edge: Placement | null
  /** This project's open counts; undefined until read. */
  githubCounts: GithubCounts[string] | undefined
  /** The GitHub page of this project showing in the main area, if any. */
  githubActive: GithubKind | null
  onGithub: (project: Project, kind: GithubKind, focus?: number) => void
  collapsed: boolean
  onToggle: (name: string) => void
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  actions: RowActions
  onMenu: MenuOpener
}) {
  const projectItems = actions.project(project)
  if (project.missing) {
    return (
      <section
        data-project-path={project.path}
        onContextMenu={(event) => onMenu(event, projectItems)}
        onPointerDown={(event) => drag.start(event, project.path)}
        className={`group relative flex h-9 items-center gap-2.5 rounded-[12px] pr-1.5 pl-2.5 select-none hover:bg-row-hover ${dragging ? 'opacity-50' : ''}`}
        title={`${project.name}\n${project.path}`}
      >
        {edge !== null && <DropLine edge={edge} />}
        <ProjectPicture project={project} />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink-400">{project.name}</h2>
        <span className="shrink-0 text-[11px] text-ink-400">folder missing</span>
        <RowActions gap="2.5">
          <MoreButton label={`Manage ${project.name}`} onClick={(event) => onMenu(event, projectItems)} />
        </RowActions>
      </section>
    )
  }
  const rows = projectWorktreeRows(project)
  const running = project.worktrees.reduce((count, worktree) => count + worktree.sessions.filter(live).length, 0)
  return (
    <section data-project-path={project.path} className={`relative space-y-1 ${dragging ? 'opacity-50' : ''}`}>
      {edge !== null && <DropLine edge={edge} />}
      <div onContextMenu={(event) => onMenu(event, projectItems)} onPointerDown={(event) => drag.start(event, project.path)} className="group flex items-center gap-0.5 rounded-[12px] pr-1.5 transition-colors select-none hover:bg-row-hover">
        <button
          type="button"
          data-project-toggle={project.path}
          onClick={() => onToggle(project.name)}
          onKeyDown={(event) => drag.key(event, project.path)}
          aria-expanded={!collapsed}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          title={`${project.name}\n${project.path}\nDrag or press ⌥↑ ⌥↓ to reorder`}
          className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-2.5 text-left"
        >
          <ProjectPicture project={project} />
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{project.name}</h2>
          {collapsed && running > 0 && (
            <span title={`${running} running`} className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-ink-400 tabular-nums">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-ok" />
              {running}
            </span>
          )}
        </button>
        <RowActions gap="0.5">
          <NewChatButton label={`New worktree in ${project.name}`} onClick={() => onNewWorktree(project)} />
        </RowActions>
        {githubRepository(project.remote) !== null && (
          <>
            <GithubButton kind="prs" label={`${project.name} pull requests`} count={githubCounts?.prs ?? null} active={githubActive === 'prs'} last={false} onClick={() => onGithub(project, 'prs')} />
            <GithubButton kind="issues" label={`${project.name} issues`} count={githubCounts?.issues ?? null} active={githubActive === 'issues'} last onClick={() => onGithub(project, 'issues')} />
          </>
        )}
        <RowActions gap="0.5">
          <MoreButton label={`Manage ${project.name}`} onClick={(event) => onMenu(event, projectItems)} />
        </RowActions>
      </div>
      {!collapsed && (
        <div className="space-y-1">
          {rows.map(({ worktree, depth }) => (
            <WorktreeRow
              key={worktree.path}
              worktree={worktree}
              depth={depth}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              menuItems={actions.worktree(project, worktree)}
              chatItems={actions.chat}
              sessionItems={actions.session}
              onMenu={onMenu}
              onCode={() => actions.code(codeTargetFor(project, worktree))}
              onPullRequest={githubRepository(project.remote) === null || worktree.pullRequest === null ? null : () => onGithub(project, 'prs', worktree.pullRequest?.number)}
              now={now}
              chats={chats[worktree.path] ?? noChats}
              selectedChatId={selectedChatId}
              onSelectChat={onSelectChat}
              onNewChat={onNewChat}
              terminals={terminals[worktree.path] ?? noTerminals}
              terminalRows={terminalRows}
              onDrag={onDragRow}
            />
          ))}
          {creations.map((creation) => (
            <PendingWorktreeRow key={creation.id} creation={creation} rows={creationRows} />
          ))}
        </div>
      )}
    </section>
  )
})

/** The line that shows where a dragged project lands. */
function DropLine({ edge }: { edge: Placement }) {
  return <span aria-hidden="true" className={`pointer-events-none absolute right-2 left-2 h-0.5 rounded-full bg-accent ${edge === 'before' ? '-top-1' : '-bottom-1'}`} />
}

/** What a project row needs to be dragged or moved with the keyboard; the same object every render. */
interface ProjectDrag {
  start: (event: PointerEvent<HTMLElement>, path: string) => void
  key: (event: KeyboardEvent<HTMLElement>, path: string) => void
}

/** The release that ends a drag must not also toggle or open the row it lands on. */
function swallowNextClick() {
  const swallow = (event: globalThis.MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

/** What every terminal row needs; one object per change of selection or rename, so rows stay memoised. */
interface TerminalRows {
  selectedId: string | null
  renamingId: string | null
  select: (terminal: AppTerminal) => void
  rename: (terminal: AppTerminal, name: string | null) => void
  items: (terminal: AppTerminal) => MenuItem[]
}

interface RowActions {
  code: (target: CodeTarget) => void
  project: (project: Project) => MenuItem[]
  worktree: (project: Project, worktree: ProjectWorktree) => MenuItem[]
  chat: (chat: NativeChat) => MenuItem[]
  session: (session: ProjectSession) => MenuItem[]
}

const worktreeName = (worktree: ProjectWorktree) => worktree.branch ?? `Detached HEAD at ${worktree.head ?? ''}`

function HiddenSection({ hidden, onShow }: { hidden: HiddenPartition; onShow: (target: { project: string } | { worktree: string }) => void }) {
  const [open, setOpen] = useState(false)
  const count = hidden.hiddenProjects.length + hidden.hiddenWorktrees.length
  if (count === 0) return null
  const row = (key: string, label: string, detail: string | null, target: { project: string } | { worktree: string }) => (
    <li key={key} className="group flex h-8 items-center gap-2 rounded-[12px] pr-1.5 pl-2.5 transition-colors hover:bg-row-hover">
      <span className="min-w-0 truncate text-[13px] text-ink-300">{label}</span>
      {detail !== null && <span className="shrink-0 truncate text-[11.5px] text-ink-400">{detail}</span>}
      <button type="button" onClick={() => onShow(target)} className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-ink-300 hover:bg-white/[0.1] hover:text-ink-100">
        Show
      </button>
    </li>
  )
  return (
    <section className="space-y-1 border-t border-white/[0.07] pt-3">
      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} className="flex h-8 w-full items-center gap-2 rounded-[12px] pr-1.5 pl-2.5 text-left text-[13px] font-semibold text-ink-400 transition-colors hover:text-ink-200">
        <Chevron open={open} />
        Hidden
        <span className="ml-auto text-[11px] font-medium tabular-nums">{count}</span>
      </button>
      {open && (
        <ul className="space-y-0.5">
          {hidden.hiddenProjects.map((project) => row(`p:${project.path}`, project.name, 'project', { project: project.path }))}
          {hidden.hiddenWorktrees.map(({ project, worktree }) => row(`w:${worktree.path}`, worktreeName(worktree), project.name, { worktree: worktree.path }))}
        </ul>
      )}
    </section>
  )
}

// Every project the person works on, main checkout first with its worktrees and their stacks
// (see stack-model.ts), and the agent sessions running in each. Each project and worktree has a
// menu (right click or …) to hide it, remove it or open its code; hidden ones wait at the bottom.
export const Sidebar = memo(function Sidebar({
  loaded,
  projects,
  selectedSessionId,
  onSelectSession,
  onCode,
  onQuickView,
  onImport,
  order,
  onReorder,
  filters,
  onFilters,
  activeGithub,
  onGithub,
  chats,
  selectedChatId,
  onSelectChat,
  onNewChat,
  onNewTerminal,
  terminals,
  selectedTerminalId,
  onSelectTerminal,
  onRenameTerminal,
  onCloseTerminal,
  onDragRow,
  creations,
  onCreateWorktree,
  onRetryCreation,
  onDismissCreation,
}: {
  /** Worktrees being created, shown as pending rows under their project. */
  creations: PendingWorktree[]
  onCreateWorktree: (project: Project, branch: string, base: string) => void
  onRetryCreation: (id: string) => void
  onDismissCreation: (id: string) => void
  /** A chat, session or terminal row dragged toward the main area. */
  onDragRow: RowDragger
  /** Opens a new terminal in a worktree. */
  onNewTerminal: (worktreePath: string) => void
  /** Terminals the app opened, by worktree path. */
  terminals: Record<string, AppTerminal[]>
  selectedTerminalId: string | null
  onSelectTerminal: (terminal: AppTerminal) => void
  onRenameTerminal: (terminal: AppTerminal, name: string) => void
  /** Ends the terminal; asked first here while it may still run. */
  onCloseTerminal: (terminal: AppTerminal) => Promise<void>
  /** Native chats by worktree path. */
  chats: Record<string, NativeChat[]>
  selectedChatId: string | null
  onSelectChat: (chat: NativeChat) => void
  /** Opens the new chat sheet for a worktree. */
  onNewChat: (worktreePath: string) => void
  /** The first projects read has answered; until then an empty list is still loading. */
  loaded: boolean
  projects: Project[]
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  /** Opens a root in Code mode, the embedded VS Code. */
  onCode: (target: CodeTarget) => void
  /** The read-only file browser, without VS Code. */
  onQuickView: (target: CodeTarget) => void
  onImport: () => void
  /** The saved project order (paths), and where a drag or ⌥↑ ⌥↓ sends the new one. */
  order: string[]
  onReorder: (order: string[]) => void
  filters: SidebarFilters
  onFilters: (filters: SidebarFilters) => void
  /** The GitHub page showing in the main area, if any. */
  activeGithub: { path: string; kind: GithubKind } | null
  /** Opens a project's pull request or issue page. */
  onGithub: (project: Project, kind: GithubKind, focus?: number) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [newWorktreeFor, setNewWorktreeFor] = useState<Project | null>(null)
  const openNewWorktree = useStableCallback((project: Project) => setNewWorktreeFor(project))
  const retryCreation = useStableCallback(onRetryCreation)
  const dismissCreation = useStableCallback(onDismissCreation)
  const creationRows = useMemo<CreationRows>(() => ({ retry: retryCreation, dismiss: dismissCreation }), [retryCreation, dismissCreation])
  // One list per project, so a creation elsewhere leaves the other memoised rows alone.
  const creationsByProject = useMemo(() => Object.fromEntries(projects.flatMap((project) => {
    const list = creationsIn(creations, project.path)
    return list.length === 0 ? [] : [[project.path, list]]
  })), [projects, creations])
  const [actionError, setActionError] = useState<unknown>(null)
  const partition = useMemo(() => partitionHidden(projects), [projects])
  const closeMenu = useCallback(() => setMenu(null), [])
  const now = useNow(30_000)
  const visible = useMemo(() => filterProjects(partition.visible, filters), [partition, filters])
  const githubCounts = useGithubCounts(partition.visible)
  const filtered = hasFilters(filters)
  const [searchOpen, setSearchOpen] = useState(filters.query !== '')
  const searchRef = useRef<HTMLInputElement>(null)
  const searching = filters.query.trim() !== ''
  const openSearch = () => {
    setSearchOpen(true)
    searchRef.current?.focus()
  }
  const toggle = useCallback((name: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      writeCollapsed(next)
      return next
    })
  }, [])

  const navRef = useRef<HTMLElement>(null)
  // The Projects header sits above the list on the sidebar's own glass, like the Settings footer
  // below it: no tint or blur of its own, which inside the glass would stack a second, darker layer.
  // Rows that scroll up fade out under its edge, and a hairline shows once they do.
  const [scrolled, setScrolled] = useState(false)
  const [dragState, setDragState] = useState<{ path: string; target: { path: string; placement: Placement } | null } | null>(null)
  // Starting from every listed project keeps hidden and not-yet-ordered ones where they are.
  const fullOrder = () => reconcileOrder(order, projects.map((project) => project.path))
  const dropRows = () =>
    [...(navRef.current?.querySelectorAll<HTMLElement>('[data-project-path]') ?? [])].map((element) => {
      const rect = element.getBoundingClientRect()
      return { path: element.dataset.projectPath ?? '', top: rect.top, bottom: rect.bottom }
    })

  const dragStart = useStableCallback((event: PointerEvent<HTMLElement>, path: string) => {
    if (event.button !== 0) return
    const startY = event.clientY
    let moving = false
    const onMove = (move: globalThis.PointerEvent) => {
      if (!moving && Math.abs(move.clientY - startY) < 4) return
      moving = true
      setDragState({ path, target: dropTarget(dropRows(), move.clientY) })
    }
    const onUp = (up: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      if (!moving) return
      swallowNextClick()
      setDragState(null)
      const target = dropTarget(dropRows(), up.clientY)
      if (target !== null && target.path !== path) onReorder(moveProject(fullOrder(), path, target.path, target.placement))
    }
    const onCancel = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setDragState(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  })
  const dragKey = useStableCallback((event: KeyboardEvent<HTMLElement>, path: string) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const current = fullOrder()
    const next = stepProject(current, visible.map((project) => project.path), path, event.key === 'ArrowUp' ? -1 : 1)
    if (next === current) return
    onReorder(next)
    // Moving the row re-inserts it in the list, which drops focus; give it back.
    requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>(`[data-project-toggle="${CSS.escape(path)}"]`)?.focus())
  })
  const drag = useMemo<ProjectDrag>(() => ({ start: dragStart, key: dragKey }), [dragStart, dragKey])
  const edgeOf = (path: string) => (dragState?.target?.path === path && dragState.target.path !== dragState.path ? dragState.target.placement : null)

  // The row whose menu is open keeps its actions visible; see rowAction.
  const menuRow = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const row = menuRow.current
    if (menu === null || row === null) return
    row.dataset.menuOpen = ''
    return () => {
      delete row.dataset.menuOpen
    }
  }, [menu])

  const openMenu: MenuOpener = useCallback((event, items) => {
    event.preventDefault()
    event.stopPropagation()
    menuRow.current = event.currentTarget.closest<HTMLElement>('.group')
    // A right click opens at the pointer; the … button opens the menu under itself.
    if (event.type === 'contextmenu') {
      setMenu({ anchor: { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY }, gap: 0, items })
      return
    }
    const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect()
    setMenu({ anchor: { left, top, right, bottom }, gap: 4, items })
  }, [])

  const setHidden = useCallback((target: { project: string } | { worktree: string }, hidden: boolean) => {
    setActionError(null)
    api.setHidden(target, hidden).catch(setActionError)
  }, [])

  const actions = useMemo<RowActions>(() => ({
    code: onCode,
    project: (project) => [
      { label: 'Open Code', onSelect: () => onCode(codeTargetFor(project)) },
      { label: 'Quick view', onSelect: () => onQuickView(codeTargetFor(project)) },
      { label: 'Hide', onSelect: () => setHidden({ project: project.path }, true) },
      {
        label: 'Remove from megabrain…',
        danger: true,
        onSelect: () =>
          setConfirm({
            title: `Remove ${project.name} from megabrain?`,
            body: `megabrain stops listing this project. The folder and its files stay where they are (${project.path}); import it again with + to bring it back.`,
            action: 'Remove',
            run: () => api.removeProject(project.path),
          }),
      },
    ],
    worktree: (project, worktree) => {
      const name = worktreeName(worktree)
      const items: MenuItem[] = [
        { label: 'New terminal', onSelect: () => onNewTerminal(worktree.path) },
        { label: 'Open Code', onSelect: () => onCode(codeTargetFor(project, worktree)) },
        { label: 'Quick view', onSelect: () => onQuickView(codeTargetFor(project, worktree)) },
        { label: 'Hide', onSelect: () => setHidden({ worktree: worktree.path }, true) },
      ]
      // The main checkout is the project itself; it is removed with the project, not as a worktree.
      if (!worktree.primary) {
        items.push({
          label: 'Remove worktree…',
          danger: true,
          onSelect: () =>
            setConfirm({
              title: `Remove ${name}?`,
              body: `This deletes the folder ${worktree.path} and the branch ${worktree.branch ?? '(detached)'} from ${project.name}. megabrain refuses when the branch has work that is not merged, and nothing is deleted then.`,
              action: 'Remove worktree',
              run: () => api.removeWorktree(worktree.path),
            }),
        })
      }
      return items
    },
    chat: (chat) => {
      if (rowStatus(chat.state) === 'ended') return []
      const title = chat.title ?? 'New chat'
      return [
        {
          label: 'Stop chat…',
          danger: true,
          onSelect: () =>
            setConfirm({
              title: `Stop ${title}?`,
              body: 'The agent ends its turn and megabrain closes the conversation. Its history stays readable.',
              action: 'Stop chat',
              run: () => api.stopChat(chat.id).then(announceAction),
            }),
        },
      ]
    },
    session: (session) => {
      if (!ownership(session).owned) return []
      return [
        {
          label: 'Release from megabrain…',
          danger: true,
          onSelect: () =>
            setConfirm({
              title: `Release ${session.title}?`,
              body: 'megabrain stops owning this session and closes its tmux session, which ends the agent running there. The conversation stays on disk and can be resumed again.',
              action: 'Release',
              run: () => api.releaseSession(session.sessionId),
            }),
        },
      ]
    },
  }), [onCode, onQuickView, setHidden, onNewTerminal])

  const [renamingTerminal, setRenamingTerminal] = useState<string | null>(null)
  const terminalRows = useMemo<TerminalRows>(() => ({
    selectedId: selectedTerminalId,
    renamingId: renamingTerminal,
    select: onSelectTerminal,
    rename: (terminal, name) => {
      setRenamingTerminal(null)
      if (name !== null) onRenameTerminal(terminal, name)
    },
    items: (terminal) => [
      { label: 'Rename…', onSelect: () => setRenamingTerminal(terminal.id) },
      {
        label: 'Close terminal…',
        danger: true,
        onSelect: () => {
          if (!closeNeedsConfirm(terminal)) {
            onCloseTerminal(terminal).catch(setActionError)
            return
          }
          setConfirm({
            title: `Close ${terminalLabel(terminal)}?`,
            body:
              terminal.engine === 'tmux'
                ? 'The app lets go of this terminal. Its tmux session keeps running on megabrain\'s tmux server, but the app does not list it again.'
                : 'Its process may still be running. Closing the terminal ends it.',
            action: 'Close terminal',
            run: () => onCloseTerminal(terminal),
          })
        },
      },
    ],
  }), [selectedTerminalId, renamingTerminal, onSelectTerminal, onRenameTerminal, onCloseTerminal])

  return (
    <nav
      ref={navRef}
      className="relative flex min-h-0 flex-1 flex-col"
      aria-label="Projects"
      onKeyDown={(event) => {
        if (!event.metaKey || event.key.toLowerCase() !== 'f' || partition.visible.length === 0) return
        event.preventDefault()
        openSearch()
      }}
    >
      <div className={`shrink-0 space-y-2 border-b px-2.5 py-2 transition-colors ${scrolled ? 'border-white/[0.07]' : 'border-transparent'}`}>
        <div className="flex items-center justify-between pr-1.5 pl-2.5">
          <h3 className="text-[13px] font-semibold tracking-[-0.005em] text-ink-300">Projects</h3>
          <span className="flex items-center gap-0.5">
            {partition.visible.length > 0 && (
              <>
                <HeaderButton label="Search (⌘F)" on={searching} expanded={searchOpen} keepFocus onClick={() => (searchOpen && filters.query === '' ? setSearchOpen(false) : openSearch())}>
                  <SearchIcon />
                </HeaderButton>
                <FilterMenu filters={filters} onFilters={onFilters} />
              </>
            )}
            <button type="button" onClick={onImport} aria-label="Import project" title="Import project" className="flex size-7 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-white/[0.08] hover:text-ink-100">
              <PlusIcon />
            </button>
          </span>
        </div>
        {searchOpen && partition.visible.length > 0 && <SearchField inputRef={searchRef} query={filters.query} onQuery={(query) => onFilters({ ...filters, query })} onClose={() => setSearchOpen(false)} />}
      </div>
      {/* The gutter the scrollbar keeps (6px) plus pr-1 matches the header's px-2.5, so rows and header actions share one right edge. */}
      <div onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)} className={`sidebar-scroll min-h-0 flex-1 space-y-4 overflow-y-auto pt-1 pr-1 pb-6 pl-2.5 ${scrolled ? 'sidebar-fade' : ''}`}>
        {actionError !== null && (
          <div className="px-1">
            <ErrorNote error={actionError} />
          </div>
        )}
        {!loaded && projects.length === 0 && <SidebarSkeleton />}
        {visible.map((project) => (
          <ProjectSection
            key={project.name}
            project={project}
            collapsed={collapsed.has(project.name)}
            onToggle={toggle}
            selectedSessionId={selectedSessionId}
            onSelectSession={onSelectSession}
            actions={actions}
            onMenu={openMenu}
            now={now}
            drag={drag}
            dragging={dragState?.path === project.path}
            edge={edgeOf(project.path)}
            githubCounts={githubCounts[project.path]}
            githubActive={activeGithub?.path === project.path ? activeGithub.kind : null}
            onGithub={onGithub}
            chats={chats}
            selectedChatId={selectedChatId}
            onSelectChat={onSelectChat}
            onNewChat={onNewChat}
            terminals={terminals}
            terminalRows={terminalRows}
            onDragRow={onDragRow}
            creations={creationsByProject[project.path] ?? noCreations}
            creationRows={creationRows}
            onNewWorktree={openNewWorktree}
          />
        ))}
        {filtered && visible.length === 0 && partition.visible.length > 0 && (
          <div className="mx-1 rounded-[18px] border border-dashed border-white/[0.12] px-4 py-5 text-center">
            <p className="text-[13.5px] text-ink-300">Nothing matches {activeFilterLabels(filters).join(' + ')}.</p>
            <button
              type="button"
              onClick={() => {
                onFilters(emptyFilters)
                setSearchOpen(false)
              }}
              className="mt-2 rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
              Clear filters
            </button>
          </div>
        )}
        {projects.length === 0 && loaded && (
          <div className="mx-1 rounded-[18px] border border-dashed border-white/[0.12] px-4 py-5 text-center">
            <p className="text-[13.5px] text-ink-300">No projects yet.</p>
            <button type="button" onClick={onImport} className="mt-2 rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
              Import a project
            </button>
          </div>
        )}
        <HiddenSection hidden={partition} onShow={(target) => setHidden(target, false)} />
      </div>
      {menu !== null && <RowMenu menu={menu} onClose={closeMenu} />}
      {confirm !== null && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
      {newWorktreeFor !== null && (
        <NewWorktreeDialog
          project={newWorktreeFor}
          taken={creations.filter((item) => item.repo === newWorktreeFor.path && item.status !== 'failed').map((item) => item.branch)}
          onCreate={(branch, base) => {
            setNewWorktreeFor(null)
            // The pending row shows under the project, so a folded project opens.
            if (collapsed.has(newWorktreeFor.name)) toggle(newWorktreeFor.name)
            onCreateWorktree(newWorktreeFor, branch, base)
          }}
          onClose={() => setNewWorktreeFor(null)}
        />
      )}
    </nav>
  )
})
