import { describe, expect, test } from 'bun:test'
import { fixtureBacklog, fixtureRoadmap, fixtureRoadmapItems } from '@/api/fixtures/github-projects'
import type { GithubProjectItem } from '@/api/schema'
import { boardCacheKey, boardKey, boardListReadDue, boardReadDue, boardFullReadDue, createBoardMemory, distinctItems, readBoardPages, emptyBoardCache, keptEntries, keptItems, mergedPages, readBoardCache, withItems, withProjects, writeBoardCache } from '@/tasks/board-cache'

const item = (id: string): GithubProjectItem => ({ id, type: 'ISSUE', number: 1, title: id, url: null, state: 'OPEN', repository: 'o/r', status: null, assignees: [], labels: [], updatedAt: '2026-10-17T00:00:00.000Z' })
const ids = (items: GithubProjectItem[]) => items.map((entry) => entry.id)

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return { values, storage: () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) }) }
}

describe('boardKey', () => {
  test('names a board by its owner and number, whatever repository shows it', () => {
    expect(boardKey(fixtureRoadmap)).toBe(`${fixtureRoadmap.owner}/${fixtureRoadmap.number}`)
  })
})

describe('reading and writing the board cache', () => {
  test('reads back what it wrote', () => {
    const { storage } = memoryStorage()
    const cache = withItems(withProjects(emptyBoardCache, '/repo', [fixtureRoadmap, fixtureBacklog], 10), boardKey(fixtureRoadmap), fixtureRoadmapItems, 20)
    writeBoardCache(storage, cache)
    expect(readBoardCache(storage)).toEqual(cache)
  })

  test('reads nothing from missing, unparsable or foreign storage', () => {
    expect(readBoardCache(memoryStorage().storage)).toEqual(emptyBoardCache)
    expect(readBoardCache(memoryStorage({ [boardCacheKey]: '{not json' }).storage)).toEqual(emptyBoardCache)
    expect(readBoardCache(memoryStorage({ [boardCacheKey]: JSON.stringify({ projects: { '/repo': { value: [{ id: 1 }], at: 1 } }, items: {} }) }).storage)).toEqual(emptyBoardCache)
    expect(
      readBoardCache(() => {
        throw new Error('blocked')
      }),
    ).toEqual(emptyBoardCache)
  })

  test('a storage that refuses the write keeps nothing and throws nothing', () => {
    expect(() =>
      writeBoardCache(() => ({
        getItem: () => null,
        setItem: () => {
          throw new Error('quota')
        },
      }), emptyBoardCache),
    ).not.toThrow()
  })

  test('stores only the latest boards and repositories, each board capped', () => {
    const { storage } = memoryStorage()
    let cache = emptyBoardCache
    for (let index = 0; index < keptEntries + 2; index++) {
      cache = withProjects(cache, `/repo${index}`, [fixtureRoadmap], index)
      cache = withItems(cache, `o/${index}`, Array.from({ length: keptItems + 5 }, (_, at) => item(`${index}-${at}`)), index)
    }
    writeBoardCache(storage, cache)
    const read = readBoardCache(storage)
    const latest = Array.from({ length: keptEntries }, (_, at) => keptEntries + 1 - at)
    expect(Object.keys(read.projects).sort()).toEqual(latest.map((index) => `/repo${index}`).sort())
    expect(Object.keys(read.items).sort()).toEqual(latest.map((index) => `o/${index}`).sort())
    expect(Object.values(read.items).map((entry) => entry.value.length)).toEqual(latest.map(() => keptItems))
  })
})

describe('streaming pages', () => {
  test('distinctItems keeps the first of each id in order', () => {
    expect(ids(distinctItems([item('a'), item('b'), item('a'), item('c'), item('b')]))).toEqual(['a', 'b', 'c'])
  })

  test('mergedPages shows the pages read, then what was shown that they have not reached, each once', () => {
    const before = [item('a'), item('b'), item('c'), item('d')]
    expect(ids(mergedPages([item('b'), item('a')], before))).toEqual(['b', 'a', 'c', 'd'])
    expect(ids(mergedPages([item('a'), item('e')], before))).toEqual(['a', 'e', 'b', 'c', 'd'])
  })

  test('the first read of a board shows each page alone, as nothing was shown before', () => {
    expect(ids(mergedPages([item('a'), item('b')], []))).toEqual(['a', 'b'])
  })

  test('a fresher item in the pages read wins over the one shown', () => {
    const shown = { ...item('a'), status: 'old' }
    const read = { ...item('a'), status: 'new' }
    expect(mergedPages([read], [shown])[0]?.status).toBe('new')
  })
})

