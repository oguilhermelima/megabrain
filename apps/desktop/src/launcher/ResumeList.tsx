import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { HistorySession } from '@/api/schema'
import { relativeAge } from '@/advanced/projects-model'
import { AgentIcon } from '@/components/agent-icons'
import { ErrorNote } from '@/components/ui'
import type { LaunchTile, LaunchTileId } from '@/launcher/launch-model'
import { resumePage, resumeRows } from '@/launcher/resume-model'

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

/** Past chats started in this worktree, for the selected tile's agent (all of them under Terminal); a click resumes one. */
export function ResumeList({ cwd, tile, tiles, disabled, onResume }: { cwd: string | null; tile: LaunchTileId; tiles: LaunchTile[]; disabled: boolean; onResume: (session: HistorySession) => void }) {
  const { sessions, error } = useHistory(cwd)
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState(1)
  const label = tiles.find((item) => item.id === tile)?.label ?? tile
  const labelOf = (agent: string) => tiles.find((item) => item.id === agent)?.label ?? agent

  // A new filter starts from the first page again.
  useEffect(() => setPages(1), [cwd, tile, query])

  if (cwd === null) return null
  const rows = sessions === null ? [] : resumeRows(sessions, tile, query)
  const page = resumePage(rows, pages)
  const empty = query.trim() !== '' ? `No past chat matches “${query.trim()}”.` : tile === 'terminal' ? 'No past chats in this worktree yet.' : `No past ${label} chats in this worktree yet.`

  return (
    <section aria-label="Resume" className="pt-6 pb-6">
      <div className="flex items-center gap-3">
        <h2 className="text-[15px] font-semibold text-ink-300">Resume</h2>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tile === 'terminal' ? 'Search past chats' : `Search past ${label} chats`}
          aria-label="Search past chats"
          className="ml-auto h-8 w-56 rounded-[12px] border border-white/[0.08] bg-ink-900 px-3 text-[13px] text-ink-200 placeholder:text-ink-500 focus:border-accent/60 focus:outline-none"
        />
      </div>
      {error !== null && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-3 grid gap-1">
        {sessions === null && error === null && [0, 1, 2].map((index) => <SkeletonRow key={index} />)}
        {sessions !== null && rows.length === 0 && <p className="px-3 py-2 text-[13px] text-ink-500">{empty}</p>}
        {page.rows.map((session) => (
          <button
            key={`${session.agent}:${session.id}`}
            type="button"
            disabled={disabled}
            onClick={() => onResume(session)}
            title={`Resume this ${labelOf(session.agent)} chat · ${session.id}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] px-3 py-2 text-left transition-colors hover:bg-row-hover disabled:cursor-not-allowed disabled:opacity-50"
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
          <button type="button" onClick={() => setPages((current) => current + 1)} className="mt-1 justify-self-start rounded-[12px] px-3 py-1.5 text-[12.5px] text-ink-400 hover:bg-row-hover hover:text-ink-200">
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
