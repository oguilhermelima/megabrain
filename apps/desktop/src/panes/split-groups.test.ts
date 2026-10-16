import { describe, expect, test } from 'bun:test'
import { closePane, dropItem, paneList, resizeSplit, serialisePanes, singlePane, type PaneNode, type Panes } from '@/panes/pane-model'
import {
  activeGroup,
  arrangeGroup,
  changeShown,
  changeGroupStrip,
  closeGroup,
  focusGroup,
  groupOfItem,
  layoutOf,
  minPaneHeight,
  minPaneWidth,
  openLayoutItem,
  parseLayout,
  presetsFor,
  presetTree,
  pruneLayout,
  removeLayoutItem,
  renameGroup,
  serialiseLayout,
  shownPanes,
  splitBeside,
  splitItems,
  unsplitGroup,
  type Layout,
} from '@/panes/split-groups'
import { emptyStrip, stripColumns } from '@/panes/strip'

const pane = (id: string, item: string): PaneNode => ({ type: 'pane', id, item })

/** The tree without ids or sizes: items, row(...) and column(...). */
function shape(node: PaneNode): unknown {
  if (node.type === 'pane') return node.item
  return { [node.direction]: node.children.map(shape) }
}

const items = (panes: Panes) => paneList(panes.root).map((leaf) => leaf.item)
const shownItems = (layout: Layout) => items(shownPanes(layout))
const groupItems = (layout: Layout, id: string) => {
  const group = layout.groups.find((candidate) => candidate.id === id)
  return group === undefined ? null : items(group.panes)
}

/** One pane showing `a`, no group. */
const start = (): Layout => layoutOf(singlePane('a', 'p1'), 'g0')

/** `a` and `b` side by side in group g1, b focused. */
function pair(): Layout {
  return changeShown(start(), (panes) => dropItem(panes, 'b', 'p1', 'right', 'p2'), 'g1')
}

/** Splits `count` items into one group, read in order, with the given preset. */
function many(count: number, preset: 'row' | 'column' | 'grid' | 'main' = 'grid'): Layout {
  const names = Array.from({ length: count }, (_, index) => `i${index + 1}`)
  return splitItems(start(), names, 'gm', names.map((name) => `p-${name}`), preset)
}

describe('a split becomes a group', () => {
  test('one pane is no group: the layout shows a single pane', () => {
    const layout = start()
    expect(layout.groups).toEqual([])
    expect(layout.active).toBeNull()
    expect(shownItems(layout)).toEqual(['a'])
  })

  test('splitting the shown pane creates a group with both items, shown and focused on the new pane', () => {
    const layout = pair()
    expect(layout.groups.map((group) => group.id)).toEqual(['g1'])
    expect(layout.active).toBe('g1')
    expect(groupItems(layout, 'g1')).toEqual(['a', 'b'])
    expect(activeGroup(layout)?.name).toBeNull()
    expect(shownPanes(layout).focused).toBe('p2')
  })

  test('splitting a group again adds a member to the same group', () => {
    const layout = changeShown(pair(), (panes) => dropItem(panes, 'c', 'p2', 'bottom', 'p3'), 'unused')
    expect(layout.groups.map((group) => group.id)).toEqual(['g1'])
    expect(shape(shownPanes(layout).root)).toEqual({ row: ['a', { column: ['b', 'c'] }] })
  })

  test('an item belongs to one group: splitting it into another takes it out of the first', () => {
    const first = pair()
    // Show d alone, then split it with b: b leaves g1, which keeps only a and dissolves.
    const alone = openLayoutItem(first, 'd')
    const moved = changeShown(alone, (panes) => dropItem(panes, 'b', panes.focused, 'right', 'p9'), 'g2')
    expect(groupItems(moved, 'g2')).toEqual(['d', 'b'])
    expect(groupItems(moved, 'g1')).toBeNull()
    expect(groupOfItem(moved, 'a')).toBeNull()
  })

  test('a group keeps any number of members, nested freely', () => {
    let layout = pair()
    for (let index = 3; index <= 8; index++) {
      const focused = shownPanes(layout).focused
      layout = changeShown(layout, (panes) => dropItem(panes, `x${index}`, focused, index % 2 === 0 ? 'right' : 'bottom', `p${index}`), 'unused')
    }
    expect(layout.groups).toHaveLength(1)
    expect(shownItems(layout)).toHaveLength(8)
  })
})

