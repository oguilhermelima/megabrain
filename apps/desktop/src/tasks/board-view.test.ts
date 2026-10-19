import { describe, expect, test } from 'bun:test'
import type { GithubProject, GithubProjectField, GithubProjectItem, GithubProjectView } from '@/api/schema'
import { statusColors } from '@/tasks/board-model'
import { cardChips, editableType, editedItems, groupField, laneField, optionOf, parseAddition, projectViews, readViewPrefs, shownView, sortedItems, swimlanes, viewColumns, withOption, writeViewPrefs } from '@/tasks/board-view'

const select = (id: string, name: string, options: [string, string, string][]): GithubProjectField => ({ id, name, dataType: 'SINGLE_SELECT', options: options.map(([optionId, optionName, color]) => ({ id: optionId, name: optionName, color, description: `${optionName} items` })), iterations: [] })
const status = select('F_status', 'Status', [['s_todo', 'Todo', 'GRAY'], ['s_doing', 'Doing', 'YELLOW'], ['s_done', 'Done', 'GREEN']])
const priority = select('F_priority', 'Priority', [['p0', 'P0', 'RED'], ['p1', 'P1', 'ORANGE'], ['p2', 'P2', 'BLUE']])
const area = select('F_area', 'Área', [['a_web', 'Web', 'PURPLE'], ['a_api', 'API', 'PINK']])
const estimate: GithubProjectField = { id: 'F_estimate', name: 'Estimate', dataType: 'NUMBER', options: [], iterations: [] }
const due: GithubProjectField = { id: 'F_due', name: 'Due', dataType: 'DATE', options: [], iterations: [] }
const ref = (field: GithubProjectField) => ({ id: field.id, name: field.name })
const view = (patch: Partial<GithubProjectView>): GithubProjectView => ({ id: 'V1', number: 1, name: 'Board', layout: 'BOARD_LAYOUT', filter: '', groupByFields: [], verticalGroupByFields: [], sortByFields: [], visibleFields: [], ...patch })
const project: Pick<GithubProject, 'fields' | 'views'> = {
  fields: [status, priority, area, estimate, due],
  views: [view({ id: 'V3', number: 3, name: 'Table', layout: 'TABLE_LAYOUT' }), view({ id: 'V1', number: 1 }), view({ id: 'V2', number: 2, name: 'By area' })],
}
type Values = NonNullable<GithubProjectItem['fieldValues']>
const item = (id: string, fieldValues: Values = [], patch: Partial<GithubProjectItem> = {}): GithubProjectItem => ({ id, type: 'ISSUE', number: 1, title: id, url: null, state: 'OPEN', repository: 'o/r', status: null, assignees: [], labels: [], updatedAt: '2026-10-17T00:00:00.000Z', fieldValues, ...patch })
const opt = (field: GithubProjectField, optionId: string): Values[number] => ({ kind: 'singleSelect', field: field.name, value: { optionId, name: field.options.find((option) => option.id === optionId)?.name ?? null } })
const num = (value: number): Values[number] => ({ kind: 'number', field: 'Estimate', value })
const ids = (items: GithubProjectItem[]) => items.map((entry) => entry.id)

describe('views', () => {
  test('tabs follow GitHub’s view order', () => {
    expect(projectViews(project).map((entry) => entry.id)).toEqual(['V1', 'V2', 'V3'])
  })
  test('the remembered view shows while it exists, else the first', () => {
    const views = projectViews(project)
    expect(shownView(views, 'V2')?.id).toBe('V2')
    expect(shownView(views, 'gone')?.id).toBe('V1')
    expect(shownView(views, undefined)?.id).toBe('V1')
    expect(shownView([], 'V1')).toBeNull()
  })
  test('the last view per project round-trips through storage and survives a broken one', () => {
    const data = new Map<string, string>()
    const storage = () => ({ getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) }) as unknown as Storage
    writeViewPrefs(storage, { 'o/1': 'V2' })
    expect(readViewPrefs(storage)).toEqual({ 'o/1': 'V2' })
    data.set('tasks.board.views', '{not json')
    expect(readViewPrefs(storage)).toEqual({})
    const throwing = () => {
      throw new Error('denied')
    }
    expect(readViewPrefs(throwing)).toEqual({})
    expect(() => writeViewPrefs(throwing, {})).not.toThrow()
  })
})

describe('grouping', () => {
  test('columns group by the view’s single-select field, else Status', () => {
    expect(groupField(project, view({ groupByFields: [ref(priority)] }))?.name).toBe('Priority')
    expect(groupField(project, view({}))?.name).toBe('Status')
    expect(groupField(project, view({ groupByFields: [ref(estimate)] }))?.name).toBe('Status')
    expect(groupField(project, null)?.name).toBe('Status')
    expect(groupField({ fields: [estimate] }, null)).toBeNull()
  })
  test('columns: No <field> first, then options with colour and description; counts are the items', () => {
    const items = [item('a', [opt(priority, 'p1')]), item('b'), item('c', [opt(priority, 'p0')]), item('d', [opt(priority, 'p1')])]
    const columns = viewColumns(priority, items)
    expect(columns.map((column) => [column.id, column.name, column.color, column.description, ids(column.items)])).toEqual([
      [null, 'No Priority', statusColors.GRAY, '', ['b']],
      ['p0', 'P0', statusColors.RED, 'P0 items', ['c']],
      ['p1', 'P1', statusColors.ORANGE, 'P1 items', ['a', 'd']],
      ['p2', 'P2', statusColors.BLUE, 'P2 items', []],
    ])
  })
  test('Status reads the item’s status when it carries no field value; an unknown option has none', () => {
    expect(optionOf(item('a', [], { status: 's_doing' }), status)).toBe('s_doing')
    expect(optionOf(item('a', [opt(status, 'gone')]), status)).toBeNull()
    expect(optionOf(item('a', [{ kind: 'singleSelect', field: 'Priority', value: { optionId: null, name: 'P2' } }]), priority)).toBe('p2')
  })
  test('swimlanes: one per option in order, empty ones kept, No <field> last', () => {
    expect(laneField(project, view({ verticalGroupByFields: [ref(area)] }))?.name).toBe('Área')
    expect(laneField(project, view({}))).toBeNull()
    const lanes = swimlanes(area, [item('a', [opt(area, 'a_api')]), item('b'), item('c', [opt(area, 'a_api')])])
    expect(lanes.map((lane) => [lane.id, lane.name, ids(lane.items)])).toEqual([
      ['a_web', 'Web', []],
      ['a_api', 'API', ['a', 'c']],
      [null, 'No Área', ['b']],
    ])
  })
  test('swimlanes by a non-select field: one per value in first-seen order', () => {
    const lanes = swimlanes(estimate, [item('a', [num(3)]), item('b', [num(1)]), item('c', [num(3)]), item('d')])
    expect(lanes.map((lane) => [lane.name, ids(lane.items)])).toEqual([
      ['3', ['a', 'c']],
      ['1', ['b']],
      ['No Estimate', ['d']],
    ])
  })
})

