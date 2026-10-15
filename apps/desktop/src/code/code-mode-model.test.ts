import { describe, expect, test } from 'bun:test'
import type { Project } from '@/api/schema'
import { mockProjects } from '@/api/fixtures/mock'
import { closeCode, codeTargetFor, emptyCodeMode, enterCode, frameFadeMs, frameRevealDelay, isToggleChatsKey, leaveCode, railEntries, switchGroups, switchTargets } from '@/code/code-mode-model'

const canto = mockProjects.find((project) => project.name === 'canto') as Project
const megabrain = mockProjects.find((project) => project.name === 'megabrain') as Project
const seek = canto.worktrees.find((worktree) => worktree.branch === 'fix/player-seek')
if (seek === undefined) throw new Error('fixture: fix/player-seek missing')

const extension = canto.worktrees.find((worktree) => worktree.branch === 'feat/extension')
if (extension === undefined) throw new Error('fixture: feat/extension missing')

const cantoTarget = { root: canto.path, title: 'canto' }
const megabrainTarget = { root: megabrain.path, title: 'megabrain' }

describe('server lifetime', () => {
  test('entering a root starts its server and shows it', () => {
    const { state, start } = enterCode(emptyCodeMode, cantoTarget)
    expect(start).toBe(true)
    expect(state.active).toBe(canto.path)
    expect(state.open.map((target) => target.root)).toEqual([canto.path])
  })

  test('switching to another root keeps the first one open', () => {
    const first = enterCode(emptyCodeMode, cantoTarget).state
    const { state, start } = enterCode(first, megabrainTarget)
    expect(start).toBe(true)
    expect(state.active).toBe(megabrain.path)
    expect(state.open.map((target) => target.root)).toEqual([canto.path, megabrain.path])
  })

  test('going back to chats hides code mode and stops nothing', () => {
    const state = leaveCode(enterCode(emptyCodeMode, cantoTarget).state)
    expect(state.active).toBeNull()
    expect(state.open.map((target) => target.root)).toEqual([canto.path])
  })

  test('reopening a root that is still open reuses its server', () => {
    const left = leaveCode(enterCode(emptyCodeMode, cantoTarget).state)
    const { state, start } = enterCode(left, cantoTarget)
    expect(start).toBe(false)
    expect(state.active).toBe(canto.path)
    expect(state.open).toHaveLength(1)
  })

  test('closing a root explicitly stops its server and forgets it', () => {
    const both = enterCode(enterCode(emptyCodeMode, cantoTarget).state, megabrainTarget).state
    const { state, stop } = closeCode(both, canto.path)
    expect(stop).toBe(canto.path)
    expect(state.open.map((target) => target.root)).toEqual([megabrain.path])
    expect(state.active).toBe(megabrain.path)
  })

  test('closing the root on screen shows another open one', () => {
    const both = enterCode(enterCode(emptyCodeMode, cantoTarget).state, megabrainTarget).state
    const { state } = closeCode(both, megabrain.path)
    expect(state.active).toBe(canto.path)
  })

  test('closing the last root goes back to chats', () => {
    const { state, stop } = closeCode(enterCode(emptyCodeMode, cantoTarget).state, canto.path)
    expect(stop).toBe(canto.path)
    expect(state).toEqual(emptyCodeMode)
  })

  test('closing a root from chats stays in chats', () => {
    const left = leaveCode(enterCode(enterCode(emptyCodeMode, cantoTarget).state, megabrainTarget).state)
    expect(closeCode(left, canto.path).state.active).toBeNull()
  })

  test('closing a root that is not open stops nothing', () => {
    const open = enterCode(emptyCodeMode, cantoTarget).state
    const { state, stop } = closeCode(open, megabrain.path)
    expect(stop).toBeNull()
    expect(state).toEqual(open)
  })

  test('a root closed and opened again starts a new server', () => {
    const closed = closeCode(enterCode(emptyCodeMode, cantoTarget).state, canto.path).state
    expect(enterCode(closed, cantoTarget).start).toBe(true)
  })
})

