import type { AnchorRect, Size } from '@/advanced/menu-placement'

const margin = 8

/** Centred above its anchor, below when the top has no room, and never closer than `margin` to an edge. */
export function placeTip(anchor: AnchorRect, size: Size, viewport: Size, gap = 6): { left: number; top: number } {
  const centre = (anchor.left + anchor.right) / 2
  const left = Math.min(Math.max(margin, centre - size.width / 2), viewport.width - margin - size.width)
  const above = anchor.top - gap - size.height
  const top = above >= margin ? above : Math.min(anchor.bottom + gap, viewport.height - margin - size.height)
  return { left: Math.max(margin, left), top: Math.max(margin, top) }
}
