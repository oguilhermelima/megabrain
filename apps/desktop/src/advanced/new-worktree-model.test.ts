import { describe, expect, test } from 'bun:test'
import type { Project, ProjectWorktree } from '@/api/schema'
import {
  arrivedCreations,
  baseSuggestions,
  branchNameError,
  createWorktreeArgs,
  creationFailed,
  creationSucceeded,
  creationsIn,
  dismissCreation,
  retryCreation,
  startCreation,
  type PendingWorktree,
} from '@/advanced/new-worktree-model'

const worktree = (path: string, branch: string | null, primary = false): ProjectWorktree => ({ path, branch, head: null, primary, parent: null, pullRequest: null, sessions: [] })

const project = (path: string, worktrees: ProjectWorktree[]): Project => ({ name: path.split('/').at(-1) ?? path, path, remote: null, source: 'megabrain', missing: false, worktrees })

const canto = project('/work/canto', [worktree('/work/canto', 'main', true), worktree('/work/wt/feat-a', 'feat/a'), worktree('/work/wt/detached', null), worktree('/work/wt/feat-b', 'feat/b')])

describe('branchNameError', () => {
  test('a plain branch name is fine', () => {
    expect(branchNameError('feat/desktop-loading', ['main'])).toBeNull()
  })

  test('an empty name asks for one', () => {
    expect(branchNameError('   ', [])).toBe('Name the branch.')
  })

  test('spaces are refused', () => {
    expect(branchNameError('feat/my branch', [])).toBe('A branch name has no spaces.')
    expect(branchNameError('feat/tab\there', [])).toBe('A branch name has no spaces.')
  })

  test('an existing branch is refused', () => {
    expect(branchNameError('feat/a', ['main', 'feat/a'])).toBe('A branch named feat/a already exists.')
  })

  test('names git refuses are refused', () => {
    for (const name of ['-feat', 'feat..x', 'feat~1', 'feat^', 'feat:x', 'feat?', 'feat*', 'feat[x', 'feat\\x', 'feat/', '/feat', 'feat.lock', 'feat.', 'feat//x', 'feat/.hidden', 'feat@{x', '@']) {
      expect(branchNameError(name, [])).toBe(`${name} is not a valid branch name.`)
    }
  })
})

describe('baseSuggestions', () => {
  test('the branches the worktrees have checked out, the primary first and the default', () => {
    expect(baseSuggestions(canto)).toEqual({ initial: 'main', suggestions: ['main', 'feat/a', 'feat/b'] })
  })

  test('a primary checkout on a detached HEAD leaves the field empty', () => {
    expect(baseSuggestions(project('/work/x', [worktree('/work/x', null, true), worktree('/work/wt/y', 'y')]))).toEqual({ initial: '', suggestions: ['y'] })
  })

  test('a branch checked out twice is suggested once', () => {
    expect(baseSuggestions(project('/work/x', [worktree('/work/x', 'main', true), worktree('/work/wt/y', 'main')])).suggestions).toEqual(['main'])
  })
})

describe('createWorktreeArgs', () => {
  test('the CLI call the adapter makes', () => {
    expect(createWorktreeArgs('/work/canto', 'feat/x', 'main')).toEqual(['worktree', 'create', '--repo', '/work/canto', '--branch', 'feat/x', '--from', 'main', '--json'])
  })
})

const start = (list: PendingWorktree[], id: string, branch = 'feat/x', repo = '/work/canto') => {
  const next = startCreation(list, { id, repo, branch, base: 'main' })
  if (next === null) throw new Error('start refused')
  return next
}

describe('pending worktree creation', () => {
  test('starts as creating, with no path yet', () => {
    expect(start([], 'c1')).toEqual([{ id: 'c1', repo: '/work/canto', branch: 'feat/x', base: 'main', status: 'creating', path: null, error: null }])
  })

  test('one pending per branch: creating the same branch again while it runs is refused', () => {
    expect(startCreation(start([], 'c1'), { id: 'c2', repo: '/work/canto', branch: 'feat/x', base: 'main' })).toBeNull()
  })

  test('the same branch name in another project is its own trigger', () => {
    expect(start(start([], 'c1'), 'c2', 'feat/x', '/work/other').map((item) => item.id)).toEqual(['c1', 'c2'])
  })

  test('success records the path; failure the error; retry runs it again', () => {
    const list = start([], 'c1')
    expect(creationSucceeded(list, 'c1', '/work/wt/feat-x')[0]).toMatchObject({ status: 'created', path: '/work/wt/feat-x', error: null })
    const failed = creationFailed(list, 'c1', new Error('branch feat/x already exists'))
    expect(failed[0]).toMatchObject({ status: 'failed', error: 'branch feat/x already exists' })
    expect(retryCreation(failed, 'c1')[0]).toMatchObject({ status: 'creating', error: null })
  })

  test('a failed creation does not block a new one for the same branch', () => {
    const failed = creationFailed(start([], 'c1'), 'c1', new Error('x'))
    expect(startCreation(failed, { id: 'c2', repo: '/work/canto', branch: 'feat/x', base: 'main' })?.map((item) => item.id)).toEqual(['c2'])
  })

  test('dismiss takes a failed one away', () => {
    expect(dismissCreation(creationFailed(start([], 'c1'), 'c1', new Error('x')), 'c1')).toEqual([])
  })

  test('creationsIn lists one project only', () => {
    const list = start(start([], 'c1'), 'c2', 'feat/y', '/work/other')
    expect(creationsIn(list, '/work/canto').map((item) => item.id)).toEqual(['c1'])
  })

  test('a created worktree has arrived once the projects list shows its path', () => {
    const list = creationSucceeded(start(start([], 'c1'), 'c2', 'feat/y'), 'c1', '/work/wt/feat-x')
    const listed = project('/work/canto', [...canto.worktrees, worktree('/work/wt/feat-x', 'feat/x')])
    const { arrived, rest } = arrivedCreations(list, [listed])
    expect(arrived.map((item) => item.id)).toEqual(['c1'])
    expect(rest.map((item) => item.id)).toEqual(['c2'])
  })

  test('a created worktree not listed yet stays pending', () => {
    const list = creationSucceeded(start([], 'c1'), 'c1', '/work/wt/feat-x')
    expect(arrivedCreations(list, [canto]).arrived).toEqual([])
  })

  test('a creating one never arrives, even when a branch of that name is listed', () => {
    const list = start([], 'c1', 'feat/a')
    expect(arrivedCreations(list, [canto]).arrived).toEqual([])
  })
})
