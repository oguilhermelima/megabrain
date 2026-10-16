import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { MenuItem } from '@/components/ContextMenu'
import { AgentIcon } from '@/components/agent-icons'
import { MenuIconGlyph } from '@/components/menu-icons'
import { CodeIcon, PlusIcon } from '@/advanced/chrome'
import { visibleMarks, type GroupMember, type GroupRow, type MemberMark, type MemberState } from '@/advanced/split-rows'
import type { SidebarDrag } from '@/advanced/Sidebar'
import { TerminalIcon } from '@/terminal/TerminalIcon'

// Split groups in the sidebar (see split-rows.ts): one row per group under its worktree, or under a
// Splits header when its members span worktrees. Advanced owns the layout and provides this context;
// the rows read it, so the memoised sidebar does not re-render for it.

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

/** The arrangement in miniature: one cell per member, the focused one filled. */
export function LayoutGlyph({ row, width, height, onCell }: { row: GroupRow; width: number; height: number; onCell?: (member: GroupMember) => void }) {
  const gap = width > 40 ? 3 : 1.5
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden={onCell === undefined ? 'true' : undefined} className="shrink-0">
      {row.glyph.map(({ item, rect }, index) => {
        const member = row.members.find((candidate) => candidate.item === item)
        const focused = member?.focused === true && row.active
        return (
          <rect
            key={item}
            x={rect.x * width + gap / 2}
            y={rect.y * height + gap / 2}
            width={Math.max(1, rect.width * width - gap)}
            height={Math.max(1, rect.height * height - gap)}
            rx={width > 40 ? 3 : 1.5}
            onClick={onCell === undefined || member === undefined ? undefined : () => onCell(member)}
            className={`${focused ? 'fill-accent/60 stroke-accent' : 'fill-white/[0.06] stroke-ink-400'} ${onCell === undefined ? '' : 'cursor-pointer hover:fill-white/[0.16]'}`}
            strokeWidth={1}
          >
            {onCell !== undefined && member !== undefined && <title>{`${index + 1}. ${member.title}`}</title>}
          </rect>
        )
      })}
    </svg>
  )
}

/** How many member marks a row shows before +N. */
const maxMarks = 4
const hoverDelayMs = 350
const leaveDelayMs = 160

/**
 * A split group's row: its layout glyph, its members' marks (each focuses that pane), its name or the
 * members' titles, and its strongest state. A click shows the split; hovering shows every member.
 * `end` is the row's … button, drawn by the sidebar.
 */
export function GroupRowView({ row, indent, onMenu, end }: { row: GroupRow; indent: 'worktree' | 'top'; onMenu: (event: MouseEvent<HTMLElement>, items: MenuItem[]) => void; end: (items: MenuItem[]) => ReactNode }) {
  const splits = useSplitRows()
  const [renaming, setRenaming] = useState(false)
  const [hover, setHover] = useState<DOMRect | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  if (splits === null) return null
  const items = splits.groupMenu(row, () => setRenaming(true))
  const marks = visibleMarks(row.members, maxMarks)
  const padding = indent === 'worktree' ? 'pl-[29px]' : 'pl-2.5'
  const later = (run: () => void, ms: number) => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(run, ms)
  }
  const enter = () => later(() => setHover(anchor.current?.getBoundingClientRect() ?? null), hover === null ? hoverDelayMs : 0)
  const leave = () => later(() => setHover(null), leaveDelayMs)

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
    <div ref={anchor} className="group relative" data-split-group={row.id} onContextMenu={(event) => onMenu(event, items)} onPointerEnter={enter} onPointerLeave={leave}>
      <div
        className={`flex h-8 w-full items-center gap-1.5 rounded-[12px] pr-1.5 text-[13px] transition-colors ${padding} ${
          row.active ? 'bg-row-selected text-ink-100' : row.state === 'ended' ? 'text-ink-400 hover:bg-row-hover hover:text-ink-200' : 'text-ink-300 hover:bg-row-hover hover:text-ink-100'
        }`}
      >
        <button type="button" onClick={() => splits.focusGroup(row.id)} aria-current={row.active ? 'true' : undefined} aria-label={`Show split ${row.title}`} className="flex shrink-0 items-center rounded-[4px] focus-visible:outline-2 focus-visible:outline-accent">
          <LayoutGlyph row={row} width={16} height={12} />
        </button>
        <span className="flex shrink-0 items-center gap-0.5 rounded-[8px] bg-white/[0.05] px-1 py-0.5">
          {marks.shown.map((member) => (
            <button
              key={member.item}
              type="button"
              onClick={() => splits.focusMember(row.id, member.item)}
              aria-label={`Focus ${member.title}`}
              title={member.title}
              className={`flex size-[18px] items-center justify-center rounded-[5px] transition-colors hover:bg-white/[0.1] ${member.focused && row.active ? 'bg-white/[0.1]' : ''}`}
            >
              <MemberMarkIcon mark={member.mark} state={member.state} />
            </button>
          ))}
          {marks.more > 0 && <span className="px-0.5 text-[10.5px] font-medium text-ink-400 tabular-nums">+{marks.more}</span>}
        </span>
        <button type="button" onClick={() => splits.focusGroup(row.id)} title={`${row.title}\n${row.members.length} panes`} className="min-w-0 flex-1 truncate text-left focus-visible:outline-2 focus-visible:outline-accent">
          {row.title}
        </button>
        <span className="w-[30px] shrink-0 group-focus-within:invisible group-hover:invisible group-data-[menu-open]:invisible" />
        <span className={`size-1.5 shrink-0 rounded-full ${stateDot[row.state]} group-focus-within:invisible group-hover:invisible group-data-[menu-open]:invisible`} aria-label={row.state} />
      </div>
      <span className="absolute top-1/2 right-0.5 flex -translate-y-1/2 items-center">{end(items)}</span>
      {hover !== null && <HoverPreview row={row} anchor={hover} onEnter={() => later(() => {}, 0)} onLeave={leave} />}
    </div>
  )
}

