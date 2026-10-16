import { describe, expect, test } from 'bun:test'
import type { GithubPullRequestFile } from '@/api/schema'
import {
  addPending,
  commentTarget,
  editPending,
  fileTotals,
  filterFiles,
  issueStateActions,
  parsePatch,
  pendingAt,
  removePending,
  reviewPayload,
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
