import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { MenuItem } from '@/components/ContextMenu'
import { AgentIcon } from '@/components/agent-icons'
import { MenuIconGlyph } from '@/components/menu-icons'
import { CodeIcon, PlusIcon } from '@/advanced/chrome'
import { visibleMarks, type GroupMember, type GroupRow, type MemberMark, type MemberState } from '@/advanced/split-rows'
import type { SidebarDrag } from '@/advanced/Sidebar'
import type { JoinTarget, RowDragStart, RowDragState } from '@/advanced/useRowDrag'
import { TerminalIcon } from '@/terminal/TerminalIcon'

// Split groups in the sidebar (see split-rows.ts): one row per group under its worktree, or under a
// Splits header when its members span worktrees. Advanced owns the layout and provides this context;
// the rows read it, so the memoised sidebar does not re-render for it.

/** A change to the groups from the sidebar: a row or group joined, a member leaving, reordered or swapped. */
export type SplitDrop =
  | { kind: 'join'; source: JoinTarget; target: JoinTarget }
  | { kind: 'leave'; groupId: string; item: string }
  | { kind: 'move'; groupId: string; item: string; index: number }
  | { kind: 'swap'; groupId: string; a: string; b: string }

/** The sidebar's drag, as the group rows and their hover take part in it (see useRowDrag). */
export interface GroupDrag {
  drag: RowDragState | null
  start: RowDragStart
}

export interface SplitRowsValue {
  byWorktree: ReadonlyMap<string, GroupRow[]>
  spanning: readonly GroupRow[]
  /** Items some group holds: their own rows hide while they are in it. */
  members: ReadonlySet<string>
  /** The item a sidebar row opens, or null for one that opens nothing yet. */
  itemOf: (row: SidebarDrag) => string | null
  focusGroup: (groupId: string) => void
  focusMember: (groupId: string, item: string) => void
  rename: (groupId: string, name: string) => void
  /** The group row's menu: layouts, rename, unsplit and close. */
  groupMenu: (row: GroupRow, startRename: () => void) => MenuItem[]
  /** What a chat, session or terminal row's menu adds: split right or down, open the selection in a split. */
  rowMenu: (item: string) => MenuItem[]
  /** Rows picked with ⌘-click, by item. */
  selected: ReadonlySet<string>
  /** ⌘-click adds or removes a row; a plain click clears the picking. */
  pick: (item: string, add: boolean) => void
  /** Joins, removes, reorders or swaps, from the hover's buttons and keys as from a drag. */
  drop: (drop: SplitDrop) => void
}

export const SplitRowsContext = createContext<SplitRowsValue | null>(null)

export const useSplitRows = () => useContext(SplitRowsContext)

const stateDot: Record<MemberState, string> = {
  working: 'bg-ok shadow-[0_0_8px_#34d399] animate-pulse',
  waiting: 'bg-warn',
  idle: 'bg-ink-400',
  ended: 'bg-ink-600',
}

const activity = (state: MemberState) => (state === 'working' ? 'working' : state === 'waiting' ? 'waiting' : 'idle')

export function MemberMarkIcon({ mark, state }: { mark: MemberMark; state: MemberState }) {
  switch (mark.kind) {
    case 'agent':
      return <AgentIcon agent={mark.agent} activity={activity(state)} className="shrink-0 text-ink-300" />
    case 'terminal':
      return <TerminalIcon className="shrink-0 text-ink-300" />
    case 'launcher':
      return (
        <span className="shrink-0 text-ink-400">
          <PlusIcon />
        </span>
      )
    case 'code':
      return (
        <span className="shrink-0 text-ink-400">
          <CodeIcon />
        </span>
      )
    case 'github':
      return (
        <span className="shrink-0 text-ink-400">
          <MenuIconGlyph icon="pullRequest" />
        </span>
      )
  }
}

/**
 * The arrangement in miniature: one cell per member, the focused one filled. With `onCell` each cell
 * is a drop target for a member dragged in the hover (`swapWith` lights the one it would swap with),
 * and cells glide to their new place when the members reorder.
 */
