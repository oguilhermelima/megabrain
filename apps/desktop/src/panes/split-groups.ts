import { arrangePane, shiftPane, type ArrangeTarget } from '@/panes/arrange'
import { closePane, dropItem, normalise, paneList, paneOfItem, parsePanes, replaceItem, singlePane, type Direction, type Edge, type PaneLeaf, type PaneNode, type Panes } from '@/panes/pane-model'
import { addColumn, columnOfPane, emptyStrip, readStrip, type Strip } from '@/panes/strip'

// Splits as groups, the way Zen keeps its split views: every arrangement of two or more panes is a
// group with an id, its members (the items its panes show), its layout tree and an optional name.
// The main area shows one group, or one item alone. Opening a member shows its group; opening any
// other item shows it alone and the group waits in the sidebar. An item is in one group at most, and
// a group left with one member dissolves. A group lays out as a strip of columns (panes/strip) and
// keeps its column widths and scroll. Every operation is pure.

export interface SplitGroup {
  id: string
  name: string | null
  /** Two or more panes. */
  panes: Panes
  /** Its columns' own widths and how far it is scrolled. */
  strip: Strip
}

export interface Layout {
  groups: SplitGroup[]
  /** The group shown, or null when `single` is. */
  active: string | null
  /** The one pane shown while no group is. */
  single: Panes
}

/**
 * side by side (a column each), stacked (one column), a grid of columns of two, one large and a
 * column of the rest, or the focused one spanning the width under (bottom) or over (top) a row of the rest.
 */
export type Preset = 'row' | 'column' | 'grid' | 'main' | 'bottom' | 'top'

export { minPaneHeight, minPaneWidth } from '@/panes/strip'

const leafCount = (panes: Panes) => paneList(panes.root).length

/** A plain tree as a layout: a split one is a group (`groupId`), shown; one pane is the single pane. */
export function layoutOf(panes: Panes, groupId: string): Layout {
  if (leafCount(panes) < 2) return { groups: [], active: null, single: panes }
  const first = paneList(panes.root)[0]
  return { groups: [{ id: groupId, name: null, panes, strip: emptyStrip }], active: groupId, single: singlePane(first?.item ?? '', first?.id ?? groupId) }
}

export function activeGroup(layout: Layout): SplitGroup | null {
  return layout.groups.find((group) => group.id === layout.active) ?? null
}

export function shownPanes(layout: Layout): Panes {
  return activeGroup(layout)?.panes ?? layout.single
}

export function groupOfItem(layout: Layout, item: string): SplitGroup | null {
  return layout.groups.find((group) => paneList(group.panes.root).some((leaf) => leaf.item === item)) ?? null
}

/** The group without `items`; null once it has fewer than two members. */
function stripItems(group: SplitGroup, items: ReadonlySet<string>): SplitGroup | null {
  let panes = group.panes
  for (const leaf of paneList(group.panes.root)) if (items.has(leaf.item)) panes = closePane(panes, leaf.id)
  const left = paneList(panes.root).filter((leaf) => !items.has(leaf.item))
  if (left.length < 2) return null
  return panes === group.panes ? group : { ...group, panes }
}

/**
 * What is shown, changed by a pane operation (split, drop, move, resize, close, focus). The result
 * decides the group: two or more panes are the active group (a new one, `newGroupId`, when a single
 * pane was split); one pane dissolves the group and shows alone. Items now shown leave every other group.
 */
export function changeShown(layout: Layout, change: (panes: Panes) => Panes, newGroupId: string): Layout {
  const current = shownPanes(layout)
  const next = change(current)
  if (next === current) return layout
  const shown = new Set(paneList(next.root).map((leaf) => leaf.item))
  const groups: SplitGroup[] = []
  let placed = false
  for (const group of layout.groups) {
    if (group.id === layout.active) {
      if (leafCount(next) >= 2) {
        groups.push({ ...group, panes: next })
        placed = true
      }
      continue
    }
    const kept = stripItems(group, shown)
    if (kept !== null) groups.push(kept)
  }
  if (leafCount(next) < 2) return { groups, active: null, single: next }
  if (placed) return { ...layout, groups }
  return { groups: [...groups, { id: newGroupId, name: null, panes: next, strip: emptyStrip }], active: newGroupId, single: layout.single }
}

