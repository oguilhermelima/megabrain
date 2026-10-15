import { describe, expect, test } from 'bun:test'
import type { Worktree } from '@/api/schema'
import { buildStackModel, flattenStack } from '@/advanced/stack-model'

const repo = { name: 'megabrain', path: '/repo/megabrain' }
const otherRepo = { name: 'canto', path: '/repo/canto' }

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    path: `/wt/${overrides.branch ?? 'branch'}`,
    branch: 'feat/x',
    parent: null,
    pullRequest: null,
    repository: repo,
    ...overrides,
  }
}

describe('buildStackModel', () => {
  test('a chain of two worktrees becomes a stack rooted at the base branch', () => {
    const a = worktree({ branch: 'feat/a', parent: 'main' })
    const b = worktree({ branch: 'feat/b', parent: 'feat/a' })
    const { stacks, standalone } = buildStackModel([a, b])

    expect(standalone).toEqual([])
    expect(stacks).toHaveLength(1)
    const [stack] = stacks
    expect(stack?.repositoryName).toBe('megabrain')
    expect(stack?.root.branch).toBe('main')
    expect(stack?.root.isBase).toBe(true)
    expect(stack?.root.worktreePath).toBeNull()
    expect(stack?.root.children).toHaveLength(1)
    expect(stack?.root.children[0]?.branch).toBe('feat/a')
    expect(stack?.root.children[0]?.children[0]?.branch).toBe('feat/b')
  })

  test('a fork renders as a tree with two children under the same parent', () => {
    const base = worktree({ branch: 'feat/base', parent: null })
    const left = worktree({ branch: 'feat/left', parent: 'feat/base' })
    const right = worktree({ branch: 'feat/right', parent: 'feat/base' })
    const { stacks } = buildStackModel([base, left, right])

    expect(stacks).toHaveLength(1)
    const [stack] = stacks
    expect(stack?.root.branch).toBe('feat/base')
    expect(stack?.root.isBase).toBe(false)
    const childBranches = stack?.root.children.map((child) => child.branch)
    expect(childBranches).toEqual(['feat/left', 'feat/right'])
  })

  test('a single worktree with no parent and no children is not a stack', () => {
    const solo = worktree({ branch: 'fix/one', parent: null })
    const { stacks, standalone } = buildStackModel([solo])

    expect(stacks).toEqual([])
    expect(standalone).toEqual([solo])
  })

  test('a parent with no worktree of its own becomes a dim base row', () => {
    const child = worktree({ branch: 'feat/a', parent: 'main' })
    const { stacks } = buildStackModel([child])

    expect(stacks).toHaveLength(1)
    const [stack] = stacks
    expect(stack?.root.branch).toBe('main')
    expect(stack?.root.isBase).toBe(true)
    expect(stack?.root.worktreePath).toBeNull()
    expect(stack?.root.pullRequest).toBeNull()
  })

  test('worktrees of different repositories never mix into the same stack', () => {
    const a = worktree({ branch: 'feat/a', parent: 'main', repository: repo })
    const b = worktree({ branch: 'feat/a', parent: 'main', repository: otherRepo })
    const { stacks } = buildStackModel([a, b])

    expect(stacks).toHaveLength(2)
    expect(stacks.map((stack) => stack.repositoryName).sort()).toEqual(['canto', 'megabrain'])
  })

  test('pull request and path carry through onto their branch node', () => {
    const a = worktree({ branch: 'feat/a', parent: 'main', path: '/wt/feat-a', pullRequest: { number: 83, state: 'OPEN', url: 'https://example.com/83' } })
    const { stacks } = buildStackModel([a])

    const node = stacks[0]?.root.children[0]
    expect(node?.worktreePath).toBe('/wt/feat-a')
    expect(node?.pullRequest).toEqual({ number: 83, state: 'OPEN', url: 'https://example.com/83' })
  })
})

describe('flattenStack', () => {
  test('orders rows depth-first, base first then each child under its parent', () => {
    const a = worktree({ branch: 'feat/a', parent: 'main' })
    const b = worktree({ branch: 'feat/b', parent: 'feat/a' })
    const { stacks } = buildStackModel([a, b])
    const rows = flattenStack(stacks[0]!.root)

    expect(rows.map((row) => [row.branch, row.depth])).toEqual([
      ['main', 0],
      ['feat/a', 1],
      ['feat/b', 2],
    ])
  })

  test('sibling forks are ordered by branch name at the same depth', () => {
    const base = worktree({ branch: 'feat/base', parent: null })
    const left = worktree({ branch: 'feat/left', parent: 'feat/base' })
    const right = worktree({ branch: 'feat/right', parent: 'feat/base' })
    const { stacks } = buildStackModel([base, left, right])
    const rows = flattenStack(stacks[0]!.root)

    expect(rows.map((row) => [row.branch, row.depth])).toEqual([
      ['feat/base', 0],
      ['feat/left', 1],
      ['feat/right', 1],
    ])
  })
})
