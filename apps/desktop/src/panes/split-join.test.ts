import { describe, expect, test } from 'bun:test'
import { dropItem, paneList, singlePane, type PaneNode, type Panes } from '@/panes/pane-model'
import { addToGroup, changeShown, groupOfItem, joinItems, layoutOf, leaveGroup, moveMember, parseLayout, serialiseLayout, shownPanes, splitItems, swapMembers, unsplitGroup, type Layout } from '@/panes/split-groups'

// Joining and reordering splits from the sidebar: a row dropped on another row's middle joins them,
// a member dragged out of its group leaves it, and the hover reorders and swaps the members.

const pane = (id: string, item: string): PaneNode => ({ type: 'pane', id, item })

/** The tree without ids or sizes: items, row(...) and column(...). */
function shape(node: PaneNode): unknown {
  if (node.type === 'pane') return node.item
  return { [node.direction]: node.children.map(shape) }
}

const items = (panes: Panes) => paneList(panes.root).map((leaf) => leaf.item)
const groupItems = (layout: Layout, id: string) => {
  const group = layout.groups.find((candidate) => candidate.id === id)
  return group === undefined ? null : items(group.panes)
}
const groupPanes = (layout: Layout, id: string): Panes => {
  const group = layout.groups.find((candidate) => candidate.id === id)
  if (group === undefined) throw new Error(`no group ${id}`)
  return group.panes
}

/** One pane showing `a`, no group. */
const start = (): Layout => layoutOf(singlePane('a', 'p1'), 'g0')

/** `a` and `b` side by side in group g1, shown, b focused. */
function pair(): Layout {
  return changeShown(start(), (panes) => dropItem(panes, 'b', 'p1', 'right', 'p2'), 'g1')
}

/** a, b, c, d in a grid (group g4), plus x and y side by side in group g2, which is shown. */
function two(): Layout {
  const grid = splitItems(start(), ['a', 'b', 'c', 'd'], 'g4', ['pa', 'pb', 'pc', 'pd'], 'grid')
  return splitItems(grid, ['x', 'y'], 'g2', ['px', 'py'], 'row')
}

describe('joining rows into a split', () => {
  test('a row dropped on a row outside any group makes a new group of the two, shown, focused on the dropped one', () => {
    const layout = joinItems(start(), 'b', 'a', { pane: 'pn', group: 'gn' })
    expect(layout.groups.map((group) => group.id)).toEqual(['gn'])
    expect(layout.active).toBe('gn')
    expect(groupItems(layout, 'gn')).toEqual(['a', 'b'])
    expect(shape(groupPanes(layout, 'gn').root)).toEqual({ row: ['a', 'b'] })
    expect(groupPanes(layout, 'gn').focused).toBe(paneList(groupPanes(layout, 'gn').root).find((leaf) => leaf.item === 'b')?.id ?? 'no pane for b')
  })

  test('the new group works for two items neither of which is shown', () => {
    const layout = joinItems(start(), 'q', 'r', { pane: 'pn', group: 'gn' })
    expect(groupItems(layout, 'gn')).toEqual(['r', 'q'])
    expect(new Set(paneList(groupPanes(layout, 'gn').root).map((leaf) => leaf.id)).size).toBe(2)
  })

  test('a row dropped on a member of a group joins that group', () => {
    const layout = joinItems(pair(), 'c', 'a', { pane: 'pn', group: 'unused' })
    expect(layout.groups.map((group) => group.id)).toEqual(['g1'])
    expect(groupItems(layout, 'g1')).toEqual(['a', 'b', 'c'])
    expect(layout.active).toBe('g1')
  })

  test('a row dropped on a group row joins that group, laid out evenly beside the others', () => {
    const layout = addToGroup(pair(), 'g1', 'c', 'pn')
    expect(groupItems(layout, 'g1')).toEqual(['a', 'b', 'c'])
    const root = groupPanes(layout, 'g1').root
    expect(shape(root)).toEqual({ row: ['a', 'b', 'c'] })
    if (root.type !== 'split') throw new Error('not split')
    for (const size of root.sizes) expect(size).toBeCloseTo(1 / 3, 6)
    expect(groupPanes(layout, 'g1').focused).toBe('pn')
  })

  test('joining a stacked group keeps its stack and puts the new one beside it', () => {
    const stacked = splitItems(start(), ['a', 'b'], 'gs', ['pa', 'pb'], 'column')
    const layout = addToGroup(stacked, 'gs', 'c', 'pn')
    expect(shape(groupPanes(layout, 'gs').root)).toEqual({ row: [{ column: ['a', 'b'] }, 'c'] })
  })

  test('a member of another group leaves it to join; a group left with one member dissolves', () => {
    const layout = joinItems(two(), 'x', 'a', { pane: 'pn', group: 'unused' })
    expect(groupItems(layout, 'g4')).toEqual(['a', 'b', 'c', 'd', 'x'])
    expect(layout.groups.map((group) => group.id)).toEqual(['g4'])
    expect(groupOfItem(layout, 'y')).toBeNull()
  })

  test('a member keeps its pane id when it moves to another group', () => {
    const layout = joinItems(two(), 'x', 'a', { pane: 'pn', group: 'unused' })
    expect(paneList(groupPanes(layout, 'g4').root).find((leaf) => leaf.item === 'x')?.id).toBe('px')
  })

  test('dragging a group row onto a row adds that row to the group', () => {
    const layout = addToGroup(two(), 'g2', 'z', 'pz')
    expect(groupItems(layout, 'g2')).toEqual(['x', 'y', 'z'])
  })

  test('dropping a row on itself or on its own group changes nothing', () => {
    const layout = pair()
    expect(joinItems(layout, 'a', 'a', { pane: 'pn', group: 'gn' })).toBe(layout)
    expect(joinItems(layout, 'a', 'b', { pane: 'pn', group: 'gn' })).toBe(layout)
    expect(addToGroup(layout, 'g1', 'b', 'pn')).toBe(layout)
    expect(addToGroup(layout, 'missing', 'c', 'pn')).toBe(layout)
  })
})