/** A sidebar click: a member shows its group, focused on it; any other item shows alone. */
export function openLayoutItem(layout: Layout, item: string): Layout {
  const group = groupOfItem(layout, item)
  if (group !== null) return focusGroup(layout, group.id, item)
  const single = replaceItem(layout.single, layout.single.focused, item)
  return { ...layout, active: null, single }
}

/** Shows group `groupId`, focused on the member showing `item` when given. */
export function focusGroup(layout: Layout, groupId: string, item?: string): Layout {
  const group = layout.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) return layout
  const leaf = item === undefined ? undefined : paneList(group.panes.root).find((candidate) => candidate.item === item)
  const panes = leaf === undefined || leaf.id === group.panes.focused ? group.panes : { ...group.panes, focused: leaf.id }
  if (layout.active === groupId && panes === group.panes) return layout
  return { ...layout, active: groupId, groups: layout.groups.map((candidate) => (candidate.id === groupId ? { ...candidate, panes } : candidate)) }
}

export function renameGroup(layout: Layout, groupId: string, name: string): Layout {
  const trimmed = name.trim()
  return { ...layout, groups: layout.groups.map((group) => (group.id === groupId ? { ...group, name: trimmed === '' ? null : trimmed } : group)) }
}

/** The group goes and its members go back to rows of their own; a shown one leaves its focused member shown alone. */
export function unsplitGroup(layout: Layout, groupId: string): Layout {
  const group = layout.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) return layout
  const groups = layout.groups.filter((candidate) => candidate.id !== groupId)
  if (layout.active !== groupId) return { ...layout, groups }
  const focused = paneList(group.panes.root).find((leaf) => leaf.id === group.panes.focused) ?? paneList(group.panes.root)[0]
  return { groups, active: null, single: focused === undefined ? layout.single : singlePane(focused.item, focused.id) }
}

/** The group and its panes close (the items stay in the sidebar); a shown one gives way to `fallback`. */
export function closeGroup(layout: Layout, groupId: string, fallback: { id: string; item: string }): Layout {
  if (!layout.groups.some((group) => group.id === groupId)) return layout
  const groups = layout.groups.filter((group) => group.id !== groupId)
  if (layout.active !== groupId) return { ...layout, groups }
  return { groups, active: null, single: singlePane(fallback.item, fallback.id) }
}

/** The pane showing `item` closes wherever it is; the single pane shows `fallback` instead. */
export function removeLayoutItem(layout: Layout, item: string, fallback: { id: string; item: string }): Layout {
  const group = groupOfItem(layout, item)
  if (group === null) {
    if (paneList(layout.single.root).some((leaf) => leaf.item === item)) return { ...layout, single: singlePane(fallback.item, fallback.id) }
    return layout
  }
  return leaveGroup(layout, item)
}

export function presetsFor(count: number): Preset[] {
  return count < 3 ? ['row', 'column'] : ['row', 'column', 'grid', 'main', 'bottom', 'top']
}

const even = (count: number) => Array.from({ length: count }, () => 1 / count)

function line(id: string, direction: 'row' | 'column', children: PaneNode[]): PaneNode {
  return { type: 'split', id, direction, children, sizes: even(children.length) }
}

