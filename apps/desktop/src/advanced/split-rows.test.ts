import { describe, expect, test } from 'bun:test'
import { dropItem, singlePane } from '@/panes/pane-model'
import { changeShown, focusGroup, layoutOf, openLayoutItem, renameGroup, splitItems, type Layout } from '@/panes/split-groups'
import { groupRows, groupsByPlace, joinedTitle, rowDropZone, strongestState, visibleMarks, type MemberInfo } from '@/advanced/split-rows'

const info: Record<string, MemberInfo> = {
  'native:1': { title: 'teste teste', mark: { kind: 'agent', agent: 'claude' }, state: 'idle', worktree: '/wt/main' },
  'native:2': { title: 'New chat', mark: { kind: 'agent', agent: 'codex' }, state: 'working', worktree: '/wt/main' },
  'terminal:3': { title: 'zsh', mark: { kind: 'terminal' }, state: 'idle', worktree: '/wt/other' },
  'launcher:4': { title: 'New chat', mark: { kind: 'launcher' }, state: 'idle', worktree: null },
  'native:5': { title: 'Triagem', mark: { kind: 'agent', agent: 'codex' }, state: 'working', worktree: '/wt/lane' },
  'native:6': { title: 'Elsewhere', mark: { kind: 'agent', agent: 'claude' }, state: 'idle', worktree: '/other/main' },
}
/** Two projects as the sidebar lists them: the main checkout and its worktrees. */
const projects = [
  { path: '/wt/main', worktrees: [{ path: '/wt/main' }, { path: '/wt/other' }, { path: '/wt/lane' }] },
  { path: '/other/main', worktrees: [{ path: '/other/main' }] },
]
const describeItem = (item: string): MemberInfo => info[item] ?? { title: item, mark: { kind: 'launcher' }, state: 'idle', worktree: null }

/** teste teste and New chat side by side. */
function pair(): Layout {
  return changeShown(layoutOf(singlePane('native:1', 'p1'), 'g0'), (panes) => dropItem(panes, 'native:2', 'p1', 'right', 'p2'), 'g1')
}

