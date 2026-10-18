import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { OrchestrationCard } from '@/native-chat/orchestration/OrchestrationCard'
import { CARD_WIDTH, focusPath, layoutTree, relationTo, treeOf, type Pulse, type TreeNode } from '@/native-chat/orchestration/orchestration-layout'
import { clampScale, fitBox, keepInView, panBy, wheelMove, zoomAt, ZOOM_STEP, type BoardView, type Box, type Size } from '@/native-chat/orchestration/orchestration-board'
import {
  BOARD_ORIGIN,
  boardKey,
  boundsOf,
  CARD_HEIGHT,
  draggedTo,
  edgePath,
  pastThreshold,
  placeBeside,
  placeTree,
  readStoredBoard,
  storedBoardText,
  type Point,
  type StoredBoard,
} from '@/native-chat/orchestration/orchestration-placement'
import type { OrchestrationGraph } from '@/api/schema'

// The canvas's side padding, which the layout leaves out of the width it wraps lanes in.
const PADDING = 24

export interface Edge {
  /** The child end; an edge is named by the lane it leads to. */
  node: string
  d: string
  /** The lane works, so the connector's dots drift towards it. */
  flowing: boolean
  /** The edge lies on the path from the root to the focused chat. */
  lit: boolean
}

/** A pulse on screen; `id` tells two pulses of the same message apart. */
export type LivePulse = Pulse & { id: number }

const pulseColor: Record<string, string> = { ask: 'var(--color-warn)', reply: 'var(--color-accent)', done: 'var(--color-ok)' }

interface CardEvents {
  selected: string | null
  now: number
  onClick: (nodeId: string) => void
  onDoubleClick: (nodeId: string) => void
}

/** The board of one orchestration: where its cards sit and the view over them; null until first fitted. */
interface Board {
  root: string
  nodes: Map<string, Point>
  view: BoardView | null
}

function loadBoard(root: string): Board {
  let stored: StoredBoard | null = null
  try {
    stored = readStoredBoard(localStorage.getItem(boardKey(root)))
  } catch {
    // No storage to read: the board lays itself out afresh.
  }
  return { root, nodes: stored?.nodes ?? new Map(), view: stored?.view ?? null }
}

function saveBoard(root: string, text: string | null) {
  try {
    if (text === null) localStorage.removeItem(boardKey(root))
    else localStorage.setItem(boardKey(root), text)
  } catch {
    // Storage full or blocked: the board still works, it only forgets on reopen.
  }
}

/** A press on the board: a pan of the background, or a card that drags once it moves past the threshold. */
type Press = { pointer: number; x: number; y: number } & ({ kind: 'pan'; from: BoardView } | { kind: 'card'; id: string; from: Point; moving: boolean })

// A WebKit pinch: its scale is relative to where the gesture began (lib.dom has no type for it).
type GestureEvent = Event & { scale: number; clientX: number; clientY: number }
// A wheel in lines (a mouse on some systems) moves about this many pixels a line.
const LINE_PX = 16

