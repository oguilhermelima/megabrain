import { useState } from 'react'
import type { GithubCheck, GithubDetail, GithubIssue, GithubPullRequest } from '@/api/schema'
import { avatarUrl, labelStyle, pullRequestVisualState, stateColors, type CheckSummary, type PullRequestVisualState } from '@/github/github-model'
import { projectColor } from '@/advanced/picture-model'
import {
  CheckFailIcon,
  CheckPassIcon,
  CheckPendingIcon,
  CheckSkippedIcon,
  ClosedIssueIcon,
  ClosedPullRequestIcon,
  DraftPullRequestIcon,
  IssueIcon,
  MergedIcon,
  PullRequestIcon,
} from '@/github/icons'

/** A GitHub picture, or the login's initial on its own colour when there is none or it fails. */
export function Avatar({ login, size = 20 }: { login: string | null; size?: number }) {
  const [failed, setFailed] = useState(false)
  const name = login ?? 'ghost'
  const url = login === null ? null : avatarUrl(login)
  const box = { width: size, height: size }
  if (url !== null && !failed) {
    return <img src={url} alt="" draggable={false} onError={() => setFailed(true)} style={box} className="shrink-0 rounded-full bg-white/[0.08] object-cover" />
  }
  return (
    <span aria-hidden="true" style={{ ...box, backgroundColor: projectColor(name), fontSize: Math.round(size * 0.5) }} className="grid shrink-0 place-items-center rounded-full font-bold text-white">
      {name.replace(/^app\//, '').slice(0, 1).toUpperCase()}
    </span>
  )
}

export function LabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span style={labelStyle(color)} className="inline-flex h-[20px] shrink-0 items-center rounded-full border px-2 text-[11.5px] leading-none font-semibold whitespace-nowrap">
      {name}
    </span>
  )
}

const prStateLabel: Record<PullRequestVisualState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }
const issueColors: Record<GithubIssue['state'], string> = { open: stateColors.open, closed: stateColors.merged }

export function PullRequestStateIcon({ item, size = 16 }: { item: GithubPullRequest; size?: number }) {
  const state = pullRequestVisualState(item)
  const Icon = state === 'draft' ? DraftPullRequestIcon : state === 'merged' ? MergedIcon : state === 'closed' ? ClosedPullRequestIcon : PullRequestIcon
  return (
    <span style={{ color: stateColors[state] }} className="shrink-0" aria-label={prStateLabel[state]}>
      <Icon size={size} />
    </span>
  )
}

export function IssueStateIcon({ state, size = 16 }: { state: GithubIssue['state']; size?: number }) {
  const Icon = state === 'open' ? IssueIcon : ClosedIssueIcon
  return (
    <span style={{ color: issueColors[state] }} className="shrink-0" aria-label={state === 'open' ? 'Open' : 'Closed'}>
      <Icon size={size} />
    </span>
  )
}

/** The big state pill at the top of a detail pane: GitHub's filled badge in the state's colour. */
export function StatePill({ kind, state, draft }: { kind: 'pr' | 'issue'; state: string; draft: boolean }) {
  const visual: PullRequestVisualState = state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : draft ? 'draft' : 'open'
  const color = kind === 'issue' ? (state === 'closed' ? stateColors.merged : stateColors.open) : stateColors[visual]
  const label = kind === 'issue' ? (state === 'closed' ? 'Closed' : 'Open') : prStateLabel[visual]
  const Icon = kind === 'issue' ? (state === 'closed' ? ClosedIssueIcon : IssueIcon) : visual === 'draft' ? DraftPullRequestIcon : visual === 'merged' ? MergedIcon : visual === 'closed' ? ClosedPullRequestIcon : PullRequestIcon
  return (
    <span style={{ backgroundColor: `${color}26`, color, borderColor: `${color}55` }} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold">
      <Icon size={14} />
      {label}
    </span>
  )
}

export function checkTitle(summary: CheckSummary): string {
  if (summary.state === 'none') return summary.total === 0 ? 'No checks' : `${summary.skipped} skipped`
  const parts = [summary.passed > 0 ? `${summary.passed} passing` : null, summary.failed > 0 ? `${summary.failed} failing` : null, summary.pending > 0 ? `${summary.pending} pending` : null, summary.skipped > 0 ? `${summary.skipped} skipped` : null]
  return parts.filter((part) => part !== null).join(' · ')
}

export function CheckGlyph({ state, size = 14 }: { state: CheckSummary['state'] | GithubCheck['state']; size?: number }) {
  if (state === 'passing' || state === 'success' || state === 'neutral') return <CheckPassIcon size={size} />
  if (state === 'failing' || state === 'failure') return <CheckFailIcon size={size} />
  if (state === 'pending') return <CheckPendingIcon size={size} />
  return <CheckSkippedIcon size={size} />
}

export const checkStateTone: Record<GithubCheck['state'], string> = { success: 'text-ok', neutral: 'text-ink-300', failure: 'text-bad', pending: 'text-warn', skipped: 'text-ink-500' }

type ReviewDecision = NonNullable<GithubDetail['reviewDecision']>

const reviewChips: Record<ReviewDecision, { label: string; className: string }> = {
  approved: { label: 'Approved', className: 'bg-ok/[0.14] text-ok' },
  changes_requested: { label: 'Changes requested', className: 'bg-bad/[0.14] text-bad' },
  review_required: { label: 'Review required', className: 'bg-white/[0.07] text-ink-300' },
}

export function ReviewChip({ decision }: { decision: ReviewDecision | null }) {
  if (decision === null) return null
  const chip = reviewChips[decision]
  return <span className={`inline-flex h-[20px] shrink-0 items-center rounded-full px-2 text-[11.5px] font-semibold whitespace-nowrap ${chip.className}`}>{chip.label}</span>
}

export function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] tabular-nums" title={`${additions} added, ${deletions} removed`}>
      <span className="text-ok">+{additions}</span>
      <span className="text-bad">−{deletions}</span>
    </span>
  )
}

/** Placeholder rows shaped like the real ones while the first list loads. */
export function SkeletonRows({ count = 7 }: { count?: number }) {
  return (
    <ul className="space-y-1 px-3" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="flex items-start gap-3 rounded-[16px] px-4 py-3.5">
          <span className="mt-0.5 size-4 shrink-0 animate-pulse rounded-full bg-white/[0.08]" />
          <span className="min-w-0 flex-1 space-y-2">
            <span className="block h-3.5 animate-pulse rounded-full bg-white/[0.08]" style={{ width: `${55 + ((index * 17) % 35)}%` }} />
            <span className="block h-2.5 w-[38%] animate-pulse rounded-full bg-white/[0.05]" />
          </span>
          <span className="h-3 w-14 shrink-0 animate-pulse rounded-full bg-white/[0.05]" />
        </li>
      ))}
    </ul>
  )
}
