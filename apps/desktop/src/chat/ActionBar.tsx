import { lazy, Suspense, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { api } from '@/api'
import type { BranchChanges, CodeChange } from '@/api/schema'
import { CodeIcon } from '@/advanced/chrome'
import { segmentExpanded, type PaneView, type Segment, type WorktreeFacts } from '@/chat/action-bar-model'
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
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
 * Agent, Code, PR and Diff as one segmented control of icons. The shown view keeps its name; a
 * segment under the pointer or the keyboard's focus grows to show its own (action-bar-model's
 * segmentExpanded), its label sliding open in a 0fr to 1fr grid column. The PR number and the Diff
 * count stay on their icons as small counters. Only a disabled segment keeps a tooltip, for its reason.
 */
export function ActionBar({ agent, segments, shown, onSelect }: { agent: string | null; segments: readonly Segment[]; shown: PaneView; onSelect: (view: PaneView) => void }) {
  const [hovered, setHovered] = useState<PaneView | null>(null)
  const [focused, setFocused] = useState<PaneView | null>(null)
  const icons: Record<PaneView, ReactNode> = {
    agent: agent === null || agent === '' ? <ChatGlyph /> : <AgentIcon agent={agent} size={16} />,
    code: <CodeIcon size={16} />,
    pr: <PullRequestIcon size={16} />,
    diff: <DiffIcon />,
  }
  const grow = { transition: 'grid-template-columns var(--motion-enter) var(--motion-ease-out), opacity var(--motion-enter) var(--motion-ease-out)' }
  return (
    <div role="group" aria-label="Views" onPointerLeave={() => setHovered(null)} className="bar-control bar-group">
      {segments.map((segment) => {
        const current = segment.view === shown
        const open = segmentExpanded(segment.view, { shown, hovered, focused })
        return (
          <button
            key={segment.view}
            type="button"
            aria-label={segment.badge === null ? segment.label : `${segment.label} ${segment.badge}`}
            aria-pressed={current}
            title={segment.enabled ? undefined : segment.title}
            disabled={!segment.enabled}
            onClick={() => onSelect(segment.view)}
            onPointerEnter={() => setHovered(segment.view)}
            onFocus={(event) => setFocused(event.currentTarget.matches(':focus-visible') ? segment.view : null)}
            onBlur={() => setFocused(null)}
            className="bar-segment"
          >
            <span className="flex shrink-0 items-start">
              {icons[segment.view]}
              {segment.badge !== null && (
                <span aria-hidden="true" className="-mt-1.5 -ml-1 min-w-3.5 rounded-full bg-ink-600 px-1 text-center text-[9px] leading-3.5 font-semibold text-ink-100 tabular-nums">
                  {segment.badge}
                </span>
              )}
            </span>
            <span aria-hidden="true" style={grow} className={`grid ${open ? 'grid-cols-[1fr] opacity-100' : 'grid-cols-[0fr] opacity-0'}`}>
              <span className="overflow-hidden pr-1 pl-1.5 whitespace-nowrap">{segment.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function ChatGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.2v-2.2h0a1.5 1.5 0 0 1-1.5-1.5Z" />
    </svg>
  )
}

/**
 * The Code, PR or Diff view, laid over the pane below its top bar so the bar stays and the Agent
 * view under it keeps its draft, scroll and terminal. The pane's content box is the positioned
 * ancestor; the top follows the header's height.
 */
export function PaneViewBody({ view, facts, changes, code, header }: { view: Exclude<PaneView, 'agent'>; facts: WorktreeFacts; changes: WorktreeChanges; code: ReactNode; header: RefObject<HTMLElement | null> }) {
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
      <WorktreeView view={view} facts={facts} changes={changes} code={code} />
    </div>
  )
}

/** The Code, PR or Diff view itself, filling its box: a pane's under its top bar, or a whole split's under the shared bar. */
export function WorktreeView({ view, facts, changes, code }: { view: Exclude<PaneView, 'agent'>; facts: WorktreeFacts; changes: WorktreeChanges; code: ReactNode }) {
  return (
    <Suspense fallback={<PaneSkeleton />}>
      {view === 'code' ? (
        code
      ) : view === 'pr' && facts.pullRequest !== null ? (
        <GithubItemView key={facts.pullRequest} root={facts.repo} kind="pr" number={facts.pullRequest} />
      ) : (
        <ChangesDiff root={facts.root} uncommitted={changes.uncommitted} branch={changes.branch} />
      )}
    </Suspense>
  )
}
