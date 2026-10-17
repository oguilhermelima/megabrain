import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KnowledgeTopicSummary } from '@/api/schema'
import { kindColors, kindGroups, nodeRadius, statusLabels, topicGraph } from '@/advanced/knowledge-model'
import { layoutGraph } from '@/advanced/knowledge-map'

// The Knowledge map: a project's topics as a graph, like Obsidian's. A node is a topic, sized by its
// activity and coloured by its kind; an edge joins topics that share chats, files or refs, thicker
// the more they share. Hovering a node lights its links; clicking it opens the topic.

/** A label under its node, cut to fit. */
const short = (title: string) => (title.length > 26 ? `${title.slice(0, 25)}…` : title)

export function KnowledgeMap({ project, topics, selectedId, onPick, onClose }: { project: string; topics: KnowledgeTopicSummary[]; selectedId: string | null; onPick: (topic: KnowledgeTopicSummary) => void; onClose: () => void }) {
  const area = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const element = area.current
    if (element === null) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const graph = useMemo(() => topicGraph(topics), [topics])
  // Labels hang under each node, so the layout keeps room for them below.
  const placed = useMemo(() => {
    if (size === null) return null
    const nodes = graph.nodes.map((node) => ({ id: node.id, radius: nodeRadius(node.activity) }))
    const edges = graph.edges.map((edge) => ({ source: edge.source, target: edge.target, weight: edge.chats + edge.files + edge.refs }))
    return layoutGraph(nodes, edges, { width: Math.max(200, size.width - 80), height: Math.max(200, size.height - 100) })
  }, [graph, size])
  const [hovered, setHovered] = useState<string | null>(null)
  const linked = useMemo(() => {
    if (hovered === null) return null
    return new Set([hovered, ...graph.edges.flatMap((edge) => (edge.source === hovered ? [edge.target] : edge.target === hovered ? [edge.source] : []))])
  }, [graph, hovered])
  const byId = new Map(topics.map((topic) => [topic.id, topic]))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 px-6 pt-5 pb-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[18px] font-semibold tracking-[-0.01em] text-ink-100">Map of {project}</h1>
          <p className="mt-0.5 text-[12.5px] text-ink-400">
            {topics.length === 1 ? '1 topic' : `${topics.length} topics`} · {graph.edges.length === 1 ? '1 link' : `${graph.edges.length} links`} through shared chats, files and refs
          </p>
        </div>
        <ul className="hidden flex-wrap items-center gap-x-3 gap-y-1 md:flex" aria-label="Kinds">
          {kindGroups.map((group) => (
            <li key={group.kind} className="flex items-center gap-1.5 text-[12px] text-ink-400">
              <span aria-hidden="true" style={{ backgroundColor: kindColors[group.kind] }} className="size-2 rounded-full" />
              {group.label}
            </li>
          ))}
        </ul>
        <button type="button" onClick={onClose} className="inline-flex h-8 shrink-0 items-center rounded-full border border-white/[0.1] bg-white/[0.04] px-3.5 text-[12.5px] font-medium text-ink-200 transition-colors hover:bg-white/[0.08]">
          Close map
        </button>
      </header>
      <div ref={area} className="relative min-h-0 flex-1">
        {topics.length === 0 ? (
          <p className="pt-24 text-center text-[13.5px] text-ink-400">No topics to map yet.</p>
        ) : (
          size !== null &&
          placed !== null && (
            <svg width={size.width} height={size.height} role="group" aria-label={`Map of ${project}`} className="absolute inset-0 select-none">
              <g transform="translate(40 30)">
                {graph.edges.map((edge) => {
                  const from = placed.get(edge.source)
                  const to = placed.get(edge.target)
                  if (from === undefined || to === undefined) return null
                  const lit = linked !== null && (edge.source === hovered || edge.target === hovered)
                  const shared = edge.chats + edge.files + edge.refs
                  return <line key={`${edge.source}\n${edge.target}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={lit ? 'rgb(255 255 255 / 0.5)' : 'rgb(255 255 255 / 0.12)'} strokeWidth={Math.min(4, 0.75 + shared * 0.5)} className="transition-[stroke] duration-[120ms]" />
                })}
                {graph.nodes.map((node) => {
                  const point = placed.get(node.id)
                  const topic = byId.get(node.id)
                  if (point === undefined || topic === undefined) return null
                  const radius = nodeRadius(node.activity)
                  const color = kindColors[node.kind]
                  const dim = linked !== null && !linked.has(node.id)
                  const selected = node.id === selectedId
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${point.x} ${point.y})`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.title}, ${statusLabels[node.status]}`}
                      onClick={() => onPick(topic)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        onPick(topic)
                      }}
                      onPointerEnter={() => setHovered(node.id)}
                      onPointerLeave={() => setHovered((current) => (current === node.id ? null : current))}
                      onFocus={() => setHovered(node.id)}
                      onBlur={() => setHovered(null)}
                      style={{ opacity: dim ? 0.3 : node.status === 'dropped' ? 0.55 : 1 }}
                      className="cursor-pointer outline-none transition-opacity duration-[120ms]"
                    >
                      <title>{`${node.title}\n${statusLabels[node.status]}`}</title>
                      {selected && <circle r={radius + 5} fill="none" stroke={color} strokeOpacity={0.6} strokeWidth={1.5} />}
                      <circle r={radius} fill={color} fillOpacity={0.22} stroke={color} strokeWidth={1.5} />
                      <circle r={Math.max(2.5, radius * 0.32)} fill={color} />
                      <text y={radius + 15} textAnchor="middle" className={`text-[11.5px] ${hovered === node.id || selected ? 'fill-ink-100 font-semibold' : 'fill-ink-300'}`}>
                        {short(node.title)}
                      </text>
                    </g>
                  )
                })}
              </g>
            </svg>
          )
        )}
      </div>
    </div>
  )
}
