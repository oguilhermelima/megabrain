import { useEffect, useState, type ReactNode } from 'react'
import type { GithubActionRun } from '@/api/schema'
import { Tooltip } from '@/components/Tooltip'
import { runLabels, runVisual, type RunVisual } from '@/github/actions-model'
import { latestRun } from '@/github/actions-requests'
import { BranchIcon, CheckFailIcon, CheckPassIcon, CheckPendingIcon, CheckSkippedIcon } from '@/github/icons'
import { StatPill } from '@/github/ItemHero'
import { ago, openOnGithub } from '@/github/parts'

// How a run, job or step shows its state wherever it appears: GitHub's green check, red cross, an
// amber ring that turns while it runs, an amber dot while it waits, grey for cancelled and skipped.

export const runTone: Record<RunVisual, string> = {
  success: 'text-ok',
  failure: 'text-bad',
  running: 'text-warn',
  queued: 'text-warn',
  waiting: 'text-warn',
  cancelled: 'text-ink-400',
  skipped: 'text-ink-500',
  neutral: 'text-ink-400',
}

const pillTone: Record<RunVisual, string> = {
  success: 'border-ok/40 bg-ok/[0.14] text-ok',
  failure: 'border-bad/40 bg-bad/[0.14] text-bad',
  running: 'border-warn/40 bg-warn/[0.12] text-warn',
  queued: 'border-warn/40 bg-warn/[0.12] text-warn',
  waiting: 'border-warn/40 bg-warn/[0.12] text-warn',
  cancelled: 'border-white/[0.12] bg-white/[0.06] text-ink-300',
  skipped: 'border-white/[0.12] bg-white/[0.05] text-ink-400',
  neutral: 'border-white/[0.12] bg-white/[0.06] text-ink-300',
}

function RunningIcon({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="animate-spin motion-reduce:animate-none">
      <circle cx="8" cy="8" r="5.5" opacity="0.3" />
      <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />
    </svg>
  )
}

export function RunGlyph({ visual, size = 16 }: { visual: RunVisual; size?: number }) {
  if (visual === 'success') return <CheckPassIcon size={size} />
  if (visual === 'failure') return <CheckFailIcon size={size} />
  if (visual === 'running') return <RunningIcon size={size} />
  if (visual === 'queued' || visual === 'waiting') return <CheckPendingIcon size={size} />
  return <CheckSkippedIcon size={size} />
}

/** A run's, job's or step's state as its icon; with `tip`, its name shows on hover. */
export function RunStatusIcon({ item, size = 16, tip, label }: { item: { status: string; conclusion: string | null }; size?: number; tip?: boolean; label?: string }) {
  const visual = runVisual(item)
  const text = label ?? runLabels[visual]
  if (tip !== true)
    return (
      <span role="img" aria-label={text} className={`inline-flex shrink-0 ${runTone[visual]}`}>
        <RunGlyph visual={visual} size={size} />
      </span>
    )
  return (
    <Tooltip text={text}>
      {(anchor) => (
        <span {...anchor} role="img" aria-label={text} className={`inline-flex shrink-0 ${runTone[visual]}`}>
          <RunGlyph visual={visual} size={size} />
        </span>
      )}
    </Tooltip>
  )
}

/** The big state pill at the top of a run: its state's colour, icon and name. */
export function RunStatePill({ item }: { item: { status: string; conclusion: string | null } }) {
  const visual = runVisual(item)
  return (
    <span className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold ${pillTone[visual]}`}>
      <RunGlyph visual={visual} size={14} />
      {runLabels[visual]}
    </span>
  )
}

export function BranchChip({ branch, className = '' }: { branch: string; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 rounded-full bg-white/[0.06] px-2 font-mono text-[11.5px] leading-[22px] text-ink-200 ${className}`}>
      <span className="shrink-0 text-ink-500">
        <BranchIcon size={11} />
      </span>
      <span className="truncate">{branch}</span>
    </span>
  )
}

const events: Record<string, string> = {
  push: 'push',
  pull_request: 'pull request',
  pull_request_target: 'pull request',
  schedule: 'schedule',
  workflow_dispatch: 'manual',
  workflow_run: 'workflow run',
  release: 'release',
  merge_group: 'merge queue',
}

/** The trigger in words: "pull request", "manual" for a dispatch; anything else as GitHub names it. */
export function eventName(event: string): string {
  return events[event] ?? event.replace(/_/g, ' ')
}

export function Fact({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 shrink-0 items-center gap-1.5">{children}</span>
}

/** The newest run of a branch, read once per branch; null when it has none or gh could not tell. */
export function useLatestRun(root: string, branch: string | null): GithubActionRun | null {
  const [run, setRun] = useState<GithubActionRun | null>(null)
  useEffect(() => {
    if (branch === null) return
    let current = true
    setRun(null)
    latestRun(root, branch).then(
      (value) => current && setRun(value),
      () => {},
    )
    return () => {
      current = false
    }
  }, [root, branch])
  return run
}

/** A pull request's stat pill for its head branch's newest run; it opens the run on GitHub. */
export function LatestRunPill({ root, branch }: { root: string; branch: string }) {
  const run = useLatestRun(root, branch)
  if (run === null) return null
  const visual = runVisual(run)
  return (
    <Tooltip text={`Latest run on ${branch}: ${run.name} #${run.number}, ${runLabels[visual].toLowerCase()} ${ago(run.createdAt, Date.now())}`}>
      {(anchor) => (
        <span {...anchor} className="inline-flex">
          <StatPill tone={runTone[visual]} onClick={() => void openOnGithub(run.url)}>
            <RunGlyph visual={visual} size={13} />
            {run.name}
          </StatPill>
        </span>
      )}
    </Tooltip>
  )
}
