import { describe, expect, test } from 'bun:test'
import { fixtureBacklog, fixtureRoadmap, fixtureRoadmapItems } from '@/api/fixtures/github-projects'
import type { GithubProjectItem } from '@/api/schema'
import { boardCacheKey, boardKey, distinctItems, emptyBoardCache, keptEntries, keptItems, mergedPages, readBoardCache, withItems, withProjects, writeBoardCache } from '@/tasks/board-cache'

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
