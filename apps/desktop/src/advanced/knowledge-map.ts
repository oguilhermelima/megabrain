import type { KnowledgeKind, KnowledgeStatus, KnowledgeTopicSummary } from '@/api/schema'
import { type MapEdge, kindGroups, nodeRadius, topicGraph } from '@/advanced/knowledge-model'

// The Knowledge map's layout, in world units the view then pans and zooms. Each kind is a region, and
// inside it the topics sit on a honeycomb of equal cells, the busiest (then the most recent) in the
// middle and the rest in rings around it; a topic linked to another kind takes the cell of its ring
// that faces that kind. A cell holds a node and the label under it, so no two labels can meet. The
// regions are then packed into rows, trying every order and row break (there are at most five
// kinds), for the arrangement that fits the viewport's shape best, and among the near-best the one
// that puts linked kinds side by side. Everything is deterministic: the same topics, the same map.

export type LinkType = 'chats' | 'files' | 'refs'

export const linkTypes: { type: LinkType; label: string }[] = [
  { type: 'chats', label: 'Chats' },
  { type: 'files', label: 'Files' },
  { type: 'refs', label: 'Refs' },
]

/** What the map shows: the kinds and the link types left on. */
export interface MapFilter {
  kinds: ReadonlySet<KnowledgeKind>
  links: ReadonlySet<LinkType>
}

export const showAll: MapFilter = { kinds: new Set(kindGroups.map((group) => group.kind)), links: new Set(linkTypes.map((entry) => entry.type)) }

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface PlacedTopic {
  id: string
  title: string
  /** The title cut to the label's width. */
  label: string
  kind: KnowledgeKind
  status: KnowledgeStatus
  activity: number
  updatedAt: string
  /** The node's centre. */
  x: number
  y: number
  radius: number
  labelBox: Box
  /** The node and its label together. */
  box: Box
  /** What the topic shares with the others on the map: distinct chats, files and refs, and how many topics. */
  shared: { chats: number; files: number; refs: number; topics: number }
}

/** Two topics on the map and what they share; `weight` counts only the link types shown. */
export interface PlacedLink extends MapEdge {
  weight: number
}

export interface Region {
  kind: KnowledgeKind
  label: string
  count: number
  box: Box
}

export interface MapLayout {
  /** Region by region in the kinds' order, each busiest first. */
  topics: PlacedTopic[]
  links: PlacedLink[]
  regions: Region[]
  bounds: Box
}

/** The label's type size in world units, and the room around it. */
export const labelSize = 12
const labelHeight = 16
const labelGap = 6
const cellGap = { x: 14, y: 12 }
/** A region's padding, with room at its top for its name. */
const regionPad = { side: 18, top: 34, bottom: 16 }
const regionGap = 28

/** A rough width for a label when the caller cannot measure text. */
const estimate = (text: string) => text.length * labelSize * 0.56

/** The links between shown topics, weighed by the link types shown; a link left with nothing is dropped. */
export function mapLinks(edges: readonly MapEdge[], links: ReadonlySet<LinkType>): PlacedLink[] {
  return edges.flatMap((edge) => {
    const weight = (links.has('chats') ? edge.chats : 0) + (links.has('files') ? edge.files : 0) + (links.has('refs') ? edge.refs : 0)
    return weight > 0 ? [{ ...edge, weight }] : []
  })
}

/** The title cut with an ellipsis until it fits `width`. */
function fit(title: string, width: number, measure: (text: string) => number): string {
  if (measure(title) <= width) return title
  let end = title.length
  while (end > 1 && measure(`${title.slice(0, end).trimEnd()}…`) > width) end--
  return `${title.slice(0, end).trimEnd()}…`
}

/** How crowded the map is: 0 up to 8 topics, 1 from 60. Nodes and labels shrink with it. */
const crowding = (count: number) => Math.min(1, Math.max(0, (count - 8) / 52))

