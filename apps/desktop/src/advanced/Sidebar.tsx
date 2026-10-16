import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type { NativeChat, Project, ProjectSession, ProjectWorktree } from '@/api/schema'
import { relativeAge } from '@/advanced/projects-model'
import { memberStatus, memberStatusLabel, stackActions, stackChain, visibleTree, worktreeTree, type MemberStatus, type StackAction, type StackDetail, type StackPlace, type WorktreeNode } from '@/advanced/stacks'
import { useStackDetails, type StackDetails } from '@/advanced/useStackDetails'
import { projectColor } from '@/advanced/picture-model'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { displayName, projectTint } from '@/advanced/appearance-model'
import { archiveDone, archiveFailed, beginArchive, beginRestore, reconcileArchives, restoreDone, restoreFailed, withoutArchived, type ArchiveMap, type ArchiveTarget } from '@/advanced/archive-model'
import { dropTarget, type Placement } from '@/advanced/project-order'
import { createFolder, deleteFolder, folderOf, layoutDropTarget, moveEntry, moveToFolder, renameFolder, sidebarEntries, stepEntry, toggleFolder, type DropPlacement, type LayoutRow, type SidebarFolder, type SidebarLayout } from '@/advanced/sidebar-folders'
import { CodeIcon, PlusIcon } from '@/advanced/chrome'
import { creationsIn, type PendingWorktree } from '@/advanced/new-worktree-model'
import { NewWorktreeDialog } from '@/advanced/NewWorktreeDialog'
import { applyRowOrder, moveRow, parseRowOrder, saveRowOrder, worktreeItems, type KeyedItem, type RowOrder } from '@/advanced/row-model'
import { ContextMenu, menuFrom, openMenuFromKeyboard, type MenuItem, type OpenMenu } from '@/components/ContextMenu'
import { Collapse } from '@/components/Collapse'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { Toast, type ToastMessage } from '@/components/Toast'
import { FilterMenu, HeaderButton, SearchField, SearchIcon } from '@/advanced/SidebarTools'
import { activeFilterLabels, emptyFilters, filterProjects, hasFilters, parseFilters, partitionHidden, sessionTimer, type HiddenPartition, type SidebarFilters } from '@/advanced/sidebar-model'
import { SidebarSkeleton } from '@/components/Skeleton'
import { ErrorNote, Spinner } from '@/components/ui'
import { activityOf } from '@/components/agent-activity'
import { AgentIcon, AgentTint } from '@/components/agent-icons'
import { codeTargetFor, type CodeTarget } from '@/code/code-mode-model'
import { countBadge, githubRepository, stateColors, worktreePullRequestState } from '@/github/github-model'
import { IssueIcon, PullRequestIcon } from '@/github/icons'
import { useGithubCounts, type GithubCounts, type GithubKind } from '@/github/useGithubCounts'
import { announceAction } from '@/lib/app-events'
import { insideRoots } from '@/lib/external'
import { useStableCallback } from '@/lib/useStableCallback'
import { useFlip } from '@/advanced/useFlip'
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

const rowOrderKey = 'megabrain.sidebar.rows'

function readRowOrder(): RowOrder {
  try {
    return parseRowOrder(localStorage.getItem(rowOrderKey))
  } catch {
    return {}
  }
}

