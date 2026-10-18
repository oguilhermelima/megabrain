import { describe, expect, test } from 'bun:test'
import { CARD_GAP, CARD_WIDTH, columnsFor, dispatchOf, elapsed, focusPath, layoutTree, LOG_CAP, logOrder, newPulses, relationTo, treeOf, type LaidOut } from '@/native-chat/orchestration/orchestration-layout'
import type { OrchestrationEvent, OrchestrationGraph, OrchestrationNode } from '@/native-chat/orchestration/orchestration-schema'

const node = (id: string, parent: string | null, startedAt = '2026-10-18T10:00:00Z'): OrchestrationNode => ({
  id, kind: parent === null ? 'coordinator' : 'lane', parent, label: id, agent: 'codex', model: null, effort: null, state: 'working',
  startedAt, endedAt: null, contextPercent: null, last: null, finding: null, unanswered: false, worktree: null, branch: null, commits: null, chatId: null, session: null,
})

const graph = (nodes: OrchestrationNode[], focus: string, events: OrchestrationEvent[] = []): OrchestrationGraph => ({ version: 1, focus, root: 'root', nodes, events })

// root ── a ── a1, a2
//      ├─ b
//      └─ c
const nodes = [node('root', null), node('b', 'root', '2026-10-18T10:02:00Z'), node('a', 'root', '2026-10-18T10:01:00Z'), node('c', 'root', '2026-10-18T10:03:00Z'), node('a2', 'a', '2026-10-18T10:05:00Z'), node('a1', 'a', '2026-10-18T10:04:00Z')]

const ids = (laid: LaidOut): unknown => ({ id: laid.node.id, rows: laid.rows.map((row) => row.map(ids)) })

describe('tree', () => {
  test('children hang under their parent in the order they started', () => {
    const tree = treeOf(graph(nodes, 'a'))
    expect(tree?.children.map((child) => child.node.id)).toEqual(['a', 'b', 'c'])
    expect(tree?.children[0]?.children.map((child) => child.node.id)).toEqual(['a1', 'a2'])
  })

  test('a node whose parent is missing hangs under the root instead of vanishing', () => {
    const tree = treeOf(graph([node('root', null), node('lost', 'gone')], 'lost'))
    expect(tree?.children.map((child) => child.node.id)).toEqual(['lost'])
  })

  test('no root, no tree', () => {
    expect(treeOf({ ...graph(nodes, 'a'), root: 'missing' })).toBeNull()
  })

  test('a chat alone is a tree of one node', () => {
    expect(treeOf(graph([node('root', null)], 'root'))).toEqual({ node: node('root', null), children: [] })
  })
})

describe('rows', () => {
  test('as many cards per row as fit, never fewer than one', () => {
    expect(columnsFor(CARD_WIDTH)).toBe(1)
    expect(columnsFor(CARD_WIDTH * 2 + CARD_GAP)).toBe(2)
    expect(columnsFor(CARD_WIDTH * 2 + CARD_GAP - 1)).toBe(1)
    expect(columnsFor(10)).toBe(1)
  })

  test('lanes wrap into rows when the width holds fewer than there are', () => {
    const tree = treeOf(graph(nodes, 'a'))
    if (tree === null) throw new Error('no tree')
    const twoWide = layoutTree(tree, CARD_WIDTH * 2 + CARD_GAP)
    expect(twoWide.rows.map((row) => row.map((cell) => cell.node.id))).toEqual([['a', 'b'], ['c']])
    const wide = layoutTree(tree, 2000)
    expect(wide.rows.map((row) => row.map((cell) => cell.node.id))).toEqual([['a', 'b', 'c']])
  })

  test('nested lanes lay out within their parent’s share of the row', () => {
    const tree = treeOf(graph(nodes, 'a'))
    if (tree === null) throw new Error('no tree')
    // Three columns wide: a gets a third, too narrow for two cards, so a1 and a2 stack.
    expect(ids(layoutTree(tree, CARD_WIDTH * 3 + CARD_GAP * 2))).toEqual({
      id: 'root',
      rows: [[{ id: 'a', rows: [[{ id: 'a1', rows: [] }], [{ id: 'a2', rows: [] }]] }, { id: 'b', rows: [] }, { id: 'c', rows: [] }]],
    })
  })
})

describe('focus', () => {
  test('the path runs from the root down to the focused chat', () => {
    expect(focusPath(graph(nodes, 'a2'))).toEqual(['root', 'a', 'a2'])
    expect(focusPath(graph(nodes, 'root'))).toEqual(['root'])
  })

  test('a focus outside the graph has no path', () => {
    expect(focusPath(graph(nodes, 'nowhere'))).toEqual([])
  })

  test('a parent loop ends the walk instead of hanging', () => {
    expect(focusPath(graph([node('root', null), node('x', 'y'), node('y', 'x')], 'x'))).toEqual(['y', 'x'])
  })

  test('each node relates to the focused chat', () => {
    const seen = graph(nodes, 'a')
    expect(Object.fromEntries(nodes.map((entry) => [entry.id, relationTo(seen, entry.id)]))).toEqual({ root: 'ancestor', a: 'focus', b: 'sibling', c: 'sibling', a1: 'descendant', a2: 'descendant' })
    expect(relationTo(graph(nodes, 'a1'), 'b')).toBe('other')
  })
})