/** How much farther a row away counts than a column away, so a region grows wider than tall, like the screen. */
const stretch = 1.4

/** A honeycomb of `count` cells around (0, 0), nearest first. */
function honeycomb(count: number, cell: { width: number; height: number }): Point[] {
  const reach = Math.ceil(Math.sqrt(count)) + 2
  const cells: Point[] = []
  for (let row = -reach; row <= reach; row++) for (let column = -reach; column <= reach; column++) cells.push({ x: (column + (Math.abs(row) % 2) / 2) * cell.width, y: row * cell.height })
  return cells.sort((left, right) => Math.hypot(left.x, left.y * stretch) - Math.hypot(right.x, right.y * stretch) || left.y - right.y || left.x - right.x).slice(0, count)
}

/** Ranks in rings: the centre, then 6, 12, 18…; a last ring less than half full joins the one before. */
function rings(count: number): [number, number][] {
  const bands: [number, number][] = []
  let start = 0
  for (let size = 1; start < count; size = bands.length * 6) {
    bands.push([start, Math.min(count, start + size)])
    start += size
  }
  const last = bands.at(-1)
  const before = bands.at(-2)
  if (last !== undefined && before !== undefined && last[1] - last[0] < (bands.length - 1) * 3) bands.splice(-2, 2, [before[0], last[1]])
  return bands
}

interface Cluster {
  kind: KnowledgeKind
  topics: KnowledgeTopicSummary[]
  cells: Point[]
  /** The cells' extent around (0, 0), padding included. */
  box: Box
}

/** The best rows for these region sizes: every order and row break, the fit first, then linked kinds side by side. */
function arrange(clusters: readonly Cluster[], aspect: number, weight: (left: KnowledgeKind, right: KnowledgeKind) => number): Point[] {
  const orders: number[][] = []
  const permute = (left: number[], rest: number[]) => {
    if (rest.length === 0) orders.push(left)
    rest.forEach((value, at) => permute([...left, value], [...rest.slice(0, at), ...rest.slice(at + 1)]))
  }
  permute(
    [],
    clusters.map((_, at) => at),
  )
  type Option = { origins: Point[]; fit: number; together: number }
  const options: Option[] = []
  for (const order of orders) {
    for (let breaks = 0; breaks < 2 ** Math.max(0, order.length - 1); breaks++) {
      const rows: number[][] = [[]]
      order.forEach((index, at) => {
        if (at > 0 && (breaks >> (at - 1)) & 1) rows.push([])
        ;(rows.at(-1) as number[]).push(index)
      })
      const sizes = rows.map((row) => ({ width: row.reduce((sum, index) => sum + (clusters[index] as Cluster).box.width, 0) + regionGap * (row.length - 1), height: Math.max(...row.map((index) => (clusters[index] as Cluster).box.height)) }))
      const width = Math.max(...sizes.map((size) => size.width))
      const height = sizes.reduce((sum, size) => sum + size.height, 0) + regionGap * (rows.length - 1)
      const origins: Point[] = clusters.map(() => ({ x: 0, y: 0 }))
      const spans: { index: number; row: number; from: number; to: number }[] = []
      let top = 0
      rows.forEach((row, rowAt) => {
        const size = sizes[rowAt] as { width: number; height: number }
        let left = (width - size.width) / 2
        for (const index of row) {
          const box = (clusters[index] as Cluster).box
          origins[index] = { x: left, y: top + (size.height - box.height) / 2 }
          spans.push({ index, row: rowAt, from: left, to: left + box.width })
          left += box.width + regionGap
        }
        top += size.height + regionGap
      })
      let together = 0
      for (const a of spans) {
        for (const b of spans) {
          if (a.index >= b.index) continue
          const row = rows[a.row] ?? []
          const beside = a.row === b.row && Math.abs(row.indexOf(a.index) - row.indexOf(b.index)) === 1
          const stacked = Math.abs(a.row - b.row) === 1 && a.from < b.to && b.from < a.to
          if (beside || stacked) together += weight((clusters[a.index] as Cluster).kind, (clusters[b.index] as Cluster).kind)
        }
      }
      options.push({ origins, fit: Math.min(aspect / width, 1 / height), together })
    }
  }
  const best = Math.max(...options.map((option) => option.fit))
  let chosen = options[0] as Option
  for (const option of options) if (option.fit >= best * 0.97 && (chosen.fit < best * 0.97 || option.together > chosen.together)) chosen = option
  return chosen.origins
}

