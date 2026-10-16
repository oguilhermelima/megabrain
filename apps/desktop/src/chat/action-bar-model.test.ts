import { describe, expect, test } from 'bun:test'
import type { Project } from '@/api/schema'
import { changedFileCount, chooseView, headerMode, initialView, paneViewKey, segmentExpanded, segments, shownView, viewForKey, worktreeFacts, type WorktreeFacts } from '@/chat/action-bar-model'

const project: Project = {
  name: 'canto',
  path: '/repo/canto',
  remote: null,
  source: 'megabrain',
  missing: false,
  worktrees: [
    { path: '/repo/canto', branch: 'main', head: null, primary: true, parent: null, pullRequest: null, sessions: [] },
    { path: '/wt/seek', branch: 'feat/seek', head: null, primary: false, parent: 'main', pullRequest: { number: 42, state: 'OPEN', url: 'https://example.com/42' }, sessions: [] },
  ],
}

const facts = (pullRequest: number | null): WorktreeFacts => ({ root: '/wt/seek', repo: '/repo/canto', branch: 'feat/seek', parent: 'main', pullRequest })
const byView = (list: ReturnType<typeof segments>) => Object.fromEntries(list.map((segment) => [segment.view, segment]))

describe('worktree facts', () => {
  test('come from the worktree at the root, with its project as the repository', () => {
    expect(worktreeFacts([project], '/wt/seek')).toEqual({ root: '/wt/seek', repo: '/repo/canto', branch: 'feat/seek', parent: 'main', pullRequest: 42 })
  })
  test('a root no project lists has no branch and no pull request', () => {
    expect(worktreeFacts([project], '/elsewhere')).toEqual({ root: '/elsewhere', repo: '/elsewhere', branch: null, parent: null, pullRequest: null })
  })
})

describe('changed file count', () => {
  test('counts a file changed both uncommitted and on the branch once', () => {
    const uncommitted = [{ path: 'a.ts', status: 'modified' as const }, { path: 'new.ts', status: 'untracked' as const }]
    const branch = { base: 'main', mergeBase: 'f'.repeat(40), changes: [{ path: 'a.ts', status: 'modified' as const }, { path: 'b.ts', status: 'added' as const }] }
    expect(changedFileCount(uncommitted, branch)).toBe(3)
  })
  test('without a branch base only the uncommitted files count', () => {
    expect(changedFileCount([{ path: 'a.ts', status: 'modified' }], null)).toBe(1)
    expect(changedFileCount([], { base: null, mergeBase: null, changes: [] })).toBe(0)
  })
})

describe('segments', () => {
  test('PR carries the number and Diff the count when there is something to show', () => {
    const list = byView(segments({ facts: facts(42), changed: 3, codeAvailable: true }))
    expect(list.pr).toMatchObject({ enabled: true, badge: '#42' })
    expect(list.diff).toMatchObject({ enabled: true, badge: '3', title: '3 changed files (⌘4)' })
    expect(list.code?.enabled).toBe(true)
    expect(list.agent?.enabled).toBe(true)
  })
  test('PR and Diff are disabled with the reason when there is nothing', () => {
    const list = byView(segments({ facts: facts(null), changed: 0, codeAvailable: false }))
    expect(list.pr).toMatchObject({ enabled: false, badge: null, title: 'No pull request for feat/seek' })
    expect(list.diff).toMatchObject({ enabled: false, badge: null, title: 'No changes' })
    expect(list.code?.enabled).toBe(false)
  })
  test('Diff stays disabled until the changes are read', () => {
    expect(byView(segments({ facts: facts(null), changed: null, codeAvailable: true })).diff?.enabled).toBe(false)
  })
  test('they are always Agent, Code, PR, Diff in that order', () => {
    expect(segments({ facts: facts(1), changed: 1, codeAvailable: true }).map((segment) => segment.label)).toEqual(['Agent', 'Code', 'PR', 'Diff'])
  })
})

describe('shown view', () => {
  const live = segments({ facts: facts(42), changed: 2, codeAvailable: true })
  const empty = segments({ facts: facts(null), changed: 0, codeAvailable: true })
  test('an enabled PR or Diff shows', () => {
    expect(shownView('pr', live)).toBe('pr')
    expect(shownView('diff', live)).toBe('diff')
  })
  test('a PR or Diff with nothing left falls back to Agent', () => {
    expect(shownView('pr', empty)).toBe('agent')
    expect(shownView('diff', empty)).toBe('agent')
  })
  test('Code shows in the pane like the other views', () => {
    expect(shownView('code', live)).toBe('code')
  })
  test('Code where it cannot open falls back to Agent', () => {
    expect(shownView('code', segments({ facts: facts(42), changed: 2, codeAvailable: false }))).toBe('agent')
  })
})

