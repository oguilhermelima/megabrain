import { dropZone, focusDirection, movePane, spanPane, type Direction, type Edge, type Panes, type Rect, type Zone } from '@/panes/pane-model'

// Arranging a split by dragging one of its panes: onto another pane, whose outer thirds split beside
// it and whose middle swaps the two, or onto a side of the whole group, which it then spans (the full
// width under or over the rest, the full height left or right of it). The pane area and the hover's
// map share these; the map hit-tests the arrangement it draws in miniature. Every function is pure.

export type ArrangeTarget = { kind: 'side'; side: Edge } | { kind: 'pane'; paneId: string; zone: Zone }

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** The side of `box` whose band, `band` pixels deep, the point is in (the nearest in a corner); null inside the bands or outside the box. */
export function outerEdge(box: Box, x: number, y: number, band: number): Edge | null {
  if (x < box.left || x > box.left + box.width || y < box.top || y > box.top + box.height) return null
  const distances: [Edge, number][] = [
    ['left', x - box.left],
    ['right', box.left + box.width - x],
    ['top', y - box.top],
    ['bottom', box.top + box.height - y],
  ]
  let nearest = distances[0] as [Edge, number]
  for (const distance of distances) if (distance[1] < nearest[1]) nearest = distance
  return nearest[1] < band ? nearest[0] : null
}

/**
 * Where a drop on the map lands: its margin, `pad` pixels round the cells, is the group's sides; a
 * cell (each in the unit square of the area inside the margin) is that pane's zones. Null off the map.
 */
export function mapTarget(cells: readonly { paneId: string; rect: Rect }[], box: Box, pad: number, x: number, y: number): ArrangeTarget | null {
  const side = outerEdge(box, x, y, pad)
  if (side !== null) return { kind: 'side', side }
  const inner = { left: box.left + pad, top: box.top + pad, width: box.width - 2 * pad, height: box.height - 2 * pad }
  for (const { paneId, rect } of cells) {
    const cell = { left: inner.left + rect.x * inner.width, top: inner.top + rect.y * inner.height, width: rect.width * inner.width, height: rect.height * inner.height }
    if (x >= cell.left && x <= cell.left + cell.width && y >= cell.top && y <= cell.top + cell.height) return { kind: 'pane', paneId, zone: dropZone(cell, x, y) }
  }
  return null
}

/** Pane `paneId` dropped on `target`: it spans that side, splits beside that pane, or swaps with it. */
export function arrangePane(panes: Panes, paneId: string, target: ArrangeTarget): Panes {
  return target.kind === 'side' ? spanPane(panes, paneId, target.side) : movePane(panes, paneId, target.paneId, target.zone)
}

const sideOf: Record<Direction, Edge> = { left: 'left', right: 'right', up: 'top', down: 'bottom' }

/** Pane `paneId` moved one step with the keyboard: it trades places with its neighbour that way, or spans that side of the group when it has none. */
export function shiftPane(panes: Panes, paneId: string, direction: Direction): Panes {
  const neighbour = focusDirection({ ...panes, focused: paneId }, direction).focused
  if (neighbour !== paneId) return movePane(panes, paneId, neighbour, 'center')
  return spanPane(panes, paneId, sideOf[direction])
}
