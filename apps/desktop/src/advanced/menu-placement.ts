// Where a menu opens so it stays inside the window: below and to the right of its anchor, flipped
// left or up when that side has no room, and never closer than `margin` to an edge.

export interface AnchorRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

const margin = 8

/** A pointer is an anchor with no size; a button opens the menu `gap` pixels below or above it. */
export function placeMenu(anchor: AnchorRect, size: Size, viewport: Size, gap = 0): { left: number; top: number } {
  const fitsRight = anchor.left + size.width + margin <= viewport.width
  const fitsBelow = anchor.bottom + gap + size.height + margin <= viewport.height
  const left = fitsRight ? anchor.left : anchor.right - size.width
  const top = fitsBelow ? anchor.bottom + gap : anchor.top - gap - size.height
  return { left: Math.max(margin, left), top: Math.max(margin, top) }
}
