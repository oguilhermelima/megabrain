import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KnowledgeKind, KnowledgeTopicSummary } from '@/api/schema'
import { kindColors, kindGroups, statusLabels } from '@/advanced/knowledge-model'
import { type Box, type Direction, type LinkType, type MapFilter, type MapLayout, type PlacedTopic, type View, fitView, labelSize, layoutMap, linkPath, linkTypes, showAll, stepFrom, zoomAt } from '@/advanced/knowledge-map'
import { relativeAge } from '@/advanced/projects-model'
import { tokenMs } from '@/lib/motion'

// The Knowledge map: a project's topics as a graph, one region per kind (knowledge-map.ts lays it
// out). A node is a topic, sized by its activity, coloured by its kind and drawn by its status; a
// curve joins topics that share chats, files or refs, heavier the more they share. Drag or scroll to
// pan, pinch or ⌘-scroll to zoom, double-click to fit. Hovering or focusing a topic lights it and its
// neighbours and shows what links it; arrow keys walk between topics and Enter opens one.

/** The filter outlives the map, so coming back from a topic finds it as it was left. */
const remembered: { filter: MapFilter } = { filter: showAll }

const padding = 40
const arrows: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/** Where each topic and region is drawn this frame; it eases from one layout to the next. */
interface Frame {
  topics: Map<string, { x: number; y: number; radius: number }>
  regions: Map<KnowledgeKind, Box>
}

const frameOf = (layout: MapLayout): Frame => ({ topics: new Map(layout.topics.map((entry) => [entry.id, { x: entry.x, y: entry.y, radius: entry.radius }])), regions: new Map(layout.regions.map((region) => [region.kind, region.box])) })

const lerp = (from: number, to: number, t: number) => from + (to - from) * t

function mix(from: Frame, to: Frame, t: number): Frame {
  const topics = new Map([...to.topics].map(([id, end]) => {
    const start = from.topics.get(id)
    return [id, start === undefined ? end : { x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t), radius: lerp(start.radius, end.radius, t) }]
  }))
  const regions = new Map([...to.regions].map(([kind, end]) => {
    const start = from.regions.get(kind)
    return [kind, start === undefined ? end : { x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t), width: lerp(start.width, end.width, t), height: lerp(start.height, end.height, t) }]
  }))
  return { topics, regions }
}

/** The app's panel easing, close enough: quick out of the gate, settling softly. */
const ease = (t: number) => 1 - (1 - t) ** 3

/** Runs `step` with an eased 0→1 over the panel duration (at once under reduced motion); returns a cancel. */
function animate(step: (t: number) => void): () => void {
  const duration = tokenMs('--motion-panel')
  if (duration === 0) {
    step(1)
    return () => {}
  }
  const start = performance.now()
  let frame = requestAnimationFrame(function tick(now) {
    const t = Math.min(1, (now - start) / duration)
    step(ease(t))
    if (t < 1) frame = requestAnimationFrame(tick)
  })
  return () => cancelAnimationFrame(frame)
}

