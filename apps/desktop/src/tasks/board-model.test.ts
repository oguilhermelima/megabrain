import { describe, expect, test } from 'bun:test'
import { answeredItems, boardColumns, movesItem, otherRepository, shownItems, statusColors, withoutMove, type PendingMove } from '@/tasks/board-model'
import { fixtureBacklog, fixtureBacklogItems, fixtureRoadmap, fixtureRoadmapItems } from '@/api/fixtures/github-projects'
import { githubProjectPageSchema, githubProjectsSchema, type GithubProjectItem } from '@/api/schema'

const field = fixtureRoadmap.statusField ?? { id: '', name: '', options: [] }
const item = (id: string, status: string | null): GithubProjectItem => ({ id, type: 'ISSUE', number: 1, title: id, url: null, state: 'OPEN', repository: 'o/r', status, assignees: [], labels: [], updatedAt: '2026-10-17T00:00:00.000Z' })
const statusOf = (items: GithubProjectItem[], id: string) => items.find((entry) => entry.id === id)?.status

describe('the GitHub Projects fixture', () => {
  test('passes the contract: a project with a Status field and 12 items, and one without', () => {
    expect(githubProjectsSchema.parse({ projects: [fixtureRoadmap, fixtureBacklog] }).projects).toHaveLength(2)
    expect(githubProjectPageSchema.parse({ project: fixtureRoadmap, items: fixtureRoadmapItems, next: null }).items).toHaveLength(12)
    expect(field.options.map((option) => option.name)).toEqual(['Todo', 'In Progress', 'In Review', 'Done'])
    expect(fixtureBacklog.statusField).toBeNull()
    expect(fixtureBacklogItems.length).toBeGreaterThan(0)
  })
})

describe('boardColumns', () => {
  test('No status first, then the options in the project’s order with their colours', () => {
    const columns = boardColumns(field, fixtureRoadmapItems)
    expect(columns.map((column) => [column.id, column.name, column.color])).toEqual([
      [null, 'No status', statusColors.GRAY],
      ['opt_todo', 'Todo', statusColors.GRAY],
      ['opt_progress', 'In Progress', statusColors.YELLOW],
      ['opt_review', 'In Review', statusColors.BLUE],
      ['opt_done', 'Done', statusColors.GREEN],
    ])
  })

  test('puts every item in its option’s column in read order, and one with no or a removed option under No status', () => {
    const columns = boardColumns(field, fixtureRoadmapItems)
    const ids = Object.fromEntries(columns.map((column) => [column.name, column.items.map((entry) => entry.id)]))
    expect(ids).toEqual({
      'No status': ['PVTI_09', 'PVTI_10', 'PVTI_12'],
      Todo: ['PVTI_03', 'PVTI_04', 'PVTI_08'],
      'In Progress': ['PVTI_01', 'PVTI_07'],
      'In Review': ['PVTI_02', 'PVTI_11'],
      Done: ['PVTI_05', 'PVTI_06'],
    })
    expect(columns.reduce((sum, column) => sum + column.items.length, 0)).toBe(12)
  })

  test('a field with no options is one No status column holding everything', () => {
    const columns = boardColumns({ id: 'f', name: 'Status', options: [] }, [item('a', 'x'), item('b', null)])
    expect(columns.map((column) => [column.name, column.items.length])).toEqual([['No status', 2]])
  })
})

describe('an optimistic move', () => {
  const read = [item('a', 'opt_todo'), item('b', 'opt_todo')]
  const move: PendingMove = { id: 1, itemId: 'a', status: 'opt_done' }

  test('shows at once over the items as read, without changing them', () => {
    const shown = shownItems(read, [move])
    expect(statusOf(shown, 'a')).toBe('opt_done')
    expect(statusOf(shown, 'b')).toBe('opt_todo')
    expect(statusOf(read, 'a')).toBe('opt_todo')
  })

  test('later moves of the same item win', () => {
    expect(statusOf(shownItems(read, [move, { id: 2, itemId: 'a', status: 'opt_review' }]), 'a')).toBe('opt_review')
  })

  test('keeps the answered item when GitHub confirms', () => {
    const answer = { ...item('a', 'opt_done'), updatedAt: '2026-10-18T00:00:00.000Z' }
    const confirmed = answeredItems(read, answer)
    expect(withoutMove([move], 1)).toEqual([])
    expect(confirmed.find((entry) => entry.id === 'a')).toEqual(answer)
    expect(statusOf(shownItems(confirmed, []), 'a')).toBe('opt_done')
  })

  test('rolls back when the call fails: the card is where it was read', () => {
    expect(statusOf(shownItems(read, withoutMove([move], 1)), 'a')).toBe('opt_todo')
  })

  test('a failed move leaves another pending move standing', () => {
    const other: PendingMove = { id: 2, itemId: 'b', status: 'opt_review' }
    const rest = withoutMove([move, other], 1)
    expect(rest).toEqual([other])
    expect(statusOf(shownItems(read, rest), 'a')).toBe('opt_todo')
    expect(statusOf(shownItems(read, rest), 'b')).toBe('opt_review')
  })

  test('only a change of column is a move', () => {
    expect(movesItem(read, [], 'a', 'opt_todo')).toBe(false)
    expect(movesItem(read, [], 'a', 'opt_done')).toBe(true)
    expect(movesItem(read, [move], 'a', 'opt_done')).toBe(false)
    expect(movesItem(read, [], 'gone', 'opt_done')).toBe(false)
  })
})

describe('otherRepository', () => {
  test('names an item’s repository only when it is not the page’s', () => {
    expect(otherRepository({ repository: 'o/r' }, 'O/R')).toBeNull()
    expect(otherRepository({ repository: null }, 'o/r')).toBeNull()
    expect(otherRepository({ repository: 'o/docs' }, 'o/r')).toBe('o/docs')
  })
})
