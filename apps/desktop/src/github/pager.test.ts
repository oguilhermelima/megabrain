import { describe, expect, test } from 'bun:test'
import { firstCursors, pageCount, pageRange, pageWindow, withNext } from '@/github/pager'

describe('pageRange', () => {
  test('names the items of the page among the total', () => {
    expect(pageRange(0, 25, 25, 687)).toBe('1 to 25 of 687')
    expect(pageRange(1, 25, 25, 687)).toBe('26 to 50 of 687')
  })

  test('a short last page ends on the total', () => {
    expect(pageRange(27, 25, 12, 687)).toBe('676 to 687 of 687')
  })

  test('an empty page says none of the total', () => {
    expect(pageRange(0, 25, 0, 0)).toBe('0 of 0')
  })
})

describe('pageCount', () => {
  test('rounds a partial page up and keeps one page for an empty list', () => {
    expect(pageCount(687, 25)).toBe(28)
    expect(pageCount(50, 25)).toBe(2)
    expect(pageCount(0, 25)).toBe(1)
  })
})

describe('cursor history', () => {
  test('starts with the first page only', () => {
    expect(firstCursors).toEqual([null])
  })

  test('each page answered records the cursor of the next one', () => {
    const second = withNext(firstCursors, 0, 'a')
    const third = withNext(second, 1, 'b')
    expect(third).toEqual([null, 'a', 'b'])
  })

  test('going back and reading a page again keeps the later cursors when nothing moved', () => {
    const cursors = [null, 'a', 'b']
    expect(withNext(cursors, 0, 'a')).toBe(cursors)
  })

  test('a page answering a different cursor drops the later ones', () => {
    expect(withNext([null, 'a', 'b'], 0, 'z')).toEqual([null, 'z'])
  })

  test('the last page records no next cursor', () => {
    expect(withNext([null, 'a'], 1, null)).toEqual([null, 'a'])
    expect(withNext([null, 'a', 'b'], 1, null)).toEqual([null, 'a'])
  })
})

describe('pageWindow', () => {
  test('offers the reached pages around the current one', () => {
    expect(pageWindow(4, [null, 'a', 'b', 'c', 'd', 'e', 'f', 'g'], 28)).toEqual([2, 3, 4, 5, 6])
  })

  test('stops at the first page', () => {
    expect(pageWindow(0, [null, 'a', 'b', 'c'], 28)).toEqual([0, 1, 2])
  })

  test('offers nothing past the last cursor known, even when the total has more pages', () => {
    expect(pageWindow(1, [null, 'a', 'b'], 28)).toEqual([0, 1, 2])
  })

  test('offers nothing past the last page of the total', () => {
    expect(pageWindow(1, [null, 'a', 'b', 'c'], 2)).toEqual([0, 1])
  })
})
