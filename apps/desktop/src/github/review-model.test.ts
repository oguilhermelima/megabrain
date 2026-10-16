import { describe, expect, test } from 'bun:test'
import type { GithubPullRequestFile, GithubReviewers, GithubReviewThread } from '@/api/schema'
import {
  addPending,
  commentTarget,
  editPending,
  fileRows,
  fileTotals,
  filterFiles,
  issueStateActions,
  mergeAction,
  parsePatch,
  pendingAt,
  placeThreads,
  removePending,
  reviewPayload,
  unresolvedCount,
  type PendingComment,
} from '@/github/review-model'

const patch = ['@@ -1,4 +1,5 @@ export function main()', ' const a = 1', '-const b = 2', '+const b = 3', '+const c = 4', ' return a', '@@ -10,2 +11,3 @@', ' end', '+tail', '\\ No newline at end of file', ''].join('\n')

describe('parsePatch', () => {
  test('numbers each line on the old and the new side', () => {
    const lines = parsePatch(patch)
    expect(lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text])).toEqual([
      ['hunk', null, null, '@@ -1,4 +1,5 @@ export function main()'],
      ['context', 1, 1, 'const a = 1'],
      ['del', 2, null, 'const b = 2'],
      ['add', null, 2, 'const b = 3'],
      ['add', null, 3, 'const c = 4'],
      ['context', 3, 4, 'return a'],
      ['hunk', null, null, '@@ -10,2 +11,3 @@'],
      ['context', 10, 11, 'end'],
      ['add', null, 12, 'tail'],
      ['note', null, null, '\\ No newline at end of file'],
    ])
  })

  test('a hunk header without counts still starts the numbering', () => {
    const lines = parsePatch('@@ -7 +9 @@\n-old\n+new')
    expect(lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['hunk', null, null],
      ['del', 7, null],
      ['add', null, 9],
    ])
  })

  test('a blank line inside a hunk is a context line', () => {
    const lines = parsePatch('@@ -1,3 +1,3 @@\n a\n\n b')
    expect(lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text])).toEqual([
      ['hunk', null, null, '@@ -1,3 +1,3 @@'],
      ['context', 1, 1, 'a'],
      ['context', 2, 2, ''],
      ['context', 3, 3, 'b'],
    ])
  })

  test('an empty or missing patch has no lines', () => {
    expect(parsePatch('')).toEqual([])
    expect(parsePatch(null)).toEqual([])
  })

  test('text before the first hunk is ignored', () => {
    expect(parsePatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+y').map((line) => line.kind)).toEqual(['hunk', 'del', 'add'])
  })
})

describe('commentTarget', () => {
  const [hunk, context, removed, added] = parsePatch(patch)

  test('a removed line comments on the left side at its old number', () => {
    expect(removed === undefined ? null : commentTarget('src/a.ts', removed)).toEqual({ path: 'src/a.ts', line: 2, side: 'LEFT' })
  })

  test('an added or context line comments on the right side at its new number', () => {
    expect(added === undefined ? null : commentTarget('src/a.ts', added)).toEqual({ path: 'src/a.ts', line: 2, side: 'RIGHT' })
    expect(context === undefined ? null : commentTarget('src/a.ts', context)).toEqual({ path: 'src/a.ts', line: 1, side: 'RIGHT' })
  })

  test('a hunk header takes no comment', () => {
    expect(hunk === undefined ? 'missing' : commentTarget('src/a.ts', hunk)).toBeNull()
  })
})

describe('pending comments', () => {
  const target = { path: 'src/a.ts', line: 4, side: 'RIGHT' as const }

  test('adding keeps the comment with its trimmed body until the review goes', () => {
    const list = addPending([], target, '  rename this  ', 'c1')
    expect(list).toEqual([{ id: 'c1', path: 'src/a.ts', line: 4, side: 'RIGHT', body: 'rename this' }])
  })

  test('an empty body adds nothing', () => {
    const list: PendingComment[] = []
    expect(addPending(list, target, '   ', 'c1')).toBe(list)
  })

  test('two comments on one line both stay, in order', () => {
    const list = addPending(addPending([], target, 'first', 'c1'), target, 'second', 'c2')
    expect(pendingAt(list, target).map((comment) => comment.body)).toEqual(['first', 'second'])
    expect(pendingAt(list, { ...target, side: 'LEFT' })).toEqual([])
    expect(pendingAt(list, { ...target, path: 'src/b.ts' })).toEqual([])
  })

  test('editing changes the body; editing to empty removes it', () => {
    const list = addPending(addPending([], target, 'first', 'c1'), target, 'second', 'c2')
    expect(editPending(list, 'c1', 'changed').map((comment) => comment.body)).toEqual(['changed', 'second'])
    expect(editPending(list, 'c1', '  ').map((comment) => comment.id)).toEqual(['c2'])
  })

  test('removing drops only that comment; an unknown id changes nothing', () => {
    const list = addPending(addPending([], target, 'first', 'c1'), target, 'second', 'c2')
    expect(removePending(list, 'c2').map((comment) => comment.id)).toEqual(['c1'])
    expect(removePending(list, 'nope')).toBe(list)
  })
})

