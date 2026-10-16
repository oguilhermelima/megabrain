import { describe, expect, test } from 'bun:test'
import { arrangePane, mapTarget, outerEdge, shiftPane } from '@/panes/arrange'
import { dropZone, paneList, spanItem, spanPane, type Edge, type PaneLeaf, type PaneNode, type Panes } from '@/panes/pane-model'
import { presetTree, type Preset } from '@/panes/split-groups'

const leaf = (item: string): PaneLeaf => ({ type: 'pane', id: `p-${item}`, item })
const five = ['a', 'b', 'c', 'd', 'e'].map(leaf)
const panesOf = (root: PaneNode, focused = 'p-a'): Panes => ({ root, focused })

/** The tree without ids or sizes: items, row(...) and column(...). */
function shape(node: PaneNode): unknown {
  if (node.type === 'pane') return node.item
  return { [node.direction]: node.children.map(shape) }
}

const items = (node: PaneNode) => paneList(node).map((pane) => pane.item)

describe('a pane spanning a whole side of the group', () => {
  test('five side by side: the fifth spans the bottom under the other four', () => {
    const next = spanPane(panesOf(presetTree(five, 'row', 'g')), 'p-e', 'bottom')
    expect(shape(next.root)).toEqual({ column: [{ row: ['a', 'b', 'c', 'd'] }, 'e'] })
    expect(next.focused).toBe('p-e')
  })

  test('the mirror cases: on top, full height on the left and on the right', () => {
    const start = panesOf(presetTree(five, 'grid', 'g'))
    expect(shape(spanPane(start, 'p-a', 'top').root)).toEqual({ column: ['a', { row: ['b', { column: ['c', 'd'] }, 'e'] }] })
    // Left of a row is one more column at its start; the rest keep their columns.
    expect(shape(spanPane(start, 'p-c', 'left').root)).toEqual({ row: ['c', { column: ['a', 'b'] }, 'd', 'e'] })
    expect(shape(spanPane(start, 'p-a', 'right').root)).toEqual({ row: ['b', { column: ['c', 'd'] }, 'e', 'a'] })
  })

  test('full height beside a layout that is not a row wraps the whole of it', () => {
    const under = spanPane(panesOf(presetTree(five, 'row', 'g')), 'p-e', 'bottom')
    expect(shape(spanPane(under, 'p-a', 'left').root)).toEqual({ row: ['a', { column: [{ row: ['b', 'c', 'd'] }, 'e'] }] })
    expect(shape(spanPane(under, 'p-e', 'right').root)).toEqual({ row: ['a', 'b', 'c', 'd', 'e'] })
  })

  test('from every preset, every side puts the pane first or last across the whole group', () => {
    const presets: Preset[] = ['row', 'column', 'grid', 'main', 'bottom', 'top']
    const sides: Edge[] = ['left', 'right', 'top', 'bottom']
    for (const preset of presets) {
      for (const side of sides) {
        for (const moved of five) {
          const next = spanPane(panesOf(presetTree(five, preset, 'g', 'p-c')), moved.id, side)
          const root = next.root
          expect(root.type).toBe('split')
          if (root.type !== 'split') continue
          expect(root.direction).toBe(side === 'left' || side === 'right' ? 'row' : 'column')
          const end = side === 'left' || side === 'top' ? root.children[0] : root.children.at(-1)
          expect(end).toEqual(moved)
          expect(items(root).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
          expect(root.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1)
        }
      }
    }
  })

  test('a pane joining a row as a whole column takes an even share of it', () => {
    const next = spanPane(panesOf(presetTree(five.slice(0, 4), 'row', 'g')), 'p-a', 'right')
    expect(next.root.type === 'split' ? next.root.sizes : []).toEqual([0.25, 0.25, 0.25, 0.25])
    const under = spanPane(panesOf(presetTree(five, 'row', 'g')), 'p-e', 'bottom')
    expect(under.root.type === 'split' ? under.root.sizes : []).toEqual([0.5, 0.5])
  })

  test('the only pane, or an unknown one, changes nothing', () => {
    const one = panesOf(leaf('a'))
    expect(spanPane(one, 'p-a', 'bottom')).toBe(one)
    const row = panesOf(presetTree(five, 'row', 'g'))
    expect(spanPane(row, 'nope', 'bottom')).toBe(row)
  })

  test('an item from the sidebar spans a side as a new pane, or moves there when it is open', () => {
    const row = panesOf(presetTree(five.slice(0, 4), 'row', 'g'))
    const added = spanItem(row, 'z', 'bottom', 'p-z')
    expect(shape(added.root)).toEqual({ column: [{ row: ['a', 'b', 'c', 'd'] }, 'z'] })
    expect(added.focused).toBe('p-z')
    expect(shape(spanItem(row, 'b', 'top', 'p-new').root)).toEqual({ column: ['b', { row: ['a', 'c', 'd'] }] })
  })
})

describe('arranging a pane onto a target', () => {
  const grid = panesOf(presetTree(five.slice(0, 4), 'grid', 'g'))

  test('the centre of another pane swaps the two', () => {
    const next = arrangePane(grid, 'p-a', { kind: 'pane', paneId: 'p-d', zone: 'center' })
    expect(shape(next.root)).toEqual({ row: [{ column: ['d', 'b'] }, { column: ['c', 'a'] }] })
  })

  test('an edge of another pane splits beside it', () => {
    const next = arrangePane(grid, 'p-a', { kind: 'pane', paneId: 'p-d', zone: 'bottom' })
    expect(shape(next.root)).toEqual({ row: ['b', { column: ['c', 'd', 'a'] }] })
    expect(shape(arrangePane(grid, 'p-a', { kind: 'pane', paneId: 'p-d', zone: 'right' }).root)).toEqual({ row: ['b', { column: ['c', { row: ['d', 'a'] }] }] })
  })

  test('a side spans it across the group', () => {
    expect(shape(arrangePane(grid, 'p-b', { kind: 'side', side: 'bottom' }).root)).toEqual({ column: [{ row: ['a', { column: ['c', 'd'] }] }, 'b'] })
  })

  test('onto itself nothing changes', () => {
    expect(arrangePane(grid, 'p-a', { kind: 'pane', paneId: 'p-a', zone: 'left' })).toBe(grid)
  })
})

describe('moving a pane with the keyboard', () => {
  const row = panesOf(presetTree(five.slice(0, 4), 'row', 'g'))

  test('toward a neighbour it trades places with it', () => {
    expect(items(shiftPane(row, 'p-b', 'right').root)).toEqual(['a', 'c', 'b', 'd'])
    expect(items(shiftPane(row, 'p-b', 'left').root)).toEqual(['b', 'a', 'c', 'd'])
  })

  test('with no neighbour that way it spans that side of the group', () => {
    expect(shape(shiftPane(row, 'p-b', 'down').root)).toEqual({ column: [{ row: ['a', 'c', 'd'] }, 'b'] })
    expect(shape(shiftPane(row, 'p-a', 'up').root)).toEqual({ column: ['a', { row: ['b', 'c', 'd'] }] })
  })
})

describe('where a drop lands', () => {
  test('a pane splits in thirds: an outer third splits toward its edge, the middle swaps', () => {
    const rect = { left: 0, top: 0, width: 300, height: 300 }
    expect(dropZone(rect, 90, 150)).toBe('left')
    expect(dropZone(rect, 210, 150)).toBe('right')
    expect(dropZone(rect, 150, 90)).toBe('top')
    expect(dropZone(rect, 150, 210)).toBe('bottom')
    expect(dropZone(rect, 150, 150)).toBe('center')
    expect(dropZone(rect, 110, 150)).toBe('center')
  })

  test('the band along the group edge is a side; inside it, or outside the group, is not', () => {
    const box = { left: 100, top: 100, width: 800, height: 600 }
    expect(outerEdge(box, 500, 690, 24)).toBe('bottom')
    expect(outerEdge(box, 500, 110, 24)).toBe('top')
    expect(outerEdge(box, 105, 400, 24)).toBe('left')
    expect(outerEdge(box, 895, 400, 24)).toBe('right')
    expect(outerEdge(box, 500, 400, 24)).toBeNull()
    expect(outerEdge(box, 500, 720, 24)).toBeNull()
    // In a corner the nearer edge wins.
    expect(outerEdge(box, 110, 695, 24)).toBe('bottom')
  })

  test('on the map: its margin is the group sides, a cell its own zones', () => {
    // Four across on top, e under them; the map is 240 by 160 with a 10 pixel margin.
    const cells = [
      { paneId: 'p-a', rect: { x: 0, y: 0, width: 0.25, height: 0.5 } },
      { paneId: 'p-b', rect: { x: 0.25, y: 0, width: 0.25, height: 0.5 } },
      { paneId: 'p-c', rect: { x: 0.5, y: 0, width: 0.25, height: 0.5 } },
      { paneId: 'p-d', rect: { x: 0.75, y: 0, width: 0.25, height: 0.5 } },
      { paneId: 'p-e', rect: { x: 0, y: 0.5, width: 1, height: 0.5 } },
    ]
    const box = { left: 0, top: 0, width: 240, height: 160 }
    expect(mapTarget(cells, box, 10, 120, 155)).toEqual({ kind: 'side', side: 'bottom' })
    expect(mapTarget(cells, box, 10, 120, 4)).toEqual({ kind: 'side', side: 'top' })
    expect(mapTarget(cells, box, 10, 3, 80)).toEqual({ kind: 'side', side: 'left' })
    expect(mapTarget(cells, box, 10, 236, 80)).toEqual({ kind: 'side', side: 'right' })
    // Cell a spans x 10..65 and y 10..80: its middle swaps, its lower third splits under it.
    expect(mapTarget(cells, box, 10, 37, 45)).toEqual({ kind: 'pane', paneId: 'p-a', zone: 'center' })
    expect(mapTarget(cells, box, 10, 37, 76)).toEqual({ kind: 'pane', paneId: 'p-a', zone: 'bottom' })
    expect(mapTarget(cells, box, 10, 120, 120)).toEqual({ kind: 'pane', paneId: 'p-e', zone: 'center' })
    expect(mapTarget(cells, box, 10, 300, 80)).toBeNull()
  })
})