describe('codeTargetFor', () => {
  test('a project opens its own folder under its name', () => {
    expect(codeTargetFor(canto)).toEqual({ root: canto.path, title: 'canto' })
  })

  test('the primary worktree is the project', () => {
    const primary = canto.worktrees.find((worktree) => worktree.primary)
    expect(primary).toBeDefined()
    if (primary !== undefined) expect(codeTargetFor(canto, primary)).toEqual({ root: canto.path, title: 'canto' })
  })

  test('a worktree is named by its project and branch', () => {
    expect(codeTargetFor(canto, seek)).toEqual({ root: seek.path, title: 'canto · fix/player-seek' })
  })
})

describe('railEntries', () => {
  test('lists open roots most recently opened first, the shown one marked', () => {
    const state = enterCode(enterCode(emptyCodeMode, codeTargetFor(canto, seek)).state, megabrainTarget).state
    const entries = railEntries(state, mockProjects)
    expect(entries.map((entry) => [entry.root, entry.active])).toEqual([
      [megabrain.path, true],
      [seek.path, false],
    ])
  })

  test('showing a root that is already open does not move it', () => {
    const both = enterCode(enterCode(emptyCodeMode, cantoTarget).state, megabrainTarget).state
    const state = enterCode(both, cantoTarget).state
    expect(railEntries(state, mockProjects).map((entry) => entry.root)).toEqual([megabrain.path, canto.path])
  })

  test('each entry carries the project whose picture it shows, worktrees included', () => {
    const state = enterCode(enterCode(emptyCodeMode, codeTargetFor(canto, seek)).state, megabrainTarget).state
    expect(railEntries(state, mockProjects).map((entry) => entry.project?.name ?? null)).toEqual(['megabrain', 'canto'])
  })

  test('the tooltip names the project, the branch and the folder', () => {
    const [entry] = railEntries(enterCode(emptyCodeMode, codeTargetFor(canto, seek)).state, mockProjects)
    expect(entry?.tooltip).toBe(`canto\nfix/player-seek\n${seek.path}`)
  })

  test('an entry names its repository, then the branch of its folder', () => {
    const [entry] = railEntries(enterCode(emptyCodeMode, cantoTarget).state, mockProjects)
    expect([entry?.name, entry?.branch]).toEqual(['canto', 'main'])
  })

  test('two worktrees of one repository differ by their branch', () => {
    const state = enterCode(enterCode(emptyCodeMode, cantoTarget).state, codeTargetFor(canto, seek)).state
    expect(railEntries(state, mockProjects).map((entry) => [entry.name, entry.branch])).toEqual([
      ['canto', 'fix/player-seek'],
      ['canto', 'main'],
    ])
  })

  test('two repositories on the same branch differ by their name', () => {
    const state = enterCode(enterCode(emptyCodeMode, cantoTarget).state, megabrainTarget).state
    expect(railEntries(state, mockProjects).map((entry) => [entry.name, entry.branch])).toEqual([
      ['megabrain', 'main'],
      ['canto', 'main'],
    ])
  })

  test('a root no project lists is named by its folder, with no branch line', () => {
    const [entry] = railEntries(enterCode(emptyCodeMode, { root: '/somewhere/gone-tree', title: 'gone-tree' }).state, mockProjects)
    expect([entry?.name, entry?.branch]).toEqual(['gone-tree', null])
    expect(entry?.tooltip).toBe('gone-tree\n/somewhere/gone-tree')
  })

  test('a picture shown once carries no badge', () => {
    const state = enterCode(enterCode(emptyCodeMode, codeTargetFor(canto, seek)).state, megabrainTarget).state
    expect(railEntries(state, mockProjects).map((entry) => entry.badge)).toEqual([null, null])
  })

  test('a repeated picture carries the first letters of each branch', () => {
    const state = enterCode(enterCode(enterCode(emptyCodeMode, cantoTarget).state, codeTargetFor(canto, seek)).state, codeTargetFor(canto, extension)).state
    expect(railEntries(state, mockProjects).map((entry) => entry.badge)).toEqual(['E', 'PS', 'M'])
  })

  test('a root no project lists any more keeps its entry without a picture', () => {
    const [entry] = railEntries(enterCode(emptyCodeMode, { root: '/gone', title: 'gone' }).state, mockProjects)
    expect(entry?.project).toBeNull()
    expect(entry?.title).toBe('gone')
  })

  test('nothing open means no entries', () => {
    expect(railEntries(emptyCodeMode, mockProjects)).toEqual([])
  })
})

