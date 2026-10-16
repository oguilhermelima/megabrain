import { describe, expect, test } from 'bun:test'
import type { Project, ProjectWorktree } from '@/api/schema'
import { memberStatus, stackActions, stackChain, stackDetails, visibleTree, worktreeTree, type WorktreeNode } from '@/advanced/stacks'

function worktree(branch: string | null, parent: string | null, extra: Partial<ProjectWorktree> = {}): ProjectWorktree {
  return { path: `/wt/${branch ?? 'detached'}`, branch, head: 'abc1234', primary: false, parent, pullRequest: null, sessions: [], ...extra }
}

const primary = worktree('main', null, { path: '/repo', primary: true })

function project(worktrees: ProjectWorktree[], remote: string | null = 'https://github.com/owner/repo'): Project {
  return { name: 'repo', path: '/repo', remote, source: 'megabrain', missing: false, worktrees }
}

// Each node as "branch@depth position/total", depth first.
function shape(nodes: WorktreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [`${node.worktree.branch ?? 'detached'}@${depth}${node.place === null ? '' : ` ${node.place.position}/${node.place.total}`}`, ...shape(node.children, depth + 1)])
}

const find = (nodes: WorktreeNode[], branch: string): WorktreeNode | undefined => {
  for (const node of nodes) {
    if (node.worktree.branch === branch) return node
    const inside = find(node.children, branch)
    if (inside !== undefined) return inside
  }
  return undefined
}

describe('worktreeTree', () => {
  test('a chain nests from base to tip with each position, the primary first and outside any stack', () => {
    const tree = worktreeTree(project([worktree('c', 'b'), primary, worktree('a', 'main'), worktree('b', 'a')]))
    expect(shape(tree)).toEqual(['main@0', 'a@0 1/3', 'b@1 2/3', 'c@2 3/3'])
  })

  test('worktrees on the primary branch with no children are independent rows, not a stack', () => {
    const tree = worktreeTree(project([primary, worktree('x', 'main'), worktree('y', null)]))
    expect(shape(tree)).toEqual(['main@0', 'x@0', 'y@0'])
  })

  test('independent rows keep the order they were listed in, with each stack where its base is', () => {
    const tree = worktreeTree(project([primary, worktree('z', null), worktree('a', 'main'), worktree('m', null), worktree('a2', 'a')]))
    expect(shape(tree)).toEqual(['main@0', 'z@0', 'a@0 1/2', 'a2@1 2/2', 'm@0'])
  })

  test('a branch with two children forks; each line counts its own length', () => {
    const tree = worktreeTree(project([primary, worktree('base', 'main'), worktree('right', 'base'), worktree('left', 'base'), worktree('left2', 'left')]))
    expect(shape(tree)).toEqual(['main@0', 'base@0 1/3', 'left@1 2/3', 'left2@2 3/3', 'right@1 2/2'])
    expect(find(tree, 'base')?.place?.forked).toBe(true)
    expect(find(tree, 'left2')?.place?.forked).toBe(true)
  })

  test('a parent that is not a worktree of the project makes a root', () => {
    const tree = worktreeTree(project([primary, worktree('a', 'release/1'), worktree('b', 'a')]))
    expect(shape(tree)).toEqual(['main@0', 'a@0 1/2', 'b@1 2/2'])
  })

  test('a parent cycle is ignored: both branches show as independent rows', () => {
    const tree = worktreeTree(project([primary, worktree('p', 'q'), worktree('q', 'p')]))
    expect(shape(tree)).toEqual(['main@0', 'p@0', 'q@0'])
  })

  test('a detached worktree is never a parent or a member', () => {
    const tree = worktreeTree(project([primary, worktree(null, 'main'), worktree('a', null)]))
    expect(shape(tree)).toEqual(['main@0', 'detached@0', 'a@0'])
  })

  test('every member of one stack names the same root', () => {
    const tree = worktreeTree(project([primary, worktree('a', 'main'), worktree('b', 'a')]))
    expect(find(tree, 'a')?.place?.root).toBe('/wt/a')
    expect(find(tree, 'b')?.place?.root).toBe('/wt/a')
  })
})

