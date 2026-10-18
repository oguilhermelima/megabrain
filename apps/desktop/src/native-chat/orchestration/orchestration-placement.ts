import { clampScale, type BoardView, type Box } from '@/native-chat/orchestration/orchestration-board'
import { CARD_GAP, CARD_WIDTH, type LaidOut } from '@/native-chat/orchestration/orchestration-layout'

// Where each card sits on the board, in canvas coordinates: laid out once from the tree, then kept,
// moved by hand, and remembered per orchestration so a reopen or a resize finds the board as it was.

export interface Point {
  x: number
  y: number
}

/** The space between a card and the row of its lanes beneath it. */
export const ROW_GAP = 48
/** How far a press must travel before it drags a card rather than clicking it. */
export const DRAG_THRESHOLD = 4
/** What a card not yet measured is taken to be tall. */
export const CARD_HEIGHT = 120
// Room above the first card for its "This chat" badge, and at its side.
export const BOARD_ORIGIN: Point = { x: 24, y: 28 }
// A stored board keeps at most this many cards, so a long-lived coordinator cannot grow it without bound.
const STORED_CAP = 500

export const pastThreshold = (dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean => Math.hypot(dx, dy) >= threshold

/** A card's place after a drag: where it started plus the pointer's travel, back in canvas units. */
export const draggedTo = (start: Point, dx: number, dy: number, scale: number): Point => ({ x: start.x + dx / scale, y: start.y + dy / scale })

/**
 * Every card of a laid-out tree placed as the board first draws it: a node centred over its share of
 * the width, its rows of lanes beneath it, each lane centred in an equal share of its row.
 */
export function placeTree(laid: LaidOut, width: number, heightOf: (id: string) => number): Map<string, Point> {
  const placed = new Map<string, Point>()
  const place = (node: LaidOut, left: number, top: number, share: number): number => {
    placed.set(node.node.id, { x: left + (share - CARD_WIDTH) / 2, y: top })
    let bottom = top + heightOf(node.node.id)
    for (const row of node.rows) {
      const child = (share - CARD_GAP * (row.length - 1)) / row.length
      const heights = row.map((lane, index) => place(lane, left + index * (child + CARD_GAP), bottom + ROW_GAP, child))
      bottom += ROW_GAP + Math.max(...heights)
    }
    return bottom - top
  }
  place(laid, BOARD_ORIGIN.x, BOARD_ORIGIN.y, Math.max(CARD_WIDTH, width))
  return placed
}

const overlaps = (a: Box, b: Box): boolean => a.left < b.left + b.width + CARD_GAP && b.left < a.left + a.width + CARD_GAP && a.top < b.top + b.height + CARD_GAP && b.top < a.top + a.height + CARD_GAP

/** A new card's place: in the row under its parent, the first free spot from the parent's left edge rightwards. */
export function placeBeside(parent: Box, occupied: readonly Box[], height: number): Point {
  const candidate = { left: parent.left, top: parent.top + parent.height + ROW_GAP, width: CARD_WIDTH, height }
  for (let step = 0; step < occupied.length + 1; step += 1) {
    if (!occupied.some((box) => overlaps(candidate, box))) break
    candidate.left += CARD_WIDTH + CARD_GAP
  }
  return { x: candidate.left, y: candidate.top }
}

/** The box that holds every card, or null for an empty board. */
export function boundsOf(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((box) => box.left))
  const top = Math.min(...boxes.map((box) => box.top))
  const right = Math.max(...boxes.map((box) => box.left + box.width))
  const bottom = Math.max(...boxes.map((box) => box.top + box.height))
  return { left, top, width: right - left, height: bottom - top }
}

/** A dotted connector from the bottom middle of a parent card to the top middle of its lane's. */
export function edgePath(from: Box, to: Box): string {
  const x1 = from.left + from.width / 2
  const y1 = from.top + from.height
  const x2 = to.left + to.width / 2
  const y2 = to.top
  const bend = y1 + Math.min(28, (y2 - y1) / 2)
  return `M ${x1} ${y1} C ${x1} ${bend + 12} ${x2} ${bend - 12} ${x2} ${Math.max(bend, y2 - 24)} L ${x2} ${y2}`
}

export interface StoredBoard {
  view: BoardView
  nodes: Map<string, Point>
}

export const boardKey = (root: string): string => `megabrain.orchestration.board:${root}`

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** A stored board read back; anything malformed is null, and a malformed card is left out. */
export function readStoredBoard(raw: string | null): StoredBoard | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { view, nodes } = parsed as { view?: unknown; nodes?: unknown }
  if (typeof view !== 'object' || view === null || typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) return null
  const { x, y, scale } = view as { x?: unknown; y?: unknown; scale?: unknown }
  if (!finite(x) || !finite(y) || !finite(scale) || scale <= 0) return null
  const placed = new Map<string, Point>()
  for (const [id, point] of Object.entries(nodes)) {
    if (placed.size >= STORED_CAP) break
    if (Array.isArray(point) && point.length === 2 && finite(point[0]) && finite(point[1])) placed.set(id, { x: point[0], y: point[1] })
  }
  return { view: { x, y, scale: clampScale(scale) }, nodes: placed }
}

/** The board as stored: the view, and the cards still drawn, in whole pixels. */
export function storedBoardText(view: BoardView, nodes: ReadonlyMap<string, Point>, drawn: ReadonlySet<string>): string {
  const kept: Record<string, [number, number]> = {}
  let count = 0
  for (const [id, point] of nodes) {
    if (!drawn.has(id) || count >= STORED_CAP) continue
    kept[id] = [Math.round(point.x), Math.round(point.y)]
    count += 1
  }
  return JSON.stringify({ view: { x: Math.round(view.x), y: Math.round(view.y), scale: Number(view.scale.toFixed(4)) }, nodes: kept })
}