describe('session log', () => {
  const event = (at: string, text: string): OrchestrationEvent => ({ at, node: 'a', direction: 'to-parent', type: 'ask', text })

  test('oldest first, newest last', () => {
    expect(logOrder([event('2026-10-18T10:03:00Z', 'three'), event('2026-10-18T10:01:00Z', 'one'), event('2026-10-18T10:02:00Z', 'two')]).map((entry) => entry.text)).toEqual(['one', 'two', 'three'])
  })

  test('events at the same instant keep their arrival order', () => {
    expect(logOrder([event('2026-10-18T10:01:00Z', 'first'), event('2026-10-18T10:01:00Z', 'second')]).map((entry) => entry.text)).toEqual(['first', 'second'])
  })

  test('only the newest 200 are kept', () => {
    const many = Array.from({ length: LOG_CAP + 5 }, (_, index) => event(`2026-10-18T10:00:00.${String(index).padStart(3, '0')}Z`, String(index)))
    const kept = logOrder(many)
    expect(kept).toHaveLength(LOG_CAP)
    expect(kept[0]?.text).toBe('5')
    expect(kept.at(-1)?.text).toBe(String(LOG_CAP + 4))
  })
})

describe('elapsed', () => {
  const start = '2026-10-18T10:00:00Z'
  test('seconds, minutes, then hours and minutes', () => {
    expect(elapsed(start, null, Date.parse('2026-10-18T10:00:45Z'))).toBe('45s')
    expect(elapsed(start, null, Date.parse('2026-10-18T10:12:30Z'))).toBe('12m')
    expect(elapsed(start, null, Date.parse('2026-10-18T11:05:00Z'))).toBe('1h 05m')
  })

  test('an ended node stops at its end, and a clock behind the start reads zero', () => {
    expect(elapsed(start, '2026-10-18T10:03:00Z', Date.parse('2026-10-18T12:00:00Z'))).toBe('3m')
    expect(elapsed(start, null, Date.parse('2026-10-18T09:00:00Z'))).toBe('0s')
  })
})

describe('edge animation', () => {
  const event = (at: string, nodeId: string, type: string, direction: OrchestrationEvent['direction'] = 'to-parent'): OrchestrationEvent => ({ at, node: nodeId, direction, type, text: `${type} ${at}` })
  const old = [event('2026-10-18T10:01:00Z', 'a', 'ask')]

  test('the first snapshot animates nothing', () => {
    expect(newPulses(null, graph(nodes, 'a', old))).toEqual([])
  })

  test('a new ask, reply or done runs along the edge to its node, in its direction', () => {
    const next = [...old, event('2026-10-18T10:02:00Z', 'a', 'reply', 'to-child'), event('2026-10-18T10:03:00Z', 'a1', 'done'), event('2026-10-18T10:04:00Z', 'b', 'ask')]
    expect(newPulses(old, graph(nodes, 'a', next)).map(({ node: id, direction, type }) => ({ id, direction, type }))).toEqual([
      { id: 'a', direction: 'to-child', type: 'reply' },
      { id: 'a1', direction: 'to-parent', type: 'done' },
      { id: 'b', direction: 'to-parent', type: 'ask' },
    ])
  })

  test('events already seen, other message types and the root animate nothing', () => {
    const next = [...old, event('2026-10-18T10:02:00Z', 'a', 'received'), event('2026-10-18T10:03:00Z', 'a', 'change', 'to-child'), event('2026-10-18T10:04:00Z', 'root', 'done')]
    expect(newPulses(old, graph(nodes, 'a', next))).toEqual([])
  })

  test('a repeat of a message already seen animates once more, as a new arrival', () => {
    const next = [...old, ...old]
    expect(newPulses(old, graph(nodes, 'a', next))).toHaveLength(1)
  })

  test('events falling off the capped log do not hide a new one', () => {
    const next = [event('2026-10-18T10:05:00Z', 'c', 'done')]
    expect(newPulses(old, graph(nodes, 'a', next)).map((pulse) => pulse.node)).toEqual(['c'])
  })
})

describe('dispatch of a node', () => {
  test('a lane is its dispatch; a coordinator that is only a session has none', () => {
    expect(dispatchOf(node('dispatch-1', 'root'))).toBe('dispatch-1')
    expect(dispatchOf(node('session:claude:abc', null))).toBeNull()
  })
})
