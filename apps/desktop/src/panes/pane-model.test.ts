import { describe, expect, test } from 'bun:test'
import {
  closePane,
  dropItem,
  dropZone,
  equaliseSplit,
  focusDirection,
  itemKey,
  movePane,
  normalise,
  openItem,
  paneList,
  paneOfItem,
  paneRects,
  parseItem,
  parsePanes,
  pruneItems,
  removeItem,
  replaceItem,
  resizeSplit,
  serialisePanes,
  singlePane,
  type PaneNode,
  type Panes,
} from '@/panes/pane-model'

const pane = (id: string, item: string): PaneNode => ({ type: 'pane', id, item })
const split = (id: string, direction: 'row' | 'column', children: PaneNode[], sizes?: number[]): PaneNode => ({
  type: 'split',
  id,
  direction,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length),
})

/** The tree without ids or sizes, so a shape reads at a glance: items, row(...) and column(...). */
function shape(node: PaneNode): unknown {
  if (node.type === 'pane') return node.item
  return { [node.direction]: node.children.map(shape) }
}

const items = (panes: Panes) => paneList(panes.root).map((leaf) => leaf.item)

describe('item keys', () => {
  test('round-trip a kind and an id that holds colons', () => {
    expect(itemKey('session', 'claude:abc')).toBe('session:claude:abc')
    expect(parseItem('session:claude:abc')).toEqual({ kind: 'session', id: 'claude:abc' })
  })

  test('a worktree shown only in Code is an item keyed by its root', () => {
    expect(parseItem(itemKey('code', '/wt/seek'))).toEqual({ kind: 'code', id: '/wt/seek' })
  })

  test("a project's page is an item keyed by the project's path", () => {
    expect(parseItem(itemKey('project', '/work/canto'))).toEqual({ kind: 'project', id: '/work/canto' })
  })

  test('an unknown kind or a key without an id is not an item', () => {
    expect(parseItem('window:1')).toBeNull()
    expect(parseItem('terminal:')).toBeNull()
    expect(parseItem('terminal')).toBeNull()
  })
})

describe('openItem', () => {
  test('shows the item in the focused pane', () => {
    const panes: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y')]), focused: 'b' }
    expect(items(openItem(panes, 'z'))).toEqual(['x', 'z'])
  })

  test('an item already open focuses its pane instead of opening it twice', () => {
    const panes: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y')]), focused: 'b' }
    const next = openItem(panes, 'x')
    expect(items(next)).toEqual(['x', 'y'])
    expect(next.focused).toBe('a')
  })
})

describe('dropItem splits like tmux', () => {
  const one = singlePane('x', 'a')

  test('right puts the item after the pane in a row', () => {
    const next = dropItem(one, 'y', 'a', 'right', 'b')
    expect(shape(next.root)).toEqual({ row: ['x', 'y'] })
    expect(next.focused).toBe('b')
  })

  test('left puts it before in a row', () => {
    expect(shape(dropItem(one, 'y', 'a', 'left', 'b').root)).toEqual({ row: ['y', 'x'] })
  })

  test('top puts it before in a column', () => {
    expect(shape(dropItem(one, 'y', 'a', 'top', 'b').root)).toEqual({ column: ['y', 'x'] })
  })

  test('bottom puts it after in a column', () => {
    expect(shape(dropItem(one, 'y', 'a', 'bottom', 'b').root)).toEqual({ column: ['x', 'y'] })
  })

  test('the new pane takes half of the pane it split', () => {
    const next = dropItem(one, 'y', 'a', 'right', 'b')
    expect(next.root.type === 'split' && next.root.sizes).toEqual([0.5, 0.5])
  })

  test('splitting along the parent direction joins the parent instead of nesting', () => {
    const row: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y')], [0.6, 0.4]), focused: 'a' }
    const next = dropItem(row, 'z', 'a', 'right', 'c')
    expect(shape(next.root)).toEqual({ row: ['x', 'z', 'y'] })
    expect(next.root.type === 'split' && next.root.sizes.map((size) => Math.round(size * 100))).toEqual([30, 30, 40])
  })

  test('splitting across the parent direction nests a split in that pane', () => {
    const row: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y')]), focused: 'a' }
    expect(shape(dropItem(row, 'z', 'b', 'bottom', 'c').root)).toEqual({ row: ['x', { column: ['y', 'z'] }] })
  })

  test('center replaces the pane item', () => {
    const next = dropItem(one, 'y', 'a', 'center', 'b')
    expect(shape(next.root)).toEqual('y')
    expect(next.focused).toBe('a')
  })

  test('an item already open elsewhere moves instead of opening twice', () => {
    const row: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y'), pane('c', 'z')]), focused: 'a' }
    const next = dropItem(row, 'z', 'a', 'bottom', 'd')
    expect(shape(next.root)).toEqual({ row: [{ column: ['x', 'z'] }, 'y'] })
    expect(paneList(next.root).filter((leaf) => leaf.item === 'z')).toHaveLength(1)
  })

  test('dropping a pane own item onto its own edge changes nothing', () => {
    expect(dropItem(one, 'x', 'a', 'left', 'b')).toEqual(one)
  })

  test('an unknown target changes nothing', () => {
    expect(dropItem(one, 'y', 'nope', 'left', 'b')).toEqual(one)
  })
})

