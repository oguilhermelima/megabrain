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
import { createFolder, deleteFolder, folderOf, layoutDropTarget, moveEntry, moveToFolder, renameFolder, sidebarEntries, stepEntry, toggleFolder, type DropPlacement, type LayoutRow, type SidebarFolder, type SidebarLayout } from '@/advanced/sidebar-folders'
import { CodeIcon, PlusIcon } from '@/advanced/chrome'
import { creationsIn, type PendingWorktree } from '@/advanced/new-worktree-model'
import { NewWorktreeDialog } from '@/advanced/NewWorktreeDialog'
import { projectActivity, projectRowClick, projectRowKey } from '@/advanced/project-row-model'
import { applyRowOrder, endedRows, moveRow, rowToOpen, worktreeItems, type KeyedItem, type RowOrder } from '@/advanced/row-model'
import { pruneSidebarState, type SidebarState } from '@/advanced/sidebar-state'
import { useSidebarState } from '@/advanced/useSidebarLayout'
import { GroupRowView, SpanningSplits, useSplitRows, type SplitDrop } from '@/advanced/SplitRows'
import { useRowDrag, type RowDragStart, type RowDragState } from '@/advanced/useRowDrag'
import type { ArrangeTarget } from '@/panes/arrange'
import type { GroupRow } from '@/advanced/split-rows'
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
import { codeTargetFor, type CodeTarget } from '@/code/code-pane-model'
import { githubRepository, stateColors, worktreePullRequestState } from '@/github/github-model'
import type { GithubKind } from '@/github/useGithubCounts'
import { announceAction } from '@/lib/app-events'
import { matchShortcut } from '@/lib/shortcuts'
import { useShortcutBindings } from '@/lib/shortcut-store'
import { insideRoots } from '@/lib/external'
import { useStableCallback } from '@/lib/useStableCallback'
import { useFlip } from '@/advanced/useFlip'
import { closable } from '@/chat/session-ownership'
import { rowStatus } from '@/native-chat/chat-model'
import { chatMenu, middleClickAction, sessionMenu, terminalMenu, withSplitItems, type RowMenuActions, type SidebarItemRow } from '@/advanced/item-menus'
import { useChatState } from '@/native-chat/live-state'
import { nativeStateLabel } from '@/native-chat/parts'
import { TerminalIcon } from '@/terminal/TerminalIcon'
import { MenuIconGlyph } from '@/components/menu-icons'
import { terminalLabel, type AppTerminal } from '@/terminal/terminal-list'

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