export function LayoutGlyph({ row, width, height, onCell, swapWith = null, dragged = null }: { row: GroupRow; width: number; height: number; onCell?: (member: GroupMember) => void; swapWith?: string | null; dragged?: string | null }) {
  const gap = width > 40 ? 3 : 1.5
  const live = onCell !== undefined
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden={live ? undefined : 'true'} className="shrink-0">
      {row.glyph.map(({ item, rect }, index) => {
        const member = row.members.find((candidate) => candidate.item === item)
        const focused = member?.focused === true && row.active
        const fill = swapWith === item ? 'fill-accent/40 stroke-accent' : dragged === item ? 'fill-accent/25 stroke-accent' : focused ? 'fill-accent/60 stroke-accent' : 'fill-white/[0.06] stroke-ink-400'
        return (
          <rect
            key={item}
            data-member-cell={live ? item : undefined}
            style={{
              x: rect.x * width + gap / 2,
              y: rect.y * height + gap / 2,
              width: Math.max(1, rect.width * width - gap),
              height: Math.max(1, rect.height * height - gap),
              transition: live ? 'x var(--motion-panel) var(--motion-ease-panel), y var(--motion-panel) var(--motion-ease-panel), width var(--motion-panel) var(--motion-ease-panel), height var(--motion-panel) var(--motion-ease-panel), fill var(--motion-enter)' : undefined,
            }}
            x={rect.x * width + gap / 2}
            y={rect.y * height + gap / 2}
            width={Math.max(1, rect.width * width - gap)}
            height={Math.max(1, rect.height * height - gap)}
            rx={width > 40 ? 3 : 1.5}
            onClick={onCell === undefined || member === undefined ? undefined : () => onCell(member)}
            className={`${fill} ${live ? 'cursor-pointer hover:fill-white/[0.16]' : ''}`}
            strokeWidth={1}
          >
            {live && member !== undefined && <title>{`${index + 1}. ${member.title}`}</title>}
          </rect>
        )
      })}
    </svg>
  )
}

/** How many slots the row's marks take at most, a +N included, so the title keeps the room. */
const maxMarks = 3
const hoverDelayMs = 350
const leaveDelayMs = 160

/**
 * A split group's row: its members' marks (each focuses that pane), its name or the members' titles,
 * and its strongest state; the layout in miniature lives in the hover, so the title gets the width. A click shows the split; hovering shows every member.
 * Dragging the row joins the row it is dropped on into the group; dragging a mark takes that member
 * out, or into another row. `end` is the row's … button, drawn by the sidebar.
 */