/**
 * The map of `topics`: regions by kind, topics placed in cells, links weighed. `aspect` is the
 * viewport's width over its height; `measure` gives a label's width at `labelSize` (an estimate if
 * left out).
 */
export function layoutMap(topics: readonly KnowledgeTopicSummary[], options: { filter?: MapFilter; aspect?: number; measure?: (text: string) => number } = {}): MapLayout {
  const { filter = showAll, aspect = 1.5, measure = estimate } = options
  const shown = topics.filter((topic) => filter.kinds.has(topic.kind))
  if (shown.length === 0) return { topics: [], links: [], regions: [], bounds: { x: 0, y: 0, width: 0, height: 0 } }
  const graph = topicGraph(shown)
  const links = mapLinks(graph.edges, filter.links)

  const crowd = crowding(shown.length)
  const radiusOf = (activity: number) => nodeRadius(activity) * (1 - 0.45 * crowd)
  const labelLimit = 136 - 36 * crowd
  const labels = new Map(shown.map((topic) => [topic.id, fit(topic.title, labelLimit, measure)]))
  const widest = Math.max(...[...labels.values()].map(measure))
  const largest = Math.max(...shown.map((topic) => radiusOf(topic.activity)))
  const cell = { width: Math.max(widest, largest * 2) + cellGap.x, height: largest * 2 + labelGap + labelHeight + cellGap.y }

  const busiest = (left: KnowledgeTopicSummary, right: KnowledgeTopicSummary) => right.activity - left.activity || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  const clusters: Cluster[] = kindGroups.flatMap(({ kind }) => {
    const own = shown.filter((topic) => topic.kind === kind).sort(busiest)
    if (own.length === 0) return []
    const cells = honeycomb(own.length, cell)
    const left = Math.min(...cells.map((point) => point.x)) - cell.width / 2 + cellGap.x / 2 - regionPad.side
    const right = Math.max(...cells.map((point) => point.x)) + cell.width / 2 - cellGap.x / 2 + regionPad.side
    const top = Math.min(...cells.map((point) => point.y)) - cell.height / 2 + cellGap.y / 2 - regionPad.top
    const bottom = Math.max(...cells.map((point) => point.y)) + cell.height / 2 - cellGap.y / 2 + regionPad.bottom
    return [{ kind, topics: own, cells, box: { x: left, y: top, width: right - left, height: bottom - top } }]
  })

  const kindOf = new Map(shown.map((topic) => [topic.id, topic.kind]))
  const between = (left: KnowledgeKind, right: KnowledgeKind) =>
    links.reduce((sum, link) => {
      const a = kindOf.get(link.source)
      const b = kindOf.get(link.target)
      return sum + ((a === left && b === right) || (a === right && b === left) ? link.weight : 0)
    }, 0)
  const origins = arrange(clusters, aspect, between)
  // Where each region's cell (0, 0) lands.
  const centres = new Map(clusters.map((cluster, at) => [cluster.kind, { x: (origins[at] as Point).x - cluster.box.x, y: (origins[at] as Point).y - cluster.box.y }]))

  const placed: PlacedTopic[] = []
  const sharedOf = sharing(shown, links, filter.links)
  for (const cluster of clusters) {
    const middle = centres.get(cluster.kind) as Point
    // Which way each topic is pulled: toward the regions of the other kinds it links to.
    const pull = (id: string): Point =>
      links.reduce(
        (sum, link) => {
          const other = link.source === id ? link.target : link.target === id ? link.source : null
          const kind = other === null ? undefined : kindOf.get(other)
          if (kind === undefined || kind === cluster.kind) return sum
          const there = centres.get(kind) as Point
          const length = Math.max(1e-9, Math.hypot(there.x - middle.x, there.y - middle.y))
          return { x: sum.x + ((there.x - middle.x) / length) * link.weight, y: sum.y + ((there.y - middle.y) / length) * link.weight }
        },
        { x: 0, y: 0 },
      )
    const slotOf = new Map<string, Point>()
    for (const [start, end] of rings(cluster.topics.length)) {
      const free = cluster.cells.slice(start, end)
      const ring = cluster.topics.slice(start, end).map((topic) => ({ topic, pull: pull(topic.id) }))
      const pulled = ring.filter((entry) => entry.pull.x !== 0 || entry.pull.y !== 0).sort((left, right) => Math.hypot(right.pull.x, right.pull.y) - Math.hypot(left.pull.x, left.pull.y))
      for (const entry of pulled) {
        const facing = (point: Point) => (point.x * entry.pull.x + point.y * entry.pull.y) / Math.max(1e-9, Math.hypot(point.x, point.y) * Math.hypot(entry.pull.x, entry.pull.y))
        const best = free.reduce((chosen, point) => (facing(point) > facing(chosen) ? point : chosen))
        slotOf.set(entry.topic.id, best)
        free.splice(free.indexOf(best), 1)
      }
      // The rest go round the ring clockwise from the top, busiest first.
      const clockwise = (point: Point) => (Math.atan2(point.x, -point.y) + 2 * Math.PI) % (2 * Math.PI)
      free.sort((left, right) => clockwise(left) - clockwise(right))
      for (const entry of ring) if (!slotOf.has(entry.topic.id)) slotOf.set(entry.topic.id, free.shift() as Point)
    }
    for (const topic of cluster.topics) {
      const slot = slotOf.get(topic.id) as Point
      const radius = radiusOf(topic.activity)
      const x = middle.x + slot.x
      const y = middle.y + slot.y - cell.height / 2 + cellGap.y / 2 + largest
      const label = labels.get(topic.id) ?? topic.title
      const width = measure(label)
      const labelBox = { x: x - width / 2, y: y + radius + labelGap, width, height: labelHeight }
      const left = Math.min(x - radius, labelBox.x)
      const box = { x: left, y: y - radius, width: Math.max(x + radius, labelBox.x + width) - left, height: radius * 2 + labelGap + labelHeight }
      placed.push({ id: topic.id, title: topic.title, label, kind: topic.kind, status: topic.status, activity: topic.activity, updatedAt: topic.updatedAt, x, y, radius, labelBox, box, shared: sharedOf(topic.id) })
    }
  }

  const regions: Region[] = clusters.map((cluster, at) => ({
    kind: cluster.kind,
    label: kindGroups.find((group) => group.kind === cluster.kind)?.label ?? cluster.kind,
    count: cluster.topics.length,
    box: { ...(origins[at] as Point), width: cluster.box.width, height: cluster.box.height },
  }))
  const left = Math.min(...regions.map((region) => region.box.x))
  const top = Math.min(...regions.map((region) => region.box.y))
  const right = Math.max(...regions.map((region) => region.box.x + region.box.width))
  const bottom = Math.max(...regions.map((region) => region.box.y + region.box.height))
  return { topics: placed, links, regions, bounds: { x: left, y: top, width: right - left, height: bottom - top } }
}

