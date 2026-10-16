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
  minimapScroll,
  navigate,
  readStrip,
  resetColumn,
  resizeColumn,
  reveal,
  revealPane,
  stripColumns,
  stripLayout,
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
    const layout = stripLayout(presetTree(leaves(3), 'row', 'g'), emptyStrip, { width: 700, height: 600 })
    expect(layout.columns.map((column) => column.width)).toEqual([minPaneWidth, minPaneWidth, minPaneWidth])
    expect(layout.width).toBe(3 * minPaneWidth)
    expect(layout.overflowX).toBe(true)
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

describe('minimap and wheel', () => {
  test('a click on the minimap centres the view there, inside the content', () => {
    expect(minimapScroll(0.5, 2016, 1512)).toBe(252)
    expect(minimapScroll(1, 2016, 1512)).toBe(504)
    expect(minimapScroll(0, 2016, 1512)).toBe(0)
  })

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
