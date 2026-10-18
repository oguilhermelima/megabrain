import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePaneWidth } from '@/native-chat/usePaneWidth'
import { OrchestrationCard } from '@/native-chat/orchestration/OrchestrationCard'
import { CARD_WIDTH, focusPath, layoutTree, relationTo, treeOf, type LaidOut, type Pulse, type Relation } from '@/native-chat/orchestration/orchestration-layout'
import type { OrchestrationGraph } from '@/native-chat/orchestration/orchestration-schema'

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

/**
 * The tree as cards, the coordinator on top and each node's lanes wrapping in rows beneath it, with
 * dotted connectors drawn behind them from where the cards actually landed. Each pulse lights its
 * edge and runs a dot along it in the message's direction.
 */
export function OrchestrationDiagram({ graph, pulses, ...events }: CardEvents & { graph: OrchestrationGraph; pulses: readonly LivePulse[] }) {
  const pane = usePaneWidth()
  const tree = useMemo(() => treeOf(graph), [graph])
  const width = Number.isFinite(pane.width) ? Math.max(CARD_WIDTH, pane.width - PADDING * 2) : CARD_WIDTH
  const laid = useMemo(() => (tree === null ? null : layoutTree(tree, width)), [tree, width])
  const relations = useMemo(() => new Map(graph.nodes.map((node) => [node.id, relationTo(graph, node.id)])), [graph])
  const canvas = useRef<HTMLDivElement>(null)
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

  useLayoutEffect(() => {
    const element = canvas.current
    if (element === null) return
    const path = new Set(focusPath(graph))
    const measure = () => {
      const origin = element.getBoundingClientRect()
      const next: Edge[] = []
      for (const node of graph.nodes) {
        if (node.parent === null) continue
        const from = cards.current.get(node.parent)?.getBoundingClientRect()
        const to = cards.current.get(node.id)?.getBoundingClientRect()
        if (from === undefined || to === undefined) continue
        const x1 = from.left + from.width / 2 - origin.left
        const y1 = from.bottom - origin.top
        const x2 = to.left + to.width / 2 - origin.left
        const y2 = to.top - origin.top
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
  }, [graph, laid])

  return (
    <div ref={pane.ref} className="min-h-0 flex-1 overflow-auto">
      <div ref={canvas} className="relative min-w-fit px-6 pt-7 pb-8">
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
    </div>
  )
}