/** What each topic shares with the other shown topics: each chat, file or ref once, counting only the link types shown. */
function sharing(topics: readonly KnowledgeTopicSummary[], links: readonly PlacedLink[], types: ReadonlySet<LinkType>): (id: string) => PlacedTopic['shared'] {
  const keys = (topic: KnowledgeTopicSummary) => ({
    chats: new Set(topic.chats),
    files: new Set(topic.refs.filter((ref) => ref.kind === 'file').map((ref) => ref.id)),
    refs: new Set(topic.refs.filter((ref) => ref.kind !== 'file').map((ref) => `${ref.kind}\n${ref.id}`)),
  })
  const sets = new Map(topics.map((topic) => [topic.id, keys(topic)]))
  const count = (id: string, type: LinkType) => {
    if (!types.has(type)) return 0
    const own = sets.get(id)?.[type] ?? new Set<string>()
    return [...own].filter((value) => [...sets].some(([other, set]) => other !== id && set[type].has(value))).length
  }
  return (id) => ({ chats: count(id, 'chats'), files: count(id, 'files'), refs: count(id, 'refs'), topics: new Set(links.flatMap((link) => (link.source === id ? [link.target] : link.target === id ? [link.source] : []))).size })
}

/** The view's transform: a world point lands on screen at `point * scale + (x, y)`. */
export interface View {
  x: number
  y: number
  scale: number
}

