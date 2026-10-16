import { describe, expect, test } from 'bun:test'
import type { GithubPullRequestFile } from '@/api/schema'
import {
  diffWindow,
  emptyPages,
  filesToFetch,
  foldAboveLines,
  isLargeDiff,
  isViewed,
  nextPage,
  pageArrived,
  shownFiles,
  startsFolded,
  touchLru,
  viewedCount,
  type FilePages,
} from '@/github/pr-files-model'

const file = (path: string, changes = 2, extra: Partial<GithubPullRequestFile> = {}): GithubPullRequestFile => ({
  path,
  status: 'modified',
  additions: changes,
  deletions: 0,
  patch: null,
  ...extra,
})

const page = (from: number, count: number, total: number, number: number) => ({
  total,
  page: number,
  perPage: 100,
  files: Array.from({ length: count }, (_, index) => file(`f${from + index}.ts`)),
})

describe('file paging', () => {
  test('nothing loaded asks for the first page', () => {
    expect(nextPage(emptyPages, -1, false)).toBe(1)
  })

  test('a page arriving appends its files and records the total', () => {
    const state = pageArrived({ ...emptyPages, loading: true }, page(0, 100, 600, 1))
    expect(state.files).toHaveLength(100)
    expect(state.total).toBe(600)
    expect(state.pages).toBe(1)
    expect(state.loading).toBe(false)
  })

  test('the next page waits until the list scrolls near the end of what is loaded', () => {
    const state = pageArrived(emptyPages, page(0, 100, 600, 1))
    expect(nextPage(state, 10, false)).toBeNull()
    expect(nextPage(state, 85, false)).toBe(2)
  })

  test('no page is asked while one is loading', () => {
    const state: FilePages = { ...pageArrived(emptyPages, page(0, 100, 600, 1)), loading: true }
    expect(nextPage(state, 99, false)).toBeNull()
  })

  test('a filter loads every page, however far the list is scrolled', () => {
    const state = pageArrived(emptyPages, page(0, 100, 600, 1))
    expect(nextPage(state, 0, true)).toBe(2)
  })

  test('the last page ends paging, and so does a short or empty page', () => {
    let state = emptyPages
    for (let number = 1; number <= 6; number++) state = pageArrived(state, page((number - 1) * 100, 100, 600, number))
    expect(state.files).toHaveLength(600)
    expect(nextPage(state, 599, true)).toBeNull()
    const short = pageArrived(emptyPages, page(0, 40, 600, 1))
    expect(nextPage(short, 39, true)).toBeNull()
    const empty = pageArrived(pageArrived(emptyPages, page(0, 100, 600, 1)), page(100, 0, 600, 2))
    expect(nextPage(empty, 99, true)).toBeNull()
  })

  test('a page out of order or arriving twice is dropped', () => {
    const first = pageArrived(emptyPages, page(0, 100, 600, 1))
    expect(pageArrived(first, page(0, 100, 600, 1))).toBe(first)
    expect(pageArrived(first, page(200, 100, 600, 3))).toBe(first)
  })
})

describe('large diffs', () => {
  test('a file with more changed lines than the threshold starts folded behind a load button', () => {
    expect(isLargeDiff(file('big.json', foldAboveLines + 1))).toBe(true)
    expect(isLargeDiff(file('ok.ts', foldAboveLines))).toBe(false)
    expect(startsFolded(file('big.json', foldAboveLines + 1), false)).toBe(true)
  })

  test('removed and viewed files start folded, others open', () => {
    expect(startsFolded(file('gone.ts', 3, { status: 'removed' }), false)).toBe(true)
    expect(startsFolded(file('seen.ts'), true)).toBe(true)
    expect(startsFolded(file('new.ts'), false)).toBe(false)
  })
})

describe('viewport window', () => {
  test('the window is the visible files plus a few either side, clamped to the list', () => {
    expect(diffWindow({ start: 10, end: 12 }, 600, 2)).toEqual({ start: 8, end: 14 })
    expect(diffWindow({ start: 0, end: 1 }, 600, 2)).toEqual({ start: 0, end: 3 })
    expect(diffWindow({ start: 597, end: 599 }, 600, 2)).toEqual({ start: 595, end: 599 })
    expect(diffWindow(null, 600, 2)).toBeNull()
    expect(diffWindow({ start: 0, end: 0 }, 0, 2)).toBeNull()
  })

  test('only open files inside the window without a diff yet are fetched', () => {
    const files = Array.from({ length: 20 }, (_, index) => file(`f${index}.ts`))
    const known = new Set(['f5.ts'])
    const folded = new Set(['f6.ts'])
    expect(filesToFetch(files, { start: 4, end: 8 }, known, folded)).toEqual(['f4.ts', 'f7.ts', 'f8.ts'])
    expect(filesToFetch(files, null, known, folded)).toEqual([])
  })

  test('a file GitHub sends no patch for is fetched once like any other', () => {
    const files = [file('a.png', 0)]
    expect(filesToFetch(files, { start: 0, end: 0 }, new Set(), new Set())).toEqual(['a.png'])
    expect(filesToFetch(files, { start: 0, end: 0 }, new Set(['a.png']), new Set())).toEqual([])
  })
})

describe('patch cache', () => {
  test('a touched file moves to the front', () => {
    expect(touchLru(['a', 'b', 'c'], ['c'], 5, new Set()).order).toEqual(['c', 'a', 'b'])
  })

  test('past the cap the least recently seen files are released', () => {
    const result = touchLru(['a', 'b', 'c'], ['d'], 3, new Set())
    expect(result.order).toEqual(['d', 'a', 'b'])
    expect(result.evicted).toEqual(['c'])
  })

  test('a file on screen is never released, even past the cap', () => {
    const result = touchLru(['a', 'b', 'c', 'd'], ['e'], 2, new Set(['c', 'd', 'e']))
    expect(result.evicted).toEqual(['b', 'a'])
    expect(result.order).toEqual(['e', 'c', 'd'])
  })

  test('touching several keeps their order, most recent first', () => {
    expect(touchLru([], ['x', 'y'], 50, new Set()).order).toEqual(['x', 'y'])
  })
})

describe('viewed files', () => {
  const files = [file('src/a.ts', 2, { viewed: true }), file('src/b.ts'), file('docs/c.md', 1, { viewed: false })]

  test('the person marking a file wins over what GitHub reported', () => {
    expect(isViewed(files[0] ?? file('x'), {})).toBe(true)
    expect(isViewed(files[0] ?? file('x'), { 'src/a.ts': false })).toBe(false)
    expect(isViewed(files[1] ?? file('x'), { 'src/b.ts': true })).toBe(true)
  })

  test('the count follows the marks', () => {
    expect(viewedCount(files, {})).toBe(1)
    expect(viewedCount(files, { 'docs/c.md': true })).toBe(2)
  })

  test('hiding viewed files keeps the rest, and the query still applies', () => {
    expect(shownFiles(files, '', true, {}).map((entry) => entry.path)).toEqual(['src/b.ts', 'docs/c.md'])
    expect(shownFiles(files, 'src', true, {}).map((entry) => entry.path)).toEqual(['src/b.ts'])
    expect(shownFiles(files, '', false, {})).toBe(files)
  })
})