describe('one row per group', () => {
  test('a layout without groups has no group rows', () => {
    expect(groupRows(layoutOf(singlePane('native:1', 'p1'), 'g0'), describeItem)).toEqual([])
  })

  test('a split is one row whose members read left to right, top to bottom', () => {
    const rows = groupRows(pair(), describeItem)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.members.map((member) => member.item)).toEqual(['native:1', 'native:2'])
    expect(rows[0]?.members.map((member) => member.paneId)).toEqual(['p1', 'p2'])
  })

  test('the row title joins the members titles, or is the group name', () => {
    expect(groupRows(pair(), describeItem)[0]?.title).toBe('teste teste + New chat')
    expect(groupRows(renameGroup(pair(), 'g1', 'pairing'), describeItem)[0]?.title).toBe('pairing')
    expect(joinedTitle(null, ['a', 'b', 'c'])).toBe('a + b + c')
    expect(joinedTitle('  ', ['a', 'b'])).toBe('a + b')
  })

  test('the row shows the strongest state of its members', () => {
    expect(groupRows(pair(), describeItem)[0]?.state).toBe('working')
    expect(strongestState(['idle', 'ended'])).toBe('idle')
    expect(strongestState(['working', 'waiting', 'idle'])).toBe('waiting')
    expect(strongestState(['ended'])).toBe('ended')
  })

  test('the row says whether its group is shown, and which member is focused', () => {
    const shown = groupRows(pair(), describeItem)[0]
    expect(shown?.active).toBe(true)
    expect(shown?.members.find((member) => member.focused)?.item).toBe('native:2')
    const away = groupRows(openLayoutItem(pair(), 'native:9'), describeItem)[0]
    expect(away?.active).toBe(false)
    expect(groupRows(focusGroup(openLayoutItem(pair(), 'native:9'), 'g1'), describeItem)[0]?.active).toBe(true)
  })

  test('the glyph mirrors the arrangement in the unit square', () => {
    const glyph = groupRows(pair(), describeItem)[0]?.glyph
    expect(glyph).toEqual([
      { item: 'native:1', rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      { item: 'native:2', rect: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    ])
  })

  test('every member item is listed so the worktree can hide its own row', () => {
    const rows = groupRows(pair(), describeItem)
    expect(new Set(rows.flatMap((row) => row.members.map((member) => member.item)))).toEqual(new Set(['native:1', 'native:2']))
  })
})

describe('where a group row sits', () => {
  const placeOf = (items: string[]) => groupsByPlace(groupRows(splitItems(layoutOf(singlePane(items[0] ?? 'x', 'p1'), 'g0'), items, 'g9', items.map((_, index) => `q${index}`)), describeItem), projects)

  test('under the one worktree its members share', () => {
    const placed = placeOf(['native:1', 'native:2'])
    expect(placed.byWorktree.get('/wt/main')?.map((row) => row.id)).toEqual(['g9'])
    expect(placed.byProject.size).toBe(0)
    expect(placed.spanning).toEqual([])
  })

  test('under the project when its members work in two of its worktrees', () => {
    const placed = placeOf(['native:1', 'native:5'])
    expect(placed.byWorktree.size).toBe(0)
    expect(placed.byProject.get('/wt/main')?.map((row) => row.id)).toEqual(['g9'])
    expect(placed.spanning).toEqual([])
  })

  test('a member without a worktree yet does not count', () => {
    expect(placeOf(['native:1', 'launcher:4']).byWorktree.get('/wt/main')?.map((row) => row.id)).toEqual(['g9'])
    const project = placeOf(['native:1', 'launcher:4', 'terminal:3'])
    expect(project.byProject.get('/wt/main')?.map((row) => row.id)).toEqual(['g9'])
    expect(project.spanning).toEqual([])
  })

  test('under Splits when its members span two projects', () => {
    const placed = placeOf(['native:1', 'native:6'])
    expect(placed.byWorktree.size).toBe(0)
    expect(placed.byProject.size).toBe(0)
    expect(placed.spanning.map((row) => row.id)).toEqual(['g9'])
  })

  test('under Splits when no member has a place', () => {
    const placed = placeOf(['launcher:4', 'launcher:5'])
    expect(placed.byWorktree.size).toBe(0)
    expect(placed.byProject.size).toBe(0)
    expect(placed.spanning.map((row) => row.id)).toEqual(['g9'])
  })
})

describe('many members', () => {
  const many = (count: number) => {
    const names = Array.from({ length: count }, (_, index) => `native:m${index + 1}`)
    return groupRows(splitItems(layoutOf(singlePane('x', 'p0'), 'g0'), names, 'gm', names.map((name) => `p-${name}`)), describeItem)[0]
  }

  test('five members: the row lists all five in order and overflows its marks into +N', () => {
    const row = many(5)
    expect(row?.members).toHaveLength(5)
    expect(row?.members.map((member) => member.item)).toEqual(['native:m1', 'native:m2', 'native:m3', 'native:m4', 'native:m5'])
    const marks = visibleMarks(row?.members ?? [], 4)
    expect(marks.shown).toHaveLength(3)
    expect(marks.more).toBe(2)
  })

  test('eight members: every member listed, the glyph has eight cells, marks overflow', () => {
    const row = many(8)
    expect(row?.members).toHaveLength(8)
    expect(row?.glyph).toHaveLength(8)
    expect(row?.title).toBe('native:m1 + native:m2 + native:m3 + native:m4 + native:m5 + native:m6 + native:m7 + native:m8')
    const marks = visibleMarks(row?.members ?? [], 4)
    expect(marks.shown.map((member) => member.item)).toEqual(['native:m1', 'native:m2', 'native:m3'])
    expect(marks.more).toBe(5)
  })

  test('up to the limit every mark shows and nothing overflows', () => {
    const marks = visibleMarks(many(4)?.members ?? [], 4)
    expect(marks.shown).toHaveLength(4)
    expect(marks.more).toBe(0)
  })
})

describe('where a row dropped on another row lands', () => {
  const row = { top: 100, bottom: 132 }

  test('the top quarter goes before the row and the bottom quarter after it', () => {
    expect(rowDropZone(row, 100)).toBe('before')
    expect(rowDropZone(row, 107)).toBe('before')
    expect(rowDropZone(row, 126)).toBe('after')
    expect(rowDropZone(row, 132)).toBe('after')
  })

  test('the middle band joins the two into a split', () => {
    expect(rowDropZone(row, 108)).toBe('join')
    expect(rowDropZone(row, 116)).toBe('join')
    expect(rowDropZone(row, 124)).toBe('join')
  })

  test('above or below the row is still before or after it', () => {
    expect(rowDropZone(row, 90)).toBe('before')
    expect(rowDropZone(row, 140)).toBe('after')
  })

  test('a row that cannot be reordered against joins over all of it', () => {
    expect(rowDropZone(row, 101, { reorder: false })).toBe('join')
    expect(rowDropZone(row, 131, { reorder: false })).toBe('join')
  })

  test('a row that cannot be joined splits at its middle into before and after', () => {
    expect(rowDropZone(row, 115, { join: false })).toBe('before')
    expect(rowDropZone(row, 117, { join: false })).toBe('after')
  })
})

describe('the map in the hover', () => {
  test('a row carries its tree and the dividers between its cells, to edit the layout on the map', () => {
    const row = groupRows(pair(), describeItem)[0]
    expect(row?.panes.root.type).toBe('split')
    expect(row?.dividers.map((divider) => ({ direction: divider.direction, at: divider.at }))).toEqual([{ direction: 'row', at: 0.5 }])
  })

  test('the map cells name each member by its pane', () => {
    expect(groupRows(pair(), describeItem)[0]?.cells).toEqual([
      { paneId: 'p1', rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      { paneId: 'p2', rect: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    ])
  })
})