describe('frameRevealDelay', () => {
  test('a root painting for the first time this session waits longest', () => {
    expect(frameRevealDelay(new Set(), canto.path)).toBe(700)
  })

  test('a root that painted before in this session waits briefly', () => {
    expect(frameRevealDelay(new Set([canto.path]), canto.path)).toBe(150)
  })

  test('another root having painted does not shorten the first open', () => {
    expect(frameRevealDelay(new Set([megabrain.path]), canto.path)).toBe(700)
  })

  test('the frame fades in over 150 ms', () => {
    expect(frameFadeMs).toBe(150)
  })
})

describe('switchTargets', () => {
  test('lists every visible project and its worktrees, primary once', () => {
    const roots = switchTargets([canto]).map((target) => target.root)
    expect(roots[0]).toBe(canto.path)
    expect(roots).toContain(seek.path)
    expect(roots.filter((root) => root === canto.path)).toHaveLength(1)
  })

  test('leaves out hidden worktrees and missing projects', () => {
    const roots = switchTargets(mockProjects).map((target) => target.root)
    const hidden = canto.worktrees.find((worktree) => worktree.hidden === true)
    expect(hidden).toBeDefined()
    if (hidden !== undefined) expect(roots).not.toContain(hidden.path)
  })

  test('leaves out a missing project', () => {
    const gone: Project = { ...canto, name: 'gone', path: '/gone', missing: true, worktrees: [] }
    expect(switchTargets([gone, megabrain]).map((target) => target.root)).not.toContain('/gone')
  })
})

describe('switchGroups', () => {
  test('groups targets by project, the project first, labelled by branch', () => {
    const groups = switchGroups([canto, megabrain], null, '')
    expect(groups.map((group) => group.project.name)).toEqual(['canto', 'megabrain'])
    expect(groups[0]?.items.map((item) => [item.target.root, item.label])).toEqual([
      [canto.path, 'main'],
      [seek.path, 'fix/player-seek'],
      [extension.path, 'feat/extension'],
    ])
  })

  test('checks the root on screen and nothing else', () => {
    const groups = switchGroups([canto, megabrain], seek.path, '')
    const current = groups.flatMap((group) => group.items).filter((item) => item.current)
    expect(current.map((item) => item.target.root)).toEqual([seek.path])
  })

  test('leaves out hidden and missing projects and hidden worktrees', () => {
    const roots = switchGroups(mockProjects, null, '').flatMap((group) => group.items.map((item) => item.target.root))
    expect(groups(mockProjects).map((group) => group.project.name)).toEqual(['stack', 'canto', 'megabrain'])
    expect(roots).not.toContain(`${canto.path}-detached`)
    expect(roots).toEqual(switchTargets(mockProjects).map((target) => target.root))
  })

  test('typing filters by project name, branch or folder, case aside', () => {
    expect(switchGroups([canto, megabrain], null, 'SEEK').flatMap((group) => group.items.map((item) => item.target.root))).toEqual([seek.path])
    expect(switchGroups([canto, megabrain], null, 'megabrain').map((group) => group.project.name)).toEqual(['megabrain'])
    expect(switchGroups([canto, megabrain], null, 'feat-extension').flatMap((group) => group.items.map((item) => item.target.root))).toEqual([extension.path])
  })

  test('every word typed must match', () => {
    expect(switchGroups([canto, megabrain], null, 'canto main').flatMap((group) => group.items.map((item) => item.target.root))).toEqual([canto.path])
  })

  test('a search matching nothing leaves no group', () => {
    expect(switchGroups([canto, megabrain], null, 'zzz')).toEqual([])
  })
})

function groups(projects: Project[]) {
  return switchGroups(projects, null, '')
}

describe('isToggleChatsKey', () => {
  test('Cmd+Shift+E toggles', () => {
    expect(isToggleChatsKey({ metaKey: true, shiftKey: true, key: 'E' })).toBe(true)
    expect(isToggleChatsKey({ metaKey: true, shiftKey: true, key: 'e' })).toBe(true)
  })

  test('Escape and plain Cmd+E do not', () => {
    expect(isToggleChatsKey({ metaKey: false, shiftKey: false, key: 'Escape' })).toBe(false)
    expect(isToggleChatsKey({ metaKey: true, shiftKey: false, key: 'e' })).toBe(false)
  })
})
