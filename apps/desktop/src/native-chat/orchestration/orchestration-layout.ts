import type { OrchestrationEvent, OrchestrationGraph, OrchestrationNode } from '@/api/schema'

// The pure side of the orchestration view: the tree, how its lanes wrap into rows, where the asked
// chat sits in it, the log's order, and which new events animate an edge.

/** The dispatch a node is: a lane's id, or null for a coordinator that is only a session (session:<agent>:<id>). */
export const dispatchOf = (node: OrchestrationNode): string | null => (node.id.startsWith('session:') ? null : node.id)

export interface TreeNode {
  node: OrchestrationNode
  children: TreeNode[]
}

const byStart = (a: TreeNode, b: TreeNode) => a.node.startedAt.localeCompare(b.node.startedAt) || a.node.id.localeCompare(b.node.id)

/**
 * The tree down from the graph's root, children in the order they started. A node whose parent is
 * not in the graph hangs under the root rather than vanishing; null when the root itself is missing.
 */
export function treeOf(graph: OrchestrationGraph): TreeNode | null {
  const items = new Map(graph.nodes.map((node) => [node.id, { node, children: [] as TreeNode[] }]))
  const root = items.get(graph.root)
  if (root === undefined) return null
  for (const item of items.values()) {
    if (item === root) continue
    const parent = (item.node.parent === null ? undefined : items.get(item.node.parent)) ?? root
    parent.children.push(item)
  }
  for (const item of items.values()) item.children.sort(byStart)
  return root
}

export const CARD_WIDTH = 248
export const CARD_GAP = 16

/** How many cards fit side by side in a width; never fewer than one. */
export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + CARD_GAP) / (CARD_WIDTH + CARD_GAP)))
}

export interface LaidOut {
  node: OrchestrationNode
  /** The node's children, wrapped into rows that fit the width it was given. */
  rows: LaidOut[][]
}

/**
 * Lays the tree out for a width: a node's children wrap into rows of as many cards as fit, and a
 * child with lanes of its own lays them out within its share of the row.
 */
export function layoutTree(tree: TreeNode, width: number): LaidOut {
  const columns = columnsFor(width)
  const rows: LaidOut[][] = []
  for (let start = 0; start < tree.children.length; start += columns) {
    const row = tree.children.slice(start, start + columns)
    const share = (width - CARD_GAP * (row.length - 1)) / row.length
    rows.push(row.map((child) => layoutTree(child, share)))
  }
  return { node: tree.node, rows }
}

/** The ids from the root down to the focused node; empty when the focus is not in the graph. */
export function focusPath(graph: OrchestrationGraph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const path: string[] = []
  let current = byId.get(graph.focus)
  while (current !== undefined && !path.includes(current.id)) {
    path.unshift(current.id)
    current = current.parent === null ? undefined : byId.get(current.parent)
  }
  return path
}

export type Relation = 'focus' | 'ancestor' | 'sibling' | 'descendant' | 'other'

/** Where a node sits relative to the focused chat, which the diagram uses to light the focus path. */
export function relationTo(graph: OrchestrationGraph, id: string): Relation {
  if (id === graph.focus) return 'focus'
  const path = focusPath(graph)
  if (path.includes(id)) return 'ancestor'
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const focus = byId.get(graph.focus)
  const node = byId.get(id)
  if (focus === undefined || node === undefined) return 'other'
  if (focus.parent !== null && node.parent === focus.parent) return 'sibling'
  let parent = node.parent === null ? undefined : byId.get(node.parent)
  const seen = new Set<string>()
  while (parent !== undefined && !seen.has(parent.id)) {
    if (parent.id === graph.focus) return 'descendant'
    seen.add(parent.id)
    parent = parent.parent === null ? undefined : byId.get(parent.parent)
  }
  return 'other'
}

export const LOG_CAP = 200

/** The session log: oldest first, newest last, events at the same instant kept in arrival order, capped at the newest 200. */
export function logOrder(events: readonly OrchestrationEvent[]): OrchestrationEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.at.localeCompare(b.event.at) || a.index - b.index)
    .map(({ event }) => event)
    .slice(-LOG_CAP)
}

const eventKey = (event: OrchestrationEvent): string => `${event.at}\u0000${event.node}\u0000${event.direction}\u0000${event.type}\u0000${event.text}`

/** The edge an event travels: the one from the node's parent down to the node, in the event's direction. */
export interface Pulse {
  key: string
  /** The child end of the edge. */
  node: string
  direction: OrchestrationEvent['direction']
  type: string
}

const PULSED = new Set(['ask', 'reply', 'done'])

/**
 * The events in `next` that were not in `previous` and move along an edge — an ask, a reply or a
 * done on a node that has a parent — each once, as many times as it is new. The first snapshot has
 * no previous one and animates nothing.
 */
export function newPulses(previous: readonly OrchestrationEvent[] | null, next: OrchestrationGraph): Pulse[] {
  if (previous === null) return []
  const seen = new Map<string, number>()
  for (const event of previous) seen.set(eventKey(event), (seen.get(eventKey(event)) ?? 0) + 1)
  const parented = new Set(next.nodes.filter((node) => node.parent !== null).map((node) => node.id))
  const pulses: Pulse[] = []
  for (const event of next.events) {
    const key = eventKey(event)
    const count = seen.get(key) ?? 0
    if (count > 0) {
      seen.set(key, count - 1)
      continue
    }
    if (PULSED.has(event.type) && parented.has(event.node)) pulses.push({ key, node: event.node, direction: event.direction, type: event.type })
  }
  return pulses
}

/** Time since a node started, up to when it ended: 45s, 12m, 1h 05m. */
export function elapsed(startedAt: string, endedAt: string | null, now: number): string {
  const end = endedAt === null ? now : Date.parse(endedAt)
  const seconds = Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
