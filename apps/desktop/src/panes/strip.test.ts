import { describe, expect, test } from 'bun:test'
import { dropItem, movePane, singlePane, type PaneLeaf, type PaneNode } from '@/panes/pane-model'
import { presetTree } from '@/panes/split-groups'
import {
  addColumn,
  columnOfPane,
  emptyStrip,
  horizontalWheel,
  minPaneHeight,
  minPaneWidth,
  navigate,
  readStrip,
  resetColumn,
  resizeColumn,
  reveal,
  revealPane,
  stripColumns,
  stripEdges,
  columnAt,
  stripLayout,
  visibleColumns,
} from '@/panes/strip'

const leaf = (item: string): PaneLeaf => ({ type: 'pane', id: `p-${item}`, item })
const leaves = (count: number) => Array.from({ length: count }, (_, index) => leaf(`i${index + 1}`))

/** The tree without ids or sizes: items, row(...) and column(...). */
function shape(node: PaneNode): unknown {
  if (node.type === 'pane') return node.item
  return { [node.direction]: node.children.map(shape) }
}

const items = (node: PaneNode): string[] => (node.type === 'pane' ? [node.item] : node.children.flatMap(items))
const columnItems = (root: PaneNode) => stripColumns(root).map((column) => items(column.node))

/** The window the headless check measures: a 14-inch MacBook Pro's pane area. */
const laptop = { width: 1512, height: 982 }

describe('columns of a split', () => {
  test('one pane is one column; a stacked split is one column of its panes', () => {
    expect(columnItems(leaf('a'))).toEqual([['a']])
    expect(columnItems(presetTree(leaves(3), 'column', 'g'))).toEqual([['i1', 'i2', 'i3']])
  })

  test('side by side is one pane per column', () => {
    expect(columnItems(presetTree(leaves(3), 'row', 'g'))).toEqual([['i1'], ['i2'], ['i3']])
  })

  test('grid is columns of two, read top to bottom then left to right', () => {
    expect(columnItems(presetTree(leaves(8), 'grid', 'g'))).toEqual([
      ['i1', 'i2'],
      ['i3', 'i4'],
      ['i5', 'i6'],
      ['i7', 'i8'],
    ])
    expect(columnItems(presetTree(leaves(3), 'grid', 'g'))).toEqual([['i1', 'i2'], ['i3']])
  })

  test('main is the first pane in a column and the rest stacked in another', () => {
    expect(columnItems(presetTree(leaves(4), 'main', 'g'))).toEqual([['i1'], ['i2', 'i3', 'i4']])
  })

  test('a column is found by any of its panes', () => {
    const root = presetTree(leaves(4), 'grid', 'g')
    const second = stripColumns(root)[1]
    expect(columnOfPane(root, 'p-i4')).toBe(second?.id ?? 'missing')
    expect(columnOfPane(root, 'nope')).toBeNull()
  })
})

describe('adding and moving columns', () => {
  test('a column added after another lands right of it', () => {
    const root = presetTree(leaves(3), 'row', 'g')
    const after = columnOfPane(root, 'p-i1') ?? ''
    const next = addColumn(root, after, leaf('new'), 'split-new')
    expect(columnItems(next)).toEqual([['i1'], ['new'], ['i2'], ['i3']])
  })

  test('a column added beside one pane, or beside a stack, makes a row of columns', () => {
    expect(shape(addColumn(leaf('a'), 'p-a', leaf('b'), 's'))).toEqual({ row: ['a', 'b'] })
    const stacked = presetTree(leaves(2), 'column', 'g')
    expect(shape(addColumn(stacked, stacked.id, leaf('b'), 's'))).toEqual({ row: [{ column: ['i1', 'i2'] }, 'b'] })
  })

  test('a column added after an unknown column goes at the end', () => {
    const root = presetTree(leaves(2), 'row', 'g')
    expect(columnItems(addColumn(root, 'nowhere', leaf('z'), 's'))).toEqual([['i1'], ['i2'], ['z']])
  })

  test('a pane moved under another joins that column; its old column closes when empty', () => {
    const root = presetTree(leaves(4), 'row', 'g')
    const moved = movePane({ root, focused: 'p-i1' }, 'p-i1', 'p-i3', 'bottom')
    expect(columnItems(moved.root)).toEqual([['i2'], ['i3', 'i1'], ['i4']])
  })

  test('an item dropped on a pane edge keeps the columns: below stacks, right adds a column', () => {
    const one = singlePane('a', 'p-a')
    expect(columnItems(dropItem(one, 'b', 'p-a', 'bottom', 'p-b').root)).toEqual([['a', 'b']])
    expect(columnItems(dropItem(one, 'b', 'p-a', 'right', 'p-b').root)).toEqual([['a'], ['b']])
  })
})

