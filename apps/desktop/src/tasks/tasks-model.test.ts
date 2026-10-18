import { describe, expect, test } from 'bun:test'
import type { WidthStorage } from '@/lib/panel-width'
import { parseItem } from '@/panes/pane-model'
import { emptyTasksMemory, readTasksMemory, shownBoard, shownRepo, tasksItem, tasksMemoryKey, writeTasksMemory } from '@/tasks/tasks-model'

function memory(initial: Record<string, string> = {}): WidthStorage & { values: Record<string, string> } {
  const values = { ...initial }
  return { values, getItem: (key) => values[key] ?? null, setItem: (key, value) => void (values[key] = value) }
}

const throwing: WidthStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

describe('the Tasks item', () => {
  test('is a tasks item the pane model reads back', () => {
    expect(parseItem(tasksItem)).toEqual({ kind: 'tasks', id: 'home' })
  })
})

describe('what the Tasks page remembers', () => {
  test('starts on the list with nothing picked', () => {
    expect(readTasksMemory(() => memory())).toEqual(emptyTasksMemory)
  })

  test('reads back the view, the repository and each repository’s board as written', () => {
    const storage = memory()
    const written = writeTasksMemory(() => storage, { view: 'board', repo: '/work/canto', boards: { '/work/canto': 3, '/work/juntin': 1 } })
    expect(readTasksMemory(() => storage)).toEqual(written)
    expect(JSON.parse(storage.values[tasksMemoryKey] ?? '')).toEqual(written)
  })

  test('drops what it does not recognise and keeps the rest', () => {
    const storage = memory({ [tasksMemoryKey]: JSON.stringify({ view: 'grid', repo: 7, boards: { '/a': 2, '/b': 'x', '/c': 1.5 } }) })
    expect(readTasksMemory(() => storage)).toEqual({ view: 'list', repo: null, boards: { '/a': 2 } })
  })

  test('remembers nothing from broken or blocked storage, and writing to it still answers', () => {
    expect(readTasksMemory(() => memory({ [tasksMemoryKey]: '{not json' }))).toEqual(emptyTasksMemory)
    expect(readTasksMemory(() => memory({ [tasksMemoryKey]: '[1,2]' }))).toEqual(emptyTasksMemory)
    expect(readTasksMemory(() => throwing)).toEqual(emptyTasksMemory)
    const next = { view: 'board' as const, repo: '/a', boards: {} }
    expect(writeTasksMemory(() => throwing, next)).toBe(next)
  })
})

describe('what the page shows', () => {
  test('the remembered repository while it is offered, else the first', () => {
    expect(shownRepo(['/a', '/b'], '/b')).toBe('/b')
    expect(shownRepo(['/a', '/b'], '/gone')).toBe('/a')
    expect(shownRepo(['/a'], null)).toBe('/a')
    expect(shownRepo([], '/a')).toBeNull()
  })

  test('the remembered board while the repository has it, else its first open one, else its first', () => {
    const boards = [
      { number: 1, closed: true },
      { number: 4, closed: false },
      { number: 7, closed: false },
    ]
    expect(shownBoard(boards, 7)).toBe(7)
    expect(shownBoard(boards, 9)).toBe(4)
    expect(shownBoard(boards, undefined)).toBe(4)
    expect(shownBoard([{ number: 2, closed: true }], undefined)).toBe(2)
    expect(shownBoard([], 3)).toBeNull()
  })
})
