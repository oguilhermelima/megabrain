// The main area as a layout tree of panes, like tmux: a split lays its children out in a row or a
// column by size, and each pane shows one item (a chat, a session, a native chat, a terminal, a
// launcher, a maximised pull request or issue, or a project's page), never one item in two panes. Every operation is
// pure and returns a normalised tree.

export type Edge = 'left' | 'right' | 'top' | 'bottom'
export type Zone = Edge | 'center'
export type Direction = 'left' | 'right' | 'up' | 'down'

export interface PaneLeaf {
  type: 'pane'
  id: string
  /** The item key, see itemKey. */
  item: string
}

export interface PaneSplit {
  type: 'split'
  id: string
  /** row: children side by side; column: stacked. */
  direction: 'row' | 'column'
  children: PaneNode[]
  /** Each child's share of the split, adding up to one. */
  sizes: number[]
}

export type PaneNode = PaneLeaf | PaneSplit

export interface Panes {
  root: PaneNode
  /** The focused pane's id. */
  focused: string
}

/** A code item is a worktree shown only in Code, keyed by its root; a project item is a project's page, keyed by its path; a knowledge item is the Knowledge page, keyed by what it shows; an artifact item is the Artifacts page, keyed by the artifact it shows; a tasks item is the Tasks page. */
export type ItemKind = 'dispatch' | 'session' | 'native' | 'terminal' | 'launcher' | 'github' | 'code' | 'project' | 'knowledge' | 'artifact' | 'tasks'
const itemKinds: readonly string[] = ['dispatch', 'session', 'native', 'terminal', 'launcher', 'github', 'code', 'project', 'knowledge', 'artifact', 'tasks']

/** An item key is its kind and its id; the id may hold colons (agent session ids do). */
export function itemKey(kind: ItemKind, id: string): string {
  return `${kind}:${id}`
}

export function parseItem(key: string): { kind: ItemKind; id: string } | null {
  const colon = key.indexOf(':')
  if (colon === -1) return null
  const kind = key.slice(0, colon)
  const id = key.slice(colon + 1)
  // The Summaries page a past run left reopens as the Knowledge page it became.
  if (kind === 'summary' && id !== '') return { kind: 'knowledge', id: 'home' }
  if (!itemKinds.includes(kind) || id === '') return null
  return { kind: kind as ItemKind, id }
}

export function singlePane(item: string, id: string): Panes {
  return { root: { type: 'pane', id, item }, focused: id }
}

/** The panes in reading order: left to right, top to bottom. */
export function paneList(node: PaneNode): PaneLeaf[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(paneList)
}

export function paneOfItem(panes: Panes, item: string): PaneLeaf | null {
  return paneList(panes.root).find((leaf) => leaf.item === item) ?? null
}

const findPane = (panes: Panes, id: string) => paneList(panes.root).find((leaf) => leaf.id === id) ?? null

/** Rebuilds the tree bottom up: `change` sees each node after its children, and null removes it. */
function mapTree(node: PaneNode, change: (node: PaneNode) => PaneNode | null): PaneNode | null {
  if (node.type === 'pane') return change(node)
  const children: PaneNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, index) => {
    const next = mapTree(child, change)
    if (next === null) return
    children.push(next)
    sizes.push(node.sizes[index] ?? 0)
  })
  return change({ ...node, children, sizes })
}

const nodeIds = (node: PaneNode): string[] => (node.type === 'pane' ? [node.id] : [node.id, ...node.children.flatMap(nodeIds)])

/** `base`, or `base` with a number when a node of the tree already has that id. */
function freshId(root: PaneNode, base: string): string {
  const taken = new Set(nodeIds(root))
  let id = base
  for (let count = 2; taken.has(id); count++) id = `${base}-${count}`
  return id
}

function withRoot(panes: Panes, root: PaneNode | null, focused: string): Panes {
  if (root === null) return panes
  const next = normalise(root) ?? panes.root
  const leaves = paneList(next)
  return { root: next, focused: leaves.some((leaf) => leaf.id === focused) ? focused : (leaves[0]?.id ?? focused) }
}

/** The tree without the pane `id`; null when it was the only one. */
function without(root: PaneNode, id: string): PaneNode | null {
  const next = mapTree(root, (node) => (node.type === 'pane' && node.id === id ? null : node))
  return next === null ? null : normalise(next)
}

/** The pane that takes a closed pane's space: the end of the sibling before it, else the start of the one after. */
function heir(root: PaneNode, id: string): string | null {
  if (root.type === 'pane') return null
  const index = root.children.findIndex((child) => child.type === 'pane' && child.id === id)
  if (index !== -1) {
    const before = root.children[index - 1]
    if (before !== undefined) return paneList(before).at(-1)?.id ?? null
    const after = root.children[index + 1]
    return after === undefined ? null : (paneList(after)[0]?.id ?? null)
  }
  for (const child of root.children) {
    const found = heir(child, id)
    if (found !== null) return found
  }
  return null
}

