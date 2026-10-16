import { useState, type PointerEvent, type RefObject } from 'react'
import { useStableCallback } from '@/lib/useStableCallback'
import { dropTarget, type Placement } from '@/advanced/project-order'
import { rowDropZone } from '@/advanced/split-rows'
import { mapTarget, type ArrangeTarget } from '@/panes/arrange'

// Dragging inside the sidebar: a chat, session or terminal row reorders its worktree's rows or, over
// another row's middle band, joins it into a split; a group row joins the row it is dropped on; a
// member of a group (one of its marks, or a cell of its hover's map) is arranged on the map (beside
// or swapped with another cell, or spanning a side of the group), joins another row, or leaves the
// group when it lands anywhere else in the sidebar. Pointer events, like the pane drag (usePaneDrag), since Tauri takes HTML5 drags.

export type RowDragSource =
  /** A row under a worktree; `item` is what it opens, null for one that opens nothing yet. */
  | { kind: 'row'; worktreePath: string; key: string; shown: string[]; item: string | null; label: string }
  | { kind: 'group'; groupId: string; label: string }
  | { kind: 'member'; groupId: string; item: string; label: string }

/** What a join lands on: a row's item, or a group row. */
export type JoinTarget = { kind: 'item'; item: string } | { kind: 'group'; groupId: string }

export type RowDropTarget =
  | { kind: 'reorder'; key: string; placement: Placement }
  /** `at` is the row key or group id that lights up. */
  | { kind: 'join'; at: string; target: JoinTarget }
  | { kind: 'leave' }
  /** A zone of a cell, or a side, of the hover's map (see panes/arrange). */
  | { kind: 'arrange'; groupId: string; target: ArrangeTarget }

export interface RowDragState {
  source: RowDragSource
  target: RowDropTarget | null
  x: number
  y: number
}

export interface RowDropHandlers {
  reorder: (worktreePath: string, next: string[]) => void
  join: (source: RowDragSource, target: JoinTarget) => void
  leave: (groupId: string, item: string) => void
  arrange: (groupId: string, item: string, target: ArrangeTarget) => void
}

const threshold = 4

const rectOf = (element: Element) => {
  const rect = element.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom }
}

/** What the pointer is over for `source`, or null where a drop does nothing. */
function targetAt(nav: HTMLElement | null, source: RowDragSource, x: number, y: number): RowDropTarget | null {
  const element = document.elementFromPoint(x, y)
  if (element === null || nav === null) return null
  const hover = element.closest<HTMLElement>('[data-split-hover]')
  if (hover !== null) {
    if (source.kind !== 'member' || hover.dataset.splitHover !== source.groupId) return null
    const map = element.closest<HTMLElement>('[data-split-map]')
    if (map === null) return null
    // Against the arrangement as it stands (the map carries it), not the preview it draws meanwhile.
    const cells = parseCells(map.dataset.splitMap)
    const own = cells.find((cell) => cell.item === source.item)?.paneId
    const target = mapTarget(cells, map.getBoundingClientRect(), Number(map.dataset.pad ?? 0), x, y)
    if (target === null || own === undefined || (target.kind === 'pane' && target.paneId === own)) return null
    return { kind: 'arrange', groupId: source.groupId, target }
  }
  if (!nav.contains(element)) return null
  const groupRow = element.closest<HTMLElement>('[data-split-group]')
  const group = groupRow?.dataset.splitGroup
  if (groupRow !== null && group !== undefined) {
    if (source.kind === 'group' || (source.kind === 'member' && source.groupId === group) || (source.kind === 'row' && source.item === null)) return null
    // Group rows keep their place, so all of one joins.
    return rowDropZone(rectOf(groupRow), y, { reorder: false }) === 'join' ? { kind: 'join', at: group, target: { kind: 'group', groupId: group } } : null
  }
  const row = element.closest<HTMLElement>('[data-row-key]')
  if (row !== null) {
    const key = row.dataset.rowKey ?? ''
    const item = row.dataset.item
    if (source.kind === 'row' && key === source.key) return null
    // Only the middle band joins, wherever the row is; its edges reorder its own worktree's rows.
    const sameList = source.kind === 'row' && row.parentElement?.dataset.worktreeRows === source.worktreePath
    const joinable = item !== undefined && (source.kind !== 'row' || source.item !== null)
    const zone = rowDropZone(rectOf(row), y, { join: joinable })
    if (zone === 'join' && item !== undefined) return { kind: 'join', at: key, target: { kind: 'item', item } }
    if (sameList && zone !== 'join') return { kind: 'reorder', key, placement: zone }
    return source.kind === 'member' ? { kind: 'leave' } : null
  }
  if (source.kind === 'member') return { kind: 'leave' }
  if (source.kind !== 'row') return null
  // Between a worktree's rows, or just past them, still reorders them.
  const list = nav.querySelector<HTMLElement>(`[data-worktree-rows="${CSS.escape(source.worktreePath)}"]`)
  if (list === null) return null
  const box = list.getBoundingClientRect()
  if (x < box.left || x > box.right || y < box.top - 8 || y > box.bottom + 8) return null
  const found = dropTarget(
    [...list.querySelectorAll<HTMLElement>(':scope > [data-row-key]')].map((entry) => ({ path: entry.dataset.rowKey ?? '', ...rectOf(entry) })),
    y,
  )
  return found === null || found.path === source.key ? null : { kind: 'reorder', key: found.path, placement: found.placement }
}

/** The cells a map carries in its data-split-map attribute; none when it is unreadable. */
function parseCells(raw: string | undefined): MapCell[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(value) ? (value as MapCell[]) : []
  } catch {
    return []
  }
}

/** A cell of the hover's map, as SplitMap writes it on the map for the drag to hit-test. */
export interface MapCell {
  paneId: string
  item: string
  rect: { x: number; y: number; width: number; height: number }
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

export function useRowDrag(nav: RefObject<HTMLElement | null>, handlers: RowDropHandlers, moveRow: (shown: string[], key: string, target: string, placement: Placement) => string[]) {
  const [state, setState] = useState<RowDragState | null>(null)
  const start = useStableCallback((event: PointerEvent<HTMLElement | SVGElement>, source: RowDragSource) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const startX = event.clientX
    const startY = event.clientY
    let moving = false
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('keydown', onKey, true)
      setState(null)
    }
    const onMove = (move: globalThis.PointerEvent) => {
      if (!moving && Math.hypot(move.clientX - startX, move.clientY - startY) < threshold) return
      moving = true
      const target = targetAt(nav.current, source, move.clientX, move.clientY)
      setState({ source, target, x: move.clientX, y: move.clientY })
    }
    const onUp = (up: globalThis.PointerEvent) => {
      stop()
      if (!moving) return
      swallowNextClick()
      const target = targetAt(nav.current, source, up.clientX, up.clientY)
      if (target === null) return
      if (target.kind === 'reorder' && source.kind === 'row') handlers.reorder(source.worktreePath, moveRow(source.shown, source.key, target.key, target.placement))
      else if (target.kind === 'join') handlers.join(source, target.target)
      else if (target.kind === 'leave' && source.kind === 'member') handlers.leave(source.groupId, source.item)
      else if (target.kind === 'arrange' && source.kind === 'member') handlers.arrange(target.groupId, source.item, target.target)
    }
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape' || !moving) return
      key.preventDefault()
      key.stopPropagation()
      stop()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('keydown', onKey, true)
  })
  return { state, start }
}

export type RowDragStart = (event: PointerEvent<HTMLElement | SVGElement>, source: RowDragSource) => void