/** Opens a worktree in Code; shown on hover like the … button beside it. */
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
export type SidebarDrag = SidebarItemRow

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
 * An agent session under its worktree. Its menu (right click or the … that replaces the age on hover)
 * releases one megabrain owns; one it does not run opens here or closes, which takes it out of the list.
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
  const splits = useSplitRows()
  const ordered = applyRowOrder(worktreeItems(chats, terminals, worktree.sessions), rowControls.order[worktree.path] ?? [])
  const itemOfRow = (item: KeyedItem): string | null => splits?.itemOf(rowOf(item)) ?? null
  // A split's members show as its one row, where its first member's row was; a split with none of
  // its members' rows here goes on top. Members of a split shown elsewhere hide here too.
  const groupsHere = splits?.byWorktree.get(worktree.path) ?? noGroups
  const groupOfRow = (item: KeyedItem): GroupRow | null => {
    const key = itemOfRow(item)
    return key === null ? null : (groupsHere.find((row) => row.members.some((member) => member.item === key)) ?? null)
  }
  const shown = ordered.filter((item) => {
    const key = itemOfRow(item)
    return key === null || !(splits?.members.has(key) ?? false)
  })
  // Conversations that ended more than a week ago fold under Ended, closed until the person opens it.
  const { ended } = endedRows(shown, now)
  const endedKeys = new Set(ended.map((item) => item.key))
  const [endedOpen, setEndedOpen] = useState(false)
  const anchored = new Map<string, GroupRow[]>()
  for (const item of ordered) {
    const group = groupOfRow(item)
    if (group !== null && ![...anchored.values()].flat().includes(group)) anchored.set(item.key, [...(anchored.get(item.key) ?? []), group])
  }
  const loose = groupsHere.filter((row) => ![...anchored.values()].flat().includes(row))
  const groupRowsAt = (key: string | null) =>
    (key === null ? loose : (anchored.get(key) ?? noGroups)).map((row) => (
      <div key={row.id} className="sidebar-row-in relative">
        <GroupRowView row={row} indent="worktree" onMenu={onMenu} drag={rowControls} end={(items) => <MoreButton label={`Manage ${row.title}`} onClick={(event) => onMenu(event, items)} />} />
      </div>
    ))
  const keys = shown.map((item) => item.key)
  // Split right or down, and Open in split for the rows picked with ⌘-click, go first in a row's menu.
  const withSplit = (item: KeyedItem, items: MenuItem[]) => {
    const key = itemOfRow(item)
    return key === null || splits === null ? items : withSplitItems(items, splits.rowMenu(key))
  }
  const pickRow = (item: KeyedItem) => (event: MouseEvent<HTMLElement>) => {
    const key = itemOfRow(item)
    if (key === null || splits === null) return
    if (event.metaKey) {
      event.preventDefault()
      event.stopPropagation()
      splits.pick(key, true)
    } else if (splits.selected.size > 0) splits.pick(key, false)
  }
  // A middle click closes exactly this row, as its Close would (the list stops autoscroll and paste).
  const middleClose = (item: KeyedItem) => (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 1) return
    event.preventDefault()
    event.stopPropagation()
    const action = middleClickAction(rowOf(item))
    if (action !== null) rowControls.close(action.row)
  }
  const picked = (item: KeyedItem) => {
    const key = itemOfRow(item)
    return key !== null && (splits?.selected.has(key) ?? false)
  }
  const openItem = (item: KeyedItem) => {
    if (item.kind === 'native') onSelectChat(item.chat)
    else if (item.kind === 'terminal') terminalRows.select(item.terminal)
    else onSelectSession(item.session)
  }
  // The branch opens its most recent row, or the launcher for a worktree with nothing in it yet.
  const openWorktree = () => {
    const item = rowToOpen(shown)
    if (item === null) onNewChat(worktree.path)
    else openItem(item)
  }
  const dragOf = (item: KeyedItem): RowDragger => (event, row) => {
    onDrag(event, row)
    rowControls.start(event, { kind: 'row', worktreePath: worktree.path, key: item.key, shown: keys, item: itemOfRow(item), label: rowLabel(item) })
  }
  const renderItem = (item: KeyedItem, drag: RowDragger) => {
    if (item.kind === 'native') {
      const { chat } = item
      return <NativeChatRow chat={chat} session={item.session} selected={chat.id === selectedChatId} now={now} onSelect={() => onSelectChat(chat)} menuItems={withSplit(item, chatItems(chat))} onMenu={onMenu} onClose={(live) => rowControls.close({ kind: 'native', chat: live })} onDrag={drag} />
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
          menuItems={withSplit(item, terminalRows.items(terminal))}
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
        menuItems={withSplit(item, sessionItems(session))}
        onMenu={onMenu}
        onClose={closable(session) ? () => rowControls.close({ kind: 'session', session }) : null}
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
        <button
          type="button"
          onClick={openWorktree}
          title={`${name}\n${worktree.path}`}
          className={`min-w-0 flex-1 truncate text-left text-[13.5px] focus-visible:outline-2 focus-visible:outline-accent ${running ? 'font-medium text-ink-100' : 'text-ink-300'}`}
        >
          {name}
        </button>
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
        {groupRowsAt(null)}
        {ordered.map((item) => {
          const groups = groupRowsAt(item.key)
          if (!shown.includes(item) || endedKeys.has(item.key)) return groups
          const key = itemOfRow(item)
          const drag = dragOf(item)
          const source = rowControls.drag?.source
          const target = rowControls.drag?.target ?? null
          return [
            ...groups,
            <div
              key={item.key}
              data-row-key={item.key}
              data-item={key ?? undefined}
              onClickCapture={pickRow(item)}
              onAuxClick={middleClose(item)}
              aria-selected={picked(item) ? 'true' : undefined}
              className={`sidebar-row-in relative rounded-[12px] ${source?.kind === 'row' && source.key === item.key ? 'opacity-50' : ''} ${picked(item) ? 'ring-1 ring-accent/60 ring-inset' : ''}`}
            >
              {target?.kind === 'reorder' && target.key === item.key && <DropLine edge={target.placement} />}
              {target?.kind === 'join' && target.at === item.key && <JoinMark />}
              {renderItem(item, drag)}
            </div>,
          ]
        })}
        {ended.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setEndedOpen((open) => !open)}
              aria-expanded={endedOpen}
              title="Conversations that ended more than a week ago"
              className="flex h-7 w-full items-center gap-1.5 rounded-[12px] pl-[31px] text-left text-[12.5px] text-ink-400 transition-colors hover:bg-row-hover hover:text-ink-300"
            >
              <Chevron open={endedOpen} />
              <span>Ended</span>
              <span className="tabular-nums">{ended.length}</span>
            </button>
            {endedOpen &&
              ended.map((item) => (
                <div key={item.key} data-row-key={item.key} onAuxClick={middleClose(item)} className="sidebar-row-in relative rounded-[12px]">
                  {renderItem(item, dragOf(item))}
                </div>
              ))}
          </>
        )}
      </div>
    </div>
  )
}