describe('reviewPayload', () => {
  const pending: PendingComment[] = [
    { id: 'c1', path: 'src/a.ts', line: 4, side: 'RIGHT', body: 'rename this' },
    { id: 'c2', path: 'src/b.ts', line: 9, side: 'LEFT', body: 'why removed?' },
  ]

  test('carries the pending comments without their ids', () => {
    expect(reviewPayload('comment', '  Overall fine  ', pending)).toEqual({
      ok: true,
      review: {
        event: 'comment',
        body: 'Overall fine',
        comments: [
          { path: 'src/a.ts', line: 4, side: 'RIGHT', body: 'rename this' },
          { path: 'src/b.ts', line: 9, side: 'LEFT', body: 'why removed?' },
        ],
      },
    })
  })

  test('approve needs no body and leaves comments out when there are none', () => {
    expect(reviewPayload('approve', '', [])).toEqual({ ok: true, review: { event: 'approve', body: '' } })
  })

  test('a comment review with neither body nor inline comments is refused', () => {
    const result = reviewPayload('comment', '   ', [])
    expect(result.ok).toBe(false)
  })

  test('a comment review with only inline comments is allowed', () => {
    expect(reviewPayload('comment', '', pending).ok).toBe(true)
  })

  test('requesting changes needs a summary, as GitHub does', () => {
    expect(reviewPayload('request-changes', '', pending).ok).toBe(false)
    expect(reviewPayload('request-changes', 'Please split it', []).ok).toBe(true)
  })
})

const file = (path: string, additions: number, deletions: number, extra: Partial<GithubPullRequestFile> = {}): GithubPullRequestFile => ({ path, status: 'modified', additions, deletions, patch: '', ...extra })

describe('files', () => {
  const files = [file('src/app.ts', 3, 1), file('docs/readme.md', 10, 0), file('src/new-name.ts', 0, 0, { status: 'renamed', previousPath: 'src/old-name.ts' })]

  test('totals add every file', () => {
    expect(fileTotals(files)).toEqual({ files: 3, additions: 13, deletions: 1 })
  })

  test('the filter matches any word of the path, previous path included, case-insensitively', () => {
    expect(filterFiles(files, 'SRC').map((entry) => entry.path)).toEqual(['src/app.ts', 'src/new-name.ts'])
    expect(filterFiles(files, 'old-name').map((entry) => entry.path)).toEqual(['src/new-name.ts'])
    expect(filterFiles(files, 'src app').map((entry) => entry.path)).toEqual(['src/app.ts'])
    expect(filterFiles(files, '  ')).toBe(files)
  })
})

describe('issueStateActions', () => {
  test('an open issue closes as completed or as not planned', () => {
    expect(issueStateActions('open')).toEqual([
      { label: 'Close as completed', state: 'closed', reason: 'completed' },
      { label: 'Close as not planned', state: 'closed', reason: 'not planned' },
    ])
  })

  test('a closed issue reopens', () => {
    expect(issueStateActions('closed')).toEqual([{ label: 'Reopen', state: 'open' }])
  })
})

