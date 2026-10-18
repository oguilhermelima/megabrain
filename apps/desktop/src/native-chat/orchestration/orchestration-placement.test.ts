import { describe, expect, test } from 'bun:test'
import { fitBox } from '@/native-chat/orchestration/orchestration-board'
import { CARD_GAP, CARD_WIDTH, layoutTree, type TreeNode } from '@/native-chat/orchestration/orchestration-layout'
import {
  BOARD_ORIGIN,
  boardKey,
  boundsOf,
  DRAG_THRESHOLD,
  draggedTo,
  edgePath,
  pastThreshold,
  placeBeside,
  placeTree,
  readStoredBoard,
  ROW_GAP,
  storedBoardText,
} from '@/native-chat/orchestration/orchestration-placement'
import type { OrchestrationNode } from '@/api/schema'

const leaf = (id: string, children: TreeNode[] = []): TreeNode => ({ node: { id } as OrchestrationNode, children })

describe('the drag threshold', () => {
  test('a press that barely moves is still a click', () => {
    expect(pastThreshold(0, 0)).toBe(false)
    expect(pastThreshold(2, 2)).toBe(false)
    expect(pastThreshold(DRAG_THRESHOLD - 0.5, 0)).toBe(false)
  })
  test('a press that travels the threshold in any direction drags', () => {
    expect(pastThreshold(DRAG_THRESHOLD, 0)).toBe(true)
    expect(pastThreshold(0, -DRAG_THRESHOLD)).toBe(true)
    expect(pastThreshold(3, 3)).toBe(true)
  })
  test('a dragged card moves by the pointer travel in canvas units', () => {
    expect(draggedTo({ x: 100, y: 50 }, 40, -20, 0.5)).toEqual({ x: 180, y: 10 })
    expect(draggedTo({ x: 100, y: 50 }, 40, -20, 2)).toEqual({ x: 120, y: 40 })
  })
})

describe('placeTree', () => {
  test('a parent sits centred over its lanes, which sit a row gap beneath it side by side', () => {
    const width = CARD_WIDTH * 2 + CARD_GAP
    const placed = placeTree(layoutTree(leaf('root', [leaf('a'), leaf('b')]), width), width, () => 100)
    const root = placed.get('root')
    const a = placed.get('a')
    const b = placed.get('b')
    expect(root).toEqual({ x: BOARD_ORIGIN.x + (width - CARD_WIDTH) / 2, y: BOARD_ORIGIN.y })
    expect(a).toEqual({ x: BOARD_ORIGIN.x, y: BOARD_ORIGIN.y + 100 + ROW_GAP })
    expect(b).toEqual({ x: BOARD_ORIGIN.x + CARD_WIDTH + CARD_GAP, y: BOARD_ORIGIN.y + 100 + ROW_GAP })
  })
  test('a second row starts under the tallest subtree of the first', () => {
    const width = CARD_WIDTH
    const tree = leaf('root', [leaf('a', [leaf('a1')]), leaf('b')])
    const placed = placeTree(layoutTree(tree, width), width, () => 100)
    // One column: a, then a1 under it, then b under a's whole subtree.
    expect(placed.get('a1')?.y).toBe(BOARD_ORIGIN.y + 2 * (100 + ROW_GAP))
    expect(placed.get('b')?.y).toBe(BOARD_ORIGIN.y + 3 * (100 + ROW_GAP))
  })
})

