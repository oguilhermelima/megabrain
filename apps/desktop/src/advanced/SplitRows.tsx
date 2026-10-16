import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { MenuItem } from '@/components/ContextMenu'
import { AgentIcon } from '@/components/agent-icons'
import { MenuIconGlyph } from '@/components/menu-icons'
import { CodeIcon, PlusIcon } from '@/advanced/chrome'
import { visibleMarks, type GroupMember, type GroupRow, type MemberMark, type MemberState } from '@/advanced/split-rows'
import type { SidebarDrag } from '@/advanced/Sidebar'
import type { JoinTarget, MapCell, RowDragStart, RowDragState } from '@/advanced/useRowDrag'
import { arrangePane, type ArrangeTarget } from '@/panes/arrange'
import { focusDirection, paneRects, resizeSplit, type Direction, type Divider, type Edge, type Panes, type Rect } from '@/panes/pane-model'
import { TerminalIcon } from '@/terminal/TerminalIcon'

// Split groups in the sidebar (see split-rows.ts): one row per group under its worktree, or under a
// Splits header when its members span worktrees. Advanced owns the layout and provides this context;
// the rows read it, so the memoised sidebar does not re-render for it.

/** A change to the groups from the sidebar: a row or group joined, a member leaving, or the layout edited on the hover's map. */
export type SplitDrop =
  | { kind: 'join'; source: JoinTarget; target: JoinTarget }
  | { kind: 'leave'; groupId: string; item: string }
  /** A member dropped on a cell's zone or a side of the map, or moved there from its menu. */
  | { kind: 'arrange'; groupId: string; item: string; target: ArrangeTarget }
  /** A member moved one step with Shift and an arrow key. */
  | { kind: 'shift'; groupId: string; item: string; direction: Direction }
  /** A divider of the map dragged: the group's panes as they now are. */
  | { kind: 'resize'; groupId: string; panes: Panes }

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
  /** Joins, removes or arranges, from the hover's map, menus and keys as from a drag. */
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

