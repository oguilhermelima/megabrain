import { describe, expect, test } from 'bun:test'
import type { GithubProjectItem } from '@/api/schema'
import { boardColumns } from '@/tasks/board-model'
import { boardFilterOptions, boardPrefsKey, emptyBoardFilters, emptyBoardPrefs, filterBoardItems, isFiltered, itemState, readBoardPrefs, writeBoardPrefs, type BoardFilters } from '@/tasks/board-filters'

const item = (id: string, patch: Partial<GithubProjectItem> = {}): GithubProjectItem => ({ id, type: 'ISSUE', number: 1, title: id, url: null, state: 'OPEN', repository: 'o/r', status: null, assignees: [], labels: [], updatedAt: '2026-10-17T00:00:00.000Z', ...patch })
const person = (login: string) => ({ login, avatarUrl: '' })
const label = (name: string) => ({ name, color: '000000' })
const ids = (items: GithubProjectItem[]) => items.map((entry) => entry.id)
const only = (patch: Partial<BoardFilters>): BoardFilters => ({ ...emptyBoardFilters, ...patch })

const items = [
  item('crash', { title: 'Fix crash on launch', number: 12, assignees: [person('ana')], labels: [label('bug')], status: 'todo' }),
  item('docs', { title: 'Write the docs', number: 120, labels: [label('docs')], status: 'done', state: 'CLOSED' }),
  item('pr', { type: 'PULL_REQUEST', title: 'Speed up the board', number: 7, state: 'MERGED', repository: 'o/other', assignees: [person('bo'), person('ana')], status: 'done' }),
  item('draft', { type: 'DRAFT_ISSUE', title: 'Idea: crash reports', number: null, state: null, repository: null }),
]

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return { values, storage: () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) }) }
}

describe('filterBoardItems', () => {
  test('no filter keeps every item in order', () => {
    expect(ids(filterBoardItems(items, emptyBoardFilters))).toEqual(['crash', 'docs', 'pr', 'draft'])
    expect(isFiltered(emptyBoardFilters)).toBe(false)
    expect(isFiltered(only({ query: '   ' }))).toBe(false)
  })

  test('words match the title ignoring case', () => {
    expect(ids(filterBoardItems(items, only({ query: 'CRASH' })))).toEqual(['crash', 'draft'])
  })

  test('a number matches the start of the item’s number, with or without #', () => {
    expect(ids(filterBoardItems(items, only({ query: '12' })))).toEqual(['crash', 'docs'])
    expect(ids(filterBoardItems(items, only({ query: '#120' })))).toEqual(['docs'])
    expect(ids(filterBoardItems(items, only({ query: '#9' })))).toEqual([])
  })

  test('assignee and label match any of the item’s', () => {
    expect(ids(filterBoardItems(items, only({ assignee: 'ana' })))).toEqual(['crash', 'pr'])
    expect(ids(filterBoardItems(items, only({ label: 'docs' })))).toEqual(['docs'])
  })

  test('type, state and repository; a draft counts as open', () => {
    expect(ids(filterBoardItems(items, only({ type: 'PULL_REQUEST' })))).toEqual(['pr'])
    expect(ids(filterBoardItems(items, only({ type: 'DRAFT_ISSUE' })))).toEqual(['draft'])
    expect(ids(filterBoardItems(items, only({ state: 'OPEN' })))).toEqual(['crash', 'draft'])
    expect(ids(filterBoardItems(items, only({ state: 'MERGED' })))).toEqual(['pr'])
    expect(ids(filterBoardItems(items, only({ repository: 'o/other' })))).toEqual(['pr'])
    expect(itemState({ state: null })).toBe('OPEN')
  })

  test('filters combine', () => {
    expect(ids(filterBoardItems(items, only({ assignee: 'ana', state: 'OPEN' })))).toEqual(['crash'])
    expect(ids(filterBoardItems(items, only({ query: 'crash', type: 'ISSUE' })))).toEqual(['crash'])
  })

  test('each column counts what the filters leave in it', () => {
    const field = { id: 'f', name: 'Status', options: [{ id: 'todo', name: 'Todo', color: 'GRAY' as const }, { id: 'done', name: 'Done', color: 'GREEN' as const }] }
    const counts = (filters: BoardFilters) => boardColumns(field, filterBoardItems(items, filters)).map((column) => [column.name, column.items.length])
    expect(counts(emptyBoardFilters)).toEqual([['No status', 1], ['Todo', 1], ['Done', 2]])
    expect(counts(only({ assignee: 'ana' }))).toEqual([['No status', 0], ['Todo', 1], ['Done', 1]])
  })
})