describe('review threads on the diff', () => {
  const lines = parsePatch('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')
  const thread = (id: string, path: string, line: number | null, side: 'LEFT' | 'RIGHT', extra: Partial<GithubReviewThread> = {}): GithubReviewThread => ({
    id,
    path,
    line,
    side,
    isResolved: false,
    isOutdated: false,
    comments: [{ id: `${id}-1`, author: { login: 'reviewer', name: null, isBot: false }, body: 'why', createdAt: '2026-10-16T10:00:00Z' }],
    ...extra,
  })

  test('a right-side thread sits under the added or context line with that new number', () => {
    const placed = placeThreads('src/a.ts', lines, [thread('t1', 'src/a.ts', 2, 'RIGHT'), thread('t2', 'src/a.ts', 3, 'RIGHT')])
    expect([...placed.at.entries()].map(([index, list]) => [index, list.map((entry) => entry.id)])).toEqual([
      [3, ['t1']],
      [4, ['t2']],
    ])
    expect(placed.elsewhere).toEqual([])
  })

  test('a left-side thread sits under the removed or context line with that old number', () => {
    const placed = placeThreads('src/a.ts', lines, [thread('t1', 'src/a.ts', 2, 'LEFT'), thread('t2', 'src/a.ts', 1, 'LEFT')])
    expect([...placed.at.entries()].map(([index, list]) => [index, list.map((entry) => entry.id)])).toEqual([
      [2, ['t1']],
      [1, ['t2']],
    ])
  })

  test('threads on another file are ignored; outdated or unplaceable ones go above the diff', () => {
    const placed = placeThreads('src/a.ts', lines, [thread('other', 'src/b.ts', 1, 'RIGHT'), thread('old', 'src/a.ts', 2, 'RIGHT', { isOutdated: true }), thread('gone', 'src/a.ts', 90, 'RIGHT'), thread('file', 'src/a.ts', null, 'RIGHT')])
    expect(placed.at.size).toBe(0)
    expect(placed.elsewhere.map((entry) => entry.id)).toEqual(['old', 'gone', 'file'])
  })

  test('two threads on one line keep their order', () => {
    const placed = placeThreads('src/a.ts', lines, [thread('t1', 'src/a.ts', 2, 'RIGHT'), thread('t2', 'src/a.ts', 2, 'RIGHT')])
    expect(placed.at.get(3)?.map((entry) => entry.id)).toEqual(['t1', 't2'])
  })

  test('the unresolved count leaves resolved threads out', () => {
    expect(unresolvedCount([thread('a', 'x', 1, 'RIGHT'), thread('b', 'x', 1, 'RIGHT', { isResolved: true }), thread('c', 'y', 2, 'LEFT', { isOutdated: true })])).toBe(2)
  })

  test('the rows of a file put a notes row after each line that carries something, and one on top when needed', () => {
    expect(fileRows(4, new Set([1, 3]), false)).toEqual([
      { kind: 'line', index: 0 },
      { kind: 'line', index: 1 },
      { kind: 'notes', index: 1 },
      { kind: 'line', index: 2 },
      { kind: 'line', index: 3 },
      { kind: 'notes', index: 3 },
    ])
    expect(fileRows(1, new Set(), true)).toEqual([{ kind: 'top' }, { kind: 'line', index: 0 }])
  })
})

describe('mergeAction', () => {
  const ready = (extra: Partial<GithubReviewers> = {}): GithubReviewers => ({
    requested: [],
    reviews: [],
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    reviewDecision: 'approved',
    requiredChecks: [{ name: 'unit', state: 'success' }],
    ...extra,
  })
  const open = { state: 'open', isDraft: false }

  test('a clean pull request merges now', () => {
    expect(mergeAction(open, ready())).toEqual({ kind: 'merge' })
    expect(mergeAction(open, ready({ mergeStateStatus: 'unstable' }))).toEqual({ kind: 'merge' })
    expect(mergeAction(open, ready({ mergeStateStatus: 'has_hooks' }))).toEqual({ kind: 'merge' })
  })

  test('one blocked by pending checks or a missing review offers auto-merge, saying why', () => {
    expect(mergeAction(open, ready({ mergeStateStatus: 'blocked', requiredChecks: [{ name: 'unit', state: 'pending' }] }))).toEqual({ kind: 'auto-merge', reason: 'Waiting on required checks: unit.' })
    expect(mergeAction(open, ready({ mergeStateStatus: 'blocked', reviewDecision: 'review_required' }))).toEqual({ kind: 'auto-merge', reason: 'Waiting on an approving review.' })
    expect(mergeAction(open, ready({ mergeStateStatus: 'blocked', reviewDecision: 'changes_requested' }))).toEqual({ kind: 'auto-merge', reason: 'Changes were requested.' })
    expect(mergeAction(open, ready({ mergeStateStatus: 'blocked', requiredChecks: [{ name: 'unit', state: 'failure' }] }))).toEqual({ kind: 'auto-merge', reason: 'Required checks failed: unit.' })
    expect(mergeAction(open, ready({ mergeStateStatus: 'behind' }))).toEqual({ kind: 'auto-merge', reason: 'The branch is behind its base.' })
  })

  test('conflicts and drafts block both', () => {
    expect(mergeAction(open, ready({ mergeable: 'conflicting', mergeStateStatus: 'dirty' }))).toEqual({ kind: 'blocked', reason: 'Resolve the conflicts with the base branch first.' })
    expect(mergeAction({ state: 'open', isDraft: true }, ready({ mergeStateStatus: 'draft' }))).toEqual({ kind: 'blocked', reason: 'Mark it ready for review before merging.' })
  })

  test('while GitHub is still computing, the checks and review decide', () => {
    expect(mergeAction(open, ready({ mergeable: 'unknown', mergeStateStatus: 'unknown' }))).toEqual({ kind: 'merge' })
    expect(mergeAction(open, ready({ mergeable: 'unknown', mergeStateStatus: 'unknown', reviewDecision: 'review_required' }))).toEqual({ kind: 'auto-merge', reason: 'Waiting on an approving review.' })
  })

  test('a closed or merged pull request has no merge, and an unread readiness keeps plain merge', () => {
    expect(mergeAction({ state: 'merged', isDraft: false }, ready())).toEqual({ kind: 'none' })
    expect(mergeAction(open, null)).toEqual({ kind: 'merge' })
  })
})