describe('sorting', () => {
  test('by the view’s sort fields, options by their order, empty values last in either direction, stable otherwise', () => {
    const items = [item('a', [opt(priority, 'p2')]), item('b'), item('c', [opt(priority, 'p0')]), item('d', [opt(priority, 'p2')])]
    expect(ids(sortedItems(items, project, view({ sortByFields: [{ direction: 'ASC', field: ref(priority) }] })))).toEqual(['c', 'a', 'd', 'b'])
    expect(ids(sortedItems(items, project, view({ sortByFields: [{ direction: 'DESC', field: ref(priority) }] })))).toEqual(['a', 'd', 'c', 'b'])
    expect(ids(sortedItems(items, project, view({})))).toEqual(['a', 'b', 'c', 'd'])
  })
  test('numbers sort as numbers', () => {
    const items = [item('a', [num(10)]), item('b', [num(2)])]
    expect(ids(sortedItems(items, project, view({ sortByFields: [{ direction: 'ASC', field: ref(estimate) }] })))).toEqual(['b', 'a'])
  })
})

describe('cardChips', () => {
  const full = item('a', [opt(priority, 'p0'), opt(status, 's_doing'), num(5), { kind: 'date', field: 'Due', value: '2026-11-03' }], {
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: [{ login: 'ana', avatarUrl: '' }],
  })
  test('one per visible field in order, the group field skipped, assignees last', () => {
    const shown = view({ visibleFields: [{ id: 'T', name: 'Title' }, { id: 'A', name: 'Assignees' }, ref(status), { id: 'L', name: 'Labels' }, ref(priority), ref(estimate), ref(due)] })
    expect(cardChips(full, project, shown, ['Status'])).toEqual([
      { kind: 'label', name: 'bug', color: 'd73a4a' },
      { kind: 'option', field: 'Priority', name: 'P0', color: statusColors.RED },
      { kind: 'value', field: 'Estimate', text: '5' },
      { kind: 'value', field: 'Due', text: 'Nov 3' },
      { kind: 'assignees', logins: ['ana'] },
    ])
  })
  test('a field without a value adds nothing; a view with no visible fields shows labels and assignees', () => {
    expect(cardChips(item('b'), project, view({ visibleFields: [ref(priority), ref(estimate)] }))).toEqual([])
    expect(cardChips(full, project, view({})).map((chip) => chip.kind)).toEqual(['label', 'assignees'])
  })
})

describe('edits', () => {
  test('an option set shows at once; Status also moves the item’s status', () => {
    const moved = withOption(item('a', [opt(priority, 'p2')]), priority, 'p0')
    expect(optionOf(moved, priority)).toBe('p0')
    expect(moved.fieldValues?.filter((entry) => entry.field === 'Priority')).toHaveLength(1)
    expect(withOption(item('a'), status, 's_done').status).toBe('s_done')
    expect(withOption(item('a'), priority, 'p0').status).toBeNull()
  })
  test('pending edits apply in order over the read items', () => {
    const shown = editedItems([item('a'), item('b')], [{ id: 1, itemId: 'a', field: priority, optionId: 'p1' }, { id: 2, itemId: 'a', field: priority, optionId: 'p2' }])
    expect(shown.map((entry) => optionOf(entry, priority))).toEqual(['p2', null])
  })
  test('editable types follow GitHub’s data types', () => {
    expect(['SINGLE_SELECT', 'NUMBER', 'DATE', 'TEXT', 'ITERATION', 'TITLE', 'ASSIGNEES'].map((dataType) => editableType({ dataType }))).toEqual(['single-select', 'number', 'date', 'text', 'iteration', null, null])
  })
})

describe('parseAddition', () => {
  test('a URL or owner/repo#number adds that item; any other text is a draft title; blank adds nothing', () => {
    expect(parseAddition(' https://github.com/o/r/issues/12 ')).toEqual({ kind: 'reference', reference: 'https://github.com/o/r/issues/12' })
    expect(parseAddition('https://github.com/o/r/pull/7')).toEqual({ kind: 'reference', reference: 'https://github.com/o/r/pull/7' })
    expect(parseAddition('cantospace/canto#41')).toEqual({ kind: 'reference', reference: 'cantospace/canto#41' })
    expect(parseAddition('Fix #41 later')).toEqual({ kind: 'draft', title: 'Fix #41 later' })
    expect(parseAddition('   ')).toBeNull()
  })
})