describe('opening items with groups', () => {
  test('opening a member shows its group and focuses its pane', () => {
    const away = openLayoutItem(pair(), 'z')
    expect(away.active).toBeNull()
    expect(shownItems(away)).toEqual(['z'])
    const back = openLayoutItem(away, 'a')
    expect(back.active).toBe('g1')
    expect(shownPanes(back).focused).toBe('p1')
  })

  test('opening an item outside every group leaves the group intact and shows the item alone', () => {
    const layout = openLayoutItem(pair(), 'z')
    expect(groupItems(layout, 'g1')).toEqual(['a', 'b'])
    expect(shownItems(layout)).toEqual(['z'])
  })

  test('focusGroup shows the group, and with an item focuses that member', () => {
    const away = openLayoutItem(pair(), 'z')
    expect(focusGroup(away, 'g1').active).toBe('g1')
    expect(shownPanes(focusGroup(away, 'g1', 'a')).focused).toBe('p1')
    expect(focusGroup(away, 'nope')).toBe(away)
  })
})

describe('removing members', () => {
  test('closing a pane of a three-member group keeps the group', () => {
    const three = changeShown(pair(), (panes) => dropItem(panes, 'c', 'p2', 'right', 'p3'), 'unused')
    const closed = changeShown(three, (panes) => closePane(panes, 'p3'), 'unused')
    expect(groupItems(closed, 'g1')).toEqual(['a', 'b'])
    expect(closed.active).toBe('g1')
  })

  test('closing a pane of a pair dissolves the group: the other member shows alone', () => {
    const closed = changeShown(pair(), (panes) => closePane(panes, 'p2'), 'unused')
    expect(closed.groups).toEqual([])
    expect(closed.active).toBeNull()
    expect(shownItems(closed)).toEqual(['a'])
  })

  test('an item that goes away leaves a group that is not shown', () => {
    const three = changeShown(pair(), (panes) => dropItem(panes, 'c', 'p2', 'right', 'p3'), 'unused')
    const away = openLayoutItem(three, 'z')
    const removed = removeLayoutItem(away, 'c', { id: 'pf', item: 'launcher' })
    expect(groupItems(removed, 'g1')).toEqual(['a', 'b'])
    expect(shownItems(removed)).toEqual(['z'])
  })

  test('the single pane losing its item shows the fallback', () => {
    const removed = removeLayoutItem(start(), 'a', { id: 'pf', item: 'launcher' })
    expect(shownItems(removed)).toEqual(['launcher'])
  })
})

describe('rename, unsplit and close', () => {
  test('rename trims; an empty name clears it', () => {
    const named = renameGroup(pair(), 'g1', '  review  ')
    expect(activeGroup(named)?.name).toBe('review')
    expect(activeGroup(renameGroup(named, 'g1', '   '))?.name).toBeNull()
  })

  test('unsplit removes the group and keeps the focused member shown alone', () => {
    const layout = unsplitGroup(focusGroup(pair(), 'g1', 'a'), 'g1')
    expect(layout.groups).toEqual([])
    expect(layout.active).toBeNull()
    expect(shownItems(layout)).toEqual(['a'])
  })

  test('unsplit of a group that is not shown leaves what is shown alone', () => {
    const layout = unsplitGroup(openLayoutItem(pair(), 'z'), 'g1')
    expect(layout.groups).toEqual([])
    expect(shownItems(layout)).toEqual(['z'])
  })

  test('close removes the group; a shown one gives way to the fallback', () => {
    const layout = closeGroup(pair(), 'g1', { id: 'pf', item: 'launcher' })
    expect(layout.groups).toEqual([])
    expect(shownItems(layout)).toEqual(['launcher'])
  })
})