/** Every member of a group with its state, and the layout to click into; it sits beside the row. */
function HoverPreview({ row, anchor, onEnter, onLeave }: { row: GroupRow; anchor: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const splits = useSplitRows()
  if (splits === null) return null
  const top = Math.max(8, Math.min(anchor.top - 8, window.innerHeight - 120 - row.members.length * 28))
  return createPortal(
    <div
      role="dialog"
      aria-label={`Split ${row.title}`}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={{ left: anchor.right + 8, top }}
      className="glass fixed z-[60] w-64 rounded-[14px] border border-white/[0.1] p-2 shadow-2xl"
    >
      <div className="flex items-center gap-2 px-1.5 pb-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-200">{row.title}</span>
        <span className="shrink-0 text-[11px] text-ink-400 tabular-nums">{row.members.length} panes</span>
      </div>
      <div className="flex justify-center pb-2">
        <LayoutGlyph row={row} width={232} height={Math.round(232 * 0.6)} onCell={(member) => splits.focusMember(row.id, member.item)} />
      </div>
      <ul className="max-h-[50vh] space-y-0.5 overflow-y-auto">
        {row.members.map((member, index) => (
          <li key={member.item}>
            <button
              type="button"
              onClick={() => splits.focusMember(row.id, member.item)}
              className={`flex h-7 w-full items-center gap-2 rounded-[9px] px-1.5 text-left text-[12.5px] transition-colors hover:bg-row-hover ${member.focused && row.active ? 'text-ink-100' : 'text-ink-300'}`}
            >
              <span className="w-3 shrink-0 text-right text-[10.5px] text-ink-400 tabular-nums">{index + 1}</span>
              <MemberMarkIcon mark={member.mark} state={member.state} />
              <span className="min-w-0 flex-1 truncate">{member.title}</span>
              <span className={`size-1.5 shrink-0 rounded-full ${stateDot[member.state]}`} aria-label={member.state} />
            </button>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  )
}

/** The Splits header and the groups whose members span worktrees; nothing when there are none. */
export function SpanningSplits({ onMenu, end }: { onMenu: (event: MouseEvent<HTMLElement>, items: MenuItem[]) => void; end: (items: MenuItem[]) => ReactNode }) {
  const splits = useSplitRows()
  if (splits === null || splits.spanning.length === 0) return null
  return (
    <section aria-label="Splits" className="space-y-0.5">
      <h3 className="px-2.5 pb-0.5 text-[11.5px] font-semibold tracking-[0.02em] text-ink-400">Splits</h3>
      {splits.spanning.map((row) => (
        <GroupRowView key={row.id} row={row} indent="top" onMenu={onMenu} end={end} />
      ))}
    </section>
  )
}
