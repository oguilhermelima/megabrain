import { lazy, Suspense, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { api } from '@/api'
import type { BranchChanges, CodeChange } from '@/api/schema'
import { CodeIcon } from '@/advanced/chrome'
import { tabStep, type PaneView, type Segment, type WorktreeFacts } from '@/chat/action-bar-model'
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
 * Agent, Code, PR and Diff as a strip of tabs, the row under a pane's title, each its icon and name.
 * The shown view is underlined, the line sitting on the bar's hairline below; the PR number and the
 * Diff count follow the name as small counters. Only a disabled tab keeps a tooltip, for its reason.
 * The shown tab takes the keyboard's Tab; Left and Right then move between tabs (action-bar-model's
 * tabStep) and Enter or Space opens one. A strip wider than its pane scrolls sideways.
 */
export function ActionBar({ segments, shown, onSelect }: { segments: readonly Segment[]; shown: PaneView; onSelect: (view: PaneView) => void }) {
  const strip = useRef<HTMLDivElement>(null)
  const icons: Record<PaneView, ReactNode> = {
    agent: <ChatGlyph />,
    code: <CodeIcon size={16} />,
    pr: <PullRequestIcon size={16} />,
    diff: <DiffIcon />,
  }
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: PaneView) => {
    const next = tabStep(segments, from, event.key)
    if (next === null) return
    event.preventDefault()
    const tab = strip.current?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)
    tab?.focus()
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  return (
    <div ref={strip} role="tablist" aria-label="Views" className="-mb-px -ml-2 flex max-w-[calc(100%+8px)] min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {segments.map((segment) => {
        const current = segment.view === shown
        return (
          <button
            key={segment.view}
            type="button"
            role="tab"
            data-view={segment.view}
            aria-label={segment.badge === null ? segment.label : `${segment.label} ${segment.badge}`}
            aria-selected={current}
            tabIndex={current ? 0 : -1}
            title={segment.enabled ? undefined : segment.title}
            disabled={!segment.enabled}
            onClick={() => onSelect(segment.view)}
            onKeyDown={(event) => move(event, segment.view)}
            className={`relative flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-semibold transition-colors duration-[var(--motion-enter)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-600 ${current ? 'text-ink-100' : 'text-ink-400 hover:text-ink-100'}`}
          >
            {icons[segment.view]}
            <span aria-hidden="true">{segment.label}</span>
            {segment.badge !== null && (
              <span aria-hidden="true" className={`min-w-4 rounded-full px-1 text-center text-[10px] leading-4 tabular-nums ${current ? 'bg-white/[0.14] text-ink-100' : 'bg-white/[0.06] text-ink-300'}`}>
                {segment.badge}
              </span>
            )}
            <span aria-hidden="true" className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors duration-[var(--motion-enter)] ${current ? 'bg-ink-100' : 'bg-transparent'}`} />
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