/** How far a fit may enlarge the map, so one or two topics never fill the screen. */
export const fitCap = 1.4
export const zoomLimits = { min: 0.2, max: 4 }

/** The view that centres `bounds` in the viewport, as large as fits inside `padding`, up to the cap. */
export function fitView(bounds: Box, viewport: { width: number; height: number }, padding = 32): View {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: viewport.width / 2, y: viewport.height / 2, scale: 1 }
  const scale = Math.min(fitCap, (viewport.width - padding * 2) / bounds.width, (viewport.height - padding * 2) / bounds.height)
  return { scale, x: viewport.width / 2 - (bounds.x + bounds.width / 2) * scale, y: viewport.height / 2 - (bounds.y + bounds.height / 2) * scale }
}

/** The view zoomed by `factor` about the screen point `at`, which stays where it is. */
export function zoomAt(view: View, factor: number, at: Point): View {
  const scale = Math.min(zoomLimits.max, Math.max(zoomLimits.min, view.scale * factor))
  const world = { x: (at.x - view.x) / view.scale, y: (at.y - view.y) / view.scale }
  return { scale, x: at.x - world.x * scale, y: at.y - world.y * scale }
}

export type Direction = 'left' | 'right' | 'up' | 'down'

const axes: Record<Direction, Point> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } }

/**
 * The topic an arrow key moves to: the nearest one within 45° of that way, sideways distance
 * counting double, and a topic linked to this one counted at 0.6 of its distance. Null at the edge.
 */
export function stepFrom(points: readonly ({ id: string } & Point)[], links: readonly { source: string; target: string }[], id: string, direction: Direction): string | null {
  const from = points.find((point) => point.id === id)
  if (from === undefined) return null
  const axis = axes[direction]
  const linked = new Set(links.flatMap((link) => (link.source === id ? [link.target] : link.target === id ? [link.source] : [])))
  let best: { id: string; score: number } | null = null
  for (const point of points) {
    if (point.id === id) continue
    const along = (point.x - from.x) * axis.x + (point.y - from.y) * axis.y
    const across = Math.abs((point.x - from.x) * axis.y - (point.y - from.y) * axis.x)
    if (along <= 0 || across > along) continue
    const score = (along + 2 * across) * (linked.has(point.id) ? 0.6 : 1)
    if (best === null || score < best.score) best = { id: point.id, score }
  }
  return best?.id ?? null
}

/** A link drawn as a gentle curve, bending the same way for the same two topics. */
export function linkPath(from: Point, to: Point): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const bend = 0.14
  const control = { x: (from.x + to.x) / 2 - dy * bend, y: (from.y + to.y) / 2 + dx * bend }
  return `M${from.x.toFixed(1)} ${from.y.toFixed(1)}Q${control.x.toFixed(1)} ${control.y.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`
}
