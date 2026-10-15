// The order the person dragged their projects into, kept per viewer as a list of project paths.
// Hidden projects stay in the list, so showing one again puts it back where it was; projects the
// list does not know yet go to the end.

export type Placement = 'before' | 'after'

/** A saved order, or an empty one when nothing usable was saved. */
export function parseOrder(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/** The saved order limited to projects that still exist, with new ones appended as they arrive. */
export function reconcileOrder(saved: string[], current: string[]): string[] {
  const present = new Set(current)
  const kept = saved.filter((path) => present.has(path))
  const known = new Set(kept)
  return [...kept, ...current.filter((path) => !known.has(path))]
}

/** Sorts projects by the saved order; ones it does not name keep their incoming order at the end. */
export function applyOrder<T extends { path: string }>(items: T[], saved: string[]): T[] {
  const rank = new Map(saved.map((path, index) => [path, index]))
  const at = (item: T, index: number) => rank.get(item.path) ?? saved.length + index
  return items
    .map((item, index) => ({ item, key: at(item, index) }))
    .sort((left, right) => left.key - right.key)
    .map(({ item }) => item)
}

/** Moves `source` next to `target`; either may be missing from `order`, and is appended first. */
export function moveProject(order: string[], source: string, target: string, placement: Placement): string[] {
  if (source === target) return order
  const full = reconcileOrder(order, [...order, source, target])
  const without = full.filter((path) => path !== source)
  const index = without.indexOf(target)
  without.splice(placement === 'before' ? index : index + 1, 0, source)
  return without
}

/** Moves a project one place up (-1) or down (1) among the visible ones, hidden ones keeping their place. */
export function stepProject(order: string[], visible: string[], path: string, step: -1 | 1): string[] {
  const neighbour = visible[visible.indexOf(path) + step]
  if (!visible.includes(path) || neighbour === undefined) return order
  return moveProject(order, path, neighbour, step === -1 ? 'before' : 'after')
}

export interface DropRow {
  path: string
  top: number
  bottom: number
}

/** Where a project dragged to `y` lands: the half of a row it is over, or after the row above a gap. */
export function dropTarget(rows: DropRow[], y: number): { path: string; placement: Placement } | null {
  const first = rows[0]
  if (first === undefined) return null
  if (y < first.top) return { path: first.path, placement: 'before' }
  let above = first
  for (const row of rows) {
    if (y < row.top) break
    above = row
    if (y <= row.bottom) return { path: row.path, placement: y < (row.top + row.bottom) / 2 ? 'before' : 'after' }
  }
  return { path: above.path, placement: 'after' }
}