export function GroupRowView({ row, indent, onMenu, end, drag }: { row: GroupRow; indent: 'worktree' | 'top'; onMenu: (event: MouseEvent<HTMLElement>, items: MenuItem[]) => void; end: (items: MenuItem[]) => ReactNode; drag: GroupDrag }) {
  const splits = useSplitRows()
  const [renaming, setRenaming] = useState(false)
  const [hover, setHover] = useState<DOMRect | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Whether the pointer is over the row or its hover, so a drag that ends elsewhere closes the hover.
  const inside = useRef(false)
  const source = drag.drag?.source ?? null
  const target = drag.drag?.target ?? null
  const draggingMember = source?.kind === 'member' && source.groupId === row.id
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  // The hover never closes during a drag of one of its members; once the drag ends outside it, it does.
  useEffect(() => {
    if (draggingMember || inside.current || hover === null) return
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setHover(null), leaveDelayMs)
  }, [draggingMember, hover])
  if (splits === null) return null
  const items = splits.groupMenu(row, () => setRenaming(true))
  const marks = visibleMarks(row.members, maxMarks)
  const padding = indent === 'worktree' ? 'pl-[29px]' : 'pl-2.5'
  const later = (run: () => void, ms: number) => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(run, ms)
  }
  const enter = () => {
    inside.current = true
    later(() => setHover(anchor.current?.getBoundingClientRect() ?? null), hover === null ? hoverDelayMs : 0)
  }
  const leave = () => {
    inside.current = false
    if (draggingMember) return
    later(() => setHover(null), leaveDelayMs)
  }
  const joining = target?.kind === 'join' && target.at === row.id

  if (renaming) {
    return (
      <div className={`flex h-8 items-center gap-2 rounded-[12px] bg-row-selected pr-1.5 ${padding}`}>
        <LayoutGlyph row={row} width={16} height={12} />
        <input
          aria-label={`Rename ${row.title}`}
          defaultValue={row.name ?? ''}
          placeholder={row.members.map((member) => member.title).join(' + ')}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              splits.rename(row.id, event.currentTarget.value)
              setRenaming(false)
            }
            if (event.key === 'Escape') setRenaming(false)
          }}
          onBlur={(event) => {
            splits.rename(row.id, event.currentTarget.value)
            setRenaming(false)
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-100 outline-none placeholder:text-ink-400"
        />
      </div>
    )
  }

  return (
    <div
      ref={anchor}
      className={`group relative rounded-[12px] ${source?.kind === 'group' && source.groupId === row.id ? 'opacity-50' : ''}`}
      data-split-group={row.id}
      onContextMenu={(event) => onMenu(event, items)}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onPointerDown={(event) => drag.start(event, { kind: 'group', groupId: row.id, label: row.title })}
    >
      {joining && <span aria-hidden="true" className="motion-fade pointer-events-none absolute inset-0 z-10 rounded-[12px] bg-accent/[0.12] ring-2 ring-accent ring-inset" />}
      <div
        className={`flex h-8 w-full items-center gap-1.5 rounded-[12px] pr-1.5 text-[13px] transition-colors ${padding} ${
          row.active ? 'bg-row-selected text-ink-100' : row.state === 'ended' ? 'text-ink-400 hover:bg-row-hover hover:text-ink-200' : 'text-ink-300 hover:bg-row-hover hover:text-ink-100'
        }`}
      >
        <span className="flex shrink-0 items-center gap-0.5 rounded-[8px] bg-white/[0.05] px-1 py-0.5">
          {marks.shown.map((member) => (
            <button
              key={member.item}
              type="button"
              onClick={() => splits.focusMember(row.id, member.item)}
              onPointerDown={(event) => drag.start(event, { kind: 'member', groupId: row.id, item: member.item, label: member.title })}
              aria-label={`Focus ${member.title}`}
              title={`${member.title}\nDrag out to remove it from the split`}
              className={`flex size-[18px] items-center justify-center rounded-[5px] transition-colors hover:bg-white/[0.1] ${member.focused && row.active ? 'bg-white/[0.1]' : ''} ${draggingMember && source.item === member.item ? 'opacity-40' : ''}`}
            >
              <MemberMarkIcon mark={member.mark} state={member.state} />
            </button>
          ))}
          {marks.more > 0 && <span className="px-0.5 text-[10.5px] font-medium text-ink-400 tabular-nums">+{marks.more}</span>}
        </span>
        <button type="button" onClick={() => splits.focusGroup(row.id)} aria-current={row.active ? 'true' : undefined} aria-label={`Show split ${row.title}`} className="min-w-0 flex-1 truncate text-left focus-visible:outline-2 focus-visible:outline-accent">
          {row.title}
        </button>
        <span className="w-[30px] shrink-0 group-focus-within:invisible group-hover:invisible group-data-[menu-open]:invisible" />
        <span className={`size-1.5 shrink-0 rounded-full ${stateDot[row.state]} group-focus-within:invisible group-hover:invisible group-data-[menu-open]:invisible`} aria-label={row.state} />
      </div>
      <span className="absolute top-1/2 right-0.5 flex -translate-y-1/2 items-center" onPointerDown={(event) => event.stopPropagation()}>
        {end(items)}
      </span>
      {hover !== null && <HoverPreview row={row} anchor={hover} drag={drag} onMenu={onMenu} onEnter={enter} onLeave={leave} />}
    </div>
  )
}