describe('leaving a group', () => {
  test('a member dragged out leaves its group; the rest stay', () => {
    const layout = leaveGroup(two(), 'b')
    expect(groupItems(layout, 'g4')).toEqual(['a', 'c', 'd'])
    expect(groupOfItem(layout, 'b')).toBeNull()
  })

  test('a group left with one member dissolves', () => {
    const layout = leaveGroup(two(), 'x')
    expect(layout.groups.map((group) => group.id)).toEqual(['g4'])
    expect(groupOfItem(layout, 'y')).toBeNull()
  })

  test('the shown group dissolving shows its last member alone', () => {
    const layout = leaveGroup(pair(), 'b')
    expect(layout.groups).toEqual([])
    expect(layout.active).toBeNull()
    expect(items(shownPanes(layout))).toEqual(['a'])
  })

  test('an item in no group changes nothing', () => {
    const layout = two()
    expect(leaveGroup(layout, 'zz')).toBe(layout)
  })
})

describe('reordering members from the hover', () => {
  test('a member moved to another place reads in its new order, the tree keeping its shape and sizes', () => {
    const before = groupPanes(two(), 'g4')
    const layout = moveMember(two(), 'g4', 'a', 2)
    expect(groupItems(layout, 'g4')).toEqual(['b', 'c', 'a', 'd'])
    const after = groupPanes(layout, 'g4')
    expect(shape(after.root)).toEqual({ row: [{ column: ['b', 'c'] }, { column: ['a', 'd'] }] })
    const sizes = (node: PaneNode): unknown => (node.type === 'pane' ? null : [node.sizes, node.children.map(sizes)])
    expect(sizes(after.root)).toEqual(sizes(before.root))
  })

  test('each member keeps its pane id, so focus stays on the same item', () => {
    const focused = moveMember(two(), 'g4', 'a', 3)
    expect(groupItems(focused, 'g4')).toEqual(['b', 'c', 'd', 'a'])
    const panes = groupPanes(focused, 'g4')
    expect(paneList(panes.root).find((leaf) => leaf.item === 'a')?.id).toBe('pa')
    expect(panes.focused).toBe('pa')
  })

  test('moving up by one and down by one, as Alt+Up and Alt+Down do', () => {
    expect(groupItems(moveMember(two(), 'g4', 'c', 1), 'g4')).toEqual(['a', 'c', 'b', 'd'])
    expect(groupItems(moveMember(two(), 'g4', 'c', 3), 'g4')).toEqual(['a', 'b', 'd', 'c'])
  })

  test('a place past either end is clamped; the same place, an unknown member or group changes nothing', () => {
    expect(groupItems(moveMember(two(), 'g4', 'c', 99), 'g4')).toEqual(['a', 'b', 'd', 'c'])
    expect(groupItems(moveMember(two(), 'g4', 'c', -5), 'g4')).toEqual(['c', 'a', 'b', 'd'])
    const layout = two()
    expect(moveMember(layout, 'g4', 'c', 2)).toBe(layout)
    expect(moveMember(layout, 'g4', 'zz', 0)).toBe(layout)
    expect(moveMember(layout, 'nope', 'a', 0)).toBe(layout)
  })

  test('a member dropped on a cell of the mini map swaps the two panes', () => {
    const layout = swapMembers(two(), 'g4', 'a', 'd')
    expect(groupItems(layout, 'g4')).toEqual(['d', 'b', 'c', 'a'])
    const panes = groupPanes(layout, 'g4')
    expect(paneList(panes.root).map((leaf) => leaf.id)).toEqual(['pd', 'pb', 'pc', 'pa'])
  })

  test('swapping a member with itself or one outside the group changes nothing', () => {
    const layout = two()
    expect(swapMembers(layout, 'g4', 'a', 'a')).toBe(layout)
    expect(swapMembers(layout, 'g4', 'a', 'x')).toBe(layout)
  })

  test('reordering the shown group changes what the main area shows', () => {
    const layout = moveMember(two(), 'g2', 'y', 0)
    expect(items(shownPanes(layout))).toEqual(['y', 'x'])
  })

  test('a reordered or joined layout survives saving and reading back', () => {
    const reordered = swapMembers(moveMember(joinItems(two(), 'z', 'a', { pane: 'pz', group: 'unused' }), 'g4', 'z', 0), 'g4', 'b', 'c')
    expect(groupItems(reordered, 'g4')).toEqual(['z', 'a', 'c', 'b', 'd'])
    expect(parseLayout(serialiseLayout(reordered), 'fresh')).toEqual(reordered)
  })

  test('a reordered group still unsplits to its focused member', () => {
    const layout = unsplitGroup(moveMember(pair(), 'g1', 'b', 0), 'g1')
    expect(items(shownPanes(layout))).toEqual(['b'])
    expect(shownPanes(layout).root).toEqual(pane('p2', 'b'))
  })
})
