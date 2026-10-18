import type { OrchestrationGraph, OrchestrationNode } from '@/api/schema'
import { treeOf, type TreeNode } from '@/native-chat/orchestration/orchestration-layout'

// What the diagram draws of a big orchestration: a long-lived coordinator gathers hundreds of closed
// lanes, so the tree keeps the coordinator, every lane not closed, the most recent closed ones, and
// the path down to the focused chat; the rest wait behind a toggle, grouped by parent.

/** How many closed lanes the tree keeps, the most recently ended. */
export const CLOSED_SHOWN = 5

const endOf = (node: OrchestrationNode): string => node.endedAt ?? node.startedAt

/**
 * The graph with only the nodes the tree draws by default, and the closed lanes left out, the most
 * recently ended first. A kept node keeps its ancestors, so nothing is drawn under the wrong parent.
 */
export function visibleGraph(graph: OrchestrationGraph): { graph: OrchestrationGraph; hidden: OrchestrationNode[] } {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const closed = graph.nodes.filter((node) => node.state === 'closed' && node.id !== graph.root).sort((a, b) => endOf(b).localeCompare(endOf(a)) || b.id.localeCompare(a.id))
  const kept = new Set<string>()
  const keep = (id: string) => {
    let current = byId.get(id)
    while (current !== undefined && !kept.has(current.id)) {
      kept.add(current.id)
      current = current.parent === null ? undefined : byId.get(current.parent)
    }
  }
  keep(graph.root)
  keep(graph.focus)
  for (const node of graph.nodes) if (node.state !== 'closed') keep(node.id)
  for (const node of closed.slice(0, CLOSED_SHOWN)) keep(node.id)
  const hidden = closed.filter((node) => !kept.has(node.id))
  return { graph: hidden.length === 0 ? graph : { ...graph, nodes: graph.nodes.filter((node) => kept.has(node.id)) }, hidden }
}

export interface ClosedGroup {
  /** The lane or coordinator these closed lanes were started by; a lane whose parent is gone counts under the root. */
  parent: OrchestrationNode | undefined
  nodes: OrchestrationNode[]
}

/** The hidden closed lanes by parent, parents in the tree's order, each group in the order given. */
export function closedGroups(graph: OrchestrationGraph, hidden: readonly OrchestrationNode[]): ClosedGroup[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const groups = new Map<string, OrchestrationNode[]>()
  for (const node of hidden) {
    const parent = node.parent !== null && byId.has(node.parent) ? node.parent : graph.root
    groups.set(parent, [...(groups.get(parent) ?? []), node])
  }
  const order = new Map<string, number>()
  const walk = (tree: TreeNode) => {
    order.set(tree.node.id, order.size)
    for (const child of tree.children) walk(child)
  }
  const tree = treeOf(graph)
  if (tree !== null) walk(tree)
  const rank = (id: string) => order.get(id) ?? order.size
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b)).map(([parent, nodes]) => ({ parent: byId.get(parent), nodes }))
}