/** A sidebar click: focus the pane that already shows the item, else show it in the focused pane. */
export function openItem(panes: Panes, item: string): Panes {
  const open = paneOfItem(panes, item)
  if (open !== null) return { ...panes, focused: open.id }
  return replaceItem(panes, panes.focused, item)
}

/** Shows the item in pane `id`; a pane that showed it elsewhere closes. */
export function replaceItem(panes: Panes, id: string, item: string): Panes {
  if (findPane(panes, id) === null) return panes
  const elsewhere = paneList(panes.root).find((leaf) => leaf.item === item && leaf.id !== id)
  const base = elsewhere === undefined ? panes.root : without(panes.root, elsewhere.id)
  if (base === null) return panes
  return withRoot(panes, mapTree(base, (node) => (node.type === 'pane' && node.id === id ? { ...node, item } : node)), id)
}

/** Splits pane `target` toward `edge`, the new pane `node` taking half of it. */
function splitAt(root: PaneNode, target: string, edge: Edge, node: PaneNode, splitId: string): PaneNode | null {
  const direction = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const first = edge === 'left' || edge === 'top'
  return mapTree(root, (current) => {
    if (current.type !== 'pane' || current.id !== target) return current
    return { type: 'split', id: freshId(root, splitId), direction, children: first ? [node, current] : [current, node], sizes: [0.5, 0.5] }
  })
}

/**
 * A sidebar item dropped on pane `target`: the center shows it there, an edge splits the pane toward
 * it. An item already open moves: its old pane closes. `newId` names the new pane and its split.
 */
export function dropItem(panes: Panes, item: string, target: string, zone: Zone, newId: string): Panes {
  const targetPane = findPane(panes, target)
  if (targetPane === null) return panes
  if (zone === 'center') return replaceItem(panes, target, item)
  if (targetPane.item === item) return panes
  const open = paneOfItem(panes, item)
  const base = open === null ? panes.root : without(panes.root, open.id)
  if (base === null) return panes
  return withRoot(panes, splitAt(base, target, zone, { type: 'pane', id: newId, item }, `split-${newId}`), newId)
}

/** A pane dragged by its header onto another: an edge moves it there, the center swaps the two. */
export function movePane(panes: Panes, source: string, target: string, zone: Zone): Panes {
  const from = findPane(panes, source)
  const to = findPane(panes, target)
  if (from === null || to === null || source === target) return panes
  if (zone === 'center') {
    const swapped = mapTree(panes.root, (node) => (node.type !== 'pane' ? node : node.id === source ? { ...node, item: to.item } : node.id === target ? { ...node, item: from.item } : node))
    return withRoot(panes, swapped, target)
  }
  const base = without(panes.root, source)
  if (base === null) return panes
  return withRoot(panes, splitAt(base, target, zone, from, `split-${source}`), source)
}

/**
 * `node` beside the whole of `root` on `side`: first or last across it. A root already split that
 * way takes it as one more child with an even share; any other root becomes half of a new split.
 */
function atSide(root: PaneNode, node: PaneNode, side: Edge): PaneNode {
  const direction = side === 'left' || side === 'right' ? 'row' : 'column'
  const first = side === 'left' || side === 'top'
  if (root.type === 'split' && root.direction === direction) {
    const count = root.children.length
    const share = 1 / (count + 1)
    const sizes = root.sizes.map((size) => (size * count) / (count + 1))
    return { ...root, children: first ? [node, ...root.children] : [...root.children, node], sizes: first ? [share, ...sizes] : [...sizes, share] }
  }
  return { type: 'split', id: freshId(root, `span-${node.id}`), direction, children: first ? [node, root] : [root, node], sizes: [0.5, 0.5] }
}

/** Pane `paneId` moves out to span a whole side of the tree: the full width under or over the rest, or the full height left or right of it. */
export function spanPane(panes: Panes, paneId: string, side: Edge): Panes {
  const pane = findPane(panes, paneId)
  if (pane === null) return panes
  const base = without(panes.root, paneId)
  if (base === null) return panes
  return withRoot(panes, atSide(base, pane, side), paneId)
}

/** A sidebar item dropped on a side of the area spans it as a new pane `newId`; an item already open moves there. */
export function spanItem(panes: Panes, item: string, side: Edge, newId: string): Panes {
  const open = paneOfItem(panes, item)
  if (open !== null) return spanPane(panes, open.id, side)
  return withRoot(panes, atSide(panes.root, { type: 'pane', id: newId, item }, side), newId)
}

