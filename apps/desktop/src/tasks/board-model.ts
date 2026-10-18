import type { GithubProjectColor, GithubProjectItem, GithubProjectStatusField } from '@/api/schema'

// What the Tasks board computes from a GitHub Projects board: its columns, and the moves it shows
// before GitHub answers. A move shows at once as pending over the items as last read; when GitHub
// answers, the item it returns replaces the read one, and when it fails the pending move is dropped,
// which puts the card back where it was.

/** GitHub's colours for a single-select option, as its dark theme draws them. */
export const statusColors: Record<GithubProjectColor, string> = {
  GRAY: '#9198a1',
  BLUE: '#4493f8',
  GREEN: '#3fb950',
  YELLOW: '#d29922',
  ORANGE: '#db6d28',
  RED: '#f85149',
  PINK: '#db61a2',
  PURPLE: '#ab7df8',
}

export interface BoardColumn {
  /** The Status option's id; null for the items with no status. */
  id: string | null
  name: string
  color: string
  items: GithubProjectItem[]
}

/**
 * The board's columns: No status first, as GitHub draws it, then one per Status option in the
 * project's order. An item keeps its read order within its column; one whose option no longer
 * exists has no status.
 */
export function boardColumns(field: GithubProjectStatusField, items: readonly GithubProjectItem[]): BoardColumn[] {
  const columns: BoardColumn[] = [{ id: null, name: 'No status', color: statusColors.GRAY, items: [] }, ...field.options.map((option) => ({ id: option.id, name: option.name, color: statusColors[option.color], items: [] }))]
  const byId = new Map(columns.map((column) => [column.id, column]))
  for (const item of items) (byId.get(item.status) ?? columns[0])?.items.push(item)
  return columns
}

export interface PendingMove {
  /** Tells moves apart, so an answer settles its own. */
  id: number
  itemId: string
  status: string
}

/** The items as the board shows them: each pending move applied, in the order made. */
export function shownItems(items: readonly GithubProjectItem[], pending: readonly PendingMove[]): GithubProjectItem[] {
  if (pending.length === 0) return [...items]
  return items.map((item) => pending.reduce((shown, move) => (move.itemId === item.id ? { ...shown, status: move.status } : shown), item))
}

/** Whether moving the item to `status` changes anything as the board shows it. */
export function movesItem(items: readonly GithubProjectItem[], pending: readonly PendingMove[], itemId: string, status: string): boolean {
  const item = shownItems(items, pending).find((entry) => entry.id === itemId)
  return item !== undefined && item.status !== status
}

/** GitHub confirmed a move: the item it answers with replaces the one read. */
export function answeredItems(items: readonly GithubProjectItem[], answer: GithubProjectItem): GithubProjectItem[] {
  return items.map((item) => (item.id === answer.id ? answer : item))
}

/** GitHub answered move `moveId`, either way: it stops pending. Dropped after a failure, it puts the card back where it was read. */
export function withoutMove(pending: readonly PendingMove[], moveId: number): PendingMove[] {
  return pending.filter((move) => move.id !== moveId)
}

/** The repository an item belongs to, when it is not the one the page shows; null otherwise. */
export function otherRepository(item: Pick<GithubProjectItem, 'repository'>, shown: string): string | null {
  return item.repository === null || item.repository.toLowerCase() === shown.toLowerCase() ? null : item.repository
}