describe('the strip is the top row only', () => {
  const under: PaneNode = { type: 'split', id: 'g', direction: 'column', children: [presetTree(leaves(4), 'row', 'top'), leaf('e')], sizes: [0.5, 0.5] }

  test('a layout whose top level is not a row is one column that fits the area, never scrolling sideways', () => {
    const layout = stripLayout(under, emptyStrip, { width: 900, height: 700 })
    expect(layout.columns.map((column) => column.id)).toEqual(['g'])
    expect(layout.columns[0]?.width).toBe(900)
    expect(layout.width).toBe(900)
    expect(layout.overflowX).toBe(false)
    // Four across on top, the fifth the whole width under them.
    expect(layout.columns[0]?.panes.map((pane) => pane.rect)).toEqual([
      { x: 0, y: 0, width: 225, height: 350 },
      { x: 225, y: 0, width: 225, height: 350 },
      { x: 450, y: 0, width: 225, height: 350 },
      { x: 675, y: 0, width: 225, height: 350 },
      { x: 0, y: 350, width: 900, height: 350 },
    ])
  })

  test('it still scrolls down when its panes need more height than the area', () => {
    const tall: PaneNode = { type: 'split', id: 'g', direction: 'column', children: [...leaves(6), presetTree([leaf('x'), leaf('y')], 'row', 'r')], sizes: Array.from({ length: 7 }, () => 1 / 7) }
    const layout = stripLayout(tall, emptyStrip, { width: 900, height: 700 })
    expect(layout.overflowY).toBe(true)
    expect(layout.overflowX).toBe(false)
  })

  test('a row on top scrolls as columns, each column holding any tree', () => {
    const row: PaneNode = { type: 'split', id: 'r', direction: 'row', children: [leaf('a'), under, leaf('z'), leaf('w')], sizes: [0.25, 0.25, 0.25, 0.25] }
    const layout = stripLayout(row, emptyStrip, laptop)
    expect(layout.columns.map((column) => column.id)).toEqual(['p-a', 'g', 'p-z', 'p-w'])
    expect(layout.overflowX).toBe(true)
  })
})