function DragHandle() {
  return (
    <svg viewBox="0 0 8 12" width="8" height="12" fill="currentColor" aria-hidden="true" className="shrink-0">
      <circle cx="2" cy="2" r="1" />
      <circle cx="6" cy="2" r="1" />
      <circle cx="2" cy="6" r="1" />
      <circle cx="6" cy="6" r="1" />
      <circle cx="2" cy="10" r="1" />
      <circle cx="6" cy="10" r="1" />
    </svg>
  )
}

/**
 * Every member of a group, in pane order, and the layout in miniature. Drag a line by its handle to
 * reorder the panes (live), onto a cell of the map to swap two, or out to the sidebar to remove it;
 * Alt+Up and Alt+Down move a focused line, × removes it and … opens its menu.
 */
function HoverPreview({ row, anchor, drag, onMenu, onEnter, onLeave }: { row: GroupRow; anchor: DOMRect; drag: GroupDrag; onMenu: (event: MouseEvent<HTMLElement>, items: MenuItem[]) => void; onEnter: () => void; onLeave: () => void }) {
  const splits = useSplitRows()
  const list = useRef<HTMLUListElement>(null)
  useSlidingLines(list)
  if (splits === null) return null
  const top = Math.max(8, Math.min(anchor.top - 8, window.innerHeight - 120 - row.members.length * 28))
  const source = drag.drag?.source ?? null
  const target = drag.drag?.target ?? null
  const dragged = source?.kind === 'member' && source.groupId === row.id ? source.item : null
  const swapWith = target?.kind === 'swap' && target.groupId === row.id ? target.item : null
  const move = (member: GroupMember, index: number) => {
    splits.drop({ kind: 'move', groupId: row.id, item: member.item, index })
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-member-line="${CSS.escape(member.item)}"] [data-member-focus]`)?.focus())
  }
  const remove = (member: GroupMember) => splits.drop({ kind: 'leave', groupId: row.id, item: member.item })
  const memberMenu = (member: GroupMember, index: number): MenuItem[] => [
    { label: 'Focus pane', icon: 'select', group: 'open', onSelect: () => splits.focusMember(row.id, member.item) },
    ...(index > 0 ? [{ label: 'Move up', icon: 'moveOut', group: 'organise', onSelect: () => move(member, index - 1) } satisfies MenuItem] : []),
    ...(index < row.members.length - 1 ? [{ label: 'Move down', icon: 'bottom', group: 'organise', onSelect: () => move(member, index + 1) } satisfies MenuItem] : []),
    { label: 'Remove from split', icon: 'unsplit', group: 'danger', onSelect: () => remove(member) },
  ]
  return createPortal(
    <div
      role="dialog"
      aria-label={`Split ${row.title}`}
      data-split-hover={row.id}
      // React carries a portal's events to the group row; a press or right click here is the hover's own.
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={{ left: anchor.right + 8, top }}
      className="glass motion-fade fixed z-[60] w-64 rounded-[14px] border border-white/[0.1] p-2 shadow-2xl"
    >
      <div className="flex items-center gap-2 px-1.5 pb-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-200">{row.title}</span>
        <span className="shrink-0 text-[11px] text-ink-400 tabular-nums">{row.members.length} panes</span>
      </div>
      <div className="flex justify-center pb-2">
        <LayoutGlyph row={row} width={232} height={Math.round(232 * 0.6)} onCell={(member) => splits.focusMember(row.id, member.item)} swapWith={swapWith} dragged={dragged} />
      </div>
      <ul ref={list} className="max-h-[50vh] space-y-0.5 overflow-y-auto">
        {row.members.map((member, index) => (
          <li
            key={member.item}
            data-member-line={member.item}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onMenu(event, memberMenu(member, index))
            }}
            className={`group/line flex h-7 items-center gap-1 rounded-[9px] pr-0.5 transition-colors hover:bg-row-hover ${dragged === member.item ? 'bg-accent/[0.12] ring-1 ring-accent/60 ring-inset' : ''}`}
          >
            <span
              onPointerDown={(event) => drag.start(event, { kind: 'member', groupId: row.id, item: member.item, label: member.title })}
              title="Drag to reorder, onto the map to swap, or out to remove"
              className="flex h-full w-4 shrink-0 cursor-grab items-center justify-center text-ink-500 group-hover/line:text-ink-300 active:cursor-grabbing"
            >
              <DragHandle />
            </span>
            <button
              type="button"
              data-member-focus=""
              onClick={() => splits.focusMember(row.id, member.item)}
              onPointerDown={(event) => drag.start(event, { kind: 'member', groupId: row.id, item: member.item, label: member.title })}
              onKeyDown={(event) => {
                if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
                event.preventDefault()
                move(member, index + (event.key === 'ArrowUp' ? -1 : 1))
              }}
              aria-label={`${index + 1}. ${member.title}`}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-[7px] text-left text-[12.5px] focus-visible:outline-2 focus-visible:outline-accent ${member.focused && row.active ? 'text-ink-100' : 'text-ink-300'}`}
            >
              <span className="w-3 shrink-0 text-right text-[10.5px] text-ink-400 tabular-nums">{index + 1}</span>
              <MemberMarkIcon mark={member.mark} state={member.state} />
              <span className="min-w-0 flex-1 truncate">{member.title}</span>
              <span className={`size-1.5 shrink-0 rounded-full ${stateDot[member.state]} group-hover/line:hidden group-focus-within/line:hidden`} aria-label={member.state} />
            </button>
            <span className="hidden shrink-0 items-center group-focus-within/line:flex group-hover/line:flex">
              <button type="button" aria-label={`Manage ${member.title}`} title="More" aria-haspopup="menu" onClick={(event) => onMenu(event, memberMenu(member, index))} className={lineAction}>
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
                  <circle cx="3.5" cy="8" r="1.3" />
                  <circle cx="8" cy="8" r="1.3" />
                  <circle cx="12.5" cy="8" r="1.3" />
                </svg>
              </button>
              <button type="button" aria-label={`Remove ${member.title} from the split`} title="Remove from split" onClick={() => remove(member)} className={lineAction}>
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  )
}

