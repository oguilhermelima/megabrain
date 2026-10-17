import { lazy, Suspense, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { api } from '@/api'
import type { BranchChanges, CodeChange } from '@/api/schema'
import { CodeIcon } from '@/advanced/chrome'
import type { PaneView, Segment, WorktreeFacts } from '@/chat/action-bar-model'
import { SegmentedTabs } from '@/components/SegmentedTabs'
import { PaneSkeleton } from '@/components/Skeleton'
import { PullRequestIcon } from '@/github/icons'
import { changesPolicy } from '@/lib/poll-model'
import { reuse } from '@/lib/reuse'
import { usePoll } from '@/lib/usePoll'

const GithubItemView = lazy(() => import('@/github/GithubItem').then((module) => ({ default: module.GithubItemView })))
const ChangesDiff = lazy(() => import('@/code/ChangesDiff').then((module) => ({ default: module.ChangesDiff })))
const DeviceView = lazy(() => import('@/device/DeviceView').then((module) => ({ default: module.DeviceView })))

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
 * Agent, Code, PR, Diff and Device as one segmented control (components/SegmentedTabs), the row
 * under a pane's title, each segment with its icon and name, the PR number and the Diff count after
 * the name as small counters. The track starts at the bar's content edge, under the agent's mark.
 */
export function ActionBar({ segments, shown, onSelect }: { segments: readonly Segment[]; shown: PaneView; onSelect: (view: PaneView) => void }) {
  const icons: Record<PaneView, ReactNode> = {
    agent: <ChatGlyph />,
    code: <CodeIcon size={16} />,
    pr: <PullRequestIcon size={16} />,
    diff: <DiffIcon />,
    device: <PhoneIcon />,
  }
  return <SegmentedTabs label="Views" segments={segments} icons={icons} shown={shown} onSelect={onSelect} />
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="1.5" width="8" height="13" rx="2" />
      <path d="M7 12.25h2" />
    </svg>
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
 * The Code, PR, Diff or Device view, laid over the pane below its top bar so the bar stays and the Agent
 * view under it keeps its draft, scroll and terminal. The pane's content box is the positioned
 * ancestor; the top follows the header's height.
 */
export function PaneViewBody({ view, facts, changes, code, openFile, header }: { view: Exclude<PaneView, 'agent'>; facts: WorktreeFacts; changes: WorktreeChanges; code: ReactNode; openFile?: (path: string) => void; header: RefObject<HTMLElement | null> }) {
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
      <WorktreeView view={view} facts={facts} changes={changes} code={code} openFile={openFile} />
    </div>
  )
}

/** The Code, PR, Diff or Device view itself, filling its box: a pane's under its top bar, or a whole split's under the shared bar. `openFile` shows a worktree file in Code. */
export function WorktreeView({ view, facts, changes, code, openFile }: { view: Exclude<PaneView, 'agent'>; facts: WorktreeFacts; changes: WorktreeChanges; code: ReactNode; openFile?: (path: string) => void }) {
  return (
    <Suspense fallback={<PaneSkeleton />}>
      {view === 'code' ? (
        code
      ) : view === 'device' ? (
        <DeviceView key={facts.root} root={facts.root} onOpenFile={openFile} />
      ) : view === 'pr' && facts.pullRequest !== null ? (
        <GithubItemView key={facts.pullRequest} root={facts.repo} kind="pr" number={facts.pullRequest} />
      ) : (
        <ChangesDiff root={facts.root} uncommitted={changes.uncommitted} branch={changes.branch} />
      )}
    </Suspense>
  )
}
