import { describe, expect, test } from 'bun:test'
import { applyOrder, dropTarget, moveProject, parseOrder, reconcileOrder, stepProject } from '@/advanced/project-order'

const item = (path: string) => ({ path })
const paths = (items: { path: string }[]) => items.map((entry) => entry.path)

describe('parseOrder', () => {
  test('reads a saved list of paths', () => {
    expect(parseOrder('["/a","/b"]')).toEqual(['/a', '/b'])
  })

  test('starts empty when nothing was saved or the value is not a list of strings', () => {
    expect(parseOrder(null)).toEqual([])
    expect(parseOrder('not json')).toEqual([])
    expect(parseOrder('{"a":1}')).toEqual([])
    expect(parseOrder('["/a",3]')).toEqual(['/a'])
  })
})

describe('reconcileOrder', () => {
  test('keeps the saved order of projects that still exist', () => {
    expect(reconcileOrder(['/c', '/a', '/b'], ['/a', '/b', '/c'])).toEqual(['/c', '/a', '/b'])
  })

  test('puts new projects at the end in the order they arrive', () => {
    expect(reconcileOrder(['/b'], ['/a', '/b', '/c'])).toEqual(['/b', '/a', '/c'])
  })

  test('drops saved projects that are gone', () => {
    expect(reconcileOrder(['/gone', '/b', '/a'], ['/a', '/b'])).toEqual(['/b', '/a'])
  })
})

describe('applyOrder', () => {
  test('sorts projects by the saved order, new ones last', () => {
    expect(paths(applyOrder([item('/a'), item('/b'), item('/c'), item('/new')], ['/c', '/a', '/b']))).toEqual(['/c', '/a', '/b', '/new'])
  })

  test('with no saved order keeps the order the projects came in', () => {
    expect(paths(applyOrder([item('/a'), item('/b')], []))).toEqual(['/a', '/b'])
  })
})

describe('moveProject', () => {
  const order = ['/a', '/b', '/c', '/d']

  test('moves a project before another', () => {
    expect(moveProject(order, '/d', '/b', 'before')).toEqual(['/a', '/d', '/b', '/c'])
  })

  test('moves a project after another', () => {
    expect(moveProject(order, '/a', '/c', 'after')).toEqual(['/b', '/c', '/a', '/d'])
  })

  test('dropping a project on itself changes nothing', () => {
    expect(moveProject(order, '/b', '/b', 'before')).toEqual(order)
  })

  test('a hidden project between the two keeps its place', () => {
    // /b is hidden: moving /c before /a leaves /b where it was relative to /a.
    expect(moveProject(order, '/c', '/a', 'before')).toEqual(['/c', '/a', '/b', '/d'])
  })

  test('appends projects the saved order does not know before moving', () => {
    expect(moveProject(['/a'], '/b', '/a', 'before')).toEqual(['/b', '/a'])
  })
})

describe('stepProject', () => {
  test('moves a project above its visible neighbour, skipping hidden ones', () => {
    expect(stepProject(['/a', '/hidden', '/b'], ['/a', '/b'], '/b', -1)).toEqual(['/b', '/a', '/hidden'])
  })

  test('moves a project below its visible neighbour', () => {
    expect(stepProject(['/a', '/b', '/c'], ['/a', '/b', '/c'], '/a', 1)).toEqual(['/b', '/a', '/c'])
  })

  test('does nothing at either end of the list', () => {
    expect(stepProject(['/a', '/b'], ['/a', '/b'], '/a', -1)).toEqual(['/a', '/b'])
    expect(stepProject(['/a', '/b'], ['/a', '/b'], '/b', 1)).toEqual(['/a', '/b'])
  })
})

describe('dropTarget', () => {
  const rows = [
    { path: '/a', top: 0, bottom: 40 },
    { path: '/b', top: 50, bottom: 90 },
  ]

  test('the upper half of a row drops before it, the lower half after it', () => {
    expect(dropTarget(rows, 10)).toEqual({ path: '/a', placement: 'before' })
    expect(dropTarget(rows, 30)).toEqual({ path: '/a', placement: 'after' })
    expect(dropTarget(rows, 60)).toEqual({ path: '/b', placement: 'before' })
  })

  test('above the first row drops before it, below the last after it', () => {
    expect(dropTarget(rows, -20)).toEqual({ path: '/a', placement: 'before' })
    expect(dropTarget(rows, 400)).toEqual({ path: '/b', placement: 'after' })
  })

  test('a gap between rows drops after the row above', () => {
    expect(dropTarget(rows, 45)).toEqual({ path: '/a', placement: 'after' })
  })

  test('no rows means no target', () => {
    expect(dropTarget([], 10)).toBeNull()
  })
})