describe('widths, and fit or scroll', () => {
  test('two or three columns share the area by default, so they fit', () => {
    const two = stripLayout(presetTree(leaves(2), 'row', 'g'), emptyStrip, laptop)
    expect(two.columns.map((column) => column.width)).toEqual([756, 756])
    expect(two.width).toBe(1512)
    expect(two.overflowX).toBe(false)
    const three = stripLayout(presetTree(leaves(3), 'row', 'g'), emptyStrip, laptop)
    expect(three.columns.map((column) => column.width)).toEqual([504, 504, 504])
    expect(three.overflowX).toBe(false)
  })

  test('past three columns each takes a third and the strip scrolls instead of squeezing', () => {
    const layout = stripLayout(presetTree(leaves(8), 'grid', 'g'), emptyStrip, laptop)
    expect(layout.columns.map((column) => column.width)).toEqual([504, 504, 504, 504])
    expect(layout.columns.map((column) => column.x)).toEqual([0, 504, 1008, 1512])
    expect(layout.width).toBe(2016)
    expect(layout.overflowX).toBe(true)
    expect(layout.overflowY).toBe(false)
    expect(layout.columns[0]?.panes.map((pane) => pane.rect)).toEqual([
      { x: 0, y: 0, width: 504, height: 491 },
      { x: 0, y: 491, width: 504, height: 491 },
    ])
  })

  test('a column never goes under the minimum width; the strip scrolls instead', () => {
    const root = presetTree(leaves(3), 'row', 'g')
    const narrow = Object.fromEntries(stripColumns(root).map((column) => [column.id, 0.1]))
    const layout = stripLayout(root, { widths: narrow, scroll: 0 }, { width: 700, height: 600 })
    expect(layout.columns.map((column) => column.width)).toEqual([minPaneWidth, minPaneWidth, minPaneWidth])
    expect(layout.width).toBe(3 * minPaneWidth)
    expect(layout.overflowX).toBe(true)
  })

  test('every column that fits at a comfortable width shows; only the rest scroll', () => {
    const four = presetTree(leaves(4), 'row', 'g')
    const at = (root: PaneNode, width: number) => stripLayout(root, emptyStrip, { width, height: 982 })
    expect(at(four, 2000).columns.map((column) => column.width)).toEqual([500, 500, 500, 500])
    expect(at(four, 2000).overflowX).toBe(false)
    expect(at(four, 1512).columns.map((column) => column.width)).toEqual([504, 504, 504, 504])
    expect(at(four, 1512).overflowX).toBe(true)
    expect(at(four, 1000).columns.map((column) => column.width)).toEqual([500, 500, 500, 500])
    expect(at(four, 1000).overflowX).toBe(true)
    const six = at(presetTree(leaves(6), 'row', 'g'), 2560)
    expect(six.columns.every((column) => Math.abs(column.width - 2560 / 6) < 1e-6)).toBe(true)
    expect(six.overflowX).toBe(false)
  })

  test('visibleColumns: as many as fit at the comfortable width, at least one, never more than there are', () => {
    expect(visibleColumns(4, 2000)).toBe(4)
    expect(visibleColumns(4, 1512)).toBe(3)
    expect(visibleColumns(4, 1000)).toBe(2)
    expect(visibleColumns(6, 2560)).toBe(6)
    expect(visibleColumns(2, 3000)).toBe(2)
    expect(visibleColumns(3, 300)).toBe(1)
    expect(visibleColumns(3, 0)).toBe(1)
  })

  test('on a wide area the columns share it by their saved ratios, and a hand-set width keeps its share', () => {
    const root = presetTree(leaves(4), 'row', 'g')
    const first = columnOfPane(root, 'p-i1') ?? ''
    const strip = resizeColumn(emptyStrip, root, first, 800, { width: 2000, height: 982 })
    const layout = stripLayout(root, strip, { width: 2000, height: 982 })
    expect(layout.columns[0]?.width).toBe(800)
    expect(layout.columns.slice(1).map((column) => column.width)).toEqual([500, 500, 500])
  })

  test('a stack taller than the area scrolls its column, every pane at least the minimum height', () => {
    const layout = stripLayout(presetTree(leaves(8), 'column', 'g'), emptyStrip, laptop)
    const column = layout.columns[0]
    expect(column?.width).toBe(1512)
    expect(column?.height).toBe(8 * minPaneHeight)
    expect(column?.panes.every((pane) => pane.rect.height >= minPaneHeight - 1e-6)).toBe(true)
    expect(layout.overflowY).toBe(true)
    expect(layout.overflowX).toBe(false)
  })

  test('a column holding panes side by side is wide enough for each of them', () => {
    const root: PaneNode = { type: 'split', id: 'r', direction: 'row', children: [{ type: 'split', id: 'inner', direction: 'column', children: [{ type: 'split', id: 'pair', direction: 'row', children: [leaf('a'), leaf('b')], sizes: [0.5, 0.5] }, leaf('c')], sizes: [0.5, 0.5] }, leaf('d'), leaf('e'), leaf('f')], sizes: [0.25, 0.25, 0.25, 0.25] }
    const layout = stripLayout(root, emptyStrip, laptop)
    expect(layout.columns[0]?.width).toBe(2 * minPaneWidth)
  })

  test('a resized column keeps its own width, clamped between the minimum and the area', () => {
    const root = presetTree(leaves(4), 'row', 'g')
    const first = columnOfPane(root, 'p-i1') ?? ''
    const wide = resizeColumn(emptyStrip, root, first, 900, laptop)
    expect(stripLayout(root, wide, laptop).columns.map((column) => column.width)).toEqual([900, 504, 504, 504])
    const narrow = resizeColumn(emptyStrip, root, first, 10, laptop)
    expect(stripLayout(root, narrow, laptop).columns[0]?.width).toBe(minPaneWidth)
    const huge = resizeColumn(emptyStrip, root, first, 5000, laptop)
    expect(stripLayout(root, huge, laptop).columns[0]?.width).toBe(1512)
  })

  test('a width is a share of the area, so it follows the window', () => {
    const root = presetTree(leaves(4), 'row', 'g')
    const first = columnOfPane(root, 'p-i1') ?? ''
    const strip = resizeColumn(emptyStrip, root, first, 756, laptop)
    expect(stripLayout(root, strip, { width: 2000, height: 982 }).columns[0]?.width).toBe(1000)
  })

  test('resizing forgets the widths of columns that are gone, and a reset brings the default back', () => {
    const root = presetTree(leaves(4), 'row', 'g')
    const first = columnOfPane(root, 'p-i1') ?? ''
    const strip = resizeColumn({ widths: { gone: 0.4 }, scroll: 0 }, root, first, 900, laptop)
    expect(Object.keys(strip.widths)).toEqual([first])
    expect(stripLayout(root, resetColumn(strip, first), laptop).columns[0]?.width).toBe(504)
  })
})

