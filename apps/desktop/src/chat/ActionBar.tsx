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
 * Agent, Code, PR, Diff and Device as one segmented control, the row under a pane's title: the bar's
 * 30px track (bar-control, as the chat or terminal switch beside the title), each segment a 24px pill
 * with its icon and name, the PR number and the Diff count after the name as small counters. The
 * track starts at the bar's content edge, under the agent's mark. The shown segment sits on a raised
 * pill that slides to the next one with the motion tokens. A disabled segment is dimmed and keeps a
 * tooltip, for its reason. The shown segment takes the keyboard's Tab; Left and Right then move
 * between segments (action-bar-model's tabStep) and Enter or Space opens one. A control wider than its
 * pane scrolls sideways.
 */
export function ActionBar({ segments, shown, onSelect }: { segments: readonly Segment[]; shown: PaneView; onSelect: (view: PaneView) => void }) {
  const strip = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null)
  const icons: Record<PaneView, ReactNode> = {
    agent: <ChatGlyph />,
    code: <CodeIcon size={16} />,
    pr: <PullRequestIcon size={16} />,
    diff: <DiffIcon />,
    device: <PhoneIcon />,
  }
  // The pill follows the shown segment, measured again whenever the control or a segment changes size (a badge appearing, the pane resizing).
  useLayoutEffect(() => {
    const element = strip.current
    if (element === null) return
    const measure = () => {
      const segment = element.querySelector<HTMLElement>(`[data-view="${shown}"]`)
      setPill(segment === null ? null : { left: segment.offsetLeft, width: segment.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const segment of element.querySelectorAll('[data-view]')) observer.observe(segment)
    return () => observer.disconnect()
  }, [shown, segments])
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: PaneView) => {
    const next = tabStep(segments, from, event.key)
    if (next === null) return
    event.preventDefault()
    const tab = strip.current?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)
    tab?.focus()
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  return (
    <div className="flex min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div ref={strip} role="tablist" aria-label="Views" className="bar-control bar-group relative">
        {pill !== null && (
          <span
            aria-hidden="true"
            data-tab-pill=""
            style={{ width: pill.width, translate: `${pill.left}px 0`, transition: 'translate var(--motion-panel) var(--motion-ease-panel), width var(--motion-panel) var(--motion-ease-panel)' }}
            className="pointer-events-none absolute top-0.5 left-0 h-6 rounded-[9999px] bg-white/[0.14]"
          />
        )}
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
              className={`bar-segment relative shrink-0 gap-1.5 pr-2.5 pl-2 ${current ? 'text-ink-100 hover:bg-transparent' : ''}`}
            >
              {icons[segment.view]}
              <span aria-hidden="true">{segment.label}</span>
              {segment.badge !== null && (
                <span aria-hidden="true" className={`min-w-4 rounded-full px-1 text-center text-[10px] leading-4 tabular-nums ${!segment.enabled ? 'bg-white/[0.04]' : current ? 'bg-white/[0.14] text-ink-100' : 'bg-white/[0.08] text-ink-300'}`}>
                  {segment.badge}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
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
