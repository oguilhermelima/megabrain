import { describe, expect, test } from 'bun:test'
import { reuse } from '@/lib/reuse'

describe('reuse', () => {
  test('an equal result keeps the previous object', () => {
    const previous = { dispatches: [{ id: 'a', state: 'running', tags: ['x'] }], machine: null, count: 3 }
    const next = JSON.parse(JSON.stringify(previous)) as typeof previous
    expect(reuse(previous, next)).toBe(previous)
  })

  test('an equal array keeps the previous array', () => {
    const previous = [{ path: '/a' }, { path: '/b' }]
    expect(reuse(previous, [{ path: '/a' }, { path: '/b' }])).toBe(previous)
  })

  test('a changed result is new, but its unchanged parts keep their identity', () => {
    const previous = { projects: [{ path: '/a', sessions: [{ id: 1 }] }, { path: '/b', sessions: [{ id: 2 }] }] }
    const next = { projects: [{ path: '/a', sessions: [{ id: 1 }] }, { path: '/b', sessions: [{ id: 3 }] }] }
    const merged = reuse(previous, next)
    expect(merged).not.toBe(previous)
    expect(merged).toEqual(next)
    expect(merged.projects[0]).toBe(previous.projects[0])
    expect(merged.projects[1]).not.toBe(previous.projects[1])
  })

  test('nothing to compare with returns the next value', () => {
    const next = { a: 1 }
    expect(reuse(null, next)).toBe(next)
    expect(reuse(undefined, next)).toBe(next)
  })

  test('added, removed and reordered entries are not equal', () => {
    expect(reuse([1, 2], [1, 2, 3])).toEqual([1, 2, 3])
    expect(reuse({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 })
    const previous = [{ id: 'a' }, { id: 'b' }]
    const reordered = reuse(previous, [{ id: 'b' }, { id: 'a' }])
    expect(reordered).not.toBe(previous)
    expect(reordered[0]).toBe(previous[1])
    expect(reordered[1]).toBe(previous[0])
  })

  test('a key holding undefined differs from a missing key, and null differs from an object', () => {
    expect(reuse({ a: 1 } as { a: number; b?: number }, { a: 1, b: undefined })).toEqual({ a: 1, b: undefined })
    const previous = { finding: null as { cause: string } | null }
    expect(reuse(previous, { finding: { cause: 'x' } })).toEqual({ finding: { cause: 'x' } })
  })
})