describe('presets', () => {
  test('two members offer side by side and stacked; three or more add grid and main', () => {
    expect(presetsFor(2)).toEqual(['row', 'column'])
    expect(presetsFor(3)).toEqual(['row', 'column', 'grid', 'main'])
    expect(presetsFor(8)).toEqual(['row', 'column', 'grid', 'main'])
  })

  test('grid is columns of two', () => {
    const leaves = ['a', 'b', 'c', 'd'].map((item, index) => ({ type: 'pane' as const, id: `p${index}`, item }))
    expect(shape(presetTree(leaves, 'grid', 'g'))).toEqual({ row: [{ column: ['a', 'b'] }, { column: ['c', 'd'] }] })
    expect(shape(presetTree(leaves.slice(0, 3), 'grid', 'g'))).toEqual({ row: [{ column: ['a', 'b'] }, 'c'] })
  })

  test('five members: grid in columns of two, main is one large and a column of the rest', () => {
    const layout = many(5)
    expect(shape(shownPanes(layout).root)).toEqual({ row: [{ column: ['i1', 'i2'] }, { column: ['i3', 'i4'] }, 'i5'] })
    const main = arrangeGroup(layout, 'gm', 'main')
    expect(shape(shownPanes(main).root)).toEqual({ row: ['i1', { column: ['i2', 'i3', 'i4', 'i5'] }] })
  })

  test('eight members: grid is four columns of two, stacked is one column, side by side one row', () => {
    const layout = many(8)
    expect(shape(shownPanes(layout).root)).toEqual({ row: [{ column: ['i1', 'i2'] }, { column: ['i3', 'i4'] }, { column: ['i5', 'i6'] }, { column: ['i7', 'i8'] }] })
    expect(shape(shownPanes(arrangeGroup(layout, 'gm', 'column')).root)).toEqual({ column: ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'] })
    expect(shape(shownPanes(arrangeGroup(layout, 'gm', 'row')).root)).toEqual({ row: ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'] })
  })

  test('arranging keeps the members, their pane ids, the focus and the name', () => {
    const named = renameGroup(many(5), 'gm', 'wall')
    const focused = shownPanes(named).focused
    const arranged = arrangeGroup(named, 'gm', 'main')
    expect(shownPanes(arranged).focused).toBe(focused)
    expect(paneList(shownPanes(arranged).root).map((leaf) => leaf.id).sort()).toEqual(paneList(shownPanes(named).root).map((leaf) => leaf.id).sort())
    expect(activeGroup(arranged)?.name).toBe('wall')
  })

  test('open in split makes one group of the items, two side by side', () => {
    const layout = splitItems(start(), ['a', 'b'], 'g5', ['q1', 'q2'])
    expect(layout.active).toBe('g5')
    expect(shape(shownPanes(layout).root)).toEqual({ row: ['a', 'b'] })
  })

  test('open in split takes members out of the groups they were in', () => {
    const layout = splitItems(pair(), ['b', 'c'], 'g5', ['q1', 'q2'])
    expect(groupItems(layout, 'g1')).toBeNull()
    expect(groupItems(layout, 'g5')).toEqual(['b', 'c'])
  })

  test('open in split needs two items', () => {
    const layout = start()
    expect(splitItems(layout, ['a'], 'g5', ['q1'])).toBe(layout)
  })
})

describe('minimum pane size', () => {
  test('the minimum is about 280 by 160 pixels', () => {
    expect(minPaneWidth).toBe(280)
    expect(minPaneHeight).toBe(160)
  })

  test('split beside puts an item next to the focused pane, or a launcher when it is the focused item', () => {
    const beside = splitBeside(start(), 'b', 'right', 'launch', { pane: 'p2', group: 'g1' })
    expect(beside === null ? null : shape(shownPanes(beside).root)).toEqual({ row: ['a', 'b'] })
    const self = splitBeside(start(), 'a', 'bottom', 'launch', { pane: 'p2', group: 'g1' })
    expect(self === null ? null : shape(shownPanes(self).root)).toEqual({ column: ['a', 'launch'] })
    expect(self === null ? null : shownPanes(self).focused).toBe('p2')
  })

  test('a split is never refused for room: the strip scrolls instead', () => {
    let layout: Layout | null = start()
    for (let count = 2; count <= 9 && layout !== null; count++) layout = splitBeside(layout, `n${count}`, 'right', 'launch', { pane: `p${count}`, group: 'g1' })
    expect(layout === null ? null : stripColumns(shownPanes(layout).root).length).toBe(9)
  })

  test('split right from a pane in a stack adds a column right after that column', () => {
    const grid = many(4)
    const focused = changeShown(grid, (panes) => ({ ...panes, focused: 'p-i2' }), 'unused')
    const next = splitBeside(focused, 'z', 'right', 'launch', { pane: 'pz', group: 'unused' })
    expect(next === null ? null : shape(shownPanes(next).root)).toEqual({ row: [{ column: ['i1', 'i2'] }, 'z', { column: ['i3', 'i4'] }] })
    expect(next === null ? null : shownPanes(next).focused).toBe('pz')
  })

  test('split down from a pane in a stack adds to that column under it', () => {
    const grid = many(4)
    const focused = changeShown(grid, (panes) => ({ ...panes, focused: 'p-i1' }), 'unused')
    const next = splitBeside(focused, 'z', 'bottom', 'launch', { pane: 'pz', group: 'unused' })
    expect(next === null ? null : shape(shownPanes(next).root)).toEqual({ row: [{ column: ['i1', 'z', 'i2'] }, { column: ['i3', 'i4'] }] })
  })

  test('resizing never takes a member of an eight-member group under the share it is given', () => {
    const layout = many(8, 'row')
    const root = shownPanes(layout).root
    const splitId = root.type === 'split' ? root.id : ''
    const resized = changeShown(layout, (panes) => resizeSplit(panes, splitId, 0, -1, 0.05), 'unused')
    const sizes = shownPanes(resized).root
    expect(sizes.type === 'split' ? Math.min(...sizes.sizes) : 0).toBeGreaterThanOrEqual(0.05 - 1e-9)
  })
})

describe('persistence', () => {
  test('a new group starts with the empty strip', () => {
    expect(activeGroup(many(8))?.strip).toEqual(emptyStrip)
    expect(activeGroup(pair())?.strip).toEqual(emptyStrip)
  })

  test("column widths and the scroll position are kept with the group and survive a round trip", () => {
    const layout = changeGroupStrip(many(8), 'gm', () => ({ widths: { 'gm-c0': 0.5 }, scroll: 0.75 }))
    expect(activeGroup(layout)?.strip).toEqual({ widths: { 'gm-c0': 0.5 }, scroll: 0.75 })
    expect(parseLayout(serialiseLayout(layout), 'fresh')).toEqual(layout)
  })

  test('changing the strip of an unknown group, or to the same strip, changes nothing', () => {
    const layout = many(3)
    expect(changeGroupStrip(layout, 'nope', () => ({ widths: {}, scroll: 1 }))).toBe(layout)
    expect(changeGroupStrip(layout, 'gm', (strip) => strip)).toBe(layout)
  })

  test('the strip stays with its group while another one is shown and while panes change', () => {
    const scrolled = changeGroupStrip(many(4), 'gm', () => ({ widths: {}, scroll: 0.5 }))
    const away = openLayoutItem(scrolled, 'elsewhere')
    expect(away.groups.find((group) => group.id === 'gm')?.strip.scroll).toBe(0.5)
    const closed = changeShown(scrolled, (panes) => closePane(panes, 'p-i4'), 'unused')
    expect(activeGroup(closed)?.strip.scroll).toBe(0.5)
  })

  test('arranging a group again starts its strip over', () => {
    const scrolled = changeGroupStrip(many(8), 'gm', () => ({ widths: { x: 0.5 }, scroll: 0.5 }))
    expect(activeGroup(arrangeGroup(scrolled, 'gm', 'row'))?.strip).toEqual(emptyStrip)
  })

  test('a stored group without a strip, or with a broken one, reads with the empty strip', () => {
    const layout = many(3)
    const stored = JSON.parse(serialiseLayout(layout)) as { groups: { strip?: unknown }[] }
    const first = stored.groups[0]
    if (first !== undefined) delete first.strip
    expect(activeGroup(parseLayout(JSON.stringify(stored), 'fresh') ?? layout)?.strip).toEqual(emptyStrip)
    if (first !== undefined) first.strip = { widths: 'no', scroll: 'far' }
    expect(activeGroup(parseLayout(JSON.stringify(stored), 'fresh') ?? layout)?.strip).toEqual(emptyStrip)
  })

  test('groups, names, the active group and the single pane survive a round trip', () => {
    const layout = renameGroup(openLayoutItem(changeShown(pair(), (panes) => dropItem(panes, 'c', 'p2', 'bottom', 'p3'), 'unused'), 'z'), 'g1', 'review')
    const back = parseLayout(serialiseLayout(layout), 'fresh')
    expect(back).toEqual(layout)
    const shown = parseLayout(serialiseLayout(focusGroup(layout, 'g1')), 'fresh')
    expect(shown?.active).toBe('g1')
  })

  test('an eight-member group round-trips', () => {
    const layout = many(8)
    expect(parseLayout(serialiseLayout(layout), 'fresh')).toEqual(layout)
  })

  test('a layout saved before groups existed becomes a group when split, or a single pane', () => {
    const split = dropItem(singlePane('a', 'p1'), 'b', 'p1', 'right', 'p2')
    const migrated = parseLayout(serialisePanes(split), 'g-old')
    expect(migrated?.active).toBe('g-old')
    expect(migrated === null ? null : groupItems(migrated, 'g-old')).toEqual(['a', 'b'])
    const single = parseLayout(serialisePanes(singlePane('a', 'p1')), 'g-old')
    expect(single?.groups).toEqual([])
    expect(single === null ? null : shownItems(single)).toEqual(['a'])
  })

  test('nothing, garbage or an unknown version reads as null', () => {
    expect(parseLayout(null, 'g')).toBeNull()
    expect(parseLayout('{', 'g')).toBeNull()
    expect(parseLayout(JSON.stringify({ version: 99 }), 'g')).toBeNull()
  })

  test('a stored group of one member, or an item in two groups, is repaired on read', () => {
    const raw = JSON.stringify({
      version: 2,
      active: null,
      single: { root: pane('s', 'z'), focused: 's' },
      groups: [
        { id: 'g1', name: null, panes: { root: { type: 'split', id: 'x', direction: 'row', children: [pane('p1', 'a'), pane('p2', 'b')], sizes: [0.5, 0.5] }, focused: 'p1' } },
        { id: 'g2', name: 'dup', panes: { root: { type: 'split', id: 'y', direction: 'row', children: [pane('p3', 'b'), pane('p4', 'c')], sizes: [0.5, 0.5] }, focused: 'p3' } },
        { id: 'g3', name: null, panes: { root: pane('p5', 'd'), focused: 'p5' } },
      ],
    })
    const layout = parseLayout(raw, 'fresh')
    expect(layout?.groups.map((group) => group.id)).toEqual(['g1'])
  })

  test('pruning drops gone items from every group and dissolves groups left with one', () => {
    const layout = openLayoutItem(changeShown(pair(), (panes) => dropItem(panes, 'c', 'p2', 'right', 'p3'), 'unused'), 'z')
    const pruned = pruneLayout(layout, (item) => item !== 'b' && item !== 'c', { id: 'pf', item: 'launcher' })
    expect(pruned.groups).toEqual([])
    expect(shownItems(pruned)).toEqual(['z'])
  })
})
