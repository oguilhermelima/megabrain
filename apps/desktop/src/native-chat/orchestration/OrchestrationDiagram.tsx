import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { OrchestrationCard } from '@/native-chat/orchestration/OrchestrationCard'
import { CARD_WIDTH, focusPath, layoutTree, relationTo, treeOf, type LaidOut, type Pulse, type Relation } from '@/native-chat/orchestration/orchestration-layout'
import { clampScale, fitView, keepInView, panBy, wheelZoom, zoomAt, ZOOM_STEP, type BoardView, type Size } from '@/native-chat/orchestration/orchestration-board'
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

function Subtree({ laid, relations, register, events }: { laid: LaidOut; relations: ReadonlyMap<string, Relation>; register: (id: string) => (element: HTMLButtonElement | null) => void; events: CardEvents }) {
  const { node } = laid
  return (
    <div className="flex w-full min-w-0 flex-col items-center">
      <OrchestrationCard
        node={node}
        relation={relations.get(node.id) ?? 'other'}
        selected={events.selected === node.id}
        now={events.now}
        cardRef={register(node.id)}
        onClick={() => events.onClick(node.id)}
        onDoubleClick={() => events.onDoubleClick(node.id)}
      />
      {laid.rows.map((row, index) => (
        <div key={index} className="mt-12 flex w-full justify-center gap-4">
          {row.map((child) => (
            <div key={child.node.id} className="flex min-w-0 flex-1 justify-center">
              <Subtree laid={child} relations={relations} register={register} events={events} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

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
 * The tree as cards on a board, the coordinator on top and each node's lanes wrapping in rows beneath
 * it, with dotted connectors drawn behind them from where the cards actually landed. Dragging the
 * background or scrolling pans it; a pinch, Ctrl/Cmd plus wheel, or the corner buttons zoom it. It
 * stays fitted to the tree until the person moves it, and a selected card is kept in view. Each pulse
 * lights its edge and runs a dot along it in the message's direction.
 */
export function OrchestrationDiagram({ graph, pulses, ...events }: CardEvents & { graph: OrchestrationGraph; pulses: readonly LivePulse[] }) {
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null)
  const [canvasElement, setCanvasElement] = useState<HTMLDivElement | null>(null)
  const viewport = useSize(viewportElement)
  const content = useSize(canvasElement)
  const tree = useMemo(() => treeOf(graph), [graph])
  // Lanes wrap to the board's width at life size; zooming out then shows more of them, not more columns.
  const width = viewport === null ? CARD_WIDTH : Math.max(CARD_WIDTH, viewport.width - PADDING * 2)
  const laid = useMemo(() => (tree === null ? null : layoutTree(tree, width)), [tree, width])
  const relations = useMemo(() => new Map(graph.nodes.map((node) => [node.id, relationTo(graph, node.id)])), [graph])
  const [view, setView] = useState<BoardView | null>(null)
  const viewRef = useRef<BoardView>({ x: 0, y: 0, scale: 1 })
  viewRef.current = view ?? viewRef.current
  // Once the person pans or zooms, the board stops refitting itself as the tree grows; Fit starts it again.
  const [moved, setMoved] = useState(false)
  const drag = useRef<{ pointer: number; x: number; y: number; from: BoardView } | null>(null)
  const [dragging, setDragging] = useState(false)
  const cards = useRef(new Map<string, HTMLButtonElement>())
  const registrars = useRef(new Map<string, (element: HTMLButtonElement | null) => void>())
  const [edges, setEdges] = useState<Edge[]>([])
  const edgeOf = new Map(edges.map((edge) => [edge.node, edge]))
  const travelling = pulses.flatMap((pulse) => {
    const edge = edgeOf.get(pulse.node)
    return edge === undefined ? [] : [{ pulse, edge, color: pulseColor[pulse.type] ?? 'var(--color-accent)' }]
  })

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

  const move = (change: (current: BoardView) => BoardView) => {
    setMoved(true)
    setView((current) => change(current ?? viewRef.current))
  }
  const fit = () => {
    if (viewport === null || content === null) return
    setMoved(false)
    setView(fitView(content, viewport))
  }

  useLayoutEffect(() => {
    if (!moved && viewport !== null && content !== null) setView(fitView(content, viewport))
  }, [moved, viewport, content])

  // A card's box in canvas coordinates: its place on screen, less the canvas's, unscaled.
  const boxOf = (id: string) => {
    const card = cards.current.get(id)?.getBoundingClientRect()
    const origin = canvasElement?.getBoundingClientRect()
    if (card === undefined || origin === undefined) return null
    const { scale } = viewRef.current
    return { left: (card.left - origin.left) / scale, top: (card.top - origin.top) / scale, width: card.width / scale, height: card.height / scale }
  }

  useEffect(() => {
    if (events.selected === null || viewport === null) return
    const box = boxOf(events.selected)
    if (box !== null) setView((current) => (current === null ? current : keepInView(current, box, viewport)))
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
      if (event.ctrlKey || event.metaKey) {
        if (pinching === null) move((current) => zoomAt(current, wheelZoom(event.deltaY * unit), at(event.clientX, event.clientY)))
      } else move((current) => panBy(current, -event.deltaX * unit, -event.deltaY * unit))
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

  // A drag that starts on a card or a control is theirs; only the background pans.
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button') !== null)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: viewRef.current }
    setDragging(true)
  }
  const continueDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (start === null || start.pointer !== event.pointerId) return
    move(() => panBy(start.from, event.clientX - start.x, event.clientY - start.y))
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }
  const zoomBy = (factor: number) => {
    if (viewport !== null) move((current) => zoomAt(current, factor, { x: viewport.width / 2, y: viewport.height / 2 }))
  }

  useLayoutEffect(() => {
    const element = canvasElement
    if (element === null) return
    const path = new Set(focusPath(graph))
    const measure = () => {
      // The canvas is scaled; dividing by the scale puts every end back in the canvas's own coordinates.
      const { scale } = viewRef.current
      const origin = element.getBoundingClientRect()
      const next: Edge[] = []
      for (const node of graph.nodes) {
        if (node.parent === null) continue
        const from = cards.current.get(node.parent)?.getBoundingClientRect()
        const to = cards.current.get(node.id)?.getBoundingClientRect()
        if (from === undefined || to === undefined) continue
        const x1 = (from.left + from.width / 2 - origin.left) / scale
        const y1 = (from.bottom - origin.top) / scale
        const x2 = (to.left + to.width / 2 - origin.left) / scale
        const y2 = (to.top - origin.top) / scale
        const bend = y1 + Math.min(28, (y2 - y1) / 2)
        next.push({
          node: node.id,
          d: `M ${x1} ${y1} C ${x1} ${bend + 12} ${x2} ${bend - 12} ${x2} ${Math.max(bend, y2 - 24)} L ${x2} ${y2}`,
          flowing: node.state === 'working' || node.state === 'starting',
          lit: path.has(node.id) && path.has(node.parent),
        })
      }
      setEdges(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [graph, laid, canvasElement])

  const shown = view ?? viewRef.current
  return (
    <div
      ref={setViewportElement}
      onPointerDown={startDrag}
      onPointerMove={continueDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={`relative min-h-0 flex-1 touch-none overflow-hidden select-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
    >
      <div
        ref={setCanvasElement}
        className="absolute top-0 left-0 min-w-fit origin-top-left px-6 pt-7 pb-8"
        style={{ width: width + PADDING * 2, transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.scale})`, visibility: view === null ? 'hidden' : undefined }}
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
        {laid !== null && <Subtree laid={laid} relations={relations} register={register} events={events} />}
      </div>
      <div className="absolute right-3 bottom-3 flex cursor-default items-center gap-0.5 rounded-full border border-white/10 bg-ink-900/90 p-0.5 shadow-[0_6px_18px_rgb(0_0_0/0.4)]">
        <BoardButton label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>−</BoardButton>
        <span className="w-11 text-center font-mono text-chat-label text-ink-400 tabular-nums" aria-live="polite">
          {Math.round(shown.scale * 100)}%
        </span>
        <BoardButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>+</BoardButton>
        <BoardButton label="Fit the tree" onClick={fit}>Fit</BoardButton>
      </div>
    </div>
  )
}
