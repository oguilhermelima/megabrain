import { paneList, paneRects, type Rect } from '@/panes/pane-model'
import type { Layout } from '@/panes/split-groups'

// A split group in the sidebar is one row, as Zen draws a split view as one combined tab: the
// members' marks side by side, a glyph of the arrangement, the group's name or its members' titles
// joined, and the strongest state among them. The members' own rows are hidden while they are in it.

export type MemberState = 'waiting' | 'working' | 'idle' | 'ended'

export type MemberMark = { kind: 'agent'; agent: string } | { kind: 'terminal' } | { kind: 'launcher' } | { kind: 'code' } | { kind: 'github' }

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
    return {
      id: group.id,
      name: group.name,
      title: joinedTitle(group.name, members.map((member) => member.title)),
      members,
      state: strongestState(members.map((member) => member.state)),
      worktree: worktrees.size === 1 && only !== undefined ? only : null,
      active: layout.active === group.id,
      glyph: paneRects(group.panes.root).panes.map(({ item, rect }) => ({ item, rect })),
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
