import { paneList, paneRects, type Divider, type Panes, type Rect } from '@/panes/pane-model'
import type { Layout } from '@/panes/split-groups'

// A split group in the sidebar is one row, as Zen draws a split view as one combined tab: the
// members' marks side by side, a glyph of the arrangement, the group's name or its members' titles
// joined, and the strongest state among them. The members' own rows are hidden while they are in it.

export type MemberState = 'waiting' | 'working' | 'idle' | 'ended'

export type MemberMark = { kind: 'agent'; agent: string } | { kind: 'terminal' } | { kind: 'launcher' } | { kind: 'code' } | { kind: 'github' } | { kind: 'project' } | { kind: 'summary' } | { kind: 'artifact' }

/** What the sidebar knows about an item a pane shows. */
export interface MemberInfo {
  title: string
  mark: MemberMark
  state: MemberState
  /** The worktree it works in; null for one in none yet (a launcher before it picks one). */
  worktree: string | null
}

export interface GroupMember extends MemberInfo {
  item: string
  paneId: string
  focused: boolean
}

export interface GroupRow {
  id: string
  name: string | null
  /** The name, or the members' titles joined. */
  title: string
  /** In reading order: left to right, top to bottom. */
  members: GroupMember[]
  state: MemberState
  /** The one worktree its members work in; null when they span several (or none has one). */
  worktree: string | null
  /** Whether the main area shows it. */
  active: boolean
  /** Each member's place in the unit square, for the mini layout. */
  glyph: { item: string; rect: Rect }[]
  /** The same places by pane, as the map in the hover hit-tests a drop against them. */
  cells: { paneId: string; rect: Rect }[]
  /** The dividers between the cells, in the unit square, for resizing on the map. */
  dividers: Divider[]
  /** The group's tree, which the map arranges and previews. */
  panes: Panes
}

const strength: Record<MemberState, number> = { waiting: 3, working: 2, idle: 1, ended: 0 }

/** Waiting on the person beats working, which beats idle, which beats ended. */
export function strongestState(states: readonly MemberState[]): MemberState {
  let best: MemberState = 'ended'
  for (const state of states) if (strength[state] > strength[best]) best = state
  return best
}

export function joinedTitle(name: string | null, titles: readonly string[]): string {
  const trimmed = name?.trim() ?? ''
  return trimmed === '' ? titles.join(' + ') : trimmed
}

/** The marks a row has room for: all up to `max`, else `max - 1` and a +N for the rest. */
export function visibleMarks<T>(members: readonly T[], max: number): { shown: T[]; more: number } {
  if (members.length <= max) return { shown: [...members], more: 0 }
  const shown = members.slice(0, Math.max(0, max - 1))
  return { shown, more: members.length - shown.length }
}

export function groupRows(layout: Layout, describe: (item: string) => MemberInfo): GroupRow[] {
  return layout.groups.map((group) => {
    const members = paneList(group.panes.root).map((leaf): GroupMember => ({ ...describe(leaf.item), item: leaf.item, paneId: leaf.id, focused: leaf.id === group.panes.focused }))
    const worktrees = new Set(members.flatMap((member) => (member.worktree === null ? [] : [member.worktree])))
    const [only] = worktrees
    const rects = paneRects(group.panes.root)
    return {
      id: group.id,
      name: group.name,
      title: joinedTitle(group.name, members.map((member) => member.title)),
      members,
      state: strongestState(members.map((member) => member.state)),
      worktree: worktrees.size === 1 && only !== undefined ? only : null,
      active: layout.active === group.id,
      glyph: rects.panes.map(({ item, rect }) => ({ item, rect })),
      cells: rects.panes.map(({ id, rect }) => ({ paneId: id, rect })),
      dividers: rects.dividers,
      panes: group.panes,
    }
  })
}

/** The rows under each worktree, and the ones under the Splits header. */
export function groupsByPlace(rows: readonly GroupRow[]): { byWorktree: Map<string, GroupRow[]>; spanning: GroupRow[] } {
  const byWorktree = new Map<string, GroupRow[]>()
  const spanning: GroupRow[] = []
  for (const row of rows) {
    if (row.worktree === null) spanning.push(row)
    else byWorktree.set(row.worktree, [...(byWorktree.get(row.worktree) ?? []), row])
  }
  return { byWorktree, spanning }
}

/**
 * Which part of a sidebar row a dragged row is over: its top quarter goes before it, its bottom
 * quarter after, and the middle band joins the two into a split. A row the drag cannot reorder
 * against joins over all of it; one it cannot join splits at its middle.
 */
export function rowDropZone(row: { top: number; bottom: number }, y: number, can: { reorder?: boolean; join?: boolean } = {}): 'before' | 'join' | 'after' {
  const reorder = can.reorder ?? true
  const join = can.join ?? true
  if (!reorder) return 'join'
  const height = row.bottom - row.top
  if (!join) return y < row.top + height / 2 ? 'before' : 'after'
  if (y < row.top + height / 4) return 'before'
  if (y > row.bottom - height / 4) return 'after'
  return 'join'
}
