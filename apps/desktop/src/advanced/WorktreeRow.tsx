import { useState, type MouseEvent } from 'react'
import type { NativeChat, ProjectSession, ProjectWorktree } from '@/api/schema'
import { memberStatus, memberStatusLabel, type MemberStatus, type StackDetail, type StackPlace } from '@/advanced/stacks'
import { ActivityDot, Chevron, BranchIcon, PlusIcon } from '@/advanced/chrome'
import { projectRowKey, worktreeActivity, worktreeActivityLabel } from '@/advanced/project-row-model'
import { Collapse } from '@/components/Collapse'
import { applyRowOrder, endedRows, rowToOpen, worktreeItems, type KeyedItem, type RowOrder } from '@/advanced/row-model'
import { GroupRowView, useSplitRows } from '@/advanced/SplitRows'
import type { GroupRow } from '@/advanced/split-rows'
import type { MenuItem } from '@/components/ContextMenu'
import { Spinner } from '@/components/ui'
import { stateColors, worktreePullRequestState } from '@/github/github-model'
import { closable } from '@/chat/session-ownership'
import { middleClickAction, withSplitItems } from '@/advanced/item-menus'
import type { AppTerminal } from '@/terminal/terminal-list'
import { CodeButton, live, MoreButton, PullRequestNumber, pullRequestTitle, RowActions, rowAction, SessionRow, NativeChatRow, TerminalRow, type MenuOpener, type RowDragger, type SidebarDrag } from '@/advanced/SidebarRows'
import { DropLine, JoinMark, rowLabel } from '@/advanced/SidebarSections'
import type { RowDragStart, RowDragState } from '@/advanced/useRowDrag'

/** Starts a native chat in this worktree; shown on hover like the code button beside it. */
export function NewChatButton({ label, onClick }: { label: string; onClick: () => void }) {
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
export function StackMarks({ place, status, needsSync, busy }: { place: StackPlace; status: MemberStatus | null; needsSync: boolean; busy: string | null }) {
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

export function WorktreeRow({
  worktree,
  place,
  detail,
  busy,
  fold,
  folded,
  onToggle,
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
  /** Its own rows are folded away; a worktree with no rows has nothing to fold and shows them open. */
  folded: boolean
  /** Folds or unfolds its rows. */
  onToggle: () => void
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
  // Like a project row: the branch icon (a chevron on hover) folds, the name opens, ← → fold from the
  // keyboard. Folded, a mark says a chat in it works or waits.
  const foldable = ordered.length > 0 || groupsHere.length > 0
  const open = !foldable || !folded
  const activity = open ? null : worktreeActivity(worktree, chats)
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
        {foldable ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={onToggle}
            aria-label={`${open ? 'Fold' : 'Unfold'} ${name}`}
            title={`${open ? 'Fold' : 'Unfold'} its chats`}
            className="group/fold relative grid shrink-0 place-items-center"
          >
            <span style={prColor === null ? undefined : { color: prColor }} className={`transition-opacity duration-[120ms] group-hover/fold:opacity-0 ${running ? 'text-ink-300' : 'text-ink-400'}`}>
              <BranchIcon />
            </span>
            <span aria-hidden="true" className="absolute inset-0 grid place-items-center text-ink-300 opacity-0 transition-opacity duration-[120ms] group-hover/fold:opacity-100">
              <Chevron open={open} />
            </span>
          </button>
        ) : (
          <span style={prColor === null ? undefined : { color: prColor }} className={`shrink-0 ${running ? 'text-ink-300' : 'text-ink-400'}`}>
            <BranchIcon />
          </span>
        )}
        <button
          type="button"
          onClick={openWorktree}
          onKeyDown={(event) => {
            const action = projectRowKey(event.key, !open, event)
            if (action === null || (action !== 'open' && !foldable)) return
            event.preventDefault()
            if (action === 'open') openWorktree()
            else onToggle()
          }}
          aria-expanded={foldable ? open : undefined}
          aria-keyshortcuts={foldable ? 'Enter ArrowLeft ArrowRight' : undefined}
          title={`${name}\n${worktree.path}${foldable ? '\nClick the branch icon or press ← → to fold' : ''}`}
          className={`min-w-0 flex-1 truncate text-left text-[13.5px] focus-visible:outline-2 focus-visible:outline-accent ${running ? 'font-medium text-ink-100' : 'text-ink-300'}`}
        >
          {name}
        </button>
        {activity !== null && <ActivityDot state={activity.state} title={worktreeActivityLabel(activity)} />}
        {worktree.primary && <span className="shrink-0 rounded-[6px] bg-white/[0.06] px-1.5 text-[10.5px] leading-4 font-medium text-ink-400">primary</span>}
        {worktree.pullRequest !== null && prState !== null && prColor !== null && (
          <PullRequestNumber pullRequest={worktree.pullRequest} color={prColor} title={pullRequestTitle(worktree.pullRequest, prState)} onOpen={onPullRequest} />
        )}
        {place !== null && <StackMarks place={place} status={member.status} needsSync={member.needsSync} busy={busy} />}
        <RowActions gap="2">
          <NewChatButton
            label={`New chat in ${name}`}
            onClick={() => {
              // The new chat's row shows here, so a folded worktree opens.
              if (!open) onToggle()
              onNewChat(worktree.path)
            }}
          />
          <CodeButton label={`Open ${name} in Code`} onClick={onCode} />
          <MoreButton label={`Manage ${name}`} onClick={(event) => onMenu(event, menuItems)} />
        </RowActions>
      </div>
      <Collapse open={open}>
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
      </Collapse>
    </div>
  )
}

export const rowOf = (item: KeyedItem): SidebarDrag => (item.kind === 'native' ? { kind: 'native', chat: item.chat } : item.kind === 'terminal' ? { kind: 'terminal', terminal: item.terminal } : { kind: 'session', session: item.session })
export const noGroups: GroupRow[] = []

/** What every terminal row needs; one object per change of selection or rename, so rows stay memoised. */
export interface TerminalRows {
  selectedId: string | null
  renamingId: string | null
  select: (terminal: AppTerminal) => void
  rename: (terminal: AppTerminal, name: string | null) => void
  items: (terminal: AppTerminal) => MenuItem[]
}


/** What every chat, session and terminal row needs to close and be reordered; one object per change. */
export interface ItemRows {
  close: (row: SidebarDrag) => void
  /** Each worktree's saved row order. */
  order: RowOrder
  /** A row, group or member being dragged in the sidebar, and where it would land. */
  drag: RowDragState | null
  start: RowDragStart
}