/** The members, in order, laid out by `preset`; split ids start with `idBase`. Bottom and top span pane `focused`, else the last. */
export function presetTree(leaves: PaneLeaf[], preset: Preset, idBase: string, focused?: string): PaneNode {
  if (leaves.length === 1 && leaves[0] !== undefined) return leaves[0]
  let tree: PaneNode
  // Two in a grid are side by side: one column of two would be stacked.
  if (preset === 'grid' && leaves.length <= 2) tree = line(`${idBase}-row`, 'row', leaves)
  else if (preset === 'bottom' || preset === 'top') {
    const spanning = leaves.find((leaf) => leaf.id === focused) ?? leaves.at(-1)
    const rest = line(`${idBase}-rest`, 'row', leaves.filter((leaf) => leaf !== spanning))
    tree = spanning === undefined ? rest : line(`${idBase}-${preset}`, 'column', preset === 'bottom' ? [rest, spanning] : [spanning, rest])
  }
  else if (preset === 'row' || preset === 'column') tree = line(`${idBase}-${preset}`, preset, leaves)
  else if (preset === 'main') {
    const [first, ...rest] = leaves
    tree = first === undefined ? line(`${idBase}-row`, 'row', leaves) : { type: 'split', id: `${idBase}-main`, direction: 'row', children: [first, line(`${idBase}-rest`, 'column', rest)], sizes: [0.5, 0.5] }
  } else {
    const columns: PaneNode[] = []
    for (let index = 0; index < leaves.length; index += 2) columns.push(line(`${idBase}-c${index / 2}`, 'column', leaves.slice(index, index + 2)))
    tree = line(`${idBase}-grid`, 'row', columns)
  }
  return normalise(tree) ?? tree
}

/** Lays group `groupId` out again by `preset`, keeping its panes, focus and name; its strip starts over. */
export function arrangeGroup(layout: Layout, groupId: string, preset: Preset): Layout {
  return {
    ...layout,
    groups: layout.groups.map((group) => (group.id === groupId ? { ...group, panes: { ...group.panes, root: presetTree(paneList(group.panes.root), preset, group.id, group.panes.focused) }, strip: emptyStrip } : group)),
  }
}

/** Open in split: the items, in order, become one shown group (grid by default; two side by side), leaving any group they were in. */
export function splitItems(layout: Layout, items: string[], groupId: string, paneIds: string[], preset: Preset = 'grid'): Layout {
  const unique = [...new Set(items)]
  if (unique.length < 2) return layout
  const leaves: PaneLeaf[] = unique.map((item, index) => ({ type: 'pane', id: paneIds[index] ?? `${groupId}-p${index}`, item }))
  const panes: Panes = { root: presetTree(leaves, preset, groupId), focused: leaves[0]?.id ?? '' }
  const members = new Set(unique)
  const groups = layout.groups.flatMap((group) => {
    const kept = stripItems(group, members)
    return kept === null ? [] : [kept]
  })
  return { groups: [...groups, { id: groupId, name: null, panes, strip: emptyStrip }], active: groupId, single: layout.single }
}

/**
 * Split right or down from the focused pane: `item` opens as a new column right of the focused
 * pane's column, or under the pane in its column, or `launcher` does when the focused pane already
 * shows `item`. Never refused for room: the strip scrolls. Null when nothing changes.
 */
export function splitBeside(layout: Layout, item: string, edge: Extract<Edge, 'right' | 'bottom'>, launcher: string, ids: { pane: string; group: string }): Layout | null {
  const shown = shownPanes(layout)
  const focusedItem = paneList(shown.root).find((leaf) => leaf.id === shown.focused)?.item
  const opened = focusedItem === item ? launcher : item
  let next: Panes
  if (edge === 'bottom') next = dropItem(shown, opened, shown.focused, 'bottom', ids.pane)
  else {
    const open = paneOfItem(shown, opened)
    const base = open === null ? shown : closePane(shown, open.id)
    const root = addColumn(base.root, columnOfPane(base.root, shown.focused) ?? '', { type: 'pane', id: ids.pane, item: opened }, `split-${ids.pane}`)
    next = { root, focused: ids.pane }
  }
  if (next === shown) return null
  return changeShown(layout, () => next, ids.group)
}

/** Drops the panes whose item no longer exists, from every group and the single pane. */
export function pruneLayout(layout: Layout, exists: (item: string) => boolean, fallback: { id: string; item: string }): Layout {
  const gone = new Set([...layout.groups.flatMap((group) => paneList(group.panes.root)), ...paneList(layout.single.root)].map((leaf) => leaf.item).filter((item) => !exists(item)))
  if (gone.size === 0) return layout
  let next = layout
  for (const item of gone) next = removeLayoutItem(next, item, fallback)
  return next
}

const storageVersion = 2