/** Closes a pane; its siblings take the space. The last pane cannot close. */
export function closePane(panes: Panes, id: string): Panes {
  if (findPane(panes, id) === null) return panes
  const root = without(panes.root, id)
  if (root === null) return panes
  return withRoot(panes, root, panes.focused === id ? (heir(panes.root, id) ?? panes.focused) : panes.focused)
}

/** The pane showing `item` closes; when it is the last, it shows `fallback` instead. */
export function removeItem(panes: Panes, item: string, fallback: string): Panes {
  const open = paneOfItem(panes, item)
  if (open === null) return panes
  if (panes.root.type === 'pane') return { ...panes, root: { ...panes.root, item: fallback } }
  return closePane(panes, open.id)
}

function mapSplit(panes: Panes, splitId: string, change: (split: PaneSplit) => PaneSplit | null): Panes {
  let changed = false
  const root = mapTree(panes.root, (node) => {
    if (node.type !== 'split' || node.id !== splitId) return node
    const next = change(node)
    if (next === null) return node
    changed = true
    return next
  })
  return changed ? withRoot(panes, root, panes.focused) : panes
}

/**
 * Moves divider `index` (between children index and index + 1) by `delta`, a share of the split,
 * clamped so neither pane goes under `min`. Called with the tree from the drag's start, so a long
 * drag does not drift.
 */
export function resizeSplit(panes: Panes, splitId: string, index: number, delta: number, min: number): Panes {
  return mapSplit(panes, splitId, (split) => {
    const before = split.sizes[index]
    const after = split.sizes[index + 1]
    if (before === undefined || after === undefined) return null
    const lowest = min - before
    const highest = after - min
    if (lowest > highest) return null
    const step = Math.min(highest, Math.max(lowest, delta))
    return { ...split, sizes: split.sizes.map((size, at) => (at === index ? before + step : at === index + 1 ? after - step : size)) }
  })
}

export function equaliseSplit(panes: Panes, splitId: string): Panes {
  return mapSplit(panes, splitId, (split) => ({ ...split, sizes: split.children.map(() => 1 / split.children.length) }))
}

/**
 * A tree every operation can rely on: no empty or one-child splits, no split inside one of the same
 * direction, sizes that add up to one, and each item and pane id once (the first one wins).
 */
export function normalise(node: PaneNode): PaneNode | null {
  const items = new Set<string>()
  const ids = new Set<string>()
  const walk = (current: PaneNode): PaneNode | null => {
    if (current.type === 'pane') {
      if (items.has(current.item) || ids.has(current.id)) return null
      items.add(current.item)
      ids.add(current.id)
      return current
    }
    const valid = current.sizes.length === current.children.length && current.sizes.every((size) => Number.isFinite(size) && size > 0)
    const children: PaneNode[] = []
    const sizes: number[] = []
    current.children.forEach((child, index) => {
      const next = walk(child)
      if (next === null) return
      const size = valid ? (current.sizes[index] ?? 1) : 1
      if (next.type === 'split' && next.direction === current.direction) {
        const total = next.sizes.reduce((sum, value) => sum + value, 0)
        next.children.forEach((grandchild, at) => {
          children.push(grandchild)
          sizes.push((size * (next.sizes[at] ?? 0)) / total)
        })
        return
      }
      children.push(next)
      sizes.push(size)
    })
    if (children.length === 0) return null
    if (children.length === 1) return children[0] ?? null
    const total = sizes.reduce((sum, value) => sum + value, 0)
    return { ...current, children, sizes: Math.abs(total - 1) < 1e-9 ? sizes : sizes.map((size) => size / total) }
  }
  return walk(node)
}