/** The arrangement in miniature: one cell per member, the focused one filled. */
export function LayoutGlyph({ row, width, height }: { row: GroupRow; width: number; height: number }) {
  const gap = width > 40 ? 3 : 1.5
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" className="shrink-0">
      {row.glyph.map(({ item, rect }) => {
        const focused = row.members.find((candidate) => candidate.item === item)?.focused === true && row.active
        return (
          <rect
            key={item}
            x={rect.x * width + gap / 2}
            y={rect.y * height + gap / 2}
            width={Math.max(1, rect.width * width - gap)}
            height={Math.max(1, rect.height * height - gap)}
            rx={width > 40 ? 3 : 1.5}
            className={focused ? 'fill-accent/60 stroke-accent' : 'fill-white/[0.06] stroke-ink-400'}
            strokeWidth={1}
          />
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

const mapWidth = 264
const mapHeight = 168
/** The margin round the map's cells: dropping a cell in it spans that side of the group. */
const mapPad = 12

const arrowDirections: Readonly<Record<string, Direction>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/**
 * A group's hover: its layout as a map to edit in place, and a line naming the cell under the
 * pointer (or the focused one). See SplitMap.
 */
function HoverPreview({ row, anchor, drag, onMenu, onEnter, onLeave }: { row: GroupRow; anchor: DOMRect; drag: GroupDrag; onMenu: (event: MouseEvent<HTMLElement>, items: MenuItem[]) => void; onEnter: () => void; onLeave: () => void }) {
  const splits = useSplitRows()
  const [named, setNamed] = useState<string | null>(null)
  if (splits === null) return null
  const height = mapHeight + 2 * mapPad + 96
  const top = Math.max(8, Math.min(anchor.top - 8, window.innerHeight - height - 8))
  const shown = row.members.find((member) => member.item === named) ?? row.members.find((member) => member.focused) ?? row.members[0]
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
      className="glass motion-fade fixed z-[60] rounded-[14px] border border-white/[0.1] p-2 shadow-2xl"
    >
      <div className="flex items-center gap-2 px-1.5 pb-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-200">{row.title}</span>
        <span className="shrink-0 text-[11px] text-ink-400 tabular-nums">{row.members.length} panes</span>
      </div>
      <SplitMap row={row} drag={drag} onMenu={onMenu} onName={setNamed} />
      {shown !== undefined && (
        <div aria-live="polite" className="flex h-7 items-center gap-2 px-1.5 text-[12.5px] text-ink-200">
          <MemberMarkIcon mark={shown.mark} state={shown.state} />
          <span className="min-w-0 flex-1 truncate">{shown.title}</span>
          <span className={`size-1.5 shrink-0 rounded-full ${stateDot[shown.state]}`} aria-label={shown.state} />
        </div>
      )}
      <p className="px-1.5 pb-0.5 text-[11px] leading-snug text-ink-400">Drag a pane onto another or onto an edge. Right-click for more.</p>
    </div>,
    document.body,
  )
}

/** Where a member is dropped and what the map then looks like, while one of this group's members is dragged over it. */
function mapDrag(row: GroupRow, drag: GroupDrag): { item: string; target: ArrangeTarget | null; preview: { item: string; rect: Rect }[] } | null {
  const source = drag.drag?.source ?? null
  if (source?.kind !== 'member' || source.groupId !== row.id) return null
  const dropped = drag.drag?.target
  const target = dropped?.kind === 'arrange' && dropped.groupId === row.id ? dropped.target : null
  const paneId = row.members.find((member) => member.item === source.item)?.paneId
  if (target === null || paneId === undefined) return { item: source.item, target: null, preview: row.glyph }
  return { item: source.item, target, preview: paneRects(arrangePane(row.panes, paneId, target).root).panes.map(({ item, rect }) => ({ item, rect })) }
}

const sideMoves: { side: Edge; label: string; icon: 'splitBottom' | 'splitTop' | 'splitMain' | 'splitRight' }[] = [
  { side: 'bottom', label: 'Move to bottom (full width)', icon: 'splitBottom' },
  { side: 'top', label: 'Move to top (full width)', icon: 'splitTop' },
  { side: 'left', label: 'Move left (full height)', icon: 'splitMain' },
  { side: 'right', label: 'Move right (full height)', icon: 'splitRight' },
]

/**
 * The group's layout to edit in place. Drag a cell onto another: an outer third splits beside it,
 * the middle swaps the two; onto the margin to span that whole side of the group; out to the sidebar
 * to remove it. The cells show the result live while dragging. Drag a divider to resize; right-click
 * a cell for its moves. Arrow keys move focus between cells, Shift and an arrow move the focused one.
 */
function SplitMap({ row, drag, onMenu, onName }: { row: GroupRow; drag: GroupDrag; onMenu: (event: MouseEvent<HTMLElement>, items: MenuItem[]) => void; onName: (item: string | null) => void }) {
  const splits = useSplitRows()
  const map = useRef<HTMLDivElement>(null)
  if (splits === null) return null
  const dragging = mapDrag(row, drag)
  const rects = dragging?.preview ?? row.glyph
  const side = dragging?.target?.kind === 'side' ? dragging.target.side : null
  const aimed = dragging?.target?.kind === 'pane' ? dragging.target.paneId : null
  const inner = { width: mapWidth, height: mapHeight }
  const cells: MapCell[] = row.cells.flatMap(({ paneId, rect }) => {
    const item = row.members.find((member) => member.paneId === paneId)?.item
    return item === undefined ? [] : [{ paneId, item, rect }]
  })
  const focusCell = (item: string) => requestAnimationFrame(() => map.current?.querySelector<HTMLElement>(`[data-member-cell="${CSS.escape(item)}"]`)?.focus())
  const arrange = (member: GroupMember, target: ArrangeTarget) => {
    splits.drop({ kind: 'arrange', groupId: row.id, item: member.item, target })
    focusCell(member.item)
  }
  const cellMenu = (member: GroupMember): MenuItem[] => [
    { label: 'Focus pane', icon: 'select', group: 'open', onSelect: () => splits.focusMember(row.id, member.item) },
    ...sideMoves.map(({ side: edge, label, icon }): MenuItem => ({ label, icon, group: 'organise', onSelect: () => arrange(member, { kind: 'side', side: edge }) })),
    { label: 'Remove from split', icon: 'unsplit', group: 'danger', onSelect: () => splits.drop({ kind: 'leave', groupId: row.id, item: member.item }) },
  ]
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, member: GroupMember) => {
    const direction = arrowDirections[event.key]
    if (direction === undefined) return
    event.preventDefault()
    if (event.shiftKey) {
      splits.drop({ kind: 'shift', groupId: row.id, item: member.item, direction })
      focusCell(member.item)
      return
    }
    const next = focusDirection({ ...row.panes, focused: member.paneId }, direction).focused
    const item = row.members.find((candidate) => candidate.paneId === next)?.item
    if (item !== undefined && item !== member.item) focusCell(item)
  }
  return (
    <div
      ref={map}
      role="group"
      aria-label={`Layout of ${row.title}`}
      data-split-map={JSON.stringify(cells)}
      data-pad={mapPad}
      style={{ width: mapWidth + 2 * mapPad, height: mapHeight + 2 * mapPad }}
      className="relative mx-auto rounded-[10px] bg-black/20"
      onPointerLeave={() => onName(null)}
    >
      {dragging !== null && (['top', 'bottom', 'left', 'right'] as const).map((edge) => <MapSide key={edge} edge={edge} lit={side === edge} />)}
      {rects.map(({ item, rect }) => {
        const member = row.members.find((candidate) => candidate.item === item)
        if (member === undefined) return null
        const box = { left: mapPad + rect.x * inner.width, top: mapPad + rect.y * inner.height, width: rect.width * inner.width, height: rect.height * inner.height }
        const moved = dragging?.item === item
        const target = aimed !== null && aimed === member.paneId
        return (
          <button
            key={item}
            type="button"
            data-member-cell={item}
            aria-label={member.title}
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown"
            onClick={() => splits.focusMember(row.id, item)}
            onPointerDown={(event) => drag.start(event, { kind: 'member', groupId: row.id, item, label: member.title })}
            onPointerEnter={() => onName(item)}
            onFocus={() => onName(item)}
            onKeyDown={(event) => onKey(event, member)}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onMenu(event, cellMenu(member))
            }}
            style={{ ...box, transition: 'left var(--motion-panel) var(--motion-ease-panel), top var(--motion-panel) var(--motion-ease-panel), width var(--motion-panel) var(--motion-ease-panel), height var(--motion-panel) var(--motion-ease-panel)' }}
            className="group/cell absolute p-[2px] focus-visible:outline-none"
          >
            <span
              className={`flex size-full cursor-grab items-center justify-center gap-1 overflow-hidden rounded-[6px] border px-1 transition-colors active:cursor-grabbing ${
                moved ? 'border-accent bg-accent/30' : target ? 'border-accent bg-accent/20' : member.focused && row.active ? 'border-accent/80 bg-accent/25' : 'border-white/[0.14] bg-white/[0.06] hover:bg-white/[0.12]'
              } group-focus-visible/cell:ring-2 group-focus-visible/cell:ring-accent`}
            >
              {box.width >= 22 && box.height >= 18 && <MemberMarkIcon mark={member.mark} state={member.state} />}
              {box.width >= 64 && box.height >= 26 && <span className="min-w-0 truncate text-[11px] text-ink-200">{member.title}</span>}
            </span>
          </button>
        )
      })}
      {dragging === null && row.dividers.map((divider) => <MapDivider key={`${divider.splitId}:${divider.index}`} divider={divider} panes={row.panes} onResize={(panes) => splits.drop({ kind: 'resize', groupId: row.id, panes })} />)}
    </div>
  )
}

/** The margin along one side of the map while a cell is dragged: a drop there spans that whole side; lit while the pointer is in it. */
function MapSide({ edge, lit }: { edge: Edge; lit: boolean }) {
  const across = edge === 'top' || edge === 'bottom'
  const style: CSSProperties = across ? { left: mapPad, right: mapPad, height: mapPad - 3, [edge]: 1 } : { top: mapPad, bottom: mapPad, width: mapPad - 3, [edge]: 1 }
  return <span aria-hidden="true" data-map-side={edge} style={style} className={`pointer-events-none absolute rounded-full transition-colors duration-100 ${lit ? 'bg-accent' : 'bg-accent/25'}`} />
}

/** The smallest a cell may get when a divider on the map is dragged, in map pixels. */
const minCell = 18

/** A divider between cells of the map: drag it to resize those panes. The pointer is captured, so the hover stays open however far it goes. */
function MapDivider({ divider, panes, onResize }: { divider: Divider; panes: Panes; onResize: (panes: Panes) => void }) {
  const row = divider.direction === 'row'
  const span = row ? divider.split.width * mapWidth : divider.split.height * mapHeight
  const style: CSSProperties = row
    ? { left: mapPad + divider.at * mapWidth - 3, top: mapPad + divider.split.y * mapHeight, height: divider.split.height * mapHeight, width: 6 }
    : { top: mapPad + divider.at * mapHeight - 3, left: mapPad + divider.split.x * mapWidth, width: divider.split.width * mapWidth, height: 6 }
  const start = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || span <= 0) return
    event.preventDefault()
    event.stopPropagation()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    // Each move resizes from the tree at the press, so the divider follows the pointer without drift.
    const origin = row ? event.clientX : event.clientY
    const onMove = (move: globalThis.PointerEvent) => onResize(resizeSplit(panes, divider.splitId, divider.index, ((row ? move.clientX : move.clientY) - origin) / span, minCell / span))
    const onUp = () => {
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerup', onUp)
      element.removeEventListener('pointercancel', onUp)
    }
    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerup', onUp)
    element.addEventListener('pointercancel', onUp)
  }
  return (
    <span
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      onPointerDown={start}
      style={style}
      className={`absolute z-10 rounded-full transition-colors hover:bg-accent/60 ${row ? 'cursor-col-resize' : 'cursor-row-resize'}`}
    />
  )
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