describe('views per item', () => {
  test('a chat, a session or a terminal opens on Agent', () => {
    expect(initialView('native')).toBe('agent')
    expect(initialView('session')).toBe('agent')
    expect(initialView('terminal')).toBe('agent')
  })
  test('a code item opens on Code', () => {
    expect(initialView('code')).toBe('code')
  })
  test('choosing a view on a chat switches its pane to that view', () => {
    expect(chooseView('native', 'code')).toEqual({ kind: 'view', view: 'code' })
    expect(chooseView('session', 'agent')).toEqual({ kind: 'view', view: 'agent' })
  })
  test('Agent on a code item opens the launcher for its worktree in that pane', () => {
    expect(chooseView('code', 'agent')).toEqual({ kind: 'launcher' })
  })
  test('PR and Diff on a code item stay in the pane', () => {
    expect(chooseView('code', 'pr')).toEqual({ kind: 'view', view: 'pr' })
    expect(chooseView('code', 'diff')).toEqual({ kind: 'view', view: 'diff' })
  })
})

describe('view keys', () => {
  const key = (value: string, extra: Partial<{ metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }> = {}) => ({ key: value, metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, ...extra })
  test('⌘1 to ⌘4 pick Agent, Code, PR and Diff', () => {
    expect(['1', '2', '3', '4'].map((value) => viewForKey(key(value)))).toEqual(['agent', 'code', 'pr', 'diff'])
  })
  test('other digits, a missing ⌘ or an extra modifier are not the bar’s', () => {
    expect(viewForKey(key('5'))).toBeNull()
    expect(viewForKey(key('1', { metaKey: false }))).toBeNull()
    expect(viewForKey(key('1', { shiftKey: true }))).toBeNull()
    expect(viewForKey(key('1', { altKey: true }))).toBeNull()
    expect(viewForKey(key('1', { ctrlKey: true }))).toBeNull()
  })
  test('the focused pane takes ⌘1 to ⌘4 while the keyboard is outside Code, Code view included', () => {
    expect(['1', '2', '3', '4'].map((value) => paneViewKey(key(value), { focused: true, inEditor: false }))).toEqual(['agent', 'code', 'pr', 'diff'])
  })
  test('inside Code ⌘1 to ⌘4 stay with Code', () => {
    expect(['1', '2', '3', '4'].map((value) => paneViewKey(key(value), { focused: true, inEditor: true }))).toEqual([null, null, null, null])
  })
  test('a pane without focus never takes them', () => {
    expect(paneViewKey(key('2'), { focused: false, inEditor: false })).toBeNull()
  })
})

describe('header mode', () => {
  test('a pane under 640 px stacks the top bar into two rows; 640 and wider keep one', () => {
    expect(headerMode(420)).toBe('stacked')
    expect(headerMode(500)).toBe('stacked')
    expect(headerMode(639)).toBe('stacked')
    expect(headerMode(640)).toBe('row')
    expect(headerMode(900)).toBe('row')
  })

  test('before the bar is measured it keeps one row', () => {
    expect(headerMode(null)).toBe('row')
    expect(headerMode(0)).toBe('row')
  })
})

describe('segmentExpanded', () => {
  const idle = { shown: 'agent' as const, hovered: null, focused: null }

  test('only the shown view keeps its label at rest', () => {
    expect(segmentExpanded('agent', idle)).toBe(true)
    expect(segmentExpanded('code', idle)).toBe(false)
    expect(segmentExpanded('diff', idle)).toBe(false)
  })

  test('the pointer grows the segment under it, and only that one', () => {
    expect(segmentExpanded('pr', { ...idle, hovered: 'pr' })).toBe(true)
    expect(segmentExpanded('diff', { ...idle, hovered: 'pr' })).toBe(false)
    expect(segmentExpanded('agent', { ...idle, hovered: 'pr' })).toBe(true)
  })

  test('keyboard focus grows a segment too', () => {
    expect(segmentExpanded('code', { ...idle, focused: 'code' })).toBe(true)
    expect(segmentExpanded('code', { shown: 'diff', hovered: null, focused: 'code' })).toBe(true)
  })
})