describe('navigation targets', () => {
  // i1 i3 i5 i7
  // i2 i4 i6 i8
  const grid = presetTree(leaves(8), 'grid', 'g')

  test('left and right move between columns at the same height', () => {
    expect(navigate(grid, 'p-i1', 'right')).toBe('p-i3')
    expect(navigate(grid, 'p-i4', 'right')).toBe('p-i6')
    expect(navigate(grid, 'p-i6', 'left')).toBe('p-i4')
  })

  test('up and down move within the column', () => {
    expect(navigate(grid, 'p-i3', 'down')).toBe('p-i4')
    expect(navigate(grid, 'p-i4', 'up')).toBe('p-i3')
  })

  test('nothing past the ends of the strip or of a column', () => {
    expect(navigate(grid, 'p-i7', 'right')).toBeNull()
    expect(navigate(grid, 'p-i1', 'left')).toBeNull()
    expect(navigate(grid, 'p-i1', 'up')).toBeNull()
    expect(navigate(grid, 'p-i2', 'down')).toBeNull()
  })

  test('a column taller than its neighbour maps by position', () => {
    // i1 | i2 i3 i4 stacked
    const main = presetTree(leaves(4), 'main', 'g')
    expect(navigate(main, 'p-i1', 'right')).toBe('p-i2')
    expect(navigate(main, 'p-i4', 'left')).toBe('p-i1')
  })

  test('panes side by side inside a column are crossed before the next column', () => {
    // a b | c
    //  x  |
    const column: PaneNode = { type: 'split', id: 'col', direction: 'column', children: [{ type: 'split', id: 'pair', direction: 'row', children: [leaf('a'), leaf('b')], sizes: [0.5, 0.5] }, leaf('x')], sizes: [0.5, 0.5] }
    const nested: PaneNode = { type: 'split', id: 'r', direction: 'row', children: [column, leaf('c')], sizes: [0.5, 0.5] }
    expect(navigate(nested, 'p-a', 'right')).toBe('p-b')
    expect(navigate(nested, 'p-b', 'right')).toBe('p-c')
    expect(navigate(nested, 'p-c', 'left')).toBe('p-b')
  })

  test('an unknown pane goes nowhere', () => {
    expect(navigate(grid, 'nope', 'right')).toBeNull()
  })
})

describe('scrolling a pane into view', () => {
  test('a span already in view keeps the scroll', () => {
    expect(reveal(504, 504, 0, 1512, 2016)).toBe(0)
  })

  test('a span past the right edge scrolls just far enough to show its end', () => {
    expect(reveal(1512, 504, 0, 1512, 2016)).toBe(504)
  })

  test('a span past the left edge scrolls to its start', () => {
    expect(reveal(0, 504, 504, 1512, 2016)).toBe(0)
    expect(reveal(504, 504, 600, 1512, 2016)).toBe(504)
  })

  test('a span wider than the view shows its start; the scroll stays inside the content', () => {
    expect(reveal(300, 2000, 0, 1512, 4000)).toBe(300)
    expect(reveal(3800, 200, 0, 1512, 4000)).toBe(4000 - 1512)
    expect(reveal(0, 100, 50, 1512, 1000)).toBe(0)
  })

  test('focusing the last column of eight panes scrolls the strip by one column', () => {
    const layout = stripLayout(presetTree(leaves(8), 'grid', 'g'), emptyStrip, laptop)
    const target = revealPane(layout, 'p-i8', { scroll: 0, columnScroll: {}, width: 1512, height: 982 })
    expect(target?.scroll).toBe(504)
    expect(target?.columnScroll).toBe(0)
  })

  test('focusing the last pane of a tall stack scrolls its column down to it', () => {
    const root = presetTree(leaves(8), 'column', 'g')
    const layout = stripLayout(root, emptyStrip, laptop)
    const target = revealPane(layout, 'p-i8', { scroll: 0, columnScroll: {}, width: 1512, height: 982 })
    expect(target?.columnId).toBe(root.id)
    expect(target?.columnScroll).toBe(8 * minPaneHeight - 982)
    const back = revealPane(layout, 'p-i1', { scroll: 0, columnScroll: { [root.id]: 298 }, width: 1512, height: 982 })
    expect(back?.columnScroll).toBe(0)
  })

  test('an unknown pane has no target', () => {
    const layout = stripLayout(presetTree(leaves(2), 'row', 'g'), emptyStrip, laptop)
    expect(revealPane(layout, 'nope', { scroll: 0, columnScroll: {}, width: 1512, height: 982 })).toBeNull()
  })
})