describe('visibleTree', () => {
  test('a hidden member drops out, its children take its place and keep their positions', () => {
    const tree = worktreeTree(project([primary, worktree('a', 'main'), worktree('b', 'a', { hidden: true }), worktree('c', 'b')]))
    const shown = visibleTree(tree, (item) => item.hidden !== true)
    expect(shape(shown)).toEqual(['main@0', 'a@0 1/3', 'c@1 3/3'])
  })

  test('a hidden root lifts its stack to the top level', () => {
    const tree = worktreeTree(project([primary, worktree('a', 'main', { hidden: true }), worktree('b', 'a')]))
    expect(shape(visibleTree(tree, (item) => item.hidden !== true))).toEqual(['main@0', 'b@0 2/2'])
  })
})

describe('memberStatus', () => {
  const pr = (state: string, isDraft = false) => ({ number: 12, state, url: 'https://github.com/owner/repo/pull/12', isDraft })

  test('without a pull request there is no status', () => {
    expect(memberStatus(null).status).toBeNull()
  })

  test('the pull request state alone gives draft, open, merged and closed', () => {
    expect(memberStatus(pr('OPEN', true)).status).toBe('draft')
    expect(memberStatus(pr('OPEN')).status).toBe('open')
    expect(memberStatus(pr('MERGED')).status).toBe('merged')
    expect(memberStatus(pr('CLOSED')).status).toBe('closed')
  })

  test('failing checks win over the review, and a review over plain open', () => {
    expect(memberStatus(pr('OPEN'), { reviewDecision: 'APPROVED', checks: 'failing', behindParent: 0 }).status).toBe('checks-failing')
    expect(memberStatus(pr('OPEN'), { reviewDecision: 'APPROVED', checks: 'passing', behindParent: 0 }).status).toBe('approved')
    expect(memberStatus(pr('OPEN'), { reviewDecision: 'CHANGES_REQUESTED', checks: 'pending', behindParent: 0 }).status).toBe('changes-requested')
    expect(memberStatus(pr('OPEN'), { reviewDecision: 'REVIEW_REQUIRED', checks: 'none', behindParent: 0 }).status).toBe('open')
  })

  test('merged and closed stay so whatever the checks said', () => {
    expect(memberStatus(pr('MERGED'), { reviewDecision: 'APPROVED', checks: 'failing', behindParent: 3 }).status).toBe('merged')
  })

  test('needs sync only when the parent has commits the branch lacks', () => {
    expect(memberStatus(null, { reviewDecision: null, checks: 'none', behindParent: 2 }).needsSync).toBe(true)
    expect(memberStatus(null, { reviewDecision: null, checks: 'none', behindParent: 0 }).needsSync).toBe(false)
    expect(memberStatus(null, { reviewDecision: null, checks: 'none', behindParent: null }).needsSync).toBe(false)
    expect(memberStatus(null).needsSync).toBe(false)
  })
})

describe('stackDetails', () => {
  test('reads the review, the checks and the behind count of each branch from stack show', () => {
    const details = stackDetails({
      branches: [
        { branch: 'a', behindParent: 0, pullRequest: { number: 1, reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }] } },
        { branch: 'b', behindParent: 4, pullRequest: { number: 2, reviewDecision: '', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] } },
        { branch: 'c', pullRequest: { number: 3, statusCheckRollup: [{ status: 'IN_PROGRESS' }] } },
        { branch: 'd', pullRequest: null },
      ],
    })
    expect(details.get('a')).toEqual({ reviewDecision: 'APPROVED', checks: 'passing', behindParent: 0 })
    expect(details.get('b')).toEqual({ reviewDecision: null, checks: 'failing', behindParent: 4 })
    expect(details.get('c')).toEqual({ reviewDecision: null, checks: 'pending', behindParent: null })
    expect(details.get('d')).toEqual({ reviewDecision: null, checks: 'none', behindParent: null })
  })
})