describe('movePane', () => {
  const row: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y'), pane('c', 'z')]), focused: 'a' }

  test('dragging a pane onto another pane edge moves it there and keeps its id', () => {
    const next = movePane(row, 'a', 'c', 'bottom')
    expect(shape(next.root)).toEqual({ row: ['y', { column: ['z', 'x'] }] })
    expect(paneOfItem(next, 'x')?.id).toBe('a')
    expect(next.focused).toBe('a')
  })

  test('center swaps the two panes items', () => {
    expect(shape(movePane(row, 'a', 'c', 'center').root)).toEqual({ row: ['z', 'y', 'x'] })
  })

  test('onto itself changes nothing', () => {
    expect(movePane(row, 'b', 'b', 'left')).toEqual(row)
  })

  test('the only pane cannot move', () => {
    const one = singlePane('x', 'a')
    expect(movePane(one, 'a', 'a', 'right')).toEqual(one)
  })
})

describe('closePane', () => {
  test('a split left with one pane collapses into it', () => {
    const panes: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y')]), focused: 'b' }
    const next = closePane(panes, 'b')
    expect(next.root).toEqual(pane('a', 'x'))
    expect(next.focused).toBe('a')
  })

  test('collapsing a nested split lifts its pane into the grandparent', () => {
    const panes: Panes = { root: split('s', 'row', [pane('a', 'x'), split('t', 'column', [pane('b', 'y'), pane('c', 'z')])]), focused: 'a' }
    const next = closePane(panes, 'c')
    expect(shape(next.root)).toEqual({ row: ['x', 'y'] })
    expect(next.focused).toBe('a')
  })

  test('the closed pane space goes to its siblings', () => {
    const panes: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y'), pane('c', 'z')], [0.5, 0.25, 0.25]), focused: 'a' }
    const next = closePane(panes, 'a')
    expect(next.root.type === 'split' && next.root.sizes).toEqual([0.5, 0.5])
  })

  test('focus moves to the neighbour that takes the space', () => {
    const panes: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y'), pane('c', 'z')]), focused: 'b' }
    expect(closePane(panes, 'b').focused).toBe('a')
    expect(closePane({ ...panes, focused: 'a' }, 'a').focused).toBe('b')
  })

  test('the last pane cannot close', () => {
    const one = singlePane('x', 'a')
    expect(closePane(one, 'a')).toEqual(one)
  })
})

describe('removeItem', () => {
  test('closes the pane that shows it', () => {
    const panes: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y')]), focused: 'a' }
    expect(shape(removeItem(panes, 'y', 'launcher:1').root)).toEqual('x')
  })

  test('the last pane shows the fallback instead', () => {
    expect(shape(removeItem(singlePane('x', 'a'), 'x', 'launcher:1').root)).toEqual('launcher:1')
  })

  test('an item no pane shows changes nothing', () => {
    const one = singlePane('x', 'a')
    expect(removeItem(one, 'q', 'launcher:1')).toEqual(one)
  })
})

describe('replaceItem', () => {
  test('puts the item in that pane', () => {
    const panes: Panes = { root: split('s', 'row', [pane('a', 'launcher:1'), pane('b', 'y')]), focused: 'b' }
    const next = replaceItem(panes, 'a', 'x')
    expect(items(next)).toEqual(['x', 'y'])
    expect(next.focused).toBe('a')
  })

  test('an item already open elsewhere leaves its old pane', () => {
    const panes: Panes = { root: split('s', 'row', [pane('a', 'launcher:1'), pane('b', 'y')]), focused: 'a' }
    expect(shape(replaceItem(panes, 'a', 'y').root)).toEqual('y')
  })
})

