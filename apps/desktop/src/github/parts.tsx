import { useEffect, useState } from 'react'
import type { GithubCheck, GithubDetail, GithubIssue, GithubPullRequest } from '@/api/schema'
import { relativeAge } from '@/advanced/projects-model'
import { MarkdownText } from '@/chat/markdown'
import { avatarUrl, checkSummary, labelStyle, pullRequestVisualState, stateColors, type CheckSummary, type PullRequestVisualState } from '@/github/github-model'
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
  LinkIcon,
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

export function ago(iso: string | null, now: number): string {
  const age = relativeAge(iso, now)
  return age === '' ? '' : age === 'now' ? 'just now' : `${age} ago`
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** "Open on GitHub": links do not open from the app yet, so this copies the address instead. */
export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = () => {
    navigator.clipboard.writeText(url).then(
      () => setCopied('copied'),
      () => setCopied('failed'),
    )
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={copy}
        title="Links don't open from the app yet; this copies the address so you can paste it in your browser."
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.12] bg-white/[0.06] px-3 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.12]"
      >
        <LinkIcon size={13} />
        {copied === 'copied' ? 'Link copied' : 'Copy GitHub link'}
      </button>
      {copied === 'failed' && <span className="max-w-[260px] truncate text-[11.5px] text-ink-400 select-text">{url}</span>}
    </div>
  )
}

const checkOrder: Record<GithubCheck['state'], number> = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 }

/** A pull request's checks, failures first; the first few unless `limit` is null. */
export function ChecksList({ checks, limit = 6 }: { checks: GithubCheck[]; limit?: number | null }) {
  const [open, setOpen] = useState(false)
  const summary = checkSummary(checks)
  if (checks.length === 0) return null
  const sorted = [...checks].sort((left, right) => checkOrder[left.state] - checkOrder[right.state])
  const shown = open || limit === null ? sorted : sorted.slice(0, limit)
  return (
    <section className="rounded-[20px] border border-white/[0.08] bg-ink-900">
      <header className="flex items-center gap-2 px-4 pt-3 pb-1.5">
        <h3 className="text-[11.5px] font-semibold tracking-[0.08em] text-ink-400 uppercase">Checks</h3>
        <span className="text-[12px] text-ink-400">{checkTitle(summary)}</span>
      </header>
      <ul className="px-2 pb-2">
        {shown.map((check, index) => (
          <li key={`${check.name}-${index}`} className="flex items-center gap-2.5 rounded-[10px] px-2 py-1 text-[12.5px]">
            <span className={checkStateTone[check.state]}>
              <CheckGlyph state={check.state} size={13} />
            </span>
            <span className="min-w-0 truncate text-ink-200" title={check.name}>
              {check.name}
            </span>
          </li>
        ))}
      </ul>
      {limit !== null && sorted.length > limit && (
        <button type="button" onClick={() => setOpen((current) => !current)} className="w-full border-t border-white/[0.06] py-2 text-[12px] font-semibold text-ink-400 hover:text-ink-100">
          {open ? 'Show fewer' : `Show all ${sorted.length}`}
        </button>
      )}
    </section>
  )
}

/** The description and the comments of a pull request or an issue, as markdown. */
export function ConversationThread({ detail, now }: { detail: Pick<GithubDetail, 'body' | 'comments'>; now: number }) {
  return (
    <>
      <section className="rounded-[20px] border border-white/[0.08] bg-ink-900 px-5 py-4 select-text">
        {detail.body.trim() === '' ? <p className="text-[13.5px] text-ink-400 italic">No description provided.</p> : <MarkdownText text={detail.body} className="text-ink-200" />}
      </section>
      {detail.comments.length > 0 && (
        <section className="space-y-3">
          <h3 className="px-1 text-[11.5px] font-semibold tracking-[0.08em] text-ink-400 uppercase">
            {detail.comments.length} {detail.comments.length === 1 ? 'comment' : 'comments'}
          </h3>
          {detail.comments.map((comment, index) => (
            <article key={`${comment.url}-${index}`} className="flex gap-3">
              <Avatar login={comment.author?.login ?? null} size={28} />
              <div className="min-w-0 flex-1 rounded-[18px] border border-white/[0.06] bg-white/[0.03] px-4 py-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-[12.5px]">
                  <span className="font-semibold text-ink-100">{comment.author?.login ?? 'ghost'}</span>
                  <span className="text-ink-400">{ago(comment.createdAt, now)}</span>
                </p>
                <div className="select-text">
                  <MarkdownText text={comment.body} className="text-ink-200" />
                </div>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  )
}