export function serialiseLayout(layout: Layout): string {
  return JSON.stringify({ version: storageVersion, groups: layout.groups, active: layout.active, single: layout.single })
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Stored panes read with the plain layout's own reader, which validates and normalises them. */
const readPanes = (value: unknown): Panes | null => (isRecord(value) ? parsePanes(JSON.stringify({ ...value, version: 1 })) : null)

/**
 * A stored layout, or null when there is none or it is unreadable. A layout saved before groups
 * existed reads as one group (`groupId`) when split. Groups of one member, and an item's second
 * group, are dropped.
 */
export function parseLayout(raw: string | null, groupId: string): Layout | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (value.version === 1) {
    const panes = parsePanes(raw)
    return panes === null ? null : layoutOf(panes, groupId)
  }
  if (value.version !== storageVersion || !Array.isArray(value.groups)) return null
  const single = readPanes(value.single)
  if (single === null || leafCount(single) !== 1) return null
  const groups: SplitGroup[] = []
  const taken = new Set<string>()
  for (const entry of value.groups) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || groups.some((group) => group.id === entry.id)) continue
    const panes = readPanes(entry.panes)
    if (panes === null) continue
    const items = paneList(panes.root).map((leaf) => leaf.item)
    if (items.length < 2 || items.some((item) => taken.has(item))) continue
    for (const item of items) taken.add(item)
    groups.push({ id: entry.id, name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name : null, panes, strip: readStrip(entry.strip) })
  }
  const active = typeof value.active === 'string' && groups.some((group) => group.id === value.active) ? value.active : null
  return { groups, active, single }
}

/** The group `groupId` with its panes changed (shown or not); the same layout when the change returns them as they were. */
export function changeGroupPanes(layout: Layout, groupId: string, change: (panes: Panes) => Panes): Layout {
  const group = layout.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) return layout
  const panes = change(group.panes)
  if (panes === group.panes) return layout
  return { ...layout, groups: layout.groups.map((candidate) => (candidate.id === groupId ? { ...candidate, panes } : candidate)) }
}

/** Group `groupId` with its strip changed (a column resized, the strip scrolled); the same layout when nothing changes. */
export function changeGroupStrip(layout: Layout, groupId: string, change: (strip: Strip) => Strip): Layout {
  const group = layout.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) return layout
  const strip = change(group.strip)
  if (strip === group.strip) return layout
  return { ...layout, groups: layout.groups.map((candidate) => (candidate.id === groupId ? { ...candidate, strip } : candidate)) }
}

/** `leaf` beside the whole tree: one more child of a root row, evenly sized, or a row of the tree and it. */
function besideRoot(root: PaneNode, leaf: PaneLeaf, splitId: string): PaneNode {
  if (root.type === 'split' && root.direction === 'row') return { ...root, children: [...root.children, leaf], sizes: even(root.children.length + 1) }
  return { type: 'split', id: splitId, direction: 'row', children: [root, leaf], sizes: [0.5, 0.5] }
}

/**
 * `item` joins group `groupId` beside its panes, focused, and the group shows. It leaves any other
 * group (which dissolves at one member), keeping its pane id there; `paneId` names a new pane.
 */
export function addToGroup(layout: Layout, groupId: string, item: string, paneId: string): Layout {
  const group = layout.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined || paneList(group.panes.root).some((leaf) => leaf.item === item)) return layout
  const from = groupOfItem(layout, item)
  const ownId = from === null ? undefined : paneList(from.panes.root).find((candidate) => candidate.item === item)?.id
  const free = ownId !== undefined && !paneList(group.panes.root).some((candidate) => candidate.id === ownId)
  const leaf: PaneLeaf = { type: 'pane', id: free ? ownId : paneId, item }
  const panes: Panes = { root: besideRoot(group.panes.root, leaf, `${groupId}-join-${leaf.id}`), focused: leaf.id }
  const groups = layout.groups.flatMap((candidate) => {
    if (candidate.id === groupId) return [{ ...candidate, panes }]
    const kept = stripItems(candidate, new Set([item]))
    return kept === null ? [] : [kept]
  })
  return { ...layout, groups, active: groupId }
}