/** Drops the panes whose item no longer exists; with none left, one pane shows `fallback`. */
export function pruneItems(panes: Panes, exists: (item: string) => boolean, fallback: { id: string; item: string }): Panes {
  if (paneList(panes.root).every((leaf) => exists(leaf.item))) return panes
  const root = mapTree(panes.root, (node) => (node.type === 'pane' && !exists(node.item) ? null : node))
  const next = root === null ? null : normalise(root)
  if (next === null) return singlePane(fallback.item, fallback.id)
  return withRoot(panes, next, panes.focused)
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Divider {
  splitId: string
  /** Between children index and index + 1. */
  index: number
  direction: 'row' | 'column'
  /** Where it sits: x for a row, y for a column, in the unit square. */
  at: number
  /** The split's own rectangle, to turn pixels into a share of it. */
  split: Rect
}

/** Every pane's and divider's place in the unit square. */
export function paneRects(root: PaneNode): { panes: { id: string; item: string; rect: Rect }[]; dividers: Divider[] } {
  const panes: { id: string; item: string; rect: Rect }[] = []
  const dividers: Divider[] = []
  const walk = (node: PaneNode, rect: Rect) => {
    if (node.type === 'pane') {
      panes.push({ id: node.id, item: node.item, rect })
      return
    }
    const row = node.direction === 'row'
    let offset = 0
    node.children.forEach((child, index) => {
      const share = node.sizes[index] ?? 0
      const childRect = row
        ? { x: rect.x + offset * rect.width, y: rect.y, width: share * rect.width, height: rect.height }
        : { x: rect.x, y: rect.y + offset * rect.height, width: rect.width, height: share * rect.height }
      walk(child, childRect)
      offset += share
      if (index < node.children.length - 1) dividers.push({ splitId: node.id, index, direction: node.direction, at: row ? rect.x + offset * rect.width : rect.y + offset * rect.height, split: rect })
    })
  }
  walk(root, { x: 0, y: 0, width: 1, height: 1 })
  return { panes, dividers }
}

const epsilon = 1e-6

/** Focus moves to the pane on that side that overlaps the focused one most; the first on a tie. */
export function focusDirection(panes: Panes, direction: Direction): Panes {
  const rects = paneRects(panes.root).panes
  const current = rects.find((item) => item.id === panes.focused)?.rect
  if (current === undefined) return panes
  const horizontal = direction === 'left' || direction === 'right'
  let best: { id: string; distance: number; overlap: number } | null = null
  for (const { id, rect } of rects) {
    if (id === panes.focused) continue
    const distance =
      direction === 'left' ? current.x - (rect.x + rect.width) : direction === 'right' ? rect.x - (current.x + current.width) : direction === 'up' ? current.y - (rect.y + rect.height) : rect.y - (current.y + current.height)
    if (distance < -epsilon) continue
    const overlap = horizontal ? Math.min(current.y + current.height, rect.y + rect.height) - Math.max(current.y, rect.y) : Math.min(current.x + current.width, rect.x + rect.width) - Math.max(current.x, rect.x)
    if (overlap <= epsilon) continue
    if (best === null || distance < best.distance - epsilon || (Math.abs(distance - best.distance) <= epsilon && overlap > best.overlap + epsilon)) best = { id, distance, overlap }
  }
  return best === null ? panes : { ...panes, focused: best.id }
}

/** The band along each edge that splits, a third of the pane; inside them the drop replaces (or swaps) the pane. */
const edgeBand = 1 / 3

/** Which zone of a pane (its client rect) the pointer is over: the nearer edge's outer third, else the center. */
export function dropZone(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone {
  const fx = rect.width <= 0 ? 0.5 : (x - rect.left) / rect.width
  const fy = rect.height <= 0 ? 0.5 : (y - rect.top) / rect.height
  const edges: [Edge, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ]
  let nearest: [Edge, number] = edges[0] as [Edge, number]
  for (const edge of edges) if (edge[1] < nearest[1]) nearest = edge
  return nearest[1] < edgeBand ? nearest[0] : 'center'
}

/** Where a drop on that zone lands inside the pane, as fractions of it: a half, or all of it. */
export function zonePreview(zone: Zone): Rect {
  switch (zone) {
    case 'left':
      return { x: 0, y: 0, width: 0.5, height: 1 }
    case 'right':
      return { x: 0.5, y: 0, width: 0.5, height: 1 }
    case 'top':
      return { x: 0, y: 0, width: 1, height: 0.5 }
    case 'bottom':
      return { x: 0, y: 0.5, width: 1, height: 0.5 }
    case 'center':
      return { x: 0, y: 0, width: 1, height: 1 }
  }
}

const storageVersion = 1

export function serialisePanes(panes: Panes): string {
  return JSON.stringify({ version: storageVersion, root: panes.root, focused: panes.focused })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNode(value: unknown): PaneNode | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  if (value.type === 'pane') return typeof value.item === 'string' ? { type: 'pane', id: value.id, item: value.item } : null
  if (value.type !== 'split' || (value.direction !== 'row' && value.direction !== 'column')) return null
  if (!Array.isArray(value.children) || !Array.isArray(value.sizes)) return null
  const children: PaneNode[] = []
  for (const child of value.children) {
    const node = readNode(child)
    if (node === null) return null
    children.push(node)
  }
  const sizes = value.sizes.map((size) => (typeof size === 'number' ? size : Number.NaN))
  return { type: 'split', id: value.id, direction: value.direction, children, sizes }
}

/** A stored layout, or null when there is none or it is not one this version wrote. */
export function parsePanes(raw: string | null): Panes | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || value.version !== storageVersion) return null
  const read = readNode(value.root)
  const root = read === null ? null : normalise(read)
  if (root === null) return null
  const leaves = paneList(root)
  const focused = typeof value.focused === 'string' && leaves.some((leaf) => leaf.id === value.focused) ? value.focused : (leaves[0]?.id ?? '')
  return { root, focused }
}
