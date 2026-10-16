import { focusDirection, normalise, paneList, paneRects, type Direction, type Divider, type PaneLeaf, type PaneNode, type Rect } from '@/panes/pane-model'

// A split group as a strip of columns, the way niri scrolls its windows: the root row's children are
// the columns, side by side, and each one holds a stack of panes (or any tree a drop made of it).
// A column has its own width; when the columns do not fit, the strip scrolls sideways instead of
// squeezing them, and a stack taller than the area scrolls its column. Only a row at the top is a
// strip: a tree whose top level is a column (one pane spanning the width under or over the rest) is
// one column as wide as the area, its panes sharing that width. No pane ever goes under the minimum
// height. Every function here is pure; PaneArea draws and scrolls the result.

/** The smallest a pane may be, in pixels. */
export const minPaneWidth = 280
export const minPaneHeight = 160

/** The width a column is comfortable at, in pixels: as many columns as fit at it share the area. */
export const comfortableColumnWidth = 420

export interface Strip {
  /** A column's own width, as a share of the area's width, by column id; the rest take the default. */
  widths: Readonly<Record<string, number>>
  /** How far the strip is scrolled, in area widths. */
  scroll: number
}

export const emptyStrip: Strip = { widths: {}, scroll: 0 }

export interface StripColumn {
  id: string
  node: PaneNode
  /** In pixels: where the column starts in the strip, its width and its content's height. */
  x: number
  width: number
  height: number
  /** Each pane's place in the column's content, in pixels. */
  panes: { id: string; item: string; rect: Rect }[]
  /** The dividers inside the column, in its unit square (see paneRects). */
  dividers: Divider[]
}

export interface StripLayout {
  columns: StripColumn[]
  /** The strip's whole width, in pixels. */
  width: number
  /** The strip is wider than the area; some column is taller than it. */
  overflowX: boolean
  overflowY: boolean
}

interface Area {
  width: number
  height: number
}

const epsilon = 1e-6

/** The columns: each child of a root row, else the whole tree as one column. */
export function stripColumns(root: PaneNode): { id: string; node: PaneNode; share: number }[] {
  if (root.type === 'split' && root.direction === 'row') return root.children.map((node, index) => ({ id: node.id, node, share: root.sizes[index] ?? 0 }))
  return [{ id: root.id, node: root, share: 1 }]
}

export function columnOfPane(root: PaneNode, paneId: string): string | null {
  return stripColumns(root).find((column) => paneList(column.node).some((leaf) => leaf.id === paneId))?.id ?? null
}

/** The narrowest a column holding `node` may be, and the shortest its content may be, in pixels. */
function minimumOf(node: PaneNode): Area {
  let width = minPaneWidth
  let height = minPaneHeight
  for (const { rect } of paneRects(node).panes) {
    width = Math.max(width, minPaneWidth / rect.width)
    height = Math.max(height, minPaneHeight / rect.height)
  }
  return { width, height }
}

/**
 * How many columns' worth of area the strip spreads over: all of them while each can be at least
 * comfortableColumnWidth wide, else as many as fit at that width (one at least), the rest scrolling.
 */
export function visibleColumns(count: number, areaWidth: number): number {
  return Math.min(count, Math.max(1, Math.floor(areaWidth / comfortableColumnWidth)))
}

/**
 * Every column's place in pixels. A column the person sized by hand takes its own width (a share of
 * the area), which nothing else ever changes. The rest share what the hand-set ones leave of the
 * strip's default width (as many columns as fit at the comfortable width fill the area, see
 * visibleColumns), by their shares of the root row: on a wide area every column shows, on a narrow one
 * the rest scroll. Never under the minimum its panes need. A root that is not a row is one column
 * exactly as wide as the area, so it never scrolls sideways.
 */
export function stripLayout(root: PaneNode, strip: Strip, area: Area): StripLayout {
  const strips = root.type === 'split' && root.direction === 'row'
  const columns = stripColumns(root).map((column) => ({ ...column, minimum: minimumOf(column.node), own: strip.widths[column.id] }))
  // The default share, in area widths; and the strip's default width, in pixels.
  const fraction = columns.length / visibleColumns(columns.length, area.width)
  const target = fraction * area.width
  let setWidth = 0
  let freeShare = 0
  let freeCount = 0
  for (const { own, minimum, share } of columns) {
    if (own === undefined) {
      freeShare += share
      freeCount += 1
    } else setWidth += Math.max(own * area.width, minimum.width)
  }
  const left = Math.max(0, target - setWidth)
  let x = 0
  const placed = columns.map(({ id, node, share, minimum, own }): StripColumn => {
    // With nothing set by hand it is exactly the default share, free of the rounding the general sum adds.
    const free = freeCount === columns.length ? share * fraction * area.width : freeShare > epsilon ? (left * share) / freeShare : left / Math.max(1, freeCount)
    const width = !strips || columns.length === 1 ? area.width : Math.max(own === undefined ? free : own * area.width, minimum.width)
    const height = Math.max(area.height, minimum.height)
    const { panes, dividers } = paneRects(node)
    const column = { id, node, x, width, height, panes: panes.map((pane) => ({ ...pane, rect: { x: pane.rect.x * width, y: pane.rect.y * height, width: pane.rect.width * width, height: pane.rect.height * height } })), dividers }
    x += width
    return column
  })
  return { columns: placed, width: x, overflowX: x > area.width + epsilon, overflowY: placed.some((column) => column.height > area.height + epsilon) }
}