describe('stackChain', () => {
  test('the chain of a member runs from the root through it to the tip', () => {
    const tree = worktreeTree(project([primary, worktree('a', 'main'), worktree('b', 'a'), worktree('c', 'b')]))
    const chain = stackChain(tree, '/wt/b')
    expect(chain?.members.map((item) => item.branch)).toEqual(['a', 'b', 'c'])
    expect(chain?.forked).toBe(false)
  })

  test('a fork anywhere on the chain marks it forked', () => {
    const tree = worktreeTree(project([primary, worktree('a', 'main'), worktree('b1', 'a'), worktree('b2', 'a')]))
    expect(stackChain(tree, '/wt/b1')?.forked).toBe(true)
    expect(stackChain(tree, '/wt/a')?.forked).toBe(true)
  })

  test('a worktree outside any stack has no chain', () => {
    const tree = worktreeTree(project([primary, worktree('solo', 'main')]))
    expect(stackChain(tree, '/wt/solo')).toBeNull()
    expect(stackChain(tree, '/repo')).toBeNull()
  })
})

describe('stackActions', () => {
  const open = (number: number) => ({ number, state: 'OPEN', url: `https://github.com/owner/repo/pull/${number}` })
  const kinds = (project: Project, branch: string) => {
    const tree = worktreeTree(project)
    const node = find(tree, branch)
    if (node === undefined) throw new Error(branch)
    return stackActions(project, tree, node).map((action) => (action.kind === 'pr' ? `pr${action.draft ? ':draft' : ''}` : action.kind))
  }

  test('the primary checkout and a detached worktree offer nothing', () => {
    const repo = project([primary, worktree(null, null), worktree('a', 'main')])
    expect(kinds(repo, 'main')).toEqual([])
    const tree = worktreeTree(repo)
    const detached = tree.find((node) => node.worktree.branch === null)
    expect(detached === undefined ? null : stackActions(repo, tree, detached)).toEqual([])
  })

  test('a worktree outside a stack can only start one', () => {
    expect(kinds(project([primary, worktree('solo', 'main')]), 'solo')).toEqual(['new-stacked'])
  })

  test('every position of a stack whose members all have open pull requests offers the whole set', () => {
    const repo = project([primary, worktree('a', 'main', { pullRequest: open(1) }), worktree('b', 'a', { pullRequest: open(2) }), worktree('c', 'b', { pullRequest: open(3) })])
    const all = ['new-stacked', 'sync', 'pr', 'pr:draft', 'merge', 'show-github']
    expect(kinds(repo, 'a')).toEqual(all)
    expect(kinds(repo, 'b')).toEqual(all)
    expect(kinds(repo, 'c')).toEqual(all)
  })

  test('merge waits until every member has an open pull request, and Show on GitHub needs one on this branch', () => {
    const repo = project([primary, worktree('a', 'main', { pullRequest: open(1) }), worktree('b', 'a')])
    expect(kinds(repo, 'a')).toEqual(['new-stacked', 'sync', 'pr', 'pr:draft', 'show-github'])
    expect(kinds(repo, 'b')).toEqual(['new-stacked', 'sync', 'pr', 'pr:draft'])
  })

  test('a forked stack keeps New stacked branch and Show on GitHub but not sync, pull requests or merge', () => {
    const repo = project([primary, worktree('a', 'main', { pullRequest: open(1) }), worktree('b1', 'a', { pullRequest: open(2) }), worktree('b2', 'a', { pullRequest: open(3) })])
    expect(kinds(repo, 'a')).toEqual(['new-stacked', 'show-github'])
    expect(kinds(repo, 'b2')).toEqual(['new-stacked', 'show-github'])
  })

  test('without a remote the stack can be extended but not synced, opened or merged', () => {
    const repo = project([primary, worktree('a', 'main'), worktree('b', 'a')], null)
    expect(kinds(repo, 'b')).toEqual(['new-stacked'])
  })

  test('merge lists the chain pull requests bottom-up', () => {
    const repo = project([primary, worktree('a', 'main', { pullRequest: open(1) }), worktree('b', 'a', { pullRequest: open(2) })])
    const tree = worktreeTree(repo)
    const node = find(tree, 'b')
    const merge = node === undefined ? undefined : stackActions(repo, tree, node).find((action) => action.kind === 'merge')
    expect(merge?.kind === 'merge' ? merge.pullRequests.map((item) => item.number) : null).toEqual([1, 2])
  })
})
