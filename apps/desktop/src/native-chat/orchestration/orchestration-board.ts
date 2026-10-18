// The pure side of the orchestration board: where the tree sits and how big it draws, as a translate
// and a scale on its canvas. A point p of the canvas lands on screen at view.x + p.x * view.scale.

export interface BoardView {
  x: number
  y: number
  scale: number
}

export interface Size {
  width: number
  height: number
}

/** A box in canvas coordinates, unscaled. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export const MIN_SCALE = 0.25
export const MAX_SCALE = 2
// The step a zoom button takes, and the room a fit or a kept-in-view card leaves at the edges.
export const ZOOM_STEP = 1.25
export const BOARD_MARGIN = 24

export const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

/**
 * The whole canvas centred in the viewport, scaled down until it fits (never up past life size, and
 * never below the smallest scale, where a big tree overflows and starts at its top).
 */
export function fitView(content: Size, viewport: Size, margin = BOARD_MARGIN): BoardView {
  const room = { width: Math.max(1, viewport.width - margin * 2), height: Math.max(1, viewport.height - margin * 2) }
  const scale = content.width <= 0 || content.height <= 0 ? 1 : clampScale(Math.min(1, room.width / content.width, room.height / content.height))
  const drawn = { width: content.width * scale, height: content.height * scale }
  return {
    x: (viewport.width - drawn.width) / 2,
    y: drawn.height <= room.height ? (viewport.height - drawn.height) / 2 : margin,
    scale,
  }
}

/** The view zoomed by `factor` around a viewport point, which stays over the same spot of the canvas. */
export function zoomAt(view: BoardView, factor: number, point: { x: number; y: number }): BoardView {
  const scale = clampScale(view.scale * factor)
  const ratio = scale / view.scale
  return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, scale }
}

/** The view that fits a box of the canvas, wherever on the canvas it lies, as fitView fits one at its origin. */
export function fitBox(box: Box, viewport: Size, margin = BOARD_MARGIN): BoardView {
  const view = fitView(box, viewport, margin)
  return { ...view, x: view.x - box.left * view.scale, y: view.y - box.top * view.scale }
}

export const panBy = (view: BoardView, dx: number, dy: number): BoardView => ({ ...view, x: view.x + dx, y: view.y + dy })

/**
 * The view moved as little as it takes for a canvas box to show whole, margin included; a box bigger
 * than the viewport keeps its top left in view. Unchanged when it already shows.
 */
export function keepInView(view: BoardView, box: Box, viewport: Size, margin = BOARD_MARGIN): BoardView {
  const axis = (offset: number, start: number, length: number, room: number): number => {
    const from = offset + start * view.scale
    const to = from + length * view.scale
    if (from < margin || to - from > room - margin * 2) return offset + margin - from
    if (to > room - margin) return offset + room - margin - to
    return offset
  }
  const x = axis(view.x, box.left, box.width, viewport.width)
  const y = axis(view.y, box.top, box.height, viewport.height)
  return x === view.x && y === view.y ? view : { ...view, x, y }
}

/** A wheel's zoom factor from its vertical delta: a pinch or Ctrl/Cmd plus wheel, smooth on a trackpad and a mouse alike. */
export const wheelZoom = (deltaY: number): number => Math.exp(-Math.max(-50, Math.min(50, deltaY)) * 0.01)

/** What one wheel event does to the board. */
export type WheelMove = { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number }

/**
 * A wheel event as a board move, its deltas already in pixels. Ctrl/Cmd (which a trackpad pinch also
 * sets) zooms; otherwise the board pans against the scroll on both axes, so a sideways swipe moves it
 * sideways. Shift plus a plain vertical wheel pans sideways too, where the system has not turned it
 * into a horizontal delta itself.
 */
export function wheelMove(event: { deltaX: number; deltaY: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): WheelMove {
  if (event.ctrlKey || event.metaKey) return { kind: 'zoom', factor: wheelZoom(event.deltaY) }
  if (event.shiftKey && event.deltaX === 0) return { kind: 'pan', dx: 0 - event.deltaY, dy: 0 }
  // 0 - d rather than -d, so a still axis is 0 and not -0.
  return { kind: 'pan', dx: 0 - event.deltaX, dy: 0 - event.deltaY }
}