describe('the board cache in memory', () => {
  test('starts from storage and keeps what it remembers', () => {
    const { storage } = memoryStorage()
    writeBoardCache(storage, withProjects(emptyBoardCache, '/repo', [fixtureRoadmap], 10))
    const memory = createBoardMemory(storage)
    expect(memory.get().projects['/repo']?.value).toEqual([fixtureRoadmap])
    memory.remember(withItems(memory.get(), boardKey(fixtureRoadmap), fixtureRoadmapItems, 20))
    expect(memory.get().items[boardKey(fixtureRoadmap)]?.value).toEqual(fixtureRoadmapItems)
  })

  test('holds no more than storage would: each board capped, only the latest boards', () => {
    const { storage } = memoryStorage()
    const memory = createBoardMemory(storage)
    const many = Array.from({ length: keptItems + 50 }, (_, index) => item(`i${index}`))
    memory.remember(withItems(memory.get(), 'o/1', many, 1))
    expect(memory.get().items['o/1']?.value).toHaveLength(keptItems)
    for (let board = 2; board <= keptEntries + 2; board++) memory.remember(withItems(memory.get(), `o/${board}`, [item('x')], board))
    expect(Object.keys(memory.get().items)).toHaveLength(keptEntries)
    expect(memory.get().items['o/1']).toBeUndefined()
  })
})

describe('when a board is read again', () => {
  test('a board read within the last minute is not read again unless asked', () => {
    expect(boardReadDue(undefined, 1_000, false)).toBe(true)
    expect(boardReadDue(1_000, 30_000, false)).toBe(false)
    expect(boardReadDue(1_000, 30_000, true)).toBe(true)
    expect(boardReadDue(1_000, 61_000, false)).toBe(true)
  })

  test('a periodic read checks every page when its last full read is missing or ten minutes old', () => {
    expect(boardFullReadDue(undefined, 600_000, false)).toBe(true)
    expect(boardFullReadDue(0, 599_999, false)).toBe(false)
    expect(boardFullReadDue(0, 600_000, false)).toBe(true)
    expect(boardFullReadDue(500_000, 500_001, true)).toBe(true)
  })
})

describe('reading a board a page at a time', () => {
  const page = (items: GithubProjectItem[], next: string | null, totalCount?: number) => ({ items, next, ...(totalCount === undefined ? {} : { totalCount }) })

  test('reads each page in turn, showing them as they come, and answers every item', async () => {
    const asked: (string | null)[] = []
    const shown: string[][] = []
    const pages: Record<string, ReturnType<typeof page>> = { first: page([item('a')], 'c2'), c2: page([item('b')], null) }
    const all = await readBoardPages({ read: async (after) => (asked.push(after), pages[after ?? 'first'] ?? page([], null)), maxPages: 5, current: () => true, show: (items) => shown.push(ids(items)) })
    expect(asked).toEqual([null, 'c2'])
    expect(all === null ? null : ids(all)).toEqual(['a', 'b'])
    expect(shown).toEqual([['a'], ['a', 'b']])
  })

  test('a read whose board was left writes nothing more and stops asking', async () => {
    let live = true
    const shown: string[][] = []
    let asked = 0
    const all = await readBoardPages({
      read: async () => {
        asked += 1
        live = false
        return page([item(`p${asked}`)], 'more')
      },
      maxPages: 5,
      current: () => live,
      show: (items) => shown.push(ids(items)),
    })
    expect(all).toBeNull()
    expect(asked).toBe(1)
    expect(shown).toEqual([])
  })

  test('a periodic refresh stops after the first unchanged page and total count', async () => {
    const cached = [item('a'), item('b')]
    const asked: (string | null)[] = []
    const all = await readBoardPages({
      read: async (after) => (asked.push(after), page(cached, 'next', 2)),
      maxPages: 5,
      current: () => true,
      show: () => {},
      unchanged: { items: cached, totalCount: 2 },
    })
    expect(asked).toEqual([null])
    expect(ids(all ?? [])).toEqual(['a', 'b'])
  })

  test('a periodic refresh reads every page when the first page or total count changed', async () => {
    const cached = [item('a'), item('b')]
    for (const [first, totalCount] of [
      [page([{ ...item('a'), updatedAt: '2026-10-18T00:00:00.000Z' }, item('b')], 'next', 2), 2],
      [page(cached, 'next', 3), 2],
      [page(cached, 'next'), 2],
    ] as const) {
      const asked: (string | null)[] = []
      const all = await readBoardPages({
        read: async (after) => (asked.push(after), after === null ? first : page([item('c')], null, totalCount)),
        maxPages: 5,
        current: () => true,
        show: () => {},
        unchanged: { items: cached, totalCount: 2 },
      })
      expect(asked).toEqual([null, 'next'])
      expect(ids(all ?? [])).toEqual(['a', 'b', 'c'])
    }
  })

  test('a periodic refresh reads every page when a full read is due, even if the first page is unchanged', async () => {
    const cached = [item('a'), item('b')]
    const asked: (string | null)[] = []
    const all = await readBoardPages({
      read: async (after) => (asked.push(after), after === null ? page(cached, 'next', 2) : page([item('deeply-edited')], null, 2)),
      maxPages: 5,
      current: () => true,
      show: () => {},
      unchanged: { items: cached, totalCount: 2 },
      fullRead: true,
    })
    expect(asked).toEqual([null, 'next'])
    expect(ids(all ?? [])).toEqual(['a', 'b', 'deeply-edited'])
  })
})

describe('when a repository lists its boards again', () => {
  test('the list read this run is read again once five minutes old, or when asked', () => {
    expect(boardListReadDue(undefined, 1_000, false)).toBe(true)
    expect(boardListReadDue(1_000, 120_000, false)).toBe(false)
    expect(boardListReadDue(1_000, 120_000, true)).toBe(true)
    expect(boardListReadDue(1_000, 301_000, false)).toBe(true)
  })
})
