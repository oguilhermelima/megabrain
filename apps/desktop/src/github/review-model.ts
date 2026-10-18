import type { GithubPullRequestFile, GithubReview, GithubReviewComment, GithubReviewers, GithubReviewEvent, GithubReviewThread } from '@/api/schema'

// What reviewing a pull request computes: gh's unified patch as numbered lines, where on the diff a
// line's comment lands, the inline comments kept pending until the review goes, the review itself,
// and the filter over the changed files.

export interface DiffLine {
  /** hunk: an `@@` header; note: gh's `\ No newline at end of file`. */
  kind: 'hunk' | 'context' | 'add' | 'del' | 'note'
  /** The line without its diff marker. */
  text: string
  oldLine: number | null
  newLine: number | null
}

const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Every line of a patch after its first hunk header, numbered on the side or sides it lives on. */
export function parsePatch(patch: string | null): DiffLine[] {
  if (patch === null || patch === '') return []
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const raw = patch.split('\n')
  if (raw.at(-1) === '') raw.pop()
  for (const line of raw) {
    const header = hunkHeader.exec(line)
    if (header !== null) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      inHunk = true
      lines.push({ kind: 'hunk', text: line, oldLine: null, newLine: null })
      continue
    }
    if (!inHunk) continue
    const marker = line.slice(0, 1)
    const text = line.slice(1)
    if (marker === '+') lines.push({ kind: 'add', text, oldLine: null, newLine: newLine++ })
    else if (marker === '-') lines.push({ kind: 'del', text, oldLine: oldLine++, newLine: null })
    else if (marker === '\\') lines.push({ kind: 'note', text: line, oldLine: null, newLine: null })
    else lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ })
  }
  return lines
}

/** Where an inline comment sits: a file, a line number and the side of the diff that number counts. */
export type CommentTarget = Pick<GithubReviewComment, 'path' | 'line' | 'side'>

/** A removed line is commented on the old side, any other on the new; headers and notes take none. */
export function commentTarget(path: string, line: DiffLine): CommentTarget | null {
  if (line.kind === 'del' && line.oldLine !== null) return { path, line: line.oldLine, side: 'LEFT' }
  if ((line.kind === 'add' || line.kind === 'context') && line.newLine !== null) return { path, line: line.newLine, side: 'RIGHT' }
  return null
}

export interface ThreadPlacement {
  /** The threads under each diff line, by the line's index. */
  at: Map<number, GithubReviewThread[]>
  /** The file's threads no line of this diff carries: outdated, on the whole file, or off the hunks. */
  elsewhere: GithubReviewThread[]
}

/** Where each of a file's review threads sits: a left-side line counts old numbers, a right-side one new. */
export function placeThreads(path: string, lines: DiffLine[], threads: GithubReviewThread[]): ThreadPlacement {
  const left = new Map<number, number>()
  const right = new Map<number, number>()
  lines.forEach((line, index) => {
    if (line.oldLine !== null && (line.kind === 'del' || line.kind === 'context')) left.set(line.oldLine, index)
    if (line.newLine !== null && (line.kind === 'add' || line.kind === 'context')) right.set(line.newLine, index)
  })
  const at = new Map<number, GithubReviewThread[]>()
  const elsewhere: GithubReviewThread[] = []
  for (const thread of threads) {
    if (thread.path !== path) continue
    const index = thread.isOutdated || thread.line === null ? undefined : (thread.side === 'LEFT' ? left : right).get(thread.line)
    if (index === undefined) elsewhere.push(thread)
    else at.set(index, [...(at.get(index) ?? []), thread])
  }
  return { at, elsewhere }
}

export const unresolvedCount = (threads: GithubReviewThread[]) => threads.filter((thread) => !thread.isResolved).length

/** A file's diff rows: an optional row on top, then each line followed by a notes row when something hangs under it. */
export type FileRow = { kind: 'top' } | { kind: 'line'; index: number } | { kind: 'notes'; index: number }

export function fileRows(lineCount: number, attached: ReadonlySet<number>, top: boolean): FileRow[] {
  const rows: FileRow[] = top ? [{ kind: 'top' }] : []
  for (let index = 0; index < lineCount; index++) {
    rows.push({ kind: 'line', index })
    if (attached.has(index)) rows.push({ kind: 'notes', index })
  }
  return rows
}

export interface PendingComment extends CommentTarget {
  id: string
  body: string
}

const sameTarget = (left: CommentTarget, right: CommentTarget) => left.path === right.path && left.line === right.line && left.side === right.side

export function addPending(list: PendingComment[], target: CommentTarget, body: string, id: string): PendingComment[] {
  const text = body.trim()
  if (text === '') return list
  return [...list, { id, path: target.path, line: target.line, side: target.side, body: text }]
}

/** A new body for one comment; an empty one removes it. */
export function editPending(list: PendingComment[], id: string, body: string): PendingComment[] {
  const text = body.trim()
  if (text === '') return removePending(list, id)
  return list.map((comment) => (comment.id === id ? { ...comment, body: text } : comment))
}

export function removePending(list: PendingComment[], id: string): PendingComment[] {
  return list.some((comment) => comment.id === id) ? list.filter((comment) => comment.id !== id) : list
}