describe('boardFilterOptions', () => {
  test('offers what the items carry, sorted, and the kinds and states in a fixed order', () => {
    expect(boardFilterOptions(items, emptyBoardFilters)).toEqual({
      assignees: ['ana', 'bo'],
      labels: ['bug', 'docs'],
      types: ['ISSUE', 'PULL_REQUEST', 'DRAFT_ISSUE'],
      states: ['OPEN', 'CLOSED', 'MERGED'],
      repositories: ['o/other', 'o/r'],
    })
  })

  test('offers no repository filter when every item comes from one', () => {
    expect(boardFilterOptions([items[0], items[1]].filter((entry) => entry !== undefined), emptyBoardFilters).repositories).toEqual([])
  })

  test('keeps a picked value no item carries any more, so the filter still shows it', () => {
    const options = boardFilterOptions([], only({ assignee: 'gone', label: 'old', type: 'PULL_REQUEST', state: 'CLOSED', repository: 'o/r' }))
    expect(options).toEqual({ assignees: ['gone'], labels: ['old'], types: ['PULL_REQUEST'], states: ['CLOSED'], repositories: ['o/r'] })
  })
})

describe('remembering filters per board', () => {
  test('reads back each board’s filters, and stores no entry for a board left unfiltered', () => {
    const { storage, values } = memoryStorage()
    const filters = { 'o/1': only({ label: 'bug', state: 'OPEN' }), 'o/2': emptyBoardFilters }
    writeBoardPrefs(storage, { ...emptyBoardPrefs, filters })
    expect(Object.keys(JSON.parse(values.get(boardPrefsKey) ?? '{}').filters)).toEqual(['o/1'])
    expect(readBoardPrefs(storage).filters).toEqual({ 'o/1': only({ label: 'bug', state: 'OPEN' }) })
  })

  test('drops what a field does not take, and reads nothing from missing or broken storage', () => {
    const stored = { filters: { 'o/1': { query: 3, assignee: 'ana', label: 4, type: 'EPIC', state: 'MERGED', repository: null }, 'o/2': 'junk' } }
    expect(readBoardPrefs(memoryStorage({ [boardPrefsKey]: JSON.stringify(stored) }).storage).filters).toEqual({ 'o/1': only({ assignee: 'ana', state: 'MERGED' }), 'o/2': emptyBoardFilters })
    expect(readBoardPrefs(memoryStorage().storage)).toEqual(emptyBoardPrefs)
    expect(readBoardPrefs(memoryStorage({ [boardPrefsKey]: '[' }).storage)).toEqual(emptyBoardPrefs)
    expect(
      readBoardPrefs(() => {
        throw new Error('blocked')
      }),
    ).toEqual(emptyBoardPrefs)
  })

  test('hides No status unless asked, and remembers the switch for every board', () => {
    const { storage } = memoryStorage()
    expect(readBoardPrefs(storage).showNoStatus).toBe(false)
    writeBoardPrefs(storage, { ...emptyBoardPrefs, showNoStatus: true })
    expect(readBoardPrefs(storage).showNoStatus).toBe(true)
    expect(readBoardPrefs(memoryStorage({ [boardPrefsKey]: JSON.stringify({ filters: {}, showNoStatus: 'yes' }) }).storage).showNoStatus).toBe(false)
  })
})
