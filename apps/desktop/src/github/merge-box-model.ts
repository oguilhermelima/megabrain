import type { GithubCheck, GithubReviewers } from '@/api/schema'
import { checkSummary } from '@/github/github-model'
import { mergeAction, type MergeAction } from '@/github/review-model'

// What the merge box at the end of a pull request's conversation shows: one line per thing that
// decides the merge (checks, reviews, conflicts), a headline, the primary action and the quiet ones.

export type Tone = 'ok' | 'warn' | 'bad' | 'muted'

export interface MergeBoxRow {
  kind: 'checks' | 'reviews' | 'conflicts'
  tone: Tone
  text: string
}

export type PrimaryAction = 'merge' | 'auto-merge' | 'disable-auto-merge' | 'ready-for-review' | 'reopen'
export type SecondaryAction = 'rerun-failed' | 'convert-to-draft' | 'close'

export interface MergeBox {
  tone: Tone
  headline: string
  /** Why the merge waits or is blocked; empty when it can go. */
  detail: string
  rows: MergeBoxRow[]
  primary: PrimaryAction | null
  /** Merge is offered but GitHub would refuse it now. */
  primaryDisabled: boolean
  /** The merge method select goes beside merge and auto-merge. */
  showMethod: boolean
  secondary: SecondaryAction[]
  action: MergeAction
}

export interface MergeBoxInput {
  state: string
  isDraft: boolean
  checks: GithubCheck[]
  /** The readiness read; null until it answers or when the CLI cannot give it. */
  readiness: GithubReviewers | null
  /** The method auto-merge was turned on with in this session, or null. */
  autoMerge: string | null
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

function checksRow(checks: GithubCheck[], readiness: GithubReviewers | null): MergeBoxRow | null {
  const all = checkSummary(checks)
  const required = readiness?.requiredChecks ?? []
  const requiredFailing = required.filter((check) => check.state === 'failure').length
  const requiredNote = required.length === 0 ? '' : ` (${checkSummary(required).passed}/${required.length} required passing)`
  if (all.total === 0 && required.length === 0) return null
  if (all.state === 'failing' || requiredFailing > 0) {
    const failed = Math.max(all.failed, requiredFailing)
    return { kind: 'checks', tone: requiredFailing > 0 ? 'bad' : 'warn', text: `${plural(failed, 'check', 'checks')} failing${requiredNote}` }
  }
  if (all.state === 'pending') return { kind: 'checks', tone: 'warn', text: `${plural(all.pending, 'check', 'checks')} still running${requiredNote}` }
  if (all.state === 'passing') return { kind: 'checks', tone: 'ok', text: `All checks passed${requiredNote}` }
  return { kind: 'checks', tone: 'muted', text: `${plural(all.skipped, 'check', 'checks')} skipped` }
}

function reviewsRow(readiness: GithubReviewers | null): MergeBoxRow | null {
  if (readiness === null) return null
  const waiting = readiness.requested.map((person) => person.login)
  const waitingNote = waiting.length === 0 ? '' : `; waiting on ${waiting.join(', ')}`
  if (readiness.reviewDecision === 'approved') return { kind: 'reviews', tone: 'ok', text: `Approved${waitingNote}` }
  if (readiness.reviewDecision === 'changes_requested') return { kind: 'reviews', tone: 'bad', text: `Changes requested${waitingNote}` }
  if (readiness.reviewDecision === 'review_required') return { kind: 'reviews', tone: 'warn', text: `An approving review is required${waitingNote}` }
  if (waiting.length > 0) return { kind: 'reviews', tone: 'muted', text: `Waiting on ${waiting.join(', ')}` }
  return { kind: 'reviews', tone: 'muted', text: 'No review required' }
}

function conflictsRow(readiness: GithubReviewers | null): MergeBoxRow | null {
  if (readiness === null) return null
  if (readiness.mergeable === 'conflicting' || readiness.mergeStateStatus === 'dirty') return { kind: 'conflicts', tone: 'bad', text: 'This branch has conflicts with the base branch' }
  if (readiness.mergeStateStatus === 'behind') return { kind: 'conflicts', tone: 'warn', text: 'No conflicts, but the branch is behind its base' }
  if (readiness.mergeable === 'mergeable') return { kind: 'conflicts', tone: 'ok', text: 'No conflicts with the base branch' }
  return { kind: 'conflicts', tone: 'muted', text: 'GitHub is still checking for conflicts' }
}

export function mergeBox({ state, isDraft, checks, readiness, autoMerge }: MergeBoxInput): MergeBox {
  const action = mergeAction({ state, isDraft }, readiness)
  const none = { rows: [], primaryDisabled: false, showMethod: false, action }
  if (state === 'merged') return { ...none, tone: 'muted', headline: 'Merged', detail: '', primary: null, secondary: [] }
  if (state === 'closed') return { ...none, tone: 'muted', headline: 'Closed without merging', detail: '', primary: 'reopen', secondary: [] }

  const rows = [checksRow(checks, readiness), reviewsRow(readiness), conflictsRow(readiness)].filter((row) => row !== null)
  const failing = [...checks, ...(readiness?.requiredChecks ?? [])].some((check) => check.state === 'failure')
  const secondary: SecondaryAction[] = [...(failing ? (['rerun-failed'] as const) : []), ...(isDraft ? [] : (['convert-to-draft'] as const)), 'close']
  const base = { rows, secondary, action }

  if (isDraft) return { ...base, tone: 'muted', headline: 'This pull request is still a draft', detail: 'Mark it ready for review before merging.', primary: 'ready-for-review', primaryDisabled: false, showMethod: false }
  if (autoMerge !== null) return { ...base, tone: 'ok', headline: 'Auto-merge is on', detail: `It merges (${autoMerge}) as soon as GitHub allows it.`, primary: 'disable-auto-merge', primaryDisabled: false, showMethod: false }
  if (action.kind === 'merge') {
    const unstable = readiness?.mergeStateStatus === 'unstable'
    return { ...base, tone: unstable ? 'warn' : 'ok', headline: unstable ? 'Can merge; some optional checks fail' : 'Ready to merge', detail: '', primary: 'merge', primaryDisabled: false, showMethod: true }
  }
  if (action.kind === 'auto-merge') return { ...base, tone: 'warn', headline: 'Merging is waiting', detail: action.reason, primary: 'auto-merge', primaryDisabled: false, showMethod: true }
  const reason = action.kind === 'blocked' ? action.reason : ''
  return { ...base, tone: 'bad', headline: 'Merging is blocked', detail: reason, primary: 'merge', primaryDisabled: true, showMethod: true }
}
