import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { HistorySession } from '@/api/schema'
import { relativeAge } from '@/advanced/projects-model'
import { AgentIcon } from '@/components/agent-icons'
import { ErrorNote } from '@/components/ui'
import type { LaunchTile, LaunchTileId } from '@/launcher/launch-model'
import { moveInColumn } from '@/launcher/launcher-keys'
import { resumePage, resumeRows, type ResumeFilter } from '@/launcher/resume-model'

// Read again each time the launcher opens on a worktree, so a chat that just ended is listed; the CLI
// caches what it parsed, so this stays quick.
function useHistory(cwd: string | null): { sessions: HistorySession[] | null; error: unknown } {
  const [state, setState] = useState<{ cwd: string | null; sessions: HistorySession[] | null; error: unknown }>({ cwd: null, sessions: null, error: null })
  useEffect(() => {
    if (cwd === null) return
    let stopped = false
    api.sessionHistory(cwd).then(
      (sessions) => {
        if (!stopped) setState({ cwd, sessions, error: null })
      },
      (error: unknown) => {
        if (!stopped) setState({ cwd, sessions: null, error })
      },
    )
    return () => {
      stopped = true
    }
  }, [cwd])
  return state.cwd === cwd ? state : { sessions: null, error: null }
}

/**
 * Past chats started in this worktree, for the selected agent or every agent; a click resumes one.
 * The column keeps one tabbable item, the search; the arrow keys move through the filter above it and
 * the rows below.
 */
export function ResumeList({
  cwd,
  filter,
  agent,
  tiles,
  disabled,
  onFilter,
  onResume,
}: {
  cwd: string | null
  filter: ResumeFilter
  /** The selected agent the filter narrows to; null when no agent can be selected. */
  agent: LaunchTileId | null
  tiles: LaunchTile[]
  disabled: boolean
  onFilter: (filter: ResumeFilter) => void
  onResume: (session: HistorySession) => void
}) {
  const { sessions, error } = useHistory(cwd)
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState(1)
  const labelOf = (id: string) => tiles.find((item) => item.id === id)?.label ?? id
  const all = filter === 'all' || filter === 'terminal'
  const label = labelOf(filter)

  // A new filter starts from the first page again.
  useEffect(() => setPages(1), [cwd, filter, query])

  if (cwd === null) return null
  const rows = sessions === null ? [] : resumeRows(sessions, filter, query)
  const page = resumePage(rows, pages)
  const empty = query.trim() !== '' ? `No past chat matches “${query.trim()}”.` : all ? 'No past chats in this worktree yet.' : `No past ${label} chats in this worktree yet.`

  return (
    <section aria-label="Resume" className="flex min-h-0 flex-col" onKeyDown={(event) => void moveInColumn(event)}>
      <div className="flex h-8 items-center gap-2">
        <h2 className="text-[13px] font-semibold text-ink-400">Resume</h2>
        {agent !== null && (
          <div role="radiogroup" aria-label="Resume filter" className="ml-auto flex gap-0.5">
            {[
              { value: agent, label: labelOf(agent) },
              { value: 'all' as const, label: 'All agents' },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                data-column-item
                tabIndex={-1}
                aria-checked={(option.value === 'all') === all}
                onClick={() => onFilter(option.value)}
                className="h-7 rounded-[10px] px-2.5 text-[12.5px] text-ink-500 transition-colors hover:text-ink-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 aria-checked:bg-white/[0.08] aria-checked:text-ink-100"
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <input
        type="search"
        data-column-item
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={all ? 'Search past chats' : `Search past ${label} chats`}
        aria-label="Search past chats"
        className="mt-2 h-8 w-full shrink-0 rounded-[12px] border border-white/[0.08] bg-ink-900 px-3 text-[13px] text-ink-200 placeholder:text-ink-500 focus:border-accent/60 focus:outline-none"
      />
      {error !== null && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-2 grid min-h-0 flex-1 content-start gap-0.5 overflow-y-auto pb-2">
        {sessions === null && error === null && [0, 1, 2].map((index) => <SkeletonRow key={index} />)}
        {sessions !== null && rows.length === 0 && <p className="px-3 py-2 text-[13px] text-ink-500">{empty}</p>}
        {page.rows.map((session) => (
          <button
            key={`${session.agent}:${session.id}`}
            type="button"
            data-column-item
            tabIndex={-1}
            disabled={disabled}
            onClick={() => onResume(session)}
            title={`Resume this ${labelOf(session.agent)} chat · ${session.id}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-3 py-2 text-left transition-colors hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            <AgentIcon agent={session.agent} size={16} />
            <span className="truncate text-[13.5px] text-ink-200">{session.title.trim() === '' ? session.id : session.title}</span>
            <span className="flex shrink-0 gap-3 text-[12px] text-ink-500 tabular-nums">
              {session.messageCount !== null && <span>{session.messageCount === 1 ? '1 message' : `${session.messageCount} messages`}</span>}
              <span>{relativeAge(session.lastActivityAt ?? session.startedAt)}</span>
            </span>
          </button>
        ))}
        {page.hidden > 0 && (
          <button
            type="button"
            data-column-item
            tabIndex={-1}
            onClick={() => setPages((current) => current + 1)}
            className="mt-1 justify-self-start rounded-[12px] px-3 py-1.5 text-[12.5px] text-ink-400 hover:bg-row-hover hover:text-ink-200 focus-visible:bg-row-hover focus-visible:outline-none"
          >
            Show more ({page.hidden})
          </button>
        )}
      </div>
    </section>
  )
}

function SkeletonRow() {
  return (
    <div aria-hidden="true" className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5">
      <span className="size-4 animate-pulse rounded-full bg-white/[0.06]" />
      <span className="h-3 w-2/3 animate-pulse rounded-full bg-white/[0.06]" />
      <span className="h-3 w-10 animate-pulse rounded-full bg-white/[0.06]" />
    </div>
  )
}