function useSize(element: HTMLElement | null): Size | null {
  const [size, setSize] = useState<Size | null>(null)
  useEffect(() => {
    if (element === null) return
    const measure = () => setSize((current) => (current !== null && current.width === element.offsetWidth && current.height === element.offsetHeight ? current : { width: element.offsetWidth, height: element.offsetHeight }))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return size
}

function BoardButton({ label, onClick, children }: { label: string; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid h-7 min-w-7 place-items-center rounded-full px-2 text-chat-small font-semibold text-ink-300 hover:bg-white/[0.08] hover:text-ink-100">
      {children}
    </button>
  )
}

/**
 * The tree as cards on a board, the coordinator on top and each node's lanes in rows beneath it, with
 * dotted connectors from each card to its lanes. A card dragged by hand stays where it is put and its
 * connectors follow; a lane that appears takes the first free spot under its parent. Dragging the
 * background or scrolling pans; a pinch, Ctrl/Cmd plus wheel, or the corner buttons zoom. The cards
 * and the view are kept per orchestration, so a resize or a reopen leaves the board as it was; Reset
 * lays it out afresh. A selected card is kept in view. Each pulse lights its edge and runs a dot along it.
 */
export function OrchestrationDiagram({ graph, pulses, ...events }: CardEvents & { graph: OrchestrationGraph; pulses: readonly LivePulse[] }) {
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null)
  const viewport = useSize(viewportElement)
  const tree = useMemo(() => treeOf(graph), [graph])
  const relations = useMemo(() => new Map(graph.nodes.map((node) => [node.id, relationTo(graph, node.id)])), [graph])
  const drawn = useMemo(() => new Set(graph.nodes.map((node) => node.id)), [graph])
  const [board, setBoard] = useState<Board>(() => loadBoard(graph.root))
  // Another orchestration's tree: its own board, read before anything draws.
  if (board.root !== graph.root) setBoard(loadBoard(graph.root))
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map())
  const viewRef = useRef<BoardView>({ x: 0, y: 0, scale: 1 })
  viewRef.current = board.view ?? viewRef.current
  const press = useRef<Press | null>(null)
  // A drag ends in a click the card must not take as a selection.
  const dragged = useRef(false)
  const [dragging, setDragging] = useState(false)
  const cards = useRef(new Map<string, HTMLButtonElement>())
  const registrars = useRef(new Map<string, (element: HTMLButtonElement | null) => void>())

  const heightOf = (id: string) => heights.get(id) ?? CARD_HEIGHT
  const boxOf = (id: string): Box | null => {
    const point = board.nodes.get(id)
    return point === undefined ? null : { left: point.x, top: point.y, width: CARD_WIDTH, height: heightOf(id) }
  }
  const path = new Set(focusPath(graph))
  const edges: Edge[] = graph.nodes.flatMap((node) => {
    const from = node.parent === null ? null : boxOf(node.parent)
    const to = boxOf(node.id)
    if (from === null || to === null || node.parent === null) return []
    return [{ node: node.id, d: edgePath(from, to), flowing: node.state === 'working' || node.state === 'starting', lit: path.has(node.id) && path.has(node.parent) }]
  })
  const edgeOf = new Map(edges.map((edge) => [edge.node, edge]))
  const travelling = pulses.flatMap((pulse) => {
    const edge = edgeOf.get(pulse.node)
    return edge === undefined ? [] : [{ pulse, edge, color: pulseColor[pulse.type] ?? 'var(--color-accent)' }]
  })
  const placedBoxes = graph.nodes.flatMap((node) => boxOf(node.id) ?? [])
  const bounds = boundsOf(placedBoxes)

  // One stable ref callback per node, so a re-render does not detach and re-attach every card.
  const register = (id: string) => {
    let registrar = registrars.current.get(id)
    if (registrar === undefined) {
      registrar = (element) => {
        if (element === null) cards.current.delete(id)
        else cards.current.set(id, element)
      }
      registrars.current.set(id, registrar)
    }
    return registrar
  }

  const move = (change: (current: BoardView) => BoardView) => setBoard((current) => (current.view === null ? current : { ...current, view: change(current.view) }))
  const fit = () => {
    if (viewport !== null && bounds !== null) setBoard((current) => ({ ...current, view: fitBox(bounds, viewport) }))
  }
  const reset = () => {
    saveBoard(board.root, null)
    setBoard({ root: board.root, nodes: new Map(), view: null })
  }

  // Each render measures the cards, then places any card not placed yet: the whole tree when none is,
  // fitted to the board; otherwise each new one beside its parent, leaving every placed card where it is.
  useLayoutEffect(() => {
    const measured = new Map<string, number>()
    for (const [id, element] of cards.current) measured.set(id, element.offsetHeight)
    if (measured.size !== heights.size || [...measured].some(([id, height]) => heights.get(id) !== height)) setHeights(measured)
    if (tree === null || viewport === null || graph.nodes.every((node) => board.nodes.has(node.id))) return
    const measuredHeight = (id: string) => measured.get(id) ?? CARD_HEIGHT
    if (!graph.nodes.some((node) => board.nodes.has(node.id))) {
      const nodes = placeTree(layoutTree(tree, Math.max(CARD_WIDTH, viewport.width - PADDING * 2)), viewport.width - PADDING * 2, measuredHeight)
      const all = boundsOf([...nodes].map(([id, point]) => ({ left: point.x, top: point.y, width: CARD_WIDTH, height: measuredHeight(id) })))
      setBoard({ root: board.root, nodes, view: all === null ? { x: 0, y: 0, scale: 1 } : fitBox(all, viewport) })
      return
    }
    const nodes = new Map(board.nodes)
    const box = (id: string): Box | null => {
      const point = nodes.get(id)
      return point === undefined ? null : { left: point.x, top: point.y, width: CARD_WIDTH, height: measuredHeight(id) }
    }
    const walk = (item: TreeNode, parent: string | null) => {
      const { id } = item.node
      if (!nodes.has(id)) {
        const parentBox = parent === null ? null : box(parent)
        const occupied = graph.nodes.flatMap((node) => box(node.id) ?? [])
        nodes.set(id, parentBox === null ? BOARD_ORIGIN : placeBeside(parentBox, occupied, measuredHeight(id)))
      }
      for (const child of item.children) walk(child, id)
    }
    walk(tree, null)
    setBoard((current) => ({ ...current, nodes }))
  })

  // The board is written a moment after it settles, and once more as the view goes away.
  const pending = useRef<{ root: string; text: string } | null>(null)
  useEffect(() => {
    const { view } = board
    if (view === null) return
    pending.current = { root: board.root, text: storedBoardText(view, board.nodes, drawn) }
    const timer = setTimeout(() => {
      if (pending.current !== null) saveBoard(pending.current.root, pending.current.text)
      pending.current = null
    }, 300)
    return () => clearTimeout(timer)
  }, [board, drawn])
  useEffect(
    () => () => {
      if (pending.current !== null) saveBoard(pending.current.root, pending.current.text)
    },
    [],
  )

  useEffect(() => {
    if (events.selected === null || viewport === null) return
    const box = boxOf(events.selected)
    if (box !== null) move((current) => keepInView(current, box, viewport))
    // Only a new selection moves the board; a live update to the same card leaves it where the person put it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.selected])

  useEffect(() => {
    const element = viewportElement
    if (element === null) return
    let pinching: { from: BoardView } | null = null
    const at = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect()
      return { x: clientX - rect.left, y: clientY - rect.top }
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PX : 1
      const wheel = wheelMove({ deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey })
      if (wheel.kind === 'pan') move((current) => panBy(current, wheel.dx, wheel.dy))
      // A WebKit pinch already zooms through its gesture events; the Ctrl-flagged wheel it also sends is left alone.
      else if (pinching === null) move((current) => zoomAt(current, wheel.factor, at(event.clientX, event.clientY)))
    }
    const onGestureStart = (event: Event) => {
      event.preventDefault()
      pinching = { from: viewRef.current }
    }
    const onGestureChange = (event: Event) => {
      event.preventDefault()
      const gesture = event as GestureEvent
      const from = pinching?.from ?? viewRef.current
      move(() => zoomAt(from, clampScale(from.scale * gesture.scale) / from.scale, at(gesture.clientX, gesture.clientY)))
    }
    const onGestureEnd = (event: Event) => {
      event.preventDefault()
      pinching = null
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('gesturestart', onGestureStart)
    element.addEventListener('gesturechange', onGestureChange)
    element.addEventListener('gestureend', onGestureEnd)
    return () => {
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('gesturestart', onGestureStart)
      element.removeEventListener('gesturechange', onGestureChange)
      element.removeEventListener('gestureend', onGestureEnd)
    }
    // move only sets state; the listeners need not follow it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportElement])

  // A press on a control is its own; on a card it waits to see whether it drags; on the background it pans.
  const startPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest('[data-board-control]') !== null) return
    dragged.current = false
    const card = event.target.closest<HTMLElement>('[data-node]')?.dataset.node
    const from = card === undefined ? undefined : board.nodes.get(card)
    if (card !== undefined && from !== undefined) {
      press.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, kind: 'card', id: card, from, moving: false }
      return
    }
    if (event.target.closest('button') !== null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, kind: 'pan', from: viewRef.current }
    setDragging(true)
  }
  const continuePress = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = press.current
    if (start === null || start.pointer !== event.pointerId) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (start.kind === 'pan') return move(() => panBy(start.from, dx, dy))
    if (!start.moving) {
      if (!pastThreshold(dx, dy)) return
      // Only now does the board take the pointer, so a press that never moves stays a click on the card.
      start.moving = true
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
    }
    const to = draggedTo(start.from, dx, dy, viewRef.current.scale)
    setBoard((current) => ({ ...current, nodes: new Map(current.nodes).set(start.id, to) }))
  }
  const endPress = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = press.current
    if (start?.pointer !== event.pointerId) return
    dragged.current = start.kind === 'card' && start.moving
    press.current = null
    setDragging(false)
  }
  const swallowDragClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!dragged.current) return
    dragged.current = false
    event.stopPropagation()
    event.preventDefault()
  }
  const zoomBy = (factor: number) => {
    if (viewport !== null) move((current) => zoomAt(current, factor, { x: viewport.width / 2, y: viewport.height / 2 }))
  }

  const shown = board.view ?? viewRef.current
  return (
    <div
      ref={setViewportElement}
      onPointerDown={startPress}
      onPointerMove={continuePress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onClickCapture={swallowDragClick}
      className={`relative min-h-0 flex-1 touch-none overflow-hidden select-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: bounds === null ? 0 : bounds.left + bounds.width,
          height: bounds === null ? 0 : bounds.top + bounds.height,
          transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.scale})`,
          visibility: board.view === null ? 'hidden' : undefined,
        }}
      >
        <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden="true">
          {edges.map((edge) => (
            <path
              key={edge.node}
              d={edge.d}
              fill="none"
              stroke={edge.lit ? 'var(--color-accent)' : 'var(--color-ink-500)'}
              strokeOpacity={edge.lit ? 0.8 : 1}
              strokeWidth={1.5}
              strokeDasharray="2 5"
              strokeLinecap="round"
              className={edge.flowing ? 'orchestration-flow' : undefined}
            />
          ))}
          {travelling.map(({ pulse, edge, color }) => (
            <path key={pulse.id} d={edge.d} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" className="orchestration-edge-pulse" />
          ))}
        </svg>
        {travelling.map(({ pulse, edge, color }) => (
          <span
            key={pulse.id}
            aria-hidden="true"
            data-direction={pulse.direction}
            className="orchestration-dot pointer-events-none absolute top-0 left-0 size-2 rounded-full"
            style={{ offsetPath: `path('${edge.d}')`, offsetAnchor: 'center', background: color, boxShadow: `0 0 8px ${color}` }}
          />
        ))}
        {graph.nodes.map((node) => {
          const point = board.nodes.get(node.id)
          return (
            <div
              key={node.id}
              data-node={node.id}
              className="absolute top-0 left-0"
              style={{ width: CARD_WIDTH, transform: point === undefined ? undefined : `translate(${point.x}px, ${point.y}px)`, visibility: point === undefined ? 'hidden' : undefined }}
            >
              <OrchestrationCard
                node={node}
                relation={relations.get(node.id) ?? 'other'}
                selected={events.selected === node.id}
                now={events.now}
                cardRef={register(node.id)}
                onClick={() => events.onClick(node.id)}
                onDoubleClick={() => events.onDoubleClick(node.id)}
              />
            </div>
          )
        })}
      </div>
      <div data-board-control className="absolute right-3 bottom-3 flex cursor-default items-center gap-0.5 rounded-full border border-white/10 bg-ink-900/90 p-0.5 shadow-[0_6px_18px_rgb(0_0_0/0.4)]">
        <BoardButton label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>−</BoardButton>
        <span className="w-11 text-center font-mono text-chat-label text-ink-400 tabular-nums" aria-live="polite">
          {Math.round(shown.scale * 100)}%
        </span>
        <BoardButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>+</BoardButton>
        <BoardButton label="Fit the tree" onClick={fit}>Fit</BoardButton>
        <BoardButton label="Reset the layout" onClick={reset}>Reset</BoardButton>
      </div>
    </div>
  )
}
