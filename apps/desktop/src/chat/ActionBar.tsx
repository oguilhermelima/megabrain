import { lazy, Suspense, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { api } from '@/api'
import type { BranchChanges, CodeChange } from '@/api/schema'
import { CodeIcon } from '@/advanced/chrome'
import type { PaneView, Segment, WorktreeFacts } from '@/chat/action-bar-model'
import { AgentIcon } from '@/components/agent-icons'
import { PaneSkeleton } from '@/components/Skeleton'
import { PullRequestIcon } from '@/github/icons'
import { changesPolicy } from '@/lib/poll-model'
import { reuse } from '@/lib/reuse'
import { usePoll } from '@/lib/usePoll'

const GithubItemView = lazy(() => import('@/github/GithubItem').then((module) => ({ default: module.GithubItemView })))
const ChangesDiff = lazy(() => import('@/code/ChangesDiff').then((module) => ({ default: module.ChangesDiff })))

function DiffIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="1.5" width="11" height="13" rx="2" />
      <path d="M8 4.25v4M6 6.25h4M6 11h4" />
    </svg>
  )
}

export interface WorktreeChanges {
  uncommitted: CodeChange[]
  branch: BranchChanges | null
  /** False until both reads answered once. */
  read: boolean
}

/** The worktree's uncommitted and branch changes, kept fresh for the Diff badge and view. */
export function useWorktreeChanges(facts: WorktreeFacts | null): WorktreeChanges {
  const [changes, setChanges] = useState<WorktreeChanges>({ uncommitted: [], branch: null, read: false })
  const root = facts?.root ?? null
  const parent = facts?.parent ?? null
  usePoll(
    changesPolicy,
    async (current) => {
      if (root === null) return
      // A failed read keeps what was known; the badge is a hint, never an error.
      const [uncommitted, branch] = await Promise.all([api.codeChanges(root).catch(() => null), api.codeBranchChanges(root, parent).catch(() => null)])
      if (!current()) return
      setChanges((previous) => ({
        uncommitted: uncommitted === null ? previous.uncommitted : reuse(previous.uncommitted, uncommitted),
        branch: branch === null ? previous.branch : reuse(previous.branch, branch),
        read: previous.read || (uncommitted !== null && branch !== null),
      }))
    },
    [root, parent],
  )
  return changes
}

/**
 * Agent, Code, PR and Diff as one segmented control. Below the header's 48rem it keeps only the
 * icons; the tooltips carry the names, counts and reasons either way.
 */
export function ActionBar({ agent, segments, shown, onSelect }: { agent: string | null; segments: readonly Segment[]; shown: PaneView; onSelect: (view: PaneView) => void }) {
  const icons: Record<PaneView, ReactNode> = {
    agent: agent === null || agent === '' ? <ChatGlyph /> : <AgentIcon agent={agent} size={14} />,
    code: <CodeIcon />,
    pr: <PullRequestIcon size={14} />,
    diff: <DiffIcon />,
  }
  return (
    <div role="group" aria-label="Views" className="flex shrink-0 gap-0.5 rounded-full border border-white/10 bg-white/[0.05] p-0.5">
      {segments.map((segment) => {
        const current = segment.view === shown
        return (
          <button
            key={segment.view}
            type="button"
            aria-label={segment.label}
            aria-pressed={current}
            title={segment.title}
            disabled={!segment.enabled}
            onClick={() => onSelect(segment.view)}
            className={`flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-full px-2 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default @3xl:px-2.5 ${
              current ? 'bg-white/[0.14] text-ink-100' : segment.enabled ? 'text-ink-300 hover:bg-white/[0.08] hover:text-ink-100' : 'text-ink-600'
            }`}
          >
            {icons[segment.view]}
            <span className="hidden @3xl:inline">{segment.label}</span>
            {segment.badge !== null && <span className="hidden rounded-full bg-white/[0.1] px-1.5 text-[10.5px] leading-4 text-ink-200 tabular-nums @3xl:inline">{segment.badge}</span>}
          </button>
        )
      })}
    </div>
  )
}

function ChatGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.2v-2.2h0a1.5 1.5 0 0 1-1.5-1.5Z" />
    </svg>
  )
}

/**
 * The PR or Diff view, laid over the pane below its top bar so the bar stays and the Agent view
 * under it keeps its draft, scroll and terminal. The pane's content box is the positioned
 * ancestor; the top follows the header's height.
 */
export function PaneViewBody({ view, facts, changes, header }: { view: 'pr' | 'diff'; facts: WorktreeFacts; changes: WorktreeChanges; header: RefObject<HTMLElement | null> }) {
  const [top, setTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = header.current
    if (element === null) return
    const measure = () => setTop(element.offsetTop + element.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [header])
  return (
    <div style={{ top: top ?? 0 }} className={`absolute inset-x-0 bottom-0 z-30 flex min-h-0 flex-col bg-ink-950 ${top === null ? 'invisible' : ''}`}>
      <Suspense fallback={<PaneSkeleton />}>
        {view === 'pr' && facts.pullRequest !== null ? (
          <GithubItemView key={facts.pullRequest} root={facts.repo} kind="pr" number={facts.pullRequest} />
        ) : (
          <ChangesDiff root={facts.root} uncommitted={changes.uncommitted} branch={changes.branch} />
        )}
      </Suspense>
    </div>
  )
}
