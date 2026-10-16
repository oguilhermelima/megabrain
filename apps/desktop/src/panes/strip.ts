import { focusDirection, normalise, paneList, paneRects, type Direction, type Divider, type PaneLeaf, type PaneNode, type Rect } from '@/panes/pane-model'

// A split group as a strip of columns, the way niri scrolls its windows: the root row's children are
// the columns, side by side, and each one holds a stack of panes (or any tree a drop made of it).
// A column has its own width; when the columns do not fit, the strip scrolls sideways instead of
// squeezing them, and a stack taller than the area scrolls its column. No pane ever goes under the
// minimum. Every function here is pure; PaneArea draws and scrolls the result.

/** The smallest a pane may be, in pixels. */
export const minPaneWidth = 280
export const minPaneHeight = 160

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
 * Every column's place in pixels. A column takes its own width, else its share of the root row
 * spread over at most three columns' worth of area: two or three columns fit side by side, more
 * take a third each and scroll. Never under the minimum its panes need.
 */
export function stripLayout(root: PaneNode, strip: Strip, area: Area): StripLayout {
  const columns = stripColumns(root)
  const visible = Math.min(columns.length, 3)
  let x = 0
  const placed = columns.map(({ id, node, share }): StripColumn => {
    const minimum = minimumOf(node)
    const own = strip.widths[id]
    const fraction = columns.length === 1 ? 1 : (own ?? (share * columns.length) / visible)
    const width = Math.max(fraction * area.width, minimum.width)
    const height = Math.max(area.height, minimum.height)
    const { panes, dividers } = paneRects(node)
    const column = { id, node, x, width, height, panes: panes.map((pane) => ({ ...pane, rect: { x: pane.rect.x * width, y: pane.rect.y * height, width: pane.rect.width * width, height: pane.rect.height * height } })), dividers }
    x += width
    return column
  })
  return { columns: placed, width: x, overflowX: x > area.width + epsilon, overflowY: placed.some((column) => column.height > area.height + epsilon) }
}

/** Column `columnId` set to `width` pixels, kept between its minimum and the area's width. Widths of columns that are gone are dropped. */
export function resizeColumn(strip: Strip, root: PaneNode, columnId: string, width: number, area: Area): Strip {
  const columns = stripColumns(root)
  const column = columns.find((candidate) => candidate.id === columnId)
  if (column === undefined || area.width <= 0) return strip
  const minimum = minimumOf(column.node).width
  const clamped = Math.max(minimum, Math.min(area.width, width))
  const widths: Record<string, number> = {}
  for (const { id } of columns) {
    const kept = strip.widths[id]
    if (id === columnId) widths[id] = clamped / area.width
    else if (kept !== undefined) widths[id] = kept
  }
  return { ...strip, widths }
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

/**
 * The sideways scroll a wheel event asks of the strip on top of what the platform does: a mostly
 * vertical wheel with shift. A sideways swipe already scrolls the strip natively.
 */
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