describe('wheel', () => {
  test('shift with a vertical wheel scrolls the strip sideways; a sideways swipe is left to the platform', () => {
    expect(horizontalWheel({ deltaX: 0, deltaY: 40, shiftKey: true })).toBe(40)
    expect(horizontalWheel({ deltaX: 0, deltaY: -40, shiftKey: true })).toBe(-40)
    expect(horizontalWheel({ deltaX: 30, deltaY: 2, shiftKey: true })).toBe(0)
    expect(horizontalWheel({ deltaX: 0, deltaY: 40, shiftKey: false })).toBe(0)
  })
})

describe('reading a stored strip', () => {
  test('widths and the scroll come back', () => {
    expect(readStrip({ widths: { a: 0.5, b: 0.25 }, scroll: 0.4 })).toEqual({ widths: { a: 0.5, b: 0.25 }, scroll: 0.4 })
  })

  test('anything unreadable is the empty strip; bad widths are dropped and the scroll is never negative', () => {
    expect(readStrip(undefined)).toEqual(emptyStrip)
    expect(readStrip('x')).toEqual(emptyStrip)
    expect(readStrip({ widths: { a: -1, b: 'wide', c: Number.NaN, d: 0.3 }, scroll: -5 })).toEqual({ widths: { d: 0.3 }, scroll: 0 })
  })
})

describe('edge arrows', () => {
  // Four columns of a third each in a 1512 px area: 504 px columns, 2016 px of strip.
  const four = () => stripLayout(presetTree(leaves(4), 'row', 'g'), emptyStrip, laptop)
  const ids = (layout: ReturnType<typeof four>) => layout.columns.map((column) => column.id)

  test('scrolled to the start: only a right arrow, on the last column in view, bringing the fourth in', () => {
    const layout = four()
    const [, , third] = ids(layout)
    expect(stripEdges(layout, 0, 1512)).toEqual({ left: null, right: { columnId: third ?? '', scroll: 504 } })
  })

  test('scrolled to the end: only a left arrow, on the first column in view, bringing the first back', () => {
    const layout = four()
    const [, second] = ids(layout)
    expect(stripEdges(layout, 504, 1512)).toEqual({ left: { columnId: second ?? '', scroll: 0 }, right: null })
  })

  test('half a column cut at each edge: each arrow first completes the column it sits on', () => {
    const layout = four()
    const [first, , , fourth] = ids(layout)
    expect(stripEdges(layout, 250, 1512)).toEqual({ left: { columnId: first ?? '', scroll: 0 }, right: { columnId: fourth ?? '', scroll: 504 } })
  })

  test('narrow area: in a 900 px view of two 450 px columns a right arrow moves by one column', () => {
    const layout = stripLayout(presetTree(leaves(4), 'row', 'g'), emptyStrip, { width: 900, height: 600 })
    const [first, second, third, fourth] = layout.columns
    expect(layout.columns.map((column) => column.width)).toEqual([450, 450, 450, 450])
    expect(stripEdges(layout, 0, 900)).toEqual({ left: null, right: { columnId: second?.id ?? '', scroll: 450 } })
    expect(stripEdges(layout, 450, 900)).toEqual({ left: { columnId: second?.id ?? '', scroll: 0 }, right: { columnId: third?.id ?? '', scroll: 900 } })
    expect(first?.id).not.toBe(fourth?.id)
  })

  test('everything fits, or nothing is measured yet: no arrows', () => {
    expect(stripEdges(stripLayout(presetTree(leaves(3), 'row', 'g'), emptyStrip, laptop), 0, 1512)).toEqual({ left: null, right: null })
    expect(stripEdges(stripLayout(presetTree(leaves(1), 'row', 'g'), emptyStrip, laptop), 0, 1512)).toEqual({ left: null, right: null })
    expect(stripEdges(four(), 0, 0)).toEqual({ left: null, right: null })
  })

  test('the column under a strip coordinate, none past the ends', () => {
    const layout = four()
    const [first, second, , fourth] = ids(layout)
    expect(columnAt(layout, 0)).toBe(first ?? null)
    expect(columnAt(layout, 504)).toBe(second ?? null)
    expect(columnAt(layout, 2015)).toBe(fourth ?? null)
    expect(columnAt(layout, 2016)).toBeNull()
    expect(columnAt(layout, -1)).toBeNull()
  })
})