function writeRowOrder(order: RowOrder) {
  try {
    localStorage.setItem(rowOrderKey, saveRowOrder(order))
  } catch {
    // Without storage the order lasts for this run.
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
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition-transform duration-[180ms] ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>
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

function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
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
const hiddenOnHover = 'group-focus-within:invisible group-hover:invisible group-data-[menu-open]:invisible'

/** The … and the close of a chat, session or terminal row, over the age and dot they replace on hover. */
function RowEnd({ label, menuItems, onMenu, onClose }: { label: string; menuItems: MenuItem[]; onMenu: MenuOpener; onClose: (() => void) | null }) {
  if (menuItems.length === 0 && onClose === null) return null
  return (
    <span className="absolute top-1/2 right-0.5 flex -translate-y-1/2 items-center">
      {menuItems.length > 0 && <MoreButton label={`Manage ${label}`} onClick={(event) => onMenu(event, menuItems)} />}
      {onClose !== null && <CloseButton label={`Close ${label}`} onClick={onClose} />}
    </span>
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
function SessionRow({ session, selected, now, onSelect, menuItems, onMenu, onClose, onDrag }: { session: ProjectSession; selected: boolean; now: number; onSelect: () => void; menuItems: MenuItem[]; onMenu: MenuOpener; onClose: (() => void) | null; onDrag: RowDragger }) {
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

const noChats: NativeChat[] = []

/**
 * A native chat under its worktree: the same row as a session, with a badge while an approval
 * waits. Its menu (right click or the … that replaces the age on hover) holds Stop.
 */
function NativeChatRow({ chat: listed, session, selected, now, onSelect, menuItems, onMenu, onClose, onDrag }: { chat: NativeChat; session: ProjectSession | null; selected: boolean; now: number; onSelect: () => void; menuItems: MenuItem[]; onMenu: MenuOpener; onClose: (chat: NativeChat) => void; onDrag: RowDragger }) {
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

const noTerminals: AppTerminal[] = []

const terminalDot: Record<AppTerminal['status'], string> = { starting: 'bg-accent animate-pulse motion-reduce:animate-none', live: 'bg-ok', exited: 'bg-ink-600', failed: 'bg-bad' }
const terminalStatus: Record<AppTerminal['status'], string> = { starting: 'starting', live: 'running', exited: 'exited', failed: 'did not start' }

/**
 * A terminal the app opened, under its worktree: the program or the name given to it, and a dot that
 * is green while it runs. Its menu renames or closes it; renaming turns the row into a field.
 */
function TerminalRow({
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

// The colour of a stack member's status word; plain open and draft stay quiet beside the PR number.
const memberTone: Record<MemberStatus, string> = {
  draft: 'text-ink-400',
  open: 'text-ink-400',
  approved: 'text-ok',
  'changes-requested': 'text-warn',
  merged: 'text-ink-400',
  closed: 'text-ink-400',
  'checks-failing': 'text-bad',
}

/** A stack member's place, its pull request's word and a quiet mark when its parent moved on. */
function StackMarks({ place, status, needsSync, busy }: { place: StackPlace; status: MemberStatus | null; needsSync: boolean; busy: string | null }) {
  if (busy !== null) {
    return (
      <span role="status" className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-400">
        {busy}
        <Spinner />
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] leading-4 tabular-nums">
      {needsSync && (
        <span title="Its parent has commits this branch lacks; Sync stack rebases it" aria-label="needs sync" className="text-ink-400">
          ↻
        </span>
      )}
      {status !== null && status !== 'open' && status !== 'draft' && <span className={memberTone[status]}>{memberStatusLabel[status]}</span>}
      <span title={`Branch ${place.position} of ${place.total} in this stack${place.forked ? '; the stack forks' : ''}`} className="text-ink-400">
        {place.position}/{place.total}
      </span>
    </span>
  )
}

function WorktreeRow({
  worktree,
  place,
  detail,
  busy,
  fold,
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
  rows: rowControls,
}: {
  onDrag: RowDragger
  /** Closing, ordering and dragging the rows; the same object while nothing about them changes. */
  rows: ItemRows
  worktree: ProjectWorktree
  /** Its place in a stack; null outside one. */
  place: StackPlace | null
  /** What `stack show` adds for this branch, once read. */
  detail: StackDetail | undefined
  /** A stack action running from this row ("syncing"), or null. */
  busy: string | null
  /** Folds the branches stacked on this one; null without any. */
  fold: { open: boolean; toggle: () => void } | null
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
  const shown = applyRowOrder(worktreeItems(chats, terminals, worktree.sessions), rowControls.order[worktree.path] ?? [])
  const keys = shown.map((item) => item.key)
  const renderItem = (item: KeyedItem, drag: RowDragger) => {
    if (item.kind === 'native') {
      const { chat } = item
      return <NativeChatRow chat={chat} session={item.session} selected={chat.id === selectedChatId} now={now} onSelect={() => onSelectChat(chat)} menuItems={chatItems(chat)} onMenu={onMenu} onClose={(live) => rowControls.close({ kind: 'native', chat: live })} onDrag={drag} />
    }
    if (item.kind === 'terminal') {
      const { terminal } = item
      return (
        <TerminalRow
          terminal={terminal}
          session={item.session}
          now={now}
          selected={terminal.id === terminalRows.selectedId}
          renaming={terminal.id === terminalRows.renamingId}
          onSelect={() => terminalRows.select(terminal)}
          onRename={(name) => terminalRows.rename(terminal, name)}
          menuItems={terminalRows.items(terminal)}
          onMenu={onMenu}
          onClose={() => rowControls.close({ kind: 'terminal', terminal })}
          onDrag={drag}
        />
      )
    }
    const { session } = item
    return (
      <SessionRow
        session={session}
        selected={session.sessionId === selectedSessionId}
        now={now}
        onSelect={() => onSelectSession(session)}
        menuItems={sessionItems(session)}
        onMenu={onMenu}
        onClose={ownership(session).owned ? () => rowControls.close({ kind: 'session', session }) : null}
        onDrag={drag}
      />
    )
  }
  const name = worktree.branch === null ? `Detached HEAD at ${worktree.head ?? ''}` : worktree.branch
  const prState = worktreePullRequestState(worktree.pullRequest)
  const prColor = prState === null ? null : stateColors[prState]
  const member = memberStatus(worktree.pullRequest, detail)
  return (
    <div className="space-y-0.5">
      <div onContextMenu={(event) => onMenu(event, menuItems)} className="group relative flex h-8 items-center gap-2 rounded-[12px] pr-1.5 pl-[15px] transition-colors hover:bg-row-hover">
        {fold !== null && (
          <button
            type="button"
            onClick={fold.toggle}
            aria-expanded={fold.open}
            aria-label={`${fold.open ? 'Fold' : 'Unfold'} the branches stacked on ${name}`}
            title={`${fold.open ? 'Fold' : 'Unfold'} the branches stacked on this one`}
            className="absolute top-1/2 left-0 flex size-4 -translate-y-1/2 items-center justify-center rounded-full text-ink-400 hover:text-ink-100"
          >
            <Chevron open={fold.open} />
          </button>
        )}
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
        {place !== null && <StackMarks place={place} status={member.status} needsSync={member.needsSync} busy={busy} />}
        <RowActions gap="2">
          <NewChatButton label={`New chat in ${name}`} onClick={() => onNewChat(worktree.path)} />
          <CodeButton label={`Open ${name} in Code`} onClick={onCode} />
          <MoreButton label={`Manage ${name}`} onClick={(event) => onMenu(event, menuItems)} />
        </RowActions>
      </div>
      <div data-worktree-rows={worktree.path} className="space-y-0.5">
        {shown.map((item) => {
          const drag: RowDragger = (event, row) => {
            onDrag(event, row)
            rowControls.start(event, worktree.path, item.key, keys)
          }
          return (
            <div key={item.key} data-row-key={item.key} className={`sidebar-row-in relative ${rowControls.dragging === item.key ? 'opacity-50' : ''}`}>
              {rowControls.edge?.key === item.key && <DropLine edge={rowControls.edge.placement} />}
              {renderItem(item, drag)}
            </div>
          )
        })}
      </div>
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
  itemRows,
  creations,
  creationRows,
  onNewWorktree,
  listed,
  stacks,
}: {
  /** The project as megabrain lists it, hidden and filtered worktrees included, so stack positions count every branch. */
  listed: Project
  stacks: StackRows
  onDragRow: RowDragger
  itemRows: ItemRows
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
  edge: DropPlacement | null
  /** This project's open counts; undefined until read. */
  githubCounts: GithubCounts[string] | undefined
  /** The GitHub page of this project showing in the main area, if any. */
  githubActive: GithubKind | null
  onGithub: (project: Project, kind: GithubKind, focus?: number) => void
  collapsed: boolean
  /** Folds or unfolds the project by its path. */
  onToggle: (path: string) => void
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  actions: RowActions
  onMenu: MenuOpener
}) {
  if (project.missing) {
    return (
      <section
        data-entry-key={project.path}
        onContextMenu={(event) => onMenu(event, actions.project(project))}
        onPointerDown={(event) => drag.start(event, project.path)}
        className={`group relative flex h-9 items-center gap-2.5 rounded-[12px] pr-1.5 pl-2.5 select-none hover:bg-row-hover ${dragging ? 'opacity-50' : ''}`}
        title={`${displayName(project)}\n${project.path}`}
      >
        {edge !== null && <DropLine edge={edge} />}
        <ProjectPicture project={project} />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink-400">{displayName(project)}</h2>
        <span className="shrink-0 text-[11px] text-ink-400">folder missing</span>
        <RowActions gap="2.5">
          <MoreButton label={`Manage ${displayName(project)}`} onClick={(event) => onMenu(event, actions.project(project))} />
        </RowActions>
      </section>
    )
  }
  const shownPaths = new Set(project.worktrees.map((worktree) => worktree.path))
  const tree = worktreeTree(listed)
  const nodes = visibleTree(tree, (worktree) => shownPaths.has(worktree.path))
  const details = stacks.details[project.path]
  // A stack nests under its base: a line runs from each parent's branch icon down to its last child's,
  // with a tick into each child; a parent folds the branches stacked on it.
  const renderNodes = (list: WorktreeNode[]): ReactNode =>
    list.map((node, index) => {
      const { worktree } = node
      const foldKey = `stack:${worktree.path}`
      const open = !stacks.folded.has(foldKey)
      const last = index === list.length - 1
      return (
        <div key={worktree.path} className="relative">
          {node.place !== null && node.place.position > 1 && (
            <>
              <span aria-hidden="true" className={`pointer-events-none absolute -top-1 left-[8px] w-px bg-white/[0.14] ${last ? 'h-5' : 'bottom-0'}`} />
              <span aria-hidden="true" className="pointer-events-none absolute top-4 left-[8px] h-px w-[6px] bg-white/[0.14]" />
            </>
          )}
          <div className="relative">
            {node.children.length > 0 && open && <span aria-hidden="true" className="pointer-events-none absolute top-[26px] bottom-0 left-[22px] w-px bg-white/[0.14]" />}
            <WorktreeRow
              worktree={worktree}
              place={node.place}
              detail={worktree.branch === null ? undefined : details?.[worktree.branch]}
              busy={stacks.busy[worktree.path] ?? null}
              fold={node.children.length === 0 ? null : { open, toggle: () => stacks.fold(foldKey) }}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              menuItems={actions.worktree(project, node, tree)}
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
              rows={itemRows}
            />
          </div>
          {node.children.length > 0 && (
            <Collapse open={open}>
              <div className="relative space-y-1 pt-1 pl-[14px]">{renderNodes(node.children)}</div>
            </Collapse>
          )}
        </div>
      )
    })
  const running = project.worktrees.reduce((count, worktree) => count + worktree.sessions.filter(live).length, 0)
  return (
    <section data-entry-key={project.path} className={`relative ${dragging ? 'opacity-50' : ''}`}>
      {edge !== null && <DropLine edge={edge} />}
      <div onContextMenu={(event) => onMenu(event, actions.project(project))} onPointerDown={(event) => drag.start(event, project.path)} className="group flex items-center gap-0.5 rounded-[12px] pr-1.5 transition-colors select-none hover:bg-row-hover">
        <button
          type="button"
          data-entry-toggle={project.path}
          onClick={() => onToggle(project.path)}
          onKeyDown={(event) => drag.key(event, project.path)}
          aria-expanded={!collapsed}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          title={`${displayName(project)}\n${project.path}\nDrag or press ⌥↑ ⌥↓ to reorder`}
          className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-2.5 text-left"
        >
          <ProjectPicture project={project} />
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{displayName(project)}</h2>
          {collapsed && running > 0 && (
            <span title={`${running} running`} className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-ink-400 tabular-nums">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-ok" />
              {running}
            </span>
          )}
        </button>
        <RowActions gap="0.5">
          <NewChatButton label={`New worktree in ${displayName(project)}`} onClick={() => onNewWorktree(project)} />
        </RowActions>
        {githubRepository(project.remote) !== null && (
          <>
            <GithubButton kind="prs" label={`${displayName(project)} pull requests`} count={githubCounts?.prs ?? null} active={githubActive === 'prs'} last={false} onClick={() => onGithub(project, 'prs')} />
            <GithubButton kind="issues" label={`${displayName(project)} issues`} count={githubCounts?.issues ?? null} active={githubActive === 'issues'} last onClick={() => onGithub(project, 'issues')} />
          </>
        )}
        <RowActions gap="0.5">
          <MoreButton label={`Manage ${displayName(project)}`} onClick={(event) => onMenu(event, actions.project(project))} />
        </RowActions>
      </div>
      <Collapse open={!collapsed}>
        {/* The project's colour reaches only the agent marks of its chats and sessions. */}
        <AgentTint.Provider value={projectTint(project)}>
          <div className="space-y-1 pt-1">
            {renderNodes(nodes)}
            {creations.map((creation) => (
              <PendingWorktreeRow key={creation.id} creation={creation} rows={creationRows} />
            ))}
          </div>
        </AgentTint.Provider>
      </Collapse>
    </section>
  )
})

/** The line that shows where a dragged project or folder lands; dropping into a folder rings its header. */
function DropLine({ edge }: { edge: DropPlacement }) {
  if (edge === 'into') return <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[12px] ring-2 ring-accent ring-inset" />
  return <span aria-hidden="true" className={`pointer-events-none absolute right-2 left-2 h-0.5 rounded-full bg-accent ${edge === 'before' ? '-top-1' : '-bottom-1'}`} />
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {open ? <path d="M1.8 4.2c0-.6.4-1 1-1h3.1l1.4 1.5h5.1c.6 0 1 .4 1 1v.8H4.6c-.5 0-.9.3-1 .7L1.8 12.3Zm1.9 2.9c.1-.4.5-.6.9-.6h9.6c.6 0 1 .6.8 1.1l-1.4 4.2c-.1.4-.5.7-1 .7H2.8" /> : <path d="M1.8 4.2c0-.6.4-1 1-1h3.1l1.4 1.5h5.9c.6 0 1 .4 1 1v6.1c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" />}
    </svg>
  )
}

/** A folder's tile: the size and tint of a project's letter badge, so the two kinds of row line up. */
function FolderTile({ folder, open }: { folder: SidebarFolder; open: boolean }) {
  return (
    <span aria-hidden="true" style={{ backgroundColor: projectColor(folder.name) }} className="grid size-6 shrink-0 place-items-center rounded-[8px] text-white">
      <FolderIcon open={open} />
    </span>
  )
}

/**
 * A folder the person made to group projects: its header folds it, renames inline, drags among the
 * projects at the top level and takes projects dropped on it; its projects sit under it.
 */
function FolderSection({
  folder,
  count,
  renaming,
  onStartRename,
  onRename,
  onToggle,
  drag,
  dragging,
  edge,
  menuItems,
  onMenu,
  children,
}: {
  folder: SidebarFolder
  /** Projects shown in it. */
  count: number
  renaming: boolean
  onStartRename: () => void
  /** The new name, or null to stop renaming without one. */
  onRename: (name: string | null) => void
  onToggle: () => void
  drag: ProjectDrag
  dragging: boolean
  edge: DropPlacement | null
  menuItems: MenuItem[]
  onMenu: MenuOpener
  children: ReactNode
}) {
  const open = !folder.collapsed
  return (
    <section data-folder-id={folder.id} className={`relative ${dragging ? 'opacity-50' : ''}`}>
      <div
        data-entry-key={folder.id}
        data-entry-folder=""
        data-entry-open={open ? '' : undefined}
        onContextMenu={renaming ? undefined : (event) => onMenu(event, menuItems)}
        onPointerDown={renaming ? undefined : (event) => drag.start(event, folder.id)}
        className="group relative flex items-center gap-0.5 rounded-[12px] pr-1.5 transition-colors select-none hover:bg-row-hover"
      >
        {edge !== null && <DropLine edge={edge} />}
        {renaming ? (
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-2.5">
            <FolderTile folder={folder} open={open} />
            <input
              aria-label={`Rename ${folder.name}`}
              defaultValue={folder.name}
              maxLength={200}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onRename(event.currentTarget.value)
                if (event.key === 'Escape') onRename(null)
              }}
              onBlur={(event) => onRename(event.currentTarget.value)}
              className="min-w-0 flex-1 bg-transparent text-[15px] font-semibold tracking-[-0.01em] text-ink-100 outline-none"
            />
          </div>
        ) : (
          <button
            type="button"
            data-entry-toggle={folder.id}
            onClick={onToggle}
            onDoubleClick={onStartRename}
            onKeyDown={(event) => drag.key(event, folder.id)}
            aria-expanded={open}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            title={`${folder.name}\nDrag or press ⌥↑ ⌥↓ to reorder; drop projects on it to group them`}
            className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-2.5 text-left"
          >
            <FolderTile folder={folder} open={open} />
            <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{folder.name}</h2>
            <span title={`${count} ${count === 1 ? 'project' : 'projects'}`} className="shrink-0 text-[11px] font-medium text-ink-400 tabular-nums">
              {count}
            </span>
          </button>
        )}
        {!renaming && (
          <RowActions gap="0.5">
            <MoreButton label={`Manage ${folder.name}`} onClick={(event) => onMenu(event, menuItems)} />
          </RowActions>
        )}
      </div>
      <Collapse open={open}>
        <div className="space-y-1 pt-1 pl-3">{children}</div>
      </Collapse>
    </section>
  )
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

/** What every chat, session and terminal row needs to close and be reordered; one object per change. */
interface ItemRows {
  close: (row: SidebarDrag) => void
  /** Each worktree's saved row order. */
  order: RowOrder
  /** The row being dragged, and where it would land. */
  dragging: string | null
  edge: { key: string; placement: Placement } | null
  start: (event: PointerEvent<HTMLElement>, worktreePath: string, key: string, shown: string[]) => void
}

/** What the stacked rows need: details read from `stack show`, folds, and actions running; one object per change. */
interface StackRows {
  details: StackDetails
  folded: ReadonlySet<string>
  fold: (key: string) => void
  /** A running stack action's word by worktree path. */
  busy: Record<string, string>
}

interface RowActions {
  code: (target: CodeTarget) => void
  project: (project: Project) => MenuItem[]
  /** `tree` is the project's whole worktree tree, which a stack action reads its chain from. */
  worktree: (project: Project, node: WorktreeNode, tree: WorktreeNode[]) => MenuItem[]
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
      <Collapse open={open}>
        <ul className="space-y-0.5 pt-1">
          {hidden.hiddenProjects.map((project) => row(`p:${project.path}`, displayName(project), 'project', { project: project.path }))}
          {hidden.hiddenWorktrees.map(({ project, worktree }) => row(`w:${worktree.path}`, worktreeName(worktree), displayName(project), { worktree: worktree.path }))}
        </ul>
      </Collapse>
    </section>
  )
}

// Every project the person works on, main checkout first with its worktrees and their stacks
// (see stacks.ts), and the agent sessions running in each. Each project and worktree has a
// menu (right click or …) to hide it, remove it or open its code; hidden ones wait at the bottom.
export const Sidebar = memo(function Sidebar({
  loaded,
  loadError,
  onRetryLoad,
  projects,
  selectedSessionId,
  onSelectSession,
  onCode,
  onImport,
  layout,
  onLayout,
  layoutError,
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
  onCloseRow,
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
  /** Closes a chat, terminal or session row, asking first about what still runs; rejects with megabrain's refusal. */
  onCloseRow: (row: SidebarDrag) => Promise<void>
  /** Native chats by worktree path. */
  chats: Record<string, NativeChat[]>
  selectedChatId: string | null
  onSelectChat: (chat: NativeChat) => void
  /** Opens the new chat sheet for a worktree. */
  onNewChat: (worktreePath: string) => void
  /** The first projects read has answered; until then an empty list is still loading. */
  loaded: boolean
  /** The last projects read's error; shown with Retry while nothing has loaded yet. */
  loadError: unknown
  onRetryLoad: () => void
  projects: Project[]
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  /** Opens a root in Code mode, the embedded VS Code. */
  onCode: (target: CodeTarget) => void
  onImport: () => void
  /** The folders and top-level order, reconciled with the listed projects; drags, ⌥↑ ⌥↓ and the folder menus send the next one. */
  layout: SidebarLayout
  onLayout: (layout: SidebarLayout) => void
  /** Why the folders could not be read or saved, if so. */
  layoutError: unknown
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
  // The new worktree dialog: from the project's +, or on a branch to stack on it.
  const [newWorktreeFor, setNewWorktreeFor] = useState<{ project: Project; base?: string } | null>(null)
  const openNewWorktree = useStableCallback((project: Project) => setNewWorktreeFor({ project }))
  const retryCreation = useStableCallback(onRetryCreation)
  const dismissCreation = useStableCallback(onDismissCreation)
  const creationRows = useMemo<CreationRows>(() => ({ retry: retryCreation, dismiss: dismissCreation }), [retryCreation, dismissCreation])
  // One list per project, so a creation elsewhere leaves the other memoised rows alone.
  const creationsByProject = useMemo(() => Object.fromEntries(projects.flatMap((project) => {
    const list = creationsIn(creations, project.path)
    return list.length === 0 ? [] : [[project.path, list]]
  })), [projects, creations])
  const [actionError, setActionError] = useState<unknown>(null)
  // Branches being archived leave the list at once (archive-model.ts); the toast offers Undo.
  const [archives, setArchives] = useState<ArchiveMap>({})
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const closeToast = useCallback(() => setToast(null), [])
  useEffect(() => setArchives((current) => reconcileArchives(current, projects)), [projects])
  const shownProjects = useMemo(() => withoutArchived(projects, archives), [projects, archives])
  const partition = useMemo(() => partitionHidden(shownProjects), [shownProjects])
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
  // Projects fold by path (two can share a name); stacks fold by `stack:<worktree path>`.
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      writeCollapsed(next)
      return next
    })
  }, [])

  const navRef = useRef<HTMLElement>(null)
  // The Projects header sits above the list on the sidebar's own glass, like the Settings footer
  // below it: no tint or blur of its own, which inside the glass would stack a second, darker layer.
  // Rows that scroll up fade out under its edge, and a hairline shows once they do.
  const [scrolled, setScrolled] = useState(false)
  // The list keeps a scrollbar gutter the header has not got; the header pads by the measured width,
  // so its right edge is the list's whatever width the webview gives the scrollbar (6px, or 0 when
  // it overlays).
  const listRef = useRef<HTMLDivElement>(null)
  const [gutter, setGutter] = useState(6)
  useLayoutEffect(() => {
    const list = listRef.current
    if (list !== null) setGutter(list.offsetWidth - list.clientWidth)
  }, [])
  // Rows that change place slide there (useFlip); every layout change goes through here.
  const captureRows = useFlip(navRef)
  const applyLayout = (next: SidebarLayout) => {
    captureRows()
    onLayout(next)
  }
  // A project or a folder being dragged, and where it would land.
  const [dragState, setDragState] = useState<{ key: string; target: { key: string; placement: DropPlacement } | null } | null>(null)
  // Every project and folder header on screen, in order; a project inside a folder names it.
  const dropRows = (): LayoutRow[] =>
    [...(navRef.current?.querySelectorAll<HTMLElement>('[data-entry-key]') ?? [])].map((element) => {
      const rect = element.getBoundingClientRect()
      const folder = element.dataset.entryFolder !== undefined
      const parent = folder ? null : (element.parentElement?.closest<HTMLElement>('[data-folder-id]')?.dataset.folderId ?? null)
      return { key: element.dataset.entryKey ?? '', parent, folder, open: element.dataset.entryOpen !== undefined, top: rect.top, bottom: rect.bottom }
    })

  const dragStart = useStableCallback((event: PointerEvent<HTMLElement>, path: string) => {
    if (event.button !== 0) return
    const startY = event.clientY
    let moving = false
    const onMove = (move: globalThis.PointerEvent) => {
      if (!moving && Math.abs(move.clientY - startY) < 4) return
      moving = true
      setDragState({ key: path, target: layoutDropTarget(dropRows(), move.clientY, path) })
    }
    const onUp = (up: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      if (!moving) return
      swallowNextClick()
      setDragState(null)
      const target = layoutDropTarget(dropRows(), up.clientY, path)
      if (target !== null) applyLayout(moveEntry(layout, path, target))
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
    const next = stepEntry(layout, path, event.key === 'ArrowUp' ? -1 : 1, new Set(visible.map((project) => project.path)))
    if (next === layout) return
    applyLayout(next)
    // Moving the row re-inserts it in the list, which drops focus; give it back.
    requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>(`[data-entry-toggle="${CSS.escape(path)}"]`)?.focus())
  })
  const drag = useMemo<ProjectDrag>(() => ({ start: dragStart, key: dragKey }), [dragStart, dragKey])
  const edgeOf = (key: string) => (dragState?.target?.key === key ? dragState.target.placement : null)

  // Folders: made from the header's + menu or a project's menu, renamed in place, removed after a confirm.
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const newFolder = useStableCallback((project?: string) => {
    const id = `folder-${crypto.randomUUID()}`
    applyLayout(createFolder(layout, id, 'New folder', project))
    setRenamingFolder(id)
  })
  const renameTo = (id: string, name: string | null) => {
    setRenamingFolder(null)
    if (name !== null) applyLayout(renameFolder(layout, id, name))
  }
  const folderItems = (folder: SidebarFolder): MenuItem[] => [
    { label: 'Rename…', icon: 'rename', group: 'organise', onSelect: () => setRenamingFolder(folder.id) },
    {
      label: 'Delete folder…',
      icon: 'trash',
      group: 'danger',
      onSelect: () =>
        setConfirm({
          title: `Delete ${folder.name}?`,
          body: folder.projects.length === 0 ? 'The folder is empty; nothing else changes.' : 'Its projects move back to the top level of the sidebar, where the folder was. Nothing on disk changes.',
          action: 'Delete folder',
          run: async () => applyLayout(deleteFolder(layout, folder.id)),
        }),
    },
  ]
  const moveItems = useStableCallback((project: Project): MenuItem[] => {
    const current = folderOf(layout, project.path)
    return [
      ...layout.folders.filter((folder) => folder.id !== current?.id).map((folder): MenuItem => ({ label: `Move to ${folder.name}`, icon: 'folder', group: 'organise', onSelect: () => applyLayout(moveToFolder(layout, project.path, folder.id)) })),
      { label: 'Move to new folder', icon: 'newFolder', group: 'organise', onSelect: () => newFolder(project.path) },
      ...(current === null ? [] : [{ label: `Move out of ${current.name}`, icon: 'moveOut', group: 'organise', onSelect: () => applyLayout(moveToFolder(layout, project.path, null)) } satisfies MenuItem]),
    ]
  })

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
    setMenu(menuFrom(event, items))
  }, [])

  const setHidden = useCallback((target: { project: string } | { worktree: string }, hidden: boolean) => {
    setActionError(null)
    api.setHidden(target, hidden).catch(setActionError)
  }, [])

  const closeRow = useStableCallback((row: SidebarDrag) => {
    setActionError(null)
    onCloseRow(row).catch(setActionError)
  })

  // Stacks: review, checks and behind counts read in the background, folds kept with the other
  // collapses, and one running action per row shown on it until megabrain answers.
  const { details: stackDetails, forget: forgetStack } = useStackDetails(partition.visible)
  const [stackBusy, setStackBusy] = useState<Record<string, string>>({})
  const runStack = useStableCallback((project: Project, worktree: ProjectWorktree, verb: 'sync' | 'pr' | 'merge', word: string, draft: boolean = false): Promise<void> => {
    const branch = worktree.branch
    if (branch === null) return Promise.resolve()
    setActionError(null)
    setStackBusy((current) => ({ ...current, [worktree.path]: word }))
    const done = () => {
      forgetStack(project.path)
      setStackBusy((current) => {
        const next = { ...current }
        delete next[worktree.path]
        return next
      })
    }
    return api.stackRun(project.path, branch, verb, { draft }).then(done, (caught: unknown) => {
      done()
      throw caught
    })
  })
  const stackItem = useStableCallback((project: Project, worktree: ProjectWorktree, action: StackAction): MenuItem => {
    const branch = worktree.branch ?? ''
    const chainOf = () => stackChain(worktreeTree(projects.find((item) => item.path === project.path) ?? project), worktree.path)
    switch (action.kind) {
      case 'new-stacked':
        return { label: 'New stacked branch…', icon: 'stack', group: 'git', onSelect: () => setNewWorktreeFor({ project, base: branch }) }
      case 'sync':
        return {
          label: 'Sync stack…',
          icon: 'sync',
          group: 'git',
          onSelect: () => {
            const names = chainOf()?.members.flatMap((member) => (member.branch === null ? [] : [member.branch])) ?? [branch]
            setConfirm({
              title: 'Sync this stack?',
              body: `Each branch is rebased on its parent and pushed with --force-with-lease, bottom-up: ${names.join(', then ')}. A conflict stops the sync and names the files.`,
              action: 'Sync stack',
              tone: 'primary',
              run: () => runStack(project, worktree, 'sync', 'syncing'),
            })
          },
        }
      case 'pr':
        return {
          label: action.draft ? 'Open draft PRs for stack' : 'Open PRs for stack',
          icon: 'pullRequest',
          group: 'git',
          onSelect: () => void runStack(project, worktree, 'pr', 'opening PRs', action.draft).catch(setActionError),
        }
      case 'merge':
        return {
          label: 'Merge stack…',
          icon: 'merge',
          group: 'git',
          onSelect: () =>
            setConfirm({
              title: 'Merge this stack?',
              body: `The pull requests merge bottom-up, in this order: ${action.pullRequests.map((pull) => `#${pull.number} ${pull.branch}`).join(', then ')}. megabrain refuses when a branch has commits that are not pushed.`,
              action: 'Merge stack',
              run: () => runStack(project, worktree, 'merge', 'merging'),
            }),
        }
      case 'show-github':
        return { label: 'Show on GitHub', icon: 'external', group: 'open', onSelect: () => onGithub(project, 'prs', worktree.pullRequest?.number) }
    }
  })

  const restore = useStableCallback((target: ArchiveTarget) => {
    setActionError(null)
    setArchives((current) => beginRestore(current, target))
    api.unarchiveWorktree(target.repo, target.branch).then(
      () => setArchives((current) => restoreDone(current, target.path)),
      (caught: unknown) => {
        setArchives((current) => restoreFailed(current, target.path))
        setActionError(caught)
      },
    )
  })
  // Runs inside the confirm, so a refusal shows there with megabrain's reasons and Archive anyway.
  const archive = useStableCallback((target: ArchiveTarget, confirm: PendingConfirm, force: boolean): Promise<void> => {
    setArchives((current) => beginArchive(current, target))
    return api.archiveWorktree(target.path, { force }).then(
      () => {
        setArchives((current) => archiveDone(current, target.path))
        setToast({ id: `${target.path}:${Date.now()}`, text: `Archived ${target.branch}`, action: { label: 'Undo', run: () => restore(target) } })
      },
      (caught: unknown) => {
        setArchives((current) => archiveFailed(current, target.path))
        if (!force) setConfirm({ ...confirm, alternative: { label: 'Archive anyway', run: () => archive(target, confirm, true) } })
        throw caught
      },
    )
  })
  const confirmArchive = useStableCallback((project: Project, worktree: ProjectWorktree) => {
    const branch = worktree.branch
    if (branch === null) return
    const target: ArchiveTarget = { repo: project.path, branch, path: worktree.path }
    const confirm: PendingConfirm = {
      title: `Archive ${branch}?`,
      body: `megabrain removes the folder ${worktree.path} and keeps the branch ${branch}; restore it from the toast or from ${displayName(project)} in Settings. It refuses when the folder has changes that are not committed or commits that are not pushed.`,
      action: 'Archive',
      tone: 'primary',
      run: () => archive(target, confirm, false),
    }
    setConfirm(confirm)
  })

  const copyText = useStableCallback((text: string) => {
    setActionError(null)
    navigator.clipboard.writeText(text).catch(setActionError)
  })
  // Only a listed project or worktree (or a folder inside one) is handed to Finder.
  const reveal = useStableCallback((path: string) => {
    setActionError(null)
    const roots = projects.flatMap((project) => [project.path, ...project.worktrees.map((worktree) => worktree.path)])
    if (!insideRoots(path, roots)) {
      setActionError(new Error(`${path} is not a listed project or worktree.`))
      return
    }
    api.revealPath(path).catch(setActionError)
  })
  // Reads the projects again now, and this project's stacks with them.
  const refreshProject = useStableCallback((path: string | null) => {
    if (path !== null) forgetStack(path)
    announceAction()
  })
  // The header's + menu, and the list's own menu for a right click between rows.
  const addItems = (): MenuItem[] => [
    { label: 'Import project…', icon: 'import', group: 'open', onSelect: onImport },
    { label: 'New folder', icon: 'newFolder', group: 'organise', onSelect: () => newFolder() },
  ]
  const listItems = (): MenuItem[] => [...addItems(), { label: 'Refresh', icon: 'refresh', group: 'copy', onSelect: () => refreshProject(null) }]

  const actions = useMemo<RowActions>(() => ({
    code: onCode,
    project: (project) => [
      { label: 'Open in VS Code', icon: 'code', group: 'open', onSelect: () => onCode(codeTargetFor(project)) },
      ...(githubRepository(project.remote) === null ? [] : [{ label: 'Show on GitHub', icon: 'external', group: 'open', onSelect: () => onGithub(project, 'prs') } satisfies MenuItem]),
      { label: 'Reveal in Finder', icon: 'reveal', group: 'open', onSelect: () => reveal(project.path) },
      { label: 'New worktree…', icon: 'branch', group: 'git', onSelect: () => openNewWorktree(project) },
      { label: 'Copy path', icon: 'copy', group: 'copy', onSelect: () => copyText(project.path) },
      { label: 'Refresh', icon: 'refresh', group: 'copy', onSelect: () => refreshProject(project.path) },
      ...moveItems(project),
      { label: 'Hide', icon: 'hide', group: 'organise', onSelect: () => setHidden({ project: project.path }, true) },
      {
        label: 'Remove from megabrain…',
        icon: 'trash',
        group: 'danger',
        onSelect: () =>
          setConfirm({
            title: `Remove ${displayName(project)} from megabrain?`,
            body: `megabrain stops listing this project. The folder and its files stay where they are (${project.path}); import it again with + to bring it back.`,
            action: 'Remove',
            run: () => api.removeProject(project.path),
          }),
      },
    ],
    worktree: (project, node, tree) => {
      const { worktree } = node
      const name = worktreeName(worktree)
      const items: MenuItem[] = [
        { label: 'New chat', icon: 'chat', group: 'open', onSelect: () => onNewChat(worktree.path) },
        { label: 'New terminal', icon: 'terminal', group: 'open', onSelect: () => onNewTerminal(worktree.path) },
        { label: 'Open in VS Code', icon: 'code', group: 'open', onSelect: () => onCode(codeTargetFor(project, worktree)) },
        { label: 'Reveal in Finder', icon: 'reveal', group: 'open', onSelect: () => reveal(worktree.path) },
        ...stackActions(project, tree, node).map((action) => stackItem(project, worktree, action)),
        { label: 'Copy path', icon: 'copy', group: 'copy', onSelect: () => copyText(worktree.path) },
        ...(worktree.branch === null ? [] : [{ label: 'Copy branch name', icon: 'copy', group: 'copy', onSelect: () => copyText(worktree.branch ?? '') } satisfies MenuItem]),
        { label: 'Hide', icon: 'hide', group: 'organise', onSelect: () => setHidden({ worktree: worktree.path }, true) },
      ]
      // The main checkout is the project itself; it is removed with the project, not as a worktree.
      if (!worktree.primary && worktree.branch !== null) items.push({ label: 'Archive…', icon: 'archive', group: 'organise', onSelect: () => confirmArchive(project, worktree) })
      if (!worktree.primary) {
        items.push({
          label: 'Remove worktree…',
          icon: 'trash',
          group: 'danger',
          onSelect: () =>
            setConfirm({
              title: `Remove ${name}?`,
              body: `This deletes the folder ${worktree.path} and the branch ${worktree.branch ?? '(detached)'} from ${displayName(project)}. megabrain refuses when the branch has work that is not merged, and nothing is deleted then.`,
              action: 'Remove worktree',
              run: () => api.removeWorktree(worktree.path),
            }),
        })
      }
      return items
    },
    chat: (chat) => {
      const title = chat.title ?? 'New chat'
      const close: MenuItem = { label: 'Close chat', icon: 'close', group: 'danger', onSelect: () => closeRow({ kind: 'native', chat }) }
      if (rowStatus(chat.state) === 'ended') return [close]
      return [
        {
          label: 'Stop chat…',
          icon: 'stop',
          group: 'danger',
          onSelect: () =>
            setConfirm({
              title: `Stop ${title}?`,
              body: 'The agent ends its turn and megabrain closes the conversation. Its history stays readable.',
              action: 'Stop chat',
              run: () => api.stopChat(chat.id).then(announceAction),
            }),
        },
        close,
      ]
    },
    session: (session) => {
      if (!ownership(session).owned) return []
      return [{ label: 'Release from megabrain…', icon: 'release', group: 'danger', onSelect: () => closeRow({ kind: 'session', session }) }]
    },
  }), [onCode, onGithub, onNewChat, openNewWorktree, reveal, copyText, refreshProject, setHidden, onNewTerminal, closeRow, moveItems, stackItem, confirmArchive])

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
      { label: 'Rename…', icon: 'rename', group: 'organise', onSelect: () => setRenamingTerminal(terminal.id) },
      { label: closeNeedsConfirm(terminal) ? 'Close terminal…' : 'Close terminal', icon: 'close', group: 'danger', onSelect: () => closeRow({ kind: 'terminal', terminal }) },
    ],
  }), [selectedTerminalId, renamingTerminal, onSelectTerminal, onRenameTerminal, closeRow])

  // Rows keep the order the person dragged them into, per worktree; new ones show on top.
  const [rowOrder, setRowOrder] = useState<RowOrder>(readRowOrder)
  const [rowDrag, setRowDrag] = useState<{ key: string; edge: { key: string; placement: Placement } | null } | null>(null)
  const rowDragStart = useStableCallback((event: PointerEvent<HTMLElement>, worktreePath: string, key: string, shown: string[]) => {
    if (event.button !== 0) return
    const startY = event.clientY
    let moving = false
    const container = () => navRef.current?.querySelector<HTMLElement>(`[data-worktree-rows="${CSS.escape(worktreePath)}"]`) ?? null
    // Only a pointer over this worktree's own rows reorders; anywhere else the pane drag decides.
    const targetAt = (x: number, y: number) => {
      const rows = container()
      if (rows === null) return null
      const box = rows.getBoundingClientRect()
      if (x < box.left || x > box.right || y < box.top - 8 || y > box.bottom + 8) return null
      const found = dropTarget(
        [...rows.querySelectorAll<HTMLElement>(':scope > [data-row-key]')].map((element) => {
          const rect = element.getBoundingClientRect()
          return { path: element.dataset.rowKey ?? '', top: rect.top, bottom: rect.bottom }
        }),
        y,
      )
      return found === null || found.path === key ? null : { key: found.path, placement: found.placement }
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', stop)
      setRowDrag(null)
    }
    const onMove = (move: globalThis.PointerEvent) => {
      if (!moving && Math.abs(move.clientY - startY) < 4) return
      moving = true
      setRowDrag({ key, edge: targetAt(move.clientX, move.clientY) })
    }
    const onUp = (up: globalThis.PointerEvent) => {
      stop()
      if (!moving) return
      const target = targetAt(up.clientX, up.clientY)
      if (target === null) return
      swallowNextClick()
      captureRows()
      setRowOrder((current) => {
        const next = { ...current, [worktreePath]: moveRow(shown, key, target.key, target.placement) }
        writeRowOrder(next)
        return next
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', stop)
  })
  const itemRows = useMemo<ItemRows>(
    () => ({ close: closeRow, order: rowOrder, dragging: rowDrag?.key ?? null, edge: rowDrag?.edge ?? null, start: rowDragStart }),
    [closeRow, rowOrder, rowDrag, rowDragStart],
  )

  const stackRows = useMemo<StackRows>(() => ({ details: stackDetails, folded: collapsed, fold: toggle, busy: stackBusy }), [stackDetails, collapsed, toggle, stackBusy])
  const listedByPath = new Map(shownProjects.map((project) => [project.path, project]))
  const shownByPath = new Map(visible.map((project) => [project.path, project]))
  const renderProject = (project: Project) => (
    <ProjectSection
      key={project.path}
      project={project}
      collapsed={collapsed.has(project.path)}
      onToggle={toggle}
      selectedSessionId={selectedSessionId}
      onSelectSession={onSelectSession}
      actions={actions}
      onMenu={openMenu}
      now={now}
      drag={drag}
      dragging={dragState?.key === project.path}
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
      itemRows={itemRows}
      creations={creationsByProject[project.path] ?? noCreations}
      creationRows={creationRows}
      onNewWorktree={openNewWorktree}
      listed={listedByPath.get(project.path) ?? project}
      stacks={stackRows}
    />
  )

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
      {/* Padded like the list (pl-2.5, pr-1 plus its gutter), and the row inside like a project row, so
          the title starts on the project pictures' column and the actions end on the rows' right padding. */}
      <div style={{ paddingRight: 4 + gutter }} className={`shrink-0 space-y-2 border-b py-2 pl-2.5 transition-colors ${scrolled ? 'border-white/[0.07]' : 'border-transparent'}`}>
        <div className="flex items-center justify-between pr-1.5 pl-2.5">
          <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink-300">Projects</h3>
          {/* A 14px glyph centred in a 28px button ends 9px inside it; the buttons overhang by that much,
              keeping their size, so the + itself ends where the badges and counts below end at rest. */}
          <span className="-mr-[9px] flex items-center gap-0.5">
            {partition.visible.length > 0 && (
              <>
                <HeaderButton label="Search (⌘F)" on={searching} expanded={searchOpen} keepFocus onClick={() => (searchOpen && filters.query === '' ? setSearchOpen(false) : openSearch())}>
                  <SearchIcon />
                </HeaderButton>
                <FilterMenu filters={filters} onFilters={onFilters} />
              </>
            )}
            <button
              type="button"
              onClick={(event) =>
                openMenu(event, addItems())
              }
              aria-label="Add project or folder"
              title="Import a project or make a folder"
              aria-haspopup="menu"
              className="flex size-7 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-white/[0.08] hover:text-ink-100"
            >
              <PlusIcon />
            </button>
          </span>
        </div>
        {searchOpen && partition.visible.length > 0 && <SearchField inputRef={searchRef} query={filters.query} onQuery={(query) => onFilters({ ...filters, query })} onClose={() => setSearchOpen(false)} />}
      </div>
      <div
        ref={listRef}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        onContextMenu={(event) => {
          // Rows open their own menu; a row with none shows nothing rather than the list's.
          if (event.target instanceof Element && event.target.closest('.group') !== null) {
            event.preventDefault()
            return
          }
          openMenu(event, listItems())
        }}
        onKeyDown={openMenuFromKeyboard}
        className={`sidebar-scroll min-h-0 flex-1 space-y-4 overflow-y-scroll pt-1 pr-1 pb-6 pl-2.5 ${scrolled ? 'sidebar-fade' : ''}`}>
        {actionError !== null && (
          <div className="px-1">
            <ErrorNote error={actionError} />
          </div>
        )}
        {!loaded && loadError === null && projects.length === 0 && <SidebarSkeleton />}
        {layoutError !== null && (
          <div className="px-1">
            <ErrorNote error={layoutError} />
          </div>
        )}
        {!loaded && loadError !== null && (
          <div className="space-y-2 px-1">
            <ErrorNote error={loadError} />
            <button type="button" onClick={onRetryLoad} className="rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
              Retry
            </button>
          </div>
        )}
        {sidebarEntries(layout, shownByPath, filtered).map((entry) =>
          entry.kind === 'project' ? (
            renderProject(entry.project)
          ) : (
            <FolderSection
              key={entry.key}
              folder={entry.folder}
              count={entry.projects.length}
              renaming={renamingFolder === entry.key}
              onStartRename={() => setRenamingFolder(entry.key)}
              onRename={(name) => renameTo(entry.key, name)}
              onToggle={() => applyLayout(toggleFolder(layout, entry.key))}
              drag={drag}
              dragging={dragState?.key === entry.key}
              edge={edgeOf(entry.key)}
              menuItems={folderItems(entry.folder)}
              onMenu={openMenu}
            >
              {entry.projects.map(renderProject)}
            </FolderSection>
          ),
        )}
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
      <ContextMenu menu={menu} onClose={closeMenu} />
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
      <Toast toast={toast} onClose={closeToast} />
      <NewWorktreeDialog
        request={newWorktreeFor}
        taken={creations.filter((item) => item.repo === newWorktreeFor?.project.path && item.status !== 'failed').map((item) => item.branch)}
        onCreate={(project, branch, base) => {
          setNewWorktreeFor(null)
          // The pending row shows under the project, so a folded project opens.
          if (collapsed.has(project.path)) toggle(project.path)
          onCreateWorktree(project, branch, base)
        }}
        onClose={() => setNewWorktreeFor(null)}
      />
    </nav>
  )
})