describe('resizeSplit', () => {
  const panes: Panes = { root: split('s', 'row', [pane('a', 'x'), pane('b', 'y'), pane('c', 'z')], [0.4, 0.3, 0.3]), focused: 'a' }
  const sizes = (next: Panes) => (next.root.type === 'split' ? next.root.sizes.map((size) => Math.round(size * 1000) / 1000) : [])

  test('moves the divider between two panes and leaves the others', () => {
    expect(sizes(resizeSplit(panes, 's', 0, 0.1, 0.1))).toEqual([0.5, 0.2, 0.3])
    expect(sizes(resizeSplit(panes, 's', 1, -0.1, 0.1))).toEqual([0.4, 0.2, 0.4])
  })

  test('clamps so neither pane goes under the minimum', () => {
    expect(sizes(resizeSplit(panes, 's', 0, 0.5, 0.1))).toEqual([0.6, 0.1, 0.3])
    expect(sizes(resizeSplit(panes, 's', 0, -0.5, 0.1))).toEqual([0.1, 0.6, 0.3])
  })

  test('a minimum the two panes cannot both meet changes nothing', () => {
    expect(resizeSplit(panes, 's', 0, 0.1, 0.4)).toEqual(panes)
  })

  test('an unknown split or divider changes nothing', () => {
    expect(resizeSplit(panes, 'nope', 0, 0.1, 0.1)).toEqual(panes)
    expect(resizeSplit(panes, 's', 2, 0.1, 0.1)).toEqual(panes)
  })

  test('equalise gives every pane of the split the same size', () => {
    expect(sizes(equaliseSplit(panes, 's'))).toEqual([0.333, 0.333, 0.333])
  })
})

describe('normalise', () => {
  test('a split of one child becomes that child', () => {
    expect(normalise(split('s', 'row', [pane('a', 'x')]))).toEqual(pane('a', 'x'))
  })

  test('an empty split is nothing', () => {
    expect(normalise(split('s', 'row', []))).toBeNull()
  })

  test('a child split in the same direction is flattened, its sizes scaled', () => {
    const node = split('s', 'row', [pane('a', 'x'), split('t', 'row', [pane('b', 'y'), pane('c', 'z')], [0.5, 0.5])], [0.5, 0.5])
    const next = normalise(node)
    expect(next === null ? null : shape(next)).toEqual({ row: ['x', 'y', 'z'] })
    expect(next?.type === 'split' && next.sizes).toEqual([0.5, 0.25, 0.25])
  })

  test('sizes are scaled to add up to one, and broken ones made equal', () => {
    expect(normalise(split('s', 'row', [pane('a', 'x'), pane('b', 'y')], [2, 6]))).toMatchObject({ sizes: [0.25, 0.75] })
    expect(normalise(split('s', 'row', [pane('a', 'x'), pane('b', 'y')], [Number.NaN, -1]))).toMatchObject({ sizes: [0.5, 0.5] })
    expect(normalise(split('s', 'row', [pane('a', 'x'), pane('b', 'y')], [1]))).toMatchObject({ sizes: [0.5, 0.5] })
  })

  test('an item shown twice keeps only its first pane', () => {
    const next = normalise(split('s', 'row', [pane('a', 'x'), pane('b', 'x'), pane('c', 'y')]))
    expect(next === null ? null : shape(next)).toEqual({ row: ['x', 'y'] })
  })

  test('a pane id used twice keeps only its first pane', () => {
    const next = normalise(split('s', 'row', [pane('a', 'x'), pane('a', 'y')]))
    expect(next).toEqual(pane('a', 'x'))
  })
})

describe('pruneItems', () => {
  const panes: Panes = { root: split('s', 'row', [pane('a', 'x'), split('t', 'column', [pane('b', 'gone'), pane('c', 'z')])]), focused: 'b' }

  test('drops panes whose item no longer exists and collapses their splits', () => {
    const next = pruneItems(panes, (item) => item !== 'gone', { id: 'f', item: 'launcher:1' })
    expect(shape(next.root)).toEqual({ row: ['x', 'z'] })
    expect(paneList(next.root).some((leaf) => leaf.id === next.focused)).toBe(true)
  })

  test('nothing left shows the fallback pane', () => {
    const next = pruneItems(panes, () => false, { id: 'f', item: 'launcher:1' })
    expect(next).toEqual({ root: pane('f', 'launcher:1'), focused: 'f' })
  })

  test('nothing stale returns the same layout', () => {
    expect(pruneItems(panes, () => true, { id: 'f', item: 'launcher:1' })).toBe(panes)
  })
})