/** The widths kept for the columns still in `root`, with `set` (column id to pixels) written over them as shares of the area. */
function withWidths(strip: Strip, root: PaneNode, set: Readonly<Record<string, number>>, area: Area): Strip {
  const widths: Record<string, number> = {}
  for (const { id } of stripColumns(root)) {
    const width = set[id]
    const kept = strip.widths[id]
    if (width !== undefined) widths[id] = width / area.width
    else if (kept !== undefined) widths[id] = kept
  }
  return { ...strip, widths }
}

/** Column `columnId` set to `width` pixels, kept between its minimum and the area's width. Widths of columns that are gone are dropped. */
export function resizeColumn(strip: Strip, root: PaneNode, columnId: string, width: number, area: Area): Strip {
  const column = stripColumns(root).find((candidate) => candidate.id === columnId)
  if (column === undefined || area.width <= 0) return strip
  const minimum = minimumOf(column.node).width
  return withWidths(strip, root, { [columnId]: Math.max(minimum, Math.min(area.width, width)) }, area)
}

/**
 * The divider right of column `leftId` dragged by `delta` pixels from where the drag started, when the
 * two columns beside it were `start` wide: one grows by what the other gives up, each kept between its
 * minimum and the area's width, and both count as set by hand from then on.
 */
export function resizeBetween(strip: Strip, root: PaneNode, leftId: string, start: { left: number; right: number }, delta: number, area: Area): Strip {
  const columns = stripColumns(root)
  const index = columns.findIndex((column) => column.id === leftId)
  const left = columns[index]
  const right = columns[index + 1]
  if (left === undefined || right === undefined || area.width <= 0) return strip
  const total = start.left + start.right
  const lowest = Math.max(minimumOf(left.node).width, total - area.width)
  const highest = Math.min(area.width, total - minimumOf(right.node).width)
  if (lowest > highest) return strip
  const width = Math.max(lowest, Math.min(highest, start.left + delta))
  return withWidths(strip, root, { [left.id]: width, [right.id]: total - width }, area)
}

/** The two columns beside the divider right of `leftId`, `current` wide, given equal halves of their width. */
export function equaliseBetween(strip: Strip, root: PaneNode, leftId: string, current: { left: number; right: number }, area: Area): Strip {
  return resizeBetween(strip, root, leftId, current, (current.right - current.left) / 2, area)
}

/**
 * The outer edge of a column dragged by `delta` pixels from where the drag started (`start`: the
 * column's width and the strip's scroll): the right edge of the last column, the left edge of the
 * first. The column takes its new width by hand, and the scroll follows: the right edge stays in view
 * however far it goes, and growing leftwards scrolls by what the column gained, so the columns right
 * of it stay where they were on screen.
 */
export function dragOuterEdge(strip: Strip, root: PaneNode, columnId: string, side: 'left' | 'right', start: { width: number; scroll: number }, delta: number, area: Area): { strip: Strip; scroll: number } {
  const next = resizeColumn(strip, root, columnId, side === 'right' ? start.width + delta : start.width - delta, area)
  const layout = stripLayout(root, next, area)
  const column = layout.columns.find((candidate) => candidate.id === columnId)
  if (column === undefined) return { strip, scroll: start.scroll }
  const most = Math.max(0, layout.width - area.width)
  const scroll = side === 'right' ? reveal(column.x + column.width, 0, start.scroll, area.width, layout.width) : Math.max(0, Math.min(most, start.scroll + column.width - start.width))
  return { strip: next, scroll }
}

/** Column `columnId` goes back to the default width. */
export function resetColumn(strip: Strip, columnId: string): Strip {
  if (!(columnId in strip.widths)) return strip
  const widths = { ...strip.widths }
  delete widths[columnId]
  return { ...strip, widths }
}

/** `leaf` as a new column right after column `afterId` (at the end when there is none), the columns evenly shared. */
export function addColumn(root: PaneNode, afterId: string, leaf: PaneLeaf, splitId: string): PaneNode {
  const columns = stripColumns(root).map((column) => column.node)
  const at = columns.findIndex((node) => node.id === afterId)
  const children = [...columns]
  children.splice(at === -1 ? children.length : at + 1, 0, leaf)
  const id = root.type === 'split' && root.direction === 'row' ? root.id : splitId
  const next: PaneNode = { type: 'split', id, direction: 'row', children, sizes: children.map(() => 1 / children.length) }
  return normalise(next) ?? next
}

/**
 * The pane focus moves to, or null at an edge. Up and down stay in the column. Left and right cross
 * panes side by side inside the column first, then move to the next column, onto the pane at the
 * same height (as a share of each column's height); on a tie, the one nearest the side it enters from.
 */