export function pendingAt(list: PendingComment[], target: CommentTarget): PendingComment[] {
  return list.filter((comment) => sameTarget(comment, target))
}

export type ReviewPayload = { ok: true; review: GithubReview } | { ok: false; error: string }

/**
 * The review to submit, or why GitHub would refuse it: a comment review needs a summary or an inline
 * comment, and requesting changes needs a summary.
 */
export function reviewPayload(event: GithubReviewEvent, body: string, pending: PendingComment[]): ReviewPayload {
  const summary = body.trim()
  if (event === 'request-changes' && summary === '') return { ok: false, error: 'Say what needs to change in the summary.' }
  if (event === 'comment' && summary === '' && pending.length === 0) return { ok: false, error: 'Write a summary or add a comment on the diff first.' }
  const comments = pending.map(({ path, line, side, body: text }) => ({ path, line, side, body: text }))
  return { ok: true, review: comments.length === 0 ? { event, body: summary } : { event, body: summary, comments } }
}

export function fileTotals(files: GithubPullRequestFile[]): { files: number; additions: number; deletions: number } {
  return { files: files.length, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) }
}

/** The files whose path or previous path holds every word of the query. */
export function filterFiles(files: GithubPullRequestFile[], query: string): GithubPullRequestFile[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return files
  return files.filter((file) => {
    const text = `${file.path}\n${file.previousPath ?? ''}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

/** What the merge control offers: merge now, turn on auto-merge (and why it cannot merge yet), nothing yet (and why), or nothing at all. */
export type MergeAction = { kind: 'merge' } | { kind: 'auto-merge'; reason: string } | { kind: 'blocked'; reason: string } | { kind: 'none' }

/**
 * Merge when GitHub says the pull request can go (clean, or with only optional checks failing);
 * auto-merge while required checks or a review hold it; neither while it is a draft or conflicts.
 * Without a readiness read (an older CLI), plain merge as before, and GitHub refuses if it must.
 */
export function mergeAction(pr: { state: string; isDraft: boolean }, readiness: GithubReviewers | null): MergeAction {
  if (pr.state !== 'open') return { kind: 'none' }
  if (pr.isDraft || readiness?.mergeStateStatus === 'draft') return { kind: 'blocked', reason: 'Mark it ready for review before merging.' }
  if (readiness === null) return { kind: 'merge' }
  if (readiness.mergeable === 'conflicting' || readiness.mergeStateStatus === 'dirty') return { kind: 'blocked', reason: 'Resolve the conflicts with the base branch first.' }
  const status = readiness.mergeStateStatus
  if (status === 'clean' || status === 'unstable' || status === 'has_hooks') return { kind: 'merge' }
  const failed = readiness.requiredChecks.filter((check) => check.state === 'failure').map((check) => check.name)
  const waiting = readiness.requiredChecks.filter((check) => check.state === 'pending').map((check) => check.name)
  const reason =
    failed.length > 0
      ? `Required checks failed: ${failed.join(', ')}.`
      : waiting.length > 0
        ? `Waiting on required checks: ${waiting.join(', ')}.`
        : readiness.reviewDecision === 'changes_requested'
          ? 'Changes were requested.'
          : readiness.reviewDecision === 'review_required'
            ? 'Waiting on an approving review.'
            : status === 'behind'
              ? 'The branch is behind its base.'
              : null
  // GitHub still computing (unknown) with nothing holding the merge: let it try.
  if (reason === null) return status === 'blocked' ? { kind: 'auto-merge', reason: 'GitHub blocks the merge for now.' } : { kind: 'merge' }
  return { kind: 'auto-merge', reason }
}

export type IssueStateAction = { label: string; state: 'closed'; reason: 'completed' | 'not planned' } | { label: string; state: 'open' }

/** What an issue's state can change to from where it is. */
export function issueStateActions(state: string): IssueStateAction[] {
  if (state === 'closed') return [{ label: 'Reopen', state: 'open' }]
  return [
    { label: 'Close as completed', state: 'closed', reason: 'completed' },
    { label: 'Close as not planned', state: 'closed', reason: 'not planned' },
  ]
}

export type GithubItemKind = 'pr' | 'issue' | 'run'

/** The pane item id of a maximised pull request, issue or workflow run: its kind, number (a run's id) and repository root. */
export function githubItemId(kind: GithubItemKind, number: number, root: string): string {
  return `${kind}:${number}:${root}`
}

export function parseGithubItemId(id: string): { kind: GithubItemKind; number: number; root: string } | null {
  const match = /^(pr|issue|run):(\d+):(.+)$/.exec(id)
  if (match === null) return null
  return { kind: match[1] === 'pr' ? 'pr' : match[1] === 'run' ? 'run' : 'issue', number: Number(match[2]), root: match[3] ?? '' }
}

/** A maximised item's tab title. */
export function githubItemTitle(target: { kind: GithubItemKind; number: number }): string {
  return target.kind === 'run' ? 'Workflow run' : `${target.kind === 'pr' ? 'Pull request' : 'Issue'} #${target.number}`
}