const lineAction = 'grid size-5 place-items-center rounded-full text-ink-400 transition-colors hover:bg-white/[0.1] hover:text-ink-100'

/**
 * The hover's member lines slide to a new place whenever the members reorder, by key or drag: each
 * commit compares every line's top with where it was after the last one. Reduced motion skips it.
 */
function useSlidingLines(list: RefObject<HTMLElement | null>) {
  const tops = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const lines = [...(list.current?.querySelectorAll<HTMLElement>('[data-member-line]') ?? [])]
    const now = new Map(lines.map((line) => [line.dataset.memberLine ?? '', line.getBoundingClientRect().top]))
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const line of lines) {
        const before = tops.current.get(line.dataset.memberLine ?? '')
        const delta = before === undefined ? 0 : before - (now.get(line.dataset.memberLine ?? '') ?? before)
        if (Math.abs(delta) >= 1) line.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' })
      }
    }
    tops.current = now
  })
}

/** The Splits header and the groups whose members span worktrees; nothing when there are none. */
export function SpanningSplits({ onMenu, end, drag }: { onMenu: (event: MouseEvent<HTMLElement>, items: MenuItem[]) => void; end: (items: MenuItem[]) => ReactNode; drag: GroupDrag }) {
  const splits = useSplitRows()
  if (splits === null || splits.spanning.length === 0) return null
  return (
    <section aria-label="Splits" className="space-y-0.5">
      <h3 className="px-2.5 pb-0.5 text-[11.5px] font-semibold tracking-[0.02em] text-ink-400">Splits</h3>
      {splits.spanning.map((row) => (
        <GroupRowView key={row.id} row={row} indent="top" onMenu={onMenu} end={end} drag={drag} />
      ))}
    </section>
  )
}