export function navigate(root: PaneNode, focused: string, direction: Direction): string | null {
  const columns = stripColumns(root)
  const index = columns.findIndex((column) => paneList(column.node).some((leaf) => leaf.id === focused))
  const column = columns[index]
  if (column === undefined) return null
  const inside = focusDirection({ root: column.node, focused }, direction).focused
  if (inside !== focused) return inside
  if (direction === 'up' || direction === 'down') return null
  const target = columns[direction === 'right' ? index + 1 : index - 1]
  const current = paneRects(column.node).panes.find((pane) => pane.id === focused)?.rect
  if (target === undefined || current === undefined) return null
  let best: { id: string; overlap: number; edge: number } | null = null
  for (const { id, rect } of paneRects(target.node).panes) {
    const overlap = Math.min(current.y + current.height, rect.y + rect.height) - Math.max(current.y, rect.y)
    // How far the pane sits from the side focus enters by: the left edge going right, the right edge going left.
    const edge = direction === 'right' ? rect.x : 1 - (rect.x + rect.width)
    if (best === null || overlap > best.overlap + epsilon || (Math.abs(overlap - best.overlap) <= epsilon && edge < best.edge - epsilon)) best = { id, overlap, edge }
  }
  return best?.id ?? null
}

/** The scroll that shows the span from `start` of `size`, moving as little as it can; a span wider than the view shows its start. */
export function reveal(start: number, size: number, viewStart: number, viewSize: number, contentSize: number): number {
  let next = viewStart
  if (size >= viewSize || start < viewStart) next = start
  else if (start + size > viewStart + viewSize) next = start + size - viewSize
  return Math.max(0, Math.min(Math.max(0, contentSize - viewSize), next))
}

/** The strip's scroll and the column's own scroll that bring pane `paneId` into view. */
export function revealPane(layout: StripLayout, paneId: string, view: { scroll: number; columnScroll: Readonly<Record<string, number>>; width: number; height: number }): { scroll: number; columnId: string; columnScroll: number } | null {
  for (const column of layout.columns) {
    const pane = column.panes.find((candidate) => candidate.id === paneId)
    if (pane === undefined) continue
    return {
      scroll: reveal(column.x + pane.rect.x, pane.rect.width, view.scroll, view.width, layout.width),
      columnId: column.id,
      columnScroll: reveal(pane.rect.y, pane.rect.height, view.columnScroll[column.id] ?? 0, view.height, column.height),
    }
  }
  return null
}

/** Where a column arrow points: the column that shows it on hover, and the scroll one column further. */
export interface EdgeArrow {
  columnId: string
  scroll: number
}

/** The arrows and shadows at the strip's visible edges; each side is null when nothing lies beyond it. */
export interface StripEdges {
  left: EdgeArrow | null
  right: EdgeArrow | null
}

/**
 * What lies past each visible edge of a strip scrolled to `scroll` in a view `view` wide. A side has
 * an arrow when the strip goes on past it: the column at that edge shows it on hover, and a click
 * brings the next column in, or the edge column itself when only part of it shows.
 */
export function stripEdges(layout: StripLayout, scroll: number, view: number): StripEdges {
  const tolerance = 1
  const columns = layout.columns
  const end = scroll + view
  let left: EdgeArrow | null = null
  let right: EdgeArrow | null = null
  if (view > 0 && scroll > tolerance) {
    const index = columns.findIndex((column) => column.x + column.width > scroll + tolerance)
    const edge = columns[index]
    const target = edge !== undefined && edge.x < scroll - tolerance ? edge : columns[index - 1]
    if (edge !== undefined && target !== undefined) left = { columnId: edge.id, scroll: reveal(target.x, target.width, scroll, view, layout.width) }
  }
  if (view > 0 && end < layout.width - tolerance) {
    let index = columns.length - 1
    while (index >= 0 && (columns[index]?.x ?? 0) >= end - tolerance) index -= 1
    const edge = columns[index]
    const target = edge !== undefined && edge.x + edge.width > end + tolerance ? edge : columns[index + 1]
    if (edge !== undefined && target !== undefined) right = { columnId: edge.id, scroll: reveal(target.x, target.width, scroll, view, layout.width) }
  }
  return { left, right }
}

/** The column under the strip coordinate `x`, or null past either end. */
export function columnAt(layout: StripLayout, x: number): string | null {
  return layout.columns.find((column) => x >= column.x && x < column.x + column.width)?.id ?? null
}

/** The sideways scroll a mostly vertical wheel with shift asks of the strip; 0 for any other wheel (see strip-gesture). */
export function horizontalWheel(event: { deltaX: number; deltaY: number; shiftKey: boolean }): number {
  return event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : 0
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A stored strip; anything unreadable is the empty strip, and widths that are not positive numbers are dropped. */
export function readStrip(value: unknown): Strip {
  if (!isRecord(value) || !isRecord(value.widths) || typeof value.scroll !== 'number' || !Number.isFinite(value.scroll)) return emptyStrip
  const widths: Record<string, number> = {}
  for (const [id, width] of Object.entries(value.widths)) if (typeof width === 'number' && Number.isFinite(width) && width > 0) widths[id] = width
  return { widths, scroll: Math.max(0, value.scroll) }
}