describe('placeBeside', () => {
  const parent = { left: 100, top: 0, width: CARD_WIDTH, height: 100 }
  test('the first lane goes straight under its parent', () => {
    expect(placeBeside(parent, [parent], 80)).toEqual({ x: 100, y: 100 + ROW_GAP })
  })
  test('a lane with siblings already there goes to their right, leaving them where they are', () => {
    const sibling = { left: 100, top: 100 + ROW_GAP, width: CARD_WIDTH, height: 100 }
    const next = { left: 100 + CARD_WIDTH + CARD_GAP, top: 100 + ROW_GAP, width: CARD_WIDTH, height: 100 }
    expect(placeBeside(parent, [parent, sibling, next], 80)).toEqual({ x: 100 + 2 * (CARD_WIDTH + CARD_GAP), y: 100 + ROW_GAP })
  })
  test('a card dragged away frees its spot', () => {
    const elsewhere = { left: 900, top: 900, width: CARD_WIDTH, height: 100 }
    expect(placeBeside(parent, [parent, elsewhere], 80)).toEqual({ x: 100, y: 100 + ROW_GAP })
  })
})

describe('boundsOf and fitBox', () => {
  test('an empty board has no bounds', () => {
    expect(boundsOf([])).toBeNull()
  })
  test('cards dragged above and left of the origin still fit whole', () => {
    const bounds = boundsOf([
      { left: -200, top: -100, width: 248, height: 100 },
      { left: 300, top: 200, width: 248, height: 100 },
    ])
    expect(bounds).toEqual({ left: -200, top: -100, width: 748, height: 400 })
    if (bounds === null) return
    const view = fitBox(bounds, { width: 1000, height: 600 })
    expect(view.x + bounds.left * view.scale).toBeCloseTo((1000 - bounds.width * view.scale) / 2)
    expect(view.y + bounds.top * view.scale).toBeCloseTo((600 - bounds.height * view.scale) / 2)
  })
})

describe('edgePath', () => {
  test('runs from the parent bottom middle to the lane top middle', () => {
    const d = edgePath({ left: 0, top: 0, width: 200, height: 100 }, { left: 300, top: 200, width: 200, height: 100 })
    expect(d.startsWith('M 100 100 ')).toBe(true)
    expect(d.endsWith('L 400 200')).toBe(true)
  })
})

describe('the stored board', () => {
  const view = { x: 12.4, y: -7.6, scale: 0.8 }
  test('reads back what was written, for the cards still drawn, in whole pixels', () => {
    const nodes = new Map([
      ['a', { x: 10.4, y: 20.6 }],
      ['gone', { x: 1, y: 1 }],
    ])
    const stored = readStoredBoard(storedBoardText(view, nodes, new Set(['a'])))
    expect(stored?.view).toEqual({ x: 12, y: -8, scale: 0.8 })
    expect([...(stored?.nodes ?? [])]).toEqual([['a', { x: 10, y: 21 }]])
  })
  test('nothing stored, or text that is not a board, reads as nothing', () => {
    expect(readStoredBoard(null)).toBeNull()
    expect(readStoredBoard('{not json')).toBeNull()
    expect(readStoredBoard('null')).toBeNull()
    expect(readStoredBoard('[]')).toBeNull()
    expect(readStoredBoard('{"view":{"x":0,"y":0,"scale":1}}')).toBeNull()
    expect(readStoredBoard('{"view":{"x":0,"y":"0","scale":1},"nodes":{}}')).toBeNull()
    expect(readStoredBoard('{"view":{"x":0,"y":0,"scale":0},"nodes":{}}')).toBeNull()
    expect(readStoredBoard('{"view":{"x":0,"y":0,"scale":1},"nodes":[]}')).toBeNull()
  })
  test('a malformed card is left out and the rest kept', () => {
    const stored = readStoredBoard('{"view":{"x":0,"y":0,"scale":1},"nodes":{"a":[1,2],"b":[1],"c":"x","d":[1,null],"e":[3,4]}}')
    expect([...(stored?.nodes.keys() ?? [])]).toEqual(['a', 'e'])
  })
  test('a stored scale out of range is brought back into it', () => {
    expect(readStoredBoard('{"view":{"x":0,"y":0,"scale":40},"nodes":{}}')?.view.scale).toBe(2)
  })
  test('each orchestration root has its own key', () => {
    expect(boardKey('a')).not.toBe(boardKey('b'))
  })
})
