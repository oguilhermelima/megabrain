import { describe, expect, test } from 'bun:test'
import { emptySidebarState, foldKeys, legacySidebarState, parseSidebarState, pruneSidebarState, serialiseSidebarState, stackFoldKey, worktreeFoldKey } from '@/advanced/sidebar-state'

const state = { collapsed: ['/repo/a', 'stack:/repo/a-wt'], rows: { '/repo/a': ['chat:1', 'group:g1'], '/repo/a-wt': ['terminal:t1'] } }

describe('parseSidebarState', () => {
  test('reads what serialiseSidebarState writes', () => {
    expect(parseSidebarState(JSON.parse(serialiseSidebarState(state)))).toEqual(state)
  })

  test('writes the shape the CLI checks', () => {
    expect(JSON.parse(serialiseSidebarState(state))).toEqual({ version: 1, ...state })
  })

  test('anything unusable reads as nothing saved', () => {
    for (const raw of [null, 'text', [], { version: 2, collapsed: ['/a'], rows: {} }, { version: 1, collapsed: 'x', rows: [] }]) {
      expect(parseSidebarState(raw)).toEqual(emptySidebarState)
    }
  })

  test('keeps the usable parts of a damaged value', () => {
    expect(parseSidebarState({ version: 1, collapsed: ['/a', 3], rows: { '/a': ['chat:1', null], '/b': 'chat:2' } })).toEqual({ collapsed: ['/a'], rows: { '/a': ['chat:1'] } })
  })
})

describe('legacySidebarState', () => {
  test('seeds from the keys this viewer kept before the CLI held them', () => {
    expect(legacySidebarState(JSON.stringify(['/repo/a']), JSON.stringify({ version: 1, worktrees: { '/repo/a': ['chat:1'] } }))).toEqual({ collapsed: ['/repo/a'], rows: { '/repo/a': ['chat:1'] } })
  })

  test('nothing kept, or nothing readable, seeds nothing', () => {
    expect(legacySidebarState(null, null)).toEqual(emptySidebarState)
    expect(legacySidebarState('{broken', 'nope')).toEqual(emptySidebarState)
  })
})

describe('pruneSidebarState', () => {
  test('drops collapse keys and worktree orders of what no longer exists', () => {
    const live = { collapsible: new Set(['/repo/a']), worktrees: new Set(['/repo/a']) }
    expect(pruneSidebarState(state, live)).toEqual({ collapsed: ['/repo/a'], rows: { '/repo/a': ['chat:1', 'group:g1'] } })
  })

  test('keeps everything that still exists, in its order', () => {
    const live = { collapsible: new Set(['stack:/repo/a-wt', '/repo/a', '/repo/b']), worktrees: new Set(['/repo/a-wt', '/repo/a']) }
    expect(pruneSidebarState(state, live)).toEqual(state)
  })

  test('an empty worktree order is not kept', () => {
    expect(pruneSidebarState({ collapsed: [], rows: { '/repo/a': [] } }, { collapsible: new Set(), worktrees: new Set(['/repo/a']) })).toEqual(emptySidebarState)
  })
})

describe('worktree folds', () => {
  const projects = [{ path: '/repo/a', worktrees: [{ path: '/repo/a' }, { path: '/repo/a-wt' }] }]

  test('a folded worktree is saved and read back by its key', () => {
    const folded = { collapsed: ['/repo/a', worktreeFoldKey('/repo/a-wt')], rows: {} }
    expect(JSON.parse(serialiseSidebarState(folded)).collapsed).toEqual(['/repo/a', 'worktree:/repo/a-wt'])
    expect(parseSidebarState(JSON.parse(serialiseSidebarState(folded)))).toEqual(folded)
  })

  test('state saved before worktrees folded reads with every worktree open', () => {
    const read = parseSidebarState({ version: 1, collapsed: ['/repo/a', 'stack:/repo/a'], rows: {} })
    expect(read.collapsed.includes(worktreeFoldKey('/repo/a'))).toBe(false)
    expect(read.collapsed.includes(worktreeFoldKey('/repo/a-wt'))).toBe(false)
  })

  test('every project, stack and worktree of the list can fold', () => {
    expect(foldKeys(projects)).toEqual(new Set(['/repo/a', stackFoldKey('/repo/a'), worktreeFoldKey('/repo/a'), stackFoldKey('/repo/a-wt'), worktreeFoldKey('/repo/a-wt')]))
  })

  test('a fold of a worktree that is gone is dropped, a live one kept', () => {
    const saved = { collapsed: [worktreeFoldKey('/repo/a-wt'), worktreeFoldKey('/repo/gone')], rows: {} }
    expect(pruneSidebarState(saved, { collapsible: foldKeys(projects), worktrees: new Set() })).toEqual({ collapsed: [worktreeFoldKey('/repo/a-wt')], rows: {} })
  })
})
