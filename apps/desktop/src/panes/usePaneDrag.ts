import { useState, type PointerEvent } from 'react'
import { useStableCallback } from '@/lib/useStableCallback'
import { outerEdge, type ArrangeTarget } from '@/panes/arrange'
import { dropZone, type Edge } from '@/panes/pane-model'

// Dragging into the panes runs on pointer events, not HTML5 drag and drop: Tauri's native file drop
// handler takes the window's drag events (the composer found HTML5 drops never arrive), and pointer
// events also let a drag start on a button without stealing its click.

/** What is being dragged: a sidebar item, or a pane by its header. */
export type DragSource = { kind: 'item'; item: string; label: string } | { kind: 'pane'; paneId: string; label: string }

/** A zone of a pane, or a side of the whole split (see panes/arrange). */
export type DropTarget = ArrangeTarget

export interface DragState {
  source: DragSource
  x: number
  y: number
  target: DropTarget | null
}

export interface PaneDrag {
  state: DragState | null
  /** Call from onPointerDown; the drag begins once the pointer travels a few pixels. */
  start: (event: PointerEvent<HTMLElement>, source: DragSource) => void
}

const threshold = 4

/** How deep the band along a split's edges is, in pixels: a drop there spans that whole side. */
export const sideBand = 24

function sideAt(under: Element | null | undefined, x: number, y: number): Edge | null {
  const area = under?.closest<HTMLElement>('[data-pane-area]')
  return area === null || area === undefined ? null : outerEdge(area.getBoundingClientRect(), x, y, sideBand)
}

/**
 * The side of the split whose band the pointer is in, else the pane under it and which of its zones
 * it is over. `skip` is a side whose band the drag started in and has not left yet: a pane's header
 * lies in the top band, so a short drag there means the pane, not the side.
 */
function targetAt(x: number, y: number, skip: Edge | null): DropTarget | null {
  const under = document.elementFromPoint(x, y)
  const side = sideAt(under, x, y)
  if (side !== null && side !== skip) return { kind: 'side', side }
  const element = under?.closest<HTMLElement>('[data-pane-id]')
  const paneId = element?.dataset.paneId
  if (element === null || element === undefined || paneId === undefined) return null
  return { kind: 'pane', paneId, zone: dropZone(element.getBoundingClientRect(), x, y) }
}

/** The release that ends a drag must not also click the row or button it started on. */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

export function usePaneDrag(onDrop: (source: DragSource, target: DropTarget) => void): PaneDrag {
  const [state, setState] = useState<DragState | null>(null)
  const start = useStableCallback((event: PointerEvent<HTMLElement>, source: DragSource) => {
    if (event.button !== 0) return
    const startX = event.clientX
    const startY = event.clientY
    let moving = false
    // The band the drag starts in counts as a side only once the pointer has been out of it.
    let startSide = sideAt(document.elementFromPoint(startX, startY), startX, startY)
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onCancel)
      setState(null)
    }
    const onMove = (move: globalThis.PointerEvent) => {
      // A release outside the window never sends pointerup; the next move without the button ends the drag, so its label does not stay behind.
      if (move.buttons === 0) {
        stop()
        return
      }
      if (!moving && Math.hypot(move.clientX - startX, move.clientY - startY) < threshold) return
      moving = true
      if (startSide !== null && sideAt(document.elementFromPoint(move.clientX, move.clientY), move.clientX, move.clientY) !== startSide) startSide = null
      setState({ source, x: move.clientX, y: move.clientY, target: targetAt(move.clientX, move.clientY, startSide) })
    }
    const onUp = (up: globalThis.PointerEvent) => {
      stop()
      if (!moving) return
      swallowNextClick()
      const target = targetAt(up.clientX, up.clientY, startSide)
      if (target !== null) onDrop(source, target)
    }
    const onCancel = () => stop()
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape' || !moving) return
      key.preventDefault()
      key.stopPropagation()
      stop()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onCancel)
  })
  return { state, start }
}
