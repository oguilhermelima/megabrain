import { describe, expect, test } from 'bun:test'
import { layoutGraph } from '@/advanced/knowledge-map'

const size = { width: 800, height: 600 }
const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, radius: 10 }))
const edges = [
  { source: 'a', target: 'b', weight: 2 },
  { source: 'b', target: 'c', weight: 1 },
  { source: 'd', target: 'e', weight: 1 },
]

const distance = (left: { x: number; y: number }, right: { x: number; y: number }) => Math.hypot(left.x - right.x, left.y - right.y)

describe('layoutGraph', () => {
  test('places every node once, inside the canvas with its radius', () => {
    const placed = layoutGraph(nodes, edges, size)
    expect([...placed.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    for (const [, point] of placed) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true)
      expect(point.x).toBeGreaterThanOrEqual(10)
      expect(point.x).toBeLessThanOrEqual(size.width - 10)
      expect(point.y).toBeGreaterThanOrEqual(10)
      expect(point.y).toBeLessThanOrEqual(size.height - 10)
    }
  })

  test('the same graph lays out the same way every time', () => {
    expect([...layoutGraph(nodes, edges, size)]).toEqual([...layoutGraph(nodes, edges, size)])
  })

  test('linked topics end up closer than unlinked ones, and no two overlap', () => {
    const placed = layoutGraph(nodes, edges, size)
    const at = (id: string) => placed.get(id) ?? { x: 0, y: 0 }
    expect(distance(at('a'), at('b'))).toBeLessThan(distance(at('a'), at('e')))
    for (const left of nodes) for (const right of nodes) if (left.id < right.id) expect(distance(at(left.id), at(right.id))).toBeGreaterThan(left.radius + right.radius)
  })

  test('one node sits in the middle; none is an empty map', () => {
    const single = layoutGraph([{ id: 'a', radius: 10 }], [], size).get('a')
    expect(single).toEqual({ x: size.width / 2, y: size.height / 2 })
    expect(layoutGraph([], [], size).size).toBe(0)
  })

  test('an edge to a node that is not listed is ignored', () => {
    expect(layoutGraph([{ id: 'a', radius: 10 }], [{ source: 'a', target: 'gone', weight: 1 }], size).size).toBe(1)
  })
})
