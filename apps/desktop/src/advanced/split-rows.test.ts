import { describe, expect, test } from 'bun:test'
import { dropItem, singlePane } from '@/panes/pane-model'
import { changeShown, focusGroup, layoutOf, openLayoutItem, renameGroup, splitItems, type Layout } from '@/panes/split-groups'
import { groupRows, groupsByPlace, joinedTitle, strongestState, visibleMarks, type MemberInfo } from '@/advanced/split-rows'

const info: Record<string, MemberInfo> = {
  'native:1': { title: 'teste teste', mark: { kind: 'agent', agent: 'claude' }, state: 'idle', worktree: '/wt/main' },
  'native:2': { title: 'New chat', mark: { kind: 'agent', agent: 'codex' }, state: 'working', worktree: '/wt/main' },
  'terminal:3': { title: 'zsh', mark: { kind: 'terminal' }, state: 'idle', worktree: '/wt/other' },
  'launcher:4': { title: 'New chat', mark: { kind: 'launcher' }, state: 'idle', worktree: null },
}
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
  test('under the one worktree its members work in; members without one do not count', () => {
    const layout = splitItems(layoutOf(singlePane('native:1', 'p1'), 'g0'), ['native:1', 'launcher:4'], 'g2', ['q1', 'q2'])
    const rows = groupRows(layout, describeItem)
    expect(rows[0]?.worktree).toBe('/wt/main')
    const placed = groupsByPlace(rows)
    expect(placed.byWorktree.get('/wt/main')?.map((row) => row.id)).toEqual(['g2'])
    expect(placed.spanning).toEqual([])
  })

  test('under Splits when its members span worktrees, or none has one', () => {
    const spanning = splitItems(layoutOf(singlePane('native:1', 'p1'), 'g0'), ['native:1', 'terminal:3'], 'g3', ['q1', 'q2'])
    const rows = groupRows(spanning, describeItem)
    expect(rows[0]?.worktree).toBeNull()
    expect(groupsByPlace(rows).spanning.map((row) => row.id)).toEqual(['g3'])
    const nowhere = splitItems(layoutOf(singlePane('launcher:4', 'p1'), 'g0'), ['launcher:4', 'launcher:5'], 'g4', ['q1', 'q2'])
    expect(groupRows(nowhere, describeItem)[0]?.worktree).toBeNull()
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