/** A label's width as the map draws it, measured in the page's own font. */
function useMeasure(element: HTMLElement | null): ((text: string) => number) | undefined {
  return useMemo(() => {
    if (element === null) return undefined
    const context = document.createElement('canvas').getContext('2d')
    if (context === null) return undefined
    context.font = `${labelSize}px ${getComputedStyle(element).fontFamily}`
    const widths = new Map<string, number>()
    return (text: string) => {
      const known = widths.get(text)
      if (known !== undefined) return known
      const width = context.measureText(text).width
      widths.set(text, width)
      return width
    }
  }, [element])
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

export function KnowledgeMap({ project, topics, selectedId, onPick }: { project: string; topics: KnowledgeTopicSummary[]; selectedId: string | null; onPick: (topic: KnowledgeTopicSummary) => void }) {
  const [area, setArea] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    if (area === null) return
    const measure = () => setSize({ width: area.clientWidth, height: area.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    return () => observer.disconnect()
  }, [area])
  const measure = useMeasure(area)

  const [filter, setFilter] = useState(remembered.filter)
  useEffect(() => {
    remembered.filter = filter
  }, [filter])
  // The shape the regions pack into, in quarter steps so a resize only rearranges at a threshold.
  const aspect = size === null ? 1.5 : Math.max(0.75, Math.round((size.width / Math.max(1, size.height)) * 4) / 4)
  const layout = useMemo(() => layoutMap(topics, { filter, aspect, measure }), [topics, filter, aspect, measure])
  const byId = useMemo(() => new Map(topics.map((topic) => [topic.id, topic])), [topics])
  const placedById = useMemo(() => new Map(layout.topics.map((entry) => [entry.id, entry])), [layout])
  const counts = useMemo(() => new Map(kindGroups.map((group) => [group.kind, topics.filter((topic) => topic.kind === group.kind).length])), [topics])

  // Topics and regions ease into a new layout.
  const [frame, setFrame] = useState(() => frameOf(layout))
  const shownFrame = useRef(frame)
  useLayoutEffect(() => {
    const from = shownFrame.current
    const to = frameOf(layout)
    return animate((t) => {
      const next = t === 1 ? to : mix(from, to, t)
      shownFrame.current = next
      setFrame(next)
    })
  }, [layout])

  // The camera: fitted to a new layout, and to a resize until the person pans or zooms.
  const [view, setViewState] = useState<View | null>(null)
  const viewRef = useRef<View | null>(null)
  const cancelView = useRef<() => void>(() => {})
  const moved = useRef(false)
  const jump = (next: View) => {
    cancelView.current()
    viewRef.current = next
    setViewState(next)
  }
  const glide = (next: View) => {
    cancelView.current()
    const from = viewRef.current
    if (from === null) return jump(next)
    cancelView.current = animate((t) => {
      const current = { x: lerp(from.x, next.x, t), y: lerp(from.y, next.y, t), scale: lerp(from.scale, next.scale, t) }
      viewRef.current = current
      setViewState(current)
    })
  }
  const fit = () => {
    if (size === null) return
    moved.current = false
    glide(fitView(layout.bounds, size, padding))
  }
  const fitted = useRef<MapLayout | null>(null)
  useLayoutEffect(() => {
    if (size === null) return
    const target = fitView(layout.bounds, size, padding)
    if (viewRef.current === null) jump(target)
    else if (fitted.current !== layout || !moved.current) glide(target)
    if (fitted.current !== layout) moved.current = false
    fitted.current = layout
  }, [layout, size])
  const zoomBy = (factor: number, at?: { x: number; y: number }) => {
    const current = viewRef.current
    if (current === null || size === null) return
    moved.current = true
    const next = zoomAt(current, factor, at ?? { x: size.width / 2, y: size.height / 2 })
    if (at === undefined) glide(next)
    else jump(next)
  }

  // Trackpad and wheel: scroll pans, pinch (ctrl-wheel in Chromium, gesture events in WebKit) and ⌘-scroll zoom.
  const zoomRef = useRef(zoomBy)
  zoomRef.current = zoomBy
  useEffect(() => {
    if (area === null) return
    const point = (event: { clientX: number; clientY: number }) => {
      const bounds = area.getBoundingClientRect()
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = viewRef.current
      if (current === null) return
      if (event.ctrlKey || event.metaKey) return zoomRef.current(Math.exp(-event.deltaY * 0.01), point(event))
      moved.current = true
      jump({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY })
    }
    let pinch = 1
    const gesture = (event: Event) => {
      event.preventDefault()
      const scale = (event as Event & { scale?: number }).scale ?? 1
      if (event.type === 'gesturestart') pinch = 1
      else zoomRef.current(scale / pinch, point(event as unknown as MouseEvent))
      pinch = scale
    }
    area.addEventListener('wheel', wheel, { passive: false })
    for (const type of ['gesturestart', 'gesturechange']) area.addEventListener(type, gesture)
    return () => {
      area.removeEventListener('wheel', wheel)
      for (const type of ['gesturestart', 'gesturechange']) area.removeEventListener(type, gesture)
    }
  }, [area])

  // Dragging anywhere pans; a press that moved is not a click.
  const drag = useRef<{ x: number; y: number; view: View; pointer: number; panning: boolean } | null>(null)
  const dragged = useRef(false)
  const [panning, setPanning] = useState(false)

  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const nodes = useRef(new Map<string, SVGGElement>())
  const [current, setCurrent] = useState<string | null>(null)
  const roving = current !== null && placedById.has(current) ? current : selectedId !== null && placedById.has(selectedId) ? selectedId : (layout.topics[0]?.id ?? null)
  const active = panning ? null : (hovered ?? focused)
  const lit = useMemo(() => {
    if (active === null) return null
    return new Set([active, ...layout.links.flatMap((link) => (link.source === active ? [link.target] : link.target === active ? [link.source] : []))])
  }, [active, layout])

  /** Moves the camera, gently, so a topic reached by keyboard is on screen. */
  const reveal = (id: string) => {
    const point = frame.topics.get(id)
    const camera = viewRef.current
    if (point === undefined || camera === null || size === null) return
    const x = point.x * camera.scale + camera.x
    const y = point.y * camera.scale + camera.y
    if (x > padding && x < size.width - padding && y > padding && y < size.height - padding) return
    moved.current = true
    glide({ ...camera, x: size.width / 2 - point.x * camera.scale, y: size.height / 2 - point.y * camera.scale })
  }

  const toggleKind = (kind: KnowledgeKind) =>
    setFilter((now) => {
      const kinds = new Set(now.kinds)
      if (!kinds.delete(kind)) kinds.add(kind)
      return { ...now, kinds }
    })
  const toggleLink = (type: LinkType) =>
    setFilter((now) => {
      const links = new Set(now.links)
      if (!links.delete(type)) links.add(type)
      return { ...now, links }
    })

  const card = active === null ? null : placedById.get(active)
  const shownCount = layout.topics.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The page's top bar closes the map; this header names it, says what it shows and filters it. */}
      <header className="shrink-0 space-y-3 px-6 pt-4 pb-3">
        <div className="space-y-1">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-100">Map of {project}</h2>
          <p className="text-[12.5px] text-ink-400">
          {shownCount === topics.length ? plural(topics.length, 'topic') : `${shownCount} of ${plural(topics.length, 'topic')}`} · {plural(layout.links.length, 'link')} through shared {linkTypes.filter((entry) => filter.links.has(entry.type)).map((entry) => entry.label.toLowerCase()).join(', ') || 'nothing'}
          </p>
        </div>
        {topics.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <ul className="flex flex-wrap items-center gap-1.5" aria-label="Kinds shown">
              {kindGroups.map((group) => {
                const count = counts.get(group.kind) ?? 0
                if (count === 0) return null
                const on = filter.kinds.has(group.kind)
                return (
                  <li key={group.kind}>
                    <Chip pressed={on} onClick={() => toggleKind(group.kind)} title={on ? `Hide ${group.label.toLowerCase()}` : `Show ${group.label.toLowerCase()}`}>
                      <span aria-hidden="true" style={on ? { backgroundColor: kindColors[group.kind] } : { boxShadow: `inset 0 0 0 1.5px ${kindColors[group.kind]}` }} className="size-2 rounded-full" />
                      {group.label}
                      <span className="tabular-nums text-ink-400">{count}</span>
                    </Chip>
                  </li>
                )
              })}
            </ul>
            <div className="ml-auto flex items-center gap-1.5" role="group" aria-label="Links drawn">
              <span className="mr-0.5 text-[12px] text-ink-400">Links</span>
              {linkTypes.map((entry) => (
                <Chip key={entry.type} pressed={filter.links.has(entry.type)} onClick={() => toggleLink(entry.type)} title={`Link topics that share ${entry.label.toLowerCase()}`}>
                  {entry.label}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </header>
      <div
        ref={setArea}
        className={`relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-[20px] border border-white/[0.06] bg-ink-900/40 ${panning ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={view === null ? undefined : grid(view)}
      >
        {topics.length === 0 ? (
          <p className="pt-24 text-center text-[13.5px] text-ink-400">No topics to map yet.</p>
        ) : shownCount === 0 ? (
          <p className="pt-24 text-center text-[13.5px] text-ink-400">Every kind is hidden. Turn one on above to see its topics.</p>
        ) : (
          size !== null &&
          view !== null && (
            <svg
              width={size.width}
              height={size.height}
              role="group"
              aria-label={`Map of ${project}`}
              className="absolute inset-0 touch-none select-none"
              onPointerDown={(event) => {
                if (event.button !== 0) return
                dragged.current = false
                drag.current = { x: event.clientX, y: event.clientY, view: viewRef.current ?? view, pointer: event.pointerId, panning: false }
              }}
              onPointerMove={(event) => {
                const start = drag.current
                if (start === null || start.pointer !== event.pointerId) return
                const dx = event.clientX - start.x
                const dy = event.clientY - start.y
                if (!start.panning && Math.hypot(dx, dy) < 4) return
                if (!start.panning) {
                  start.panning = true
                  dragged.current = true
                  event.currentTarget.setPointerCapture(event.pointerId)
                  setPanning(true)
                }
                moved.current = true
                jump({ ...start.view, x: start.view.x + dx, y: start.view.y + dy })
              }}
              onPointerUp={(event) => {
                if (drag.current?.panning === true) event.currentTarget.releasePointerCapture(event.pointerId)
                drag.current = null
                setPanning(false)
              }}
              onPointerCancel={() => {
                drag.current = null
                setPanning(false)
              }}
              onDoubleClick={(event) => {
                if ((event.target as Element).closest('[data-topic]') === null) fit()
              }}
              onKeyDown={(event) => {
                if (event.key === '+' || event.key === '=') zoomBy(1.25)
                else if (event.key === '-') zoomBy(0.8)
                else if (event.key === '0') fit()
                else return
                event.preventDefault()
              }}
            >
              <defs>
                <filter id="knowledge-map-glow" x="-100%" y="-100%" width="300%" height="300%">
                  <feGaussianBlur stdDeviation="6" />
                </filter>
              </defs>
              <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
                {layout.regions.map((region) => {
                  const box = frame.regions.get(region.kind) ?? region.box
                  const color = kindColors[region.kind]
                  const faded = lit !== null && ![...lit].some((id) => placedById.get(id)?.kind === region.kind)
                  return (
                    <g key={region.kind} style={{ opacity: faded ? 0.45 : 1, transition: 'opacity var(--motion-enter) var(--motion-ease-out)' }}>
                      <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={22} fill={color} fillOpacity={0.045} stroke={color} strokeOpacity={0.16} />
                      <circle cx={box.x + 22} cy={box.y + 20} r={3.5} fill={color} />
                      <text x={box.x + 32} y={box.y + 24} fontSize={12} className="font-semibold" fill={color}>
                        {region.label}
                        <tspan dx={6} className="fill-ink-400 font-normal">
                          {region.count}
                        </tspan>
                      </text>
                    </g>
                  )
                })}
                {[...layout.links]
                  .sort((left, right) => Number(touches(left, active)) - Number(touches(right, active)))
                  .map((link) => {
                    const from = frame.topics.get(link.source)
                    const to = frame.topics.get(link.target)
                    if (from === undefined || to === undefined) return null
                    const on = touches(link, active)
                    const color = on && active !== null ? kindColors[placedById.get(active)?.kind ?? 'feat'] : '#ffffff'
                    const opacity = on ? 0.75 : lit !== null ? 0.035 : Math.min(0.26, 0.08 + 0.04 * link.weight)
                    const length = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y))
                    const trim = (point: { x: number; y: number; radius: number }, toward: { x: number; y: number }) => ({ x: point.x + ((toward.x - point.x) / length) * (point.radius + 3), y: point.y + ((toward.y - point.y) / length) * (point.radius + 3) })
                    return (
                      <path
                        key={`${link.source}\n${link.target}`}
                        d={linkPath(trim(from, to), trim(to, from))}
                        fill="none"
                        stroke={color}
                        strokeOpacity={opacity}
                        strokeWidth={Math.min(4.5, 0.9 + 0.55 * link.weight) * (on ? 1.15 : 1)}
                        strokeLinecap="round"
                        style={{ transition: 'stroke-opacity var(--motion-enter) var(--motion-ease-out)' }}
                      />
                    )
                  })}
                {layout.topics.map((entry) => {
                  const point = frame.topics.get(entry.id)
                  const topic = byId.get(entry.id)
                  if (point === undefined || topic === undefined) return null
                  return (
                    <Node
                      key={entry.id}
                      entry={entry}
                      point={point}
                      dim={lit !== null && !lit.has(entry.id)}
                      hot={active === entry.id}
                      selected={entry.id === selectedId}
                      tabbable={entry.id === roving}
                      register={(element) => {
                        if (element === null) nodes.current.delete(entry.id)
                        else nodes.current.set(entry.id, element)
                      }}
                      onOpen={() => {
                        if (!dragged.current) onPick(topic)
                      }}
                      onHover={(on) => setHovered((now) => (on ? entry.id : now === entry.id ? null : now))}
                      onFocusChange={(on) => {
                        if (on) {
                          setCurrent(entry.id)
                          reveal(entry.id)
                        }
                        setFocused((now) => (on ? entry.id : now === entry.id ? null : now))
                      }}
                      onStep={(direction) => {
                        const next = stepFrom(layout.topics, layout.links, entry.id, direction)
                        if (next !== null) nodes.current.get(next)?.focus()
                      }}
                    />
                  )
                })}
              </g>
            </svg>
          )
        )}
        {card !== null && card !== undefined && view !== null && size !== null && <TopicCard entry={card} point={frame.topics.get(card.id) ?? card} view={view} size={size} />}
        {shownCount > 0 && view !== null && (
          <>
            <p className="pointer-events-none absolute bottom-3.5 left-4 hidden text-[11.5px] text-ink-500 lg:block">Drag to pan · pinch or ⌘-scroll to zoom · double-click to fit · arrows move between topics</p>
            <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-full border border-white/[0.08] bg-ink-900/85 p-1 shadow-lg backdrop-blur" role="group" aria-label="Zoom">
              <RoundButton label="Zoom out" onClick={() => zoomBy(0.8)}>
                <path d="M4 8h8" />
              </RoundButton>
              <button type="button" onClick={fit} title="Fit the map" className="h-7 min-w-[46px] rounded-full px-1.5 text-[11.5px] font-medium tabular-nums text-ink-300 transition-colors hover:bg-white/[0.08] hover:text-ink-100">
                {Math.round(view.scale * 100)}%
              </button>
              <RoundButton label="Zoom in" onClick={() => zoomBy(1.25)}>
                <path d="M4 8h8M8 4v8" />
              </RoundButton>
              <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-white/[0.08]" />
              <RoundButton label="Fit the map" onClick={fit}>
                <path d="M2.75 6V3.75a1 1 0 0 1 1-1H6M10 2.75h2.25a1 1 0 0 1 1 1V6M13.25 10v2.25a1 1 0 0 1-1 1H10M6 13.25H3.75a1 1 0 0 1-1-1V10" />
              </RoundButton>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const touches = (link: { source: string; target: string }, id: string | null) => id !== null && (link.source === id || link.target === id)

/** A faint dot grid that pans and zooms with the map, re-spaced so its dots never crowd or scatter. */
function grid(view: View): CSSProperties {
  let step = 24 * view.scale
  while (step < 14) step *= 2
  while (step > 48) step /= 2
  return { backgroundImage: 'radial-gradient(circle, rgb(255 255 255 / 0.07) 1px, transparent 1.25px)', backgroundSize: `${step}px ${step}px`, backgroundPosition: `${view.x}px ${view.y}px` }
}

function Node({
  entry,
  point,
  dim,
  hot,
  selected,
  tabbable,
  register,
  onOpen,
  onHover,
  onFocusChange,
  onStep,
}: {
  entry: PlacedTopic
  point: { x: number; y: number; radius: number }
  dim: boolean
  hot: boolean
  selected: boolean
  tabbable: boolean
  register: (element: SVGGElement | null) => void
  onOpen: () => void
  onHover: (on: boolean) => void
  onFocusChange: (on: boolean) => void
  onStep: (direction: Direction) => void
}) {
  const color = kindColors[entry.kind]
  const { radius } = point
  const dropped = entry.status === 'dropped'
  const [ring, setRing] = useState(false)
  return (
    <g
      ref={register}
      data-topic={entry.id}
      transform={`translate(${point.x} ${point.y})`}
      role="button"
      tabIndex={tabbable ? 0 : -1}
      aria-label={`${entry.title}, ${kindGroups.find((group) => group.kind === entry.kind)?.one ?? entry.kind}, ${statusLabels[entry.status]}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        const direction = arrows[event.key]
        if (direction !== undefined) {
          event.preventDefault()
          event.stopPropagation()
          onStep(direction)
          return
        }
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={(event) => {
        setRing(event.currentTarget.matches(':focus-visible'))
        onFocusChange(true)
      }}
      onBlur={() => {
        setRing(false)
        onFocusChange(false)
      }}
      style={{ opacity: dim ? 0.22 : 1, transition: 'opacity var(--motion-enter) var(--motion-ease-out)' }}
      className="cursor-pointer outline-none"
    >
      <title>{entry.title}</title>
      {hot && <circle r={radius + 2} fill={color} opacity={0.5} filter="url(#knowledge-map-glow)" />}
      {(selected || ring) && <circle r={radius + 5} fill="none" stroke={ring ? 'var(--color-accent)' : color} strokeWidth={1.5} strokeOpacity={ring ? 1 : 0.85} strokeDasharray={ring ? '3 3' : undefined} />}
      {entry.status === 'shipped' && <circle r={radius} fill={color} />}
      {entry.status === 'active' && (
        <>
          <circle r={radius - 0.9} fill={color} fillOpacity={0.16} stroke={color} strokeWidth={1.8} />
          <circle r={Math.max(2.5, radius * 0.46)} fill={color} />
        </>
      )}
      {dropped && <circle r={radius - 0.75} fill={color} fillOpacity={0.08} stroke={color} strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="2.5 2.5" />}
      <text
        y={entry.labelBox.y - entry.y + labelSize - 1}
        textAnchor="middle"
        fontSize={labelSize}
        stroke="var(--color-ink-950)"
        strokeWidth={3}
        strokeLinejoin="round"
        paintOrder="stroke"
        opacity={dropped && !hot ? 0.55 : 1}
        className={hot || selected ? 'fill-ink-100 font-semibold' : 'fill-ink-300'}
      >
        {entry.label}
      </text>
    </g>
  )
}

/** The card beside a hovered or focused topic: what it is, where it stands and what links it. */
function TopicCard({ entry, point, view, size }: { entry: PlacedTopic; point: { x: number; y: number }; view: View; size: { width: number; height: number } }) {
  const x = Math.min(size.width - 156, Math.max(156, point.x * view.scale + view.x))
  const top = (point.y - entry.radius) * view.scale + view.y
  const below = top < 150
  const y = below ? (entry.labelBox.y + entry.labelBox.height) * view.scale + view.y + 10 : top - 12
  const { chats, files, refs, topics } = entry.shared
  const parts = [chats > 0 && plural(chats, 'chat'), files > 0 && plural(files, 'file'), refs > 0 && plural(refs, 'ref')].filter((part) => part !== false)
  const age = relativeAge(entry.updatedAt)
  return (
    <div role="tooltip" style={{ left: x, top: y, translate: below ? '-50% 0' : '-50% -100%' }} className="popover pointer-events-none absolute z-10 w-max max-w-[300px] px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-400">
        <span aria-hidden="true" style={{ backgroundColor: kindColors[entry.kind] }} className="size-2 rounded-full" />
        <span style={{ color: kindColors[entry.kind] }} className="font-medium">
          {kindGroups.find((group) => group.kind === entry.kind)?.one}
        </span>
        <span aria-hidden="true">·</span>
        {statusLabels[entry.status]}
        {age !== '' && (
          <>
            <span aria-hidden="true">·</span>
            {age === 'now' ? 'updated just now' : `updated ${age} ago`}
          </>
        )}
      </div>
      <p className="mt-1 text-[13.5px] leading-snug font-semibold text-ink-100">{entry.title}</p>
      <p className="mt-1.5 text-[12px] text-ink-300">{parts.length === 0 ? 'Shares nothing with another topic' : `Shares ${parts.join(', ')} with ${plural(topics, 'topic')}`}</p>
    </div>
  )
}

function Chip({ pressed, onClick, title, children }: { pressed: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      title={title}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors ${pressed ? 'border-white/[0.1] bg-white/[0.06] text-ink-200 hover:bg-white/[0.1]' : 'border-white/[0.05] text-ink-500 hover:bg-white/[0.04] hover:text-ink-300'}`}
    >
      {children}
    </button>
  )
}

function RoundButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="grid size-7 place-items-center rounded-full text-ink-300 transition-colors hover:bg-white/[0.08] hover:text-ink-100">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  )
}