describe('persistence', () => {
  const panes: Panes = {
    root: split('s', 'row', [pane('a', 'native:1'), split('t', 'column', [pane('b', 'terminal:old'), pane('c', 'session:claude:9')], [0.3, 0.7])], [0.6, 0.4]),
    focused: 'c',
  }

  test('round-trips through its stored text', () => {
    expect(parsePanes(serialisePanes(panes))).toEqual(panes)
  })

  test('a round trip then a prune drops the items that are gone', () => {
    const restored = parsePanes(serialisePanes(panes))
    expect(restored).not.toBeNull()
    if (restored === null) return
    const next = pruneItems(restored, (item) => parseItem(item)?.kind !== 'terminal', { id: 'f', item: 'launcher:1' })
    expect(shape(next.root)).toEqual({ row: ['native:1', 'session:claude:9'] })
    expect(next.focused).toBe('c')
  })

  test('nothing stored, broken JSON, another version or a malformed tree read as nothing', () => {
    expect(parsePanes(null)).toBeNull()
    expect(parsePanes('{')).toBeNull()
    expect(parsePanes(JSON.stringify({ version: 2, root: pane('a', 'x'), focused: 'a' }))).toBeNull()
    expect(parsePanes(JSON.stringify({ version: 1, root: { type: 'split', id: 's', direction: 'diagonal', children: [], sizes: [] }, focused: 'a' }))).toBeNull()
    expect(parsePanes(JSON.stringify({ version: 1, root: { type: 'pane', id: 3, item: 'x' }, focused: 'a' }))).toBeNull()
  })

  test('a focus on a pane that is not there falls to the first pane', () => {
    expect(parsePanes(JSON.stringify({ version: 1, root: split('s', 'row', [pane('a', 'x'), pane('b', 'y')]), focused: 'zz' }))?.focused).toBe('a')
  })
})

describe('paneRects', () => {
  test('lays panes out in the unit square by their sizes', () => {
    const root = split('s', 'row', [pane('a', 'x'), split('t', 'column', [pane('b', 'y'), pane('c', 'z')], [0.25, 0.75])], [0.6, 0.4])
    const { panes } = paneRects(root)
    const near = (value: number) => Math.round(value * 1000) / 1000
    const rounded = panes.map(({ id, rect }) => ({ id, x: near(rect.x), y: near(rect.y), width: near(rect.width), height: near(rect.height) }))
    expect(rounded).toEqual([
      { id: 'a', x: 0, y: 0, width: 0.6, height: 1 },
      { id: 'b', x: 0.6, y: 0, width: 0.4, height: 0.25 },
      { id: 'c', x: 0.6, y: 0.25, width: 0.4, height: 0.75 },
    ])
  })

  test('one divider between each pair of children, at their boundary', () => {
    const root = split('s', 'row', [pane('a', 'x'), pane('b', 'y'), pane('c', 'z')], [0.5, 0.25, 0.25])
    const { dividers } = paneRects(root)
    expect(dividers.map((divider) => ({ splitId: divider.splitId, index: divider.index, at: divider.at }))).toEqual([
      { splitId: 's', index: 0, at: 0.5 },
      { splitId: 's', index: 1, at: 0.75 },
    ])
  })
})

describe('focusDirection', () => {
  // a | b
  //   | c
  const panes: Panes = { root: split('s', 'row', [pane('a', 'x'), split('t', 'column', [pane('b', 'y'), pane('c', 'z')])]), focused: 'c' }

  test('moves to the neighbour on that side', () => {
    expect(focusDirection(panes, 'left').focused).toBe('a')
    expect(focusDirection(panes, 'up').focused).toBe('b')
    expect(focusDirection({ ...panes, focused: 'b' }, 'down').focused).toBe('c')
  })

  test('from a tall pane, right picks the neighbour it overlaps most, the first on a tie', () => {
    expect(focusDirection({ ...panes, focused: 'a' }, 'right').focused).toBe('b')
  })

  test('no neighbour on that side keeps the focus', () => {
    expect(focusDirection(panes, 'right').focused).toBe('c')
    expect(focusDirection({ ...panes, focused: 'a' }, 'left').focused).toBe('a')
  })
})

describe('dropZone', () => {
  const rect = { left: 100, top: 0, width: 400, height: 200 }

  test('the middle of the pane replaces it', () => {
    expect(dropZone(rect, 300, 100)).toBe('center')
  })

  test('near an edge splits toward that edge', () => {
    expect(dropZone(rect, 110, 100)).toBe('left')
    expect(dropZone(rect, 490, 100)).toBe('right')
    expect(dropZone(rect, 300, 10)).toBe('top')
    expect(dropZone(rect, 300, 190)).toBe('bottom')
  })

  test('in a corner the nearer edge wins', () => {
    expect(dropZone(rect, 104, 20)).toBe('left')
    expect(dropZone(rect, 160, 4)).toBe('top')
  })
})