const rowOf = (item: KeyedItem): SidebarDrag => (item.kind === 'native' ? { kind: 'native', chat: item.chat } : item.kind === 'terminal' ? { kind: 'terminal', terminal: item.terminal } : { kind: 'session', session: item.session })

const noCreations: PendingWorktree[] = []
const noGroups: GroupRow[] = []

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
  selected,
  onOpenProject,
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
  /** The project's page is in the focused pane. */
  selected: boolean
  onOpenProject: (project: Project) => void
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
  const activity = projectActivity(project, chats)
  const name = displayName(project)
  return (
    <section data-entry-key={project.path} className={`relative ${dragging ? 'opacity-50' : ''}`}>
      {edge !== null && <DropLine edge={edge} />}
      <div
        onContextMenu={(event) => onMenu(event, actions.project(project))}
        onPointerDown={(event) => drag.start(event, project.path)}
        className={`group flex items-center gap-0.5 rounded-[12px] pr-1.5 transition-colors select-none ${selected ? 'bg-row-selected' : 'hover:bg-row-hover'}`}
      >
        {/* One button, two zones (project-row-model): the picture, a chevron on hover, folds; the rest opens the page. */}
        <button
          type="button"
          data-entry-toggle={project.path}
          onClick={(event) => {
            const action = projectRowClick(event.clientX - event.currentTarget.getBoundingClientRect().left, event.detail === 0)
            if (action === 'collapse') onToggle(project.path)
            else onOpenProject(project)
          }}
          onKeyDown={(event) => {
            const action = projectRowKey(event.key, collapsed, event)
            if (action === null) return drag.key(event, project.path)
            event.preventDefault()
            if (action === 'open') onOpenProject(project)
            else onToggle(project.path)
          }}
          aria-expanded={!collapsed}
          aria-current={selected ? 'page' : undefined}
          aria-keyshortcuts="Enter ArrowLeft ArrowRight Alt+ArrowUp Alt+ArrowDown"
          title={`${name}\n${project.path}\nClick to open its page; click the picture or press ← → to fold\nDrag or press ⌥↑ ⌥↓ to reorder`}
          className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-2.5 text-left"
        >
          <span className="group/fold relative -ml-2.5 flex h-9 shrink-0 items-center pl-2.5">
            <span className="transition-opacity duration-[120ms] group-hover/fold:opacity-0">
              <ProjectPicture project={project} />
            </span>
            <span aria-hidden="true" className="absolute inset-y-0 right-0 grid w-6 place-items-center text-ink-300 opacity-0 transition-opacity duration-[120ms] group-hover/fold:opacity-100">
              <Chevron open={!collapsed} />
            </span>
          </span>
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{name}</h2>
          {activity !== null && (
            <span title={activity === 'working' ? 'A chat is working' : 'A chat is waiting for you'} className={`size-1.5 shrink-0 rounded-full ${activity === 'working' ? 'bg-ok shadow-[0_0_8px_#34d399] animate-pulse' : 'bg-warn'}`} />
          )}
        </button>
        <RowActions gap="0.5">
          <MoreButton label={`Manage ${name}`} onClick={(event) => onMenu(event, actions.project(project))} />
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

/** What a drop on the hover's map does, in words. */
function arrangeNote(target: ArrangeTarget): string {
  if (target.kind === 'side') return target.side === 'top' || target.side === 'bottom' ? `Span the width, ${target.side === 'top' ? 'on top' : 'at the bottom'}` : `Span the height, on the ${target.side}`
  return target.zone === 'center' ? 'Swap panes' : 'Split beside'
}

/** What a dragged group or member carries, by the pointer; a row dragged out of its group says it leaves. */
function DragGhost({ state }: { state: RowDragState }) {
  const target = state.target
  const note = target?.kind === 'leave' ? 'Remove from split' : target?.kind === 'join' ? 'Join split' : target?.kind === 'arrange' ? arrangeNote(target.target) : null
  return (
    <div style={{ left: state.x + 12, top: state.y + 12 }} className="pointer-events-none fixed z-[70] max-w-64 rounded-[10px] border border-white/[0.12] bg-ink-850 px-2.5 py-1 text-[12.5px] text-ink-100 shadow-xl">
      {note !== null && <div className="text-[11px] font-medium text-accent">{note}</div>}
      <div className="truncate">{state.source.label}</div>
    </div>
  )
}

/** A row's title, for what a drag carries. */
const rowLabel = (item: KeyedItem) => (item.kind === 'native' ? (item.chat.title ?? 'New chat') : item.kind === 'terminal' ? terminalLabel(item.terminal) : item.session.title)

/** A row a dragged row would join into a split: ringed, with the split glyph at its right. */
function JoinMark() {
  return (
    <span aria-hidden="true" className="motion-fade pointer-events-none absolute inset-0 z-10 flex items-center justify-end rounded-[12px] bg-accent/[0.12] pr-2 ring-2 ring-accent ring-inset">
      <span className="flex items-center gap-1 rounded-[6px] bg-ink-850/90 px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">
        <MenuIconGlyph icon="splitRight" />
        Split
      </span>
    </span>
  )
}

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
  /** A row, group or member being dragged in the sidebar, and where it would land. */
  drag: RowDragState | null
  start: RowDragStart
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
  layoutReady,
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
  onGithub,
  onOpenProject,
  selectedProject,
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
  onSplitDrop,
  creations,
  onCreateWorktree,
  onRetryCreation,
  onDismissCreation,
}: {
  /** A row joined into a split, a member leaving its group, or a group's members reordered; see useRowDrag. */
  onSplitDrop: (drop: SplitDrop) => void
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
  /** Shows a root in Code, the embedded editor, in a pane. */
  onCode: (target: CodeTarget) => void
  onImport: () => void
  /** The folders and top-level order, reconciled with the listed projects; drags, ⌥↑ ⌥↓ and the folder menus send the next one. */
  layout: SidebarLayout
  onLayout: (layout: SidebarLayout) => void
  /** Why the folders could not be read or saved, if so. */
  layoutError: unknown
  /** The saved folders have been read (or failed to be); the list waits for them. */
  layoutReady: boolean
  filters: SidebarFilters
  onFilters: (filters: SidebarFilters) => void
  /** Opens a project's pull request or issue page. */
  onGithub: (project: Project, kind: GithubKind, focus?: number) => void
  /** Opens a project's own page, its overview and actions, in the focused pane. */
  onOpenProject: (project: Project) => void
  /** The path of the project whose page is in the focused pane, if any. */
  selectedProject: string | null
}) {
  // What is folded and each worktree's row order, kept across restarts (useSidebarState); the list
  // waits for them so it never draws unfolded and then jumps.
  const { state: savedState, change: changeSavedState, error: savedStateError, ready: savedStateReady } = useSidebarState()
  const collapsed = useMemo(() => new Set(savedState.collapsed), [savedState.collapsed])
  const ready = layoutReady && savedStateReady
  // Every save drops what no longer exists: folds of projects and stacks gone, orders of worktrees gone.
  const saveState = useStableCallback((next: SidebarState) => {
    const worktrees = projects.flatMap((project) => project.worktrees.map((worktree) => worktree.path))
    const collapsible = new Set([...projects.map((project) => project.path), ...worktrees.map((path) => `stack:${path}`)])
    changeSavedState(pruneSidebarState(next, { collapsible, worktrees: new Set([...projects.map((project) => project.path), ...worktrees]) }))
  })
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
  const filtered = hasFilters(filters)
  const [searchOpen, setSearchOpen] = useState(filters.query !== '')
  const searchRef = useRef<HTMLInputElement>(null)
  const searching = filters.query.trim() !== ''
  const openSearch = () => {
    setSearchOpen(true)
    searchRef.current?.focus()
  }
  // Projects fold by path (two can share a name); stacks fold by `stack:<worktree path>`.
  const toggle = useStableCallback((key: string) => {
    const folded = savedState.collapsed
    saveState({ ...savedState, collapsed: folded.includes(key) ? folded.filter((entry) => entry !== key) : [...folded, key] })
  })

  const navRef = useRef<HTMLElement>(null)
  // The Projects header sits above the list on the sidebar's own glass: no tint or blur of its own,
  // which inside the glass would stack a second, darker layer.
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

  const searchKeys = useShortcutBindings()
  const [renamingTerminal, setRenamingTerminal] = useState<string | null>(null)
  const stopChat = useStableCallback((chat: NativeChat) =>
    setConfirm({
      title: `Stop ${chat.title ?? 'New chat'}?`,
      body: 'The agent ends its turn and megabrain closes the conversation. Its history stays readable.',
      action: 'Stop chat',
      run: () => api.stopChat(chat.id).then(announceAction),
    }),
  )

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

  const rowMenuActions = useMemo<RowMenuActions>(
    () => ({ close: closeRow, copy: copyText, stop: stopChat, rename: (terminal) => setRenamingTerminal(terminal.id) }),
    [closeRow, copyText, stopChat],
  )
  const actions = useMemo<RowActions>(() => ({
    code: onCode,
    project: (project) => [
      { label: 'Open project page', icon: 'folder', group: 'open', onSelect: () => onOpenProject(project) },
      { label: 'New chat', icon: 'chat', group: 'open', onSelect: () => onNewChat(project.path) },
      { label: 'Open in Code', icon: 'code', group: 'open', onSelect: () => onCode(codeTargetFor(project)) },
      ...(githubRepository(project.remote) === null
        ? []
        : [
            { label: 'Pull requests', icon: 'pullRequest', group: 'open', onSelect: () => onGithub(project, 'prs') } satisfies MenuItem,
            { label: 'Issues', icon: 'external', group: 'open', onSelect: () => onGithub(project, 'issues') } satisfies MenuItem,
          ]),
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
        { label: 'Open in Code', icon: 'code', group: 'open', onSelect: () => onCode(codeTargetFor(project, worktree)) },
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
    chat: (chat) => chatMenu(chat, rowMenuActions),
    session: (session) => sessionMenu(session, rowMenuActions),
  }), [onCode, onGithub, onOpenProject, onNewChat, openNewWorktree, reveal, copyText, refreshProject, setHidden, onNewTerminal, closeRow, moveItems, stackItem, confirmArchive, rowMenuActions])

  const terminalRows = useMemo<TerminalRows>(() => ({
    selectedId: selectedTerminalId,
    renamingId: renamingTerminal,
    select: onSelectTerminal,
    rename: (terminal, name) => {
      setRenamingTerminal(null)
      if (name !== null) onRenameTerminal(terminal, name)
    },
    items: (terminal) => terminalMenu(terminal, rowMenuActions),
  }), [selectedTerminalId, renamingTerminal, onSelectTerminal, onRenameTerminal, rowMenuActions])

  // Rows keep the order the person dragged them into, per worktree; new ones show on top.
  const rowOrder = savedState.rows
  const rowDrag = useRowDrag(
    navRef,
    {
      reorder: (worktreePath, next) => {
        captureRows()
        saveState({ ...savedState, rows: { ...savedState.rows, [worktreePath]: next } })
      },
      join: (source, target) => {
        const from = source.kind === 'group' ? ({ kind: 'group', groupId: source.groupId } as const) : source.kind === 'member' ? ({ kind: 'item', item: source.item } as const) : source.item === null ? null : ({ kind: 'item', item: source.item } as const)
        if (from === null) return
        captureRows()
        onSplitDrop({ kind: 'join', source: from, target })
      },
      leave: (groupId, item) => {
        captureRows()
        onSplitDrop({ kind: 'leave', groupId, item })
      },
      arrange: (groupId, item, target) => onSplitDrop({ kind: 'arrange', groupId, item, target }),
    },
    moveRow,
  )
  const itemRows = useMemo<ItemRows>(
    () => ({ close: closeRow, order: rowOrder, drag: rowDrag.state, start: rowDrag.start }),
    [closeRow, rowOrder, rowDrag.state, rowDrag.start],
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
      selected={selectedProject === project.path}
      onOpenProject={onOpenProject}
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
      listed={listedByPath.get(project.path) ?? project}
      stacks={stackRows}
    />
  )

  return (
    <nav
      ref={navRef}
      className="relative flex min-h-0 flex-1 flex-col"
      aria-label="Projects"
      // A middle press closes an item row on release (WorktreeRow); it never autoscrolls or pastes here.
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onKeyDown={(event) => {
        if (matchShortcut(event, searchKeys) !== 'sidebar.search' || partition.visible.length === 0) return
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
      {rowDrag.state !== null && rowDrag.state.source.kind !== 'row' && <DragGhost state={rowDrag.state} />}
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
        {((!loaded && loadError === null && projects.length === 0) || !ready) && <SidebarSkeleton />}
        <SpanningSplits onMenu={openMenu} drag={itemRows} end={(items) => <MoreButton label="Manage split" onClick={(event) => openMenu(event, items)} />} />
        {(layoutError ?? savedStateError) !== null && (
          <div className="px-1">
            <ErrorNote error={layoutError ?? savedStateError} />
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
        {ready && sidebarEntries(layout, shownByPath, filtered).map((entry) =>
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