/**
 * A sidebar row (`source`) dropped on the middle of another (`target`): it joins the target's group,
 * or the two become a new group side by side, shown and focused on the dropped one.
 */
export function joinItems(layout: Layout, source: string, target: string, ids: { pane: string; group: string }): Layout {
  if (source === target) return layout
  const group = groupOfItem(layout, target)
  if (group !== null) return addToGroup(layout, group.id, source, ids.pane)
  const withTarget = splitItems(layout, [target, source], ids.group, [`${ids.group}-p0`, ids.pane], 'row')
  const panes = groupPanes(withTarget, ids.group)
  return panes === null ? withTarget : changeGroupPanes(withTarget, ids.group, () => ({ ...panes, focused: ids.pane }))
}

const groupPanes = (layout: Layout, groupId: string) => layout.groups.find((group) => group.id === groupId)?.panes ?? null

/** A member dragged out of its group goes back to a row of its own; a group left with one member dissolves. */
export function leaveGroup(layout: Layout, item: string): Layout {
  const group = groupOfItem(layout, item)
  if (group === null) return layout
  const leaf = paneList(group.panes.root).find((candidate) => candidate.item === item)
  if (leaf === undefined) return layout
  if (group.id === layout.active) return changeShown(layout, (panes) => closePane(panes, leaf.id), group.id)
  const kept = stripItems(group, new Set([item]))
  return { ...layout, groups: kept === null ? layout.groups.filter((candidate) => candidate.id !== group.id) : layout.groups.map((candidate) => (candidate.id === group.id ? kept : candidate)) }
}

/** The tree with its panes, in reading order, replaced by `leaves`; splits and sizes stay. */
function withLeaves(root: PaneNode, leaves: readonly PaneLeaf[]): PaneNode {
  let next = 0
  const walk = (node: PaneNode): PaneNode => {
    if (node.type === 'pane') return leaves[next++] ?? node
    return { ...node, children: node.children.map(walk) }
  }
  return walk(root)
}

/** Member `item` of group `groupId` moves to place `index` in reading order (clamped); the tree keeps its shape and each pane its id. */
export function moveMember(layout: Layout, groupId: string, item: string, index: number): Layout {
  return changeGroupPanes(layout, groupId, (panes) => {
    const leaves = paneList(panes.root)
    const from = leaves.findIndex((leaf) => leaf.item === item)
    const to = Math.max(0, Math.min(leaves.length - 1, Math.round(index)))
    const moved = leaves[from]
    if (from === -1 || moved === undefined || from === to) return panes
    const order = leaves.filter((leaf) => leaf !== moved)
    order.splice(to, 0, moved)
    return { ...panes, root: withLeaves(panes.root, order) }
  })
}

/** Members `a` and `b` of group `groupId` trade places. */
export function swapMembers(layout: Layout, groupId: string, a: string, b: string): Layout {
  return changeGroupPanes(layout, groupId, (panes) => {
    const leaves = paneList(panes.root)
    const first = leaves.findIndex((leaf) => leaf.item === a)
    const second = leaves.findIndex((leaf) => leaf.item === b)
    const left = leaves[first]
    const right = leaves[second]
    if (left === undefined || right === undefined || first === second) return panes
    const order = [...leaves]
    order[first] = right
    order[second] = left
    return { ...panes, root: withLeaves(panes.root, order) }
  })
}

/** Member `item` of group `groupId`, shown or not, dropped on `target` (a side of the group, or another member's zone). */
export function arrangeMember(layout: Layout, groupId: string, item: string, target: ArrangeTarget): Layout {
  return changeGroupPanes(layout, groupId, (panes) => {
    const leaf = paneOfItem(panes, item)
    return leaf === null ? panes : arrangePane(panes, leaf.id, target)
  })
}

/** Member `item` of group `groupId` moved one step with the keyboard (see shiftPane). */
export function shiftMember(layout: Layout, groupId: string, item: string, direction: Direction): Layout {
  return changeGroupPanes(layout, groupId, (panes) => {
    const leaf = paneOfItem(panes, item)
    return leaf === null ? panes : shiftPane(panes, leaf.id, direction)
  })
}
